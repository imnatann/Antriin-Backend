import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { ORDER_STATUSES } from '../orders/orders.constants';
import type { OrderStatus } from '../orders/orders.constants';
import {
  TRANSACTION_PAGE_LIMIT_DEFAULT,
  TRANSACTION_PAGE_LIMIT_MAX,
} from './reporting.constants';

const MAX_RANGE_DAYS = 366;

/** Cursor timestamp: the microsecond UTC string D7 returns, never a Date. */
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type Range = { from: string; to: string };

/**
 * Order counts and totals per status inside a date window. Totals are order
 * totals, NOT revenue: fees, taxes and gross/net definitions are undecided
 * (REQUIREMENTS §3.8.8), so no derived money figure is invented here.
 */
export type SalesReport = {
  tenantId: string;
  currency: string;
  from: string;
  to: string;
  orders: { status: string; count: number; totalMinor: string }[];
  refunds: { status: string; count: number; totalMinor: string }[];
};

export type CampusDashboard = {
  campusId: string;
  currency: string;
  from: string;
  to: string;
  tenants: { status: string; count: number }[];
  orders: { status: string; count: number; totalMinor: string }[];
  refunds: { status: string; count: number; totalMinor: string }[];
  payouts: { status: string; count: number; totalMinor: string }[];
  cases: { status: string; count: number }[];
};

/**
 * One order as campus oversight sees it. Money stays the database string
 * (::text) and timestamps stay the microsecond UTC strings of D7; nothing is
 * rounded or re-serialized in the API layer.
 */
