import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';

const MAX_RANGE_DAYS = 366;

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

function assertUuid(value: string, name: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value ?? '',
    )
  )
    throw new BadRequestException('Invalid ' + name + ' id');
}
