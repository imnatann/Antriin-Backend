import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { uuidPattern } from '../notifications/outbox.service';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './settlements.constants';

const MAX_RANGE_DAYS = 366;

/** D7: response timestamps are the DB microsecond UTC strings themselves. */
const SQL_TS = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Every status the settlements table accepts (CHECK settlements_status_check). */
export const SETTLEMENT_STATUS_FILTERS = [
  'pending',
  'available',
  'paid_out',
  'voided',
  'reversed',
] as const;
export type SettlementStatusFilter = (typeof SETTLEMENT_STATUS_FILTERS)[number];

export type CampusSettlementView = {
  settlementId: string;
  tenantId: string;
  tenantName: string;
  orderId: string;
  amountMinor: string;
  paidOutMinor: string;
  currency: string;
  status: string;
  releasedAt: string | null;
  createdAt: string;
};

export type CampusSettlementPage = {
  items: CampusSettlementView[];
  nextCursor: string | null;
};

export type CampusSettlementQuery = {
  from: string;
  to: string;
  status?: string;
  tenantId?: string;
  cursor?: string;
  limit?: number;
};

type Cursor = { createdAt: string; id: string };

/**
 * Read-only campus monitoring of the tenant settlements (REQUIREMENTS §3.8.7,
 * design §7). A campus manager with campus.payouts.read can watch the
 * settlements of the tenants in their campus.
 *
 * Nothing here recomputes a balance, moves money or infers a financial
 * definition: every row is an existing settlements row scoped through
 * tenants.campus_id, and money stays an integer minor-unit decimal string.
 */
@Injectable()
export class CampusSettlementsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
  ) {}

  async listCampusSettlements(
    actorUserId: string,
    campusId: string,
    query: CampusSettlementQuery,
  ): Promise<CampusSettlementPage> {
    assertUuid(actorUserId, 'user');
    assertUuid(campusId, 'campus');
    const { from, to } = normalizeRange(query);
    const limit = normalizeLimit(query.limit);
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (query.status !== undefined && !isSettlementStatus(query.status))
      throw new BadRequestException({
        code: 'SETTLEMENT_STATUS_INVALID',
        message:
          'status must be one of: ' + SETTLEMENT_STATUS_FILTERS.join(', '),
      });
    if (query.tenantId !== undefined) assertUuid(query.tenantId, 'tenant');

    return this.withTransaction(async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.payouts.read',
        tx,
      );
      // settlements carries no campus_id of its own; the campus comes from its
      // tenant, so the join is also the scope check.
      const values: unknown[] = [campusId, from, to];
      let where =
        't.campus_id = $1 and s.created_at >= $2 and s.created_at < $3';
      if (query.status !== undefined) {
        values.push(query.status);
        where += ' and s.status = $' + String(values.length);
      }
      if (query.tenantId !== undefined) {
        values.push(query.tenantId);
        where += ' and s.tenant_id = $' + String(values.length);
      }
      if (cursor) {
        values.push(cursor.createdAt, cursor.id);
        where +=
          ' and (s.created_at, s.id) < ($' +
          String(values.length - 1) +
          '::timestamptz, $' +
          String(values.length) +
          '::uuid)';
      }
      values.push(limit + 1);
      const result = await tx.query<{
        id: string;
        tenant_id: string;
        tenant_name: string;
        order_id: string;
        amount_minor: string;
        paid_out_minor: string;
        currency: string;
        status: string;
        released_at: string | null;
        created_at: string;
        cursor_created_at: string;
      }>(
        `select s.id::text, s.tenant_id::text, t.name as tenant_name,
                s.order_id::text, s.amount_minor::text,
                s.paid_out_minor::text, s.currency, s.status,
                ${SQL_TS('s.released_at')} as released_at,
                ${SQL_TS('s.created_at')} as created_at,
                ${SQL_TS('s.created_at')} as cursor_created_at
           from settlements s
           join tenants t on t.id = s.tenant_id
          where ${where}
          order by s.created_at desc, s.id desc
          limit $${String(values.length)}`,
        values,
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          settlementId: row.id,
          tenantId: row.tenant_id,
          tenantName: row.tenant_name,
          orderId: row.order_id,
          amountMinor: row.amount_minor,
          paidOutMinor: row.paid_out_minor,
          currency: row.currency,
          status: row.status,
          releasedAt: row.released_at,
          createdAt: row.created_at,
        })),
        nextCursor:
          hasMore && last
            ? encodeCursor({ createdAt: last.cursor_created_at, id: last.id })
            : null,
      };
    });
  }

  private async withTransaction<T>(
    operation: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
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
 * Half-open [from, to) window, capped at one year, mirroring the reporting
 * slice: a monitoring query can never silently scan the whole table.
 */
function normalizeRange(query: { from?: string; to?: string }): {
  from: string;
  to: string;
} {
  const from = typeof query?.from === 'string' ? query.from.trim() : '';
  const to = typeof query?.to === 'string' ? query.to.trim() : '';
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
        'The settlement window must not exceed ' +
        String(MAX_RANGE_DAYS) +
        ' days',
    });
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

function isSettlementStatus(value: string): value is SettlementStatusFilter {
  return (SETTLEMENT_STATUS_FILTERS as readonly string[]).includes(value);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT)
    throw new BadRequestException(
      'limit must be an integer from 1 to ' + String(MAX_PAGE_LIMIT),
    );
  return value;
}

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
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(parsed.createdAt) ||
      typeof parsed.id !== 'string' ||
      !uuidPattern.test(parsed.id)
    )
      throw new Error('invalid cursor shape');
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid settlement list cursor');
  }
}

function assertUuid(value: string, name: string): void {
  if (!uuidPattern.test(value ?? ''))
    throw new BadRequestException('Invalid ' + name + ' id');
}