export type CampusTransactionView = {
  orderId: string;
  orderNumber: string | null;
  tenantId: string;
  tenantName: string;
  buyerDisplayName: string;
  status: OrderStatus;
  currency: string;
  totalMinor: string;
  pickupStartsAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CampusTransactionQuery = Range & {
  status?: string;
  tenantId?: string;
  cursor?: string;
  limit?: number;
};

export type CampusTransactionPage = {
  items: CampusTransactionView[];
  nextCursor: string | null;
};

type TransactionRow = {
  order_id: string;
  order_number: string | null;
  tenant_id: string;
  tenant_name: string;
  buyer_display_name: string;
  status: OrderStatus;
  currency: string;
  total_minor: string;
  pickup_starts_at: string;
  created_at: string;
  updated_at: string;
};

type Cursor = { createdAt: string; id: string };

/**
 * Read-only reporting. Nothing here moves money, writes a row or infers a
 * financial definition the product has not decided: every number is a count
 * or a sum of an existing column, grouped by an existing status.
 */
@Injectable()
export class ReportingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
  ) {}

  /** Tenant sales report: order/refund counts and order totals per status. */
  async getSalesReport(
    actorUserId: string,
    tenantId: string,
    range: Range,
  ): Promise<SalesReport> {
    assertUuid(actorUserId, 'user');
    assertUuid(tenantId, 'tenant');
    const { from, to } = normalizeRange(range);
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.sales.read',
        tx,
      );
      const orders = await tx.query<{
        status: string;
        count: string;
        total_minor: string;
      }>(
        `select status, count(*)::text as count,
                coalesce(sum(total_minor), 0)::text as total_minor
           from orders
          where tenant_id = $1 and created_at >= $2 and created_at < $3
          group by status order by status`,
        [tenantId, from, to],
      );
      const refunds = await tx.query<{
        status: string;
        count: string;
        total_minor: string;
      }>(
        `select status, count(*)::text as count,
                coalesce(sum(amount_minor), 0)::text as total_minor
           from refunds
          where tenant_id = $1 and created_at >= $2 and created_at < $3
          group by status order by status`,
        [tenantId, from, to],
      );
      return {
        tenantId,
        currency: 'IDR',
        from,
        to,
        orders: orders.rows.map((row) => ({
          status: row.status,
          count: Number(row.count),
          totalMinor: row.total_minor,
        })),
        refunds: refunds.rows.map((row) => ({
          status: row.status,
          count: Number(row.count),
          totalMinor: row.total_minor,
        })),
      };
    });
  }

  /**
   * Campus oversight dashboard (REQUIREMENTS §3.10.1): tenants, orders,
   * refunds, payouts and cases of one campus in a date window. Risk/AI review
   * counts are absent because the risk slice is not implemented.
   */
  async getCampusDashboard(
    actorUserId: string,
    campusId: string,
    range: Range,
  ): Promise<CampusDashboard> {
    assertUuid(actorUserId, 'user');
    assertUuid(campusId, 'campus');
    const { from, to } = normalizeRange(range);
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.transactions.read',
        tx,
      );
      const tenants = await tx.query<{ status: string; count: string }>(
        'select status, count(*)::text as count from tenants where campus_id = $1 group by status order by status',
        [campusId],
      );
      // orders and payouts carry no campus_id of their own; the campus comes
      // from their tenant (REQUIREMENTS §7.2 asks for orders.campus_id, the
      // accepted schema resolves it through tenants instead).
      const orders = await tx.query<{
        status: string;
        count: string;
        total_minor: string;
      }>(
        `select o.status, count(*)::text as count,
                coalesce(sum(o.total_minor), 0)::text as total_minor
           from orders o
           join tenants t on t.id = o.tenant_id
          where t.campus_id = $1 and o.created_at >= $2 and o.created_at < $3
          group by o.status order by o.status`,
        [campusId, from, to],
      );
      const refunds = await tx.query<{
        status: string;
        count: string;
        total_minor: string;
      }>(
        `select status, count(*)::text as count,
                coalesce(sum(amount_minor), 0)::text as total_minor
           from refunds
          where campus_id = $1 and created_at >= $2 and created_at < $3
          group by status order by status`,
        [campusId, from, to],
      );
      const payouts = await tx.query<{
        status: string;
        count: string;
        total_minor: string;
      }>(
        `select p.status, count(*)::text as count,
                coalesce(sum(p.amount_minor), 0)::text as total_minor
           from payouts p
           join tenants t on t.id = p.tenant_id
          where t.campus_id = $1 and p.created_at >= $2 and p.created_at < $3
          group by p.status order by p.status`,
        [campusId, from, to],
      );
      const cases = await tx.query<{ status: string; count: string }>(
        `select status, count(*)::text as count
           from cases
          where campus_id = $1 and created_at >= $2 and created_at < $3
          group by status order by status`,
        [campusId, from, to],
      );
      return {
        campusId,
        currency: 'IDR',
        from,
        to,
        tenants: tenants.rows.map((row) => ({
          status: row.status,
          count: Number(row.count),
        })),
        orders: orders.rows.map((row) => ({
          status: row.status,
          count: Number(row.count),
          totalMinor: row.total_minor,
        })),
        refunds: refunds.rows.map((row) => ({
          status: row.status,
          count: Number(row.count),
          totalMinor: row.total_minor,
        })),
        payouts: payouts.rows.map((row) => ({
          status: row.status,
          count: Number(row.count),
          totalMinor: row.total_minor,
        })),
        cases: cases.rows.map((row) => ({
          status: row.status,
          count: Number(row.count),
        })),
      };
    });
  }

  /**
   * Campus transaction monitoring (REQUIREMENTS §3.10.1): the individual orders
   * behind the dashboard totals, newest first, inside a half-open window.
   *
   * Orders carry no campus_id, so the campus scope comes from their tenant —
   * the same join the dashboard uses. `tenantId` may only narrow that scope,
   * never widen it: a tenant of another campus is a 403, not an empty page.
   */
  async listCampusTransactions(
    actorUserId: string,
    campusId: string,
    query: CampusTransactionQuery,
  ): Promise<CampusTransactionPage> {
    assertUuid(actorUserId, 'user');
    assertUuid(campusId, 'campus');
    const { from, to } = normalizeRange(query);
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.transactions.read',
        tx,
      );
      const limit = normalizeLimit(query.limit);
      const status = query.status?.trim();
      if (status && !isOrderStatus(status))
        throw new BadRequestException({
          code: 'REPORT_STATUS_INVALID',
          message: 'status must be one of: ' + ORDER_STATUSES.join(', '),
        });
      const tenantId = query.tenantId?.trim();
      if (tenantId) {
        assertUuid(tenantId, 'tenant');
        const scoped = await tx.query(
          'select 1 from tenants where id = $1 and campus_id = $2',
          [tenantId, campusId],
        );
        if (!scoped.rows[0])
          throw new ForbiddenException({
            code: 'REPORT_TENANT_OUT_OF_SCOPE',
            message: 'tenantId does not belong to this campus',
          });
      }
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const values: unknown[] = [campusId, from, to];
      let where =
        't.campus_id = $1 and o.created_at >= $2 and o.created_at < $3';
      if (status) {
        values.push(status);
        where += ' and o.status = $' + String(values.length);
      }
      if (tenantId) {
        values.push(tenantId);
        where += ' and o.tenant_id = $' + String(values.length);
      }
      if (cursor) {
        values.push(cursor.createdAt, cursor.id);
        where +=
          ' and (o.created_at, o.id) < ($' +
          String(values.length - 1) +
          '::timestamptz, $' +
          String(values.length) +
          '::uuid)';
      }
      values.push(limit + 1);
      const result = await tx.query<TransactionRow>(
        `select o.id::text as order_id,
                o.order_number,
                o.tenant_id::text as tenant_id,
                t.name as tenant_name,
                u.display_name as buyer_display_name,
                o.status,
                o.currency,
                o.total_minor::text as total_minor,
                ${microUtc('o.pickup_starts_at', 'pickup_starts_at')},
                ${microUtc('o.created_at', 'created_at')},
                ${microUtc('o.updated_at', 'updated_at')}
           from orders o
           join tenants t on t.id = o.tenant_id
           join users u on u.id = o.buyer_id
          where ${where}
          order by o.created_at desc, o.id desc
          limit $` + String(values.length),
        values,
      );
      const page = result.rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          orderId: row.order_id,
          orderNumber: row.order_number,
          tenantId: row.tenant_id,
          tenantName: row.tenant_name,
          buyerDisplayName: row.buyer_display_name,
          status: row.status,
          currency: row.currency,
          totalMinor: row.total_minor,
          pickupStartsAt: row.pickup_starts_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        nextCursor:
          result.rows.length > limit && last
            ? encodeCursor({ createdAt: last.created_at, id: last.order_id })
            : null,
      };
    });
  }

  private async withTransaction<T>(
    client: PoolClient | undefined,
    operation: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (client) return operation(client);
    const connection = await this.database.pool.connect();
    try {
      await connection.query('begin');
      const result = await operation(connection);
      await connection.query('commit');
      return result;
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}

/**
 * Half-open [from, to) window. Both bounds are required so a report can never
 * silently scan the whole table, and the window is capped at one year.
 */
function normalizeRange(range: Range): { from: string; to: string } {
  const from = typeof range?.from === 'string' ? range.from.trim() : '';
  const to = typeof range?.to === 'string' ? range.to.trim() : '';
  if (!from || !to)
    throw new BadRequestException({
      code: 'REPORT_RANGE_REQUIRED',
      message: 'from and to are required (ISO 8601 dates)',
    });
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs))
    throw new BadRequestException({
      code: 'REPORT_RANGE_INVALID',
      message: 'from and to must be ISO 8601 timestamps',
    });
  if (fromMs >= toMs)
    throw new BadRequestException({
      code: 'REPORT_RANGE_INVALID',
      message: 'from must be before to',
    });
  if (toMs - fromMs > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000)
    throw new BadRequestException({
      code: 'REPORT_RANGE_TOO_LARGE',
      message:
        'The report window must not exceed ' + String(MAX_RANGE_DAYS) + ' days',
    });
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

/**
 * Response timestamps are the DB microsecond UTC strings themselves (D7).
 * Re-serializing through Date/toISOString would truncate to milliseconds and
 * break the (created_at, id) cursor round-trip.
 */
function microUtc(column: string, alias: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${alias}`;
}

function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return TRANSACTION_PAGE_LIMIT_DEFAULT;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > TRANSACTION_PAGE_LIMIT_MAX
  )
    throw new BadRequestException({
      code: 'REPORT_LIMIT_INVALID',
      message:
        'limit must be an integer from 1 to ' +
        String(TRANSACTION_PAGE_LIMIT_MAX),
    });
  return value;
}

/** Opaque cursor over (created_at, id); same shape as the orders slice. */
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as { createdAt?: unknown; id?: unknown };
    if (
      typeof parsed.createdAt !== 'string' ||
      !CURSOR_TIMESTAMP_PATTERN.test(parsed.createdAt) ||
      typeof parsed.id !== 'string' ||
      !UUID_PATTERN.test(parsed.id)
    )
      throw new Error('invalid cursor shape');
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException({
      code: 'REPORT_CURSOR_INVALID',
      message: 'Invalid transaction list cursor',
    });
  }
}

function assertUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value ?? ''))
    throw new BadRequestException('Invalid ' + name + ' id');
}
