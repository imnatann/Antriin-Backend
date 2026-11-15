import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { ORDER_STATUSES } from '../orders/orders.constants';
import type { OrderStatus } from '../orders/orders.constants';
import {
  DUE_EXPORT_BATCH_LIMIT,
  REPORT_EXPORT_FORMATS,
  REPORT_EXPORT_KINDS,
  REPORT_EXPORT_LIST_LIMIT,
  REPORT_EXPORT_SCHEDULES,
  TRANSACTION_PAGE_LIMIT_DEFAULT,
  TRANSACTION_PAGE_LIMIT_MAX,
} from './reporting.constants';
import type {
  ReportExportFormat,
  ReportExportKind,
  ReportExportStatus,
  ReportSchedule,
} from './reporting.constants';
import {
  advanceNextRunAt,
  isValidScheduleHour,
  isValidTimeZone,
  nextRunAt as nextScheduledRunAt,
} from './reporting.schedule';
import { campusDashboardToCsv, salesReportToCsv } from './reporting.csv';
import { campusDashboardToPdf, salesReportToPdf } from './reporting.pdf';

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

/** A report export belongs to exactly one tenant or one campus. */
export type ReportExportScope = { type: 'tenant' | 'campus'; id: string };

/**
 * One report_exports row as the API shows it. Timestamps are the microsecond
 * UTC strings of D7, produced by PostgreSQL; the window is the stored calendar
 * dates (report_exports keeps dates, not instants).
 *
 * `mediaAssetId` is always null today: media storage accepts images only, so a
 * generated report file is not persisted. `downloadPath` is therefore the
 * on-demand route that renders the file from live data, not a stored artefact.
 */
export type ReportExportView = {
  id: string;
  scope: ReportExportScope;
  kind: ReportExportKind;
  format: ReportExportFormat;
  from: string | null;
  to: string | null;
  schedule: ReportSchedule;
  scheduleHour: number | null;
  status: ReportExportStatus;
  mediaAssetId: string | null;
  error: string | null;
  nextRunAt: string | null;
  generatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  downloadPath: string;
};

export type ReportExportRequest = {
  kind: string;
  format: string;
  from: string;
  to: string;
  schedule?: string;
  scheduleHour?: number;
};

export type ReportExportPage = {
  items: ReportExportView[];
  /** True when the list bound was reached; no row is hidden silently. */
  truncated: boolean;
};

export type DueExportRun = { generated: number; failed: number };

type ReportExportRow = {
  id: string;
  tenant_id: string | null;
  campus_id: string | null;
  kind: ReportExportKind;
  format: ReportExportFormat;
  range_from: string | null;
  range_to: string | null;
  schedule: ReportSchedule;
  schedule_hour: number | null;
  status: ReportExportStatus;
  media_asset_id: string | null;
  error: string | null;
  next_run_at: string | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
};

type DueExportRow = ReportExportRow & {
  created_by: string;
  next_run_at_instant: Date | null;
};

/** report_exports columns in the microsecond-string form the API returns. */
const EXPORT_COLUMNS = `
  id::text AS id,
  tenant_id::text AS tenant_id,
  campus_id::text AS campus_id,
  kind, format, range_from, range_to, schedule, schedule_hour, status,
  media_asset_id::text AS media_asset_id,
  error,
  ${microUtc('next_run_at', 'next_run_at')},
  ${microUtc('generated_at', 'generated_at')},
  ${microUtc('created_at', 'created_at')},
  ${microUtc('updated_at', 'updated_at')}`;

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
      return this.loadSalesReport(tx, tenantId, from, to);
    });
  }

  /**
   * The tenant aggregation without the permission check. The route checks the
   * caller first; the worker calls this after re-checking the scope of the
   * stored export, because a background run has no interactive actor.
   */
  private async loadSalesReport(
    tx: PoolClient,
    tenantId: string,
    from: string,
    to: string,
  ): Promise<SalesReport> {
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
      return this.loadCampusDashboard(tx, campusId, from, to);
    });
  }

  /** The campus aggregation without the permission check; see loadSalesReport. */
  private async loadCampusDashboard(
    tx: PoolClient,
    campusId: string,
    from: string,
    to: string,
  ): Promise<CampusDashboard> {
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

  /**
   * Records a report export: a one-off request or a recurring schedule.
   *
   * The window is the same [from, to) the report endpoints take, stored at day
   * granularity because report_exports keeps calendar dates rather than
   * instants. Nothing is written into the report tables; the row is a request
   * for a file, and the worker (or the on-demand route) produces it from live
   * data.
   *
   * A manual export is due immediately and is generated exactly once;
   * daily/weekly rows get the next instant of scheduleHour in the campus
   * timezone.
   */
  async createExport(
    actorUserId: string,
    target: ReportExportScope,
    input: ReportExportRequest,
  ): Promise<ReportExportView> {
    assertUuid(actorUserId, 'user');
    assertUuid(target.id, target.type);
    const kind = normalizeExportKind(target, input.kind);
    const format = normalizeExportFormat(input.format);
    const { schedule, scheduleHour } = normalizeExportSchedule(
      input.schedule,
      input.scheduleHour,
    );
    const window = normalizeExportWindow(input);

    return this.withTransaction(undefined, async (tx) => {
      const timeZone = await this.authorizeExportScope(actorUserId, target, tx);
      const now = new Date();
      const dueAt = this.firstRunAt(schedule, scheduleHour, timeZone, now);
      const inserted = await tx.query<ReportExportRow>(
        `insert into report_exports
           (tenant_id, campus_id, kind, format, range_from, range_to, schedule,
            schedule_hour, next_run_at, status, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)
         returning ${EXPORT_COLUMNS}`,
        [
          target.type === 'tenant' ? target.id : null,
          target.type === 'campus' ? target.id : null,
          kind,
          format,
          window.from,
          window.to,
          schedule,
          scheduleHour,
          dueAt,
          actorUserId,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('report_exports insert returned no row');
      return this.renderExport(row);
    });
  }

  /**
   * The exports of one tenant or campus, newest first. Any actor who may read
   * the report sees the whole scope's schedules: hiding a colleague's schedule
   * would only make duplicate ones likely.
   */
  async listExports(
    actorUserId: string,
    target: ReportExportScope,
  ): Promise<ReportExportPage> {
    assertUuid(actorUserId, 'user');
    assertUuid(target.id, target.type);
    // The column name is chosen from a closed set, never interpolated input.
    const column = target.type === 'tenant' ? 'tenant_id' : 'campus_id';
    return this.withTransaction(undefined, async (tx) => {
      await this.requireExportRead(actorUserId, target, tx);
      const result = await tx.query<ReportExportRow>(
        `select ${EXPORT_COLUMNS}
           from report_exports
          where ${column} = $1
          order by created_at desc, id desc
          limit $2`,
        [target.id, REPORT_EXPORT_LIST_LIMIT + 1],
      );
      return {
        items: result.rows
          .slice(0, REPORT_EXPORT_LIST_LIMIT)
          .map((row) => this.renderExport(row)),
        truncated: result.rows.length > REPORT_EXPORT_LIST_LIMIT,
      };
    });
  }

  /**
   * Regenerates every export whose next_run_at has passed. The worker calls
   * this; no HTTP route does.
   *
   * Rows are claimed with FOR UPDATE SKIP LOCKED inside one transaction, so two
   * workers take different batches instead of repeating the same one, and a row
   * that was just advanced is not due again for a second caller.
   *
   * A failing row is recorded as failed with a stable error and its schedule
   * advanced, so one broken export cannot block the batch or spin forever.
   */
  async runDueExports(): Promise<DueExportRun> {
    let generated = 0;
    let failed = 0;
    const connection = await this.database.pool.connect();
    try {
      await connection.query('begin');
      const due = await connection.query<DueExportRow>(
        `select ${EXPORT_COLUMNS}, created_by::text as created_by,
                next_run_at as next_run_at_instant
           from report_exports
          where next_run_at is not null and next_run_at <= now()
          order by next_run_at asc
          limit $1
            for update skip locked`,
        [DUE_EXPORT_BATCH_LIMIT],
      );
      for (const row of due.rows) {
        try {
          await this.regenerateExport(connection, row);
          generated += 1;
        } catch (error) {
          failed += 1;
          await this.recordExportFailure(connection, row, error);
        }
      }
      await connection.query('commit');
      return { generated, failed };
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Renders one export from live data and stamps the row.
   *
   * The scope is re-checked against the row's creator first: a background run
   * has no interactive actor, and a schedule whose owner lost access must stop
   * rather than keep producing reports on their behalf.
   *
   * The generated bytes are not persisted. report_exports.media_asset_id may
   * only point at a media_assets row, and media storage accepts images only
   * (media_assets_content_type_check allows image/jpeg|png|webp and
   * MediaService.create sniffs the header), so no purpose or content type fits
   * a PDF or CSV report. The render still happens so a broken render is
   * recorded as a failure; the file itself is produced on demand by the .csv /
   * .pdf routes (see downloadPath), which always read live data. Storing report
   * files needs a migration widening media storage or a report_files table.
   */
  private async regenerateExport(
    tx: PoolClient,
    row: DueExportRow,
  ): Promise<void> {
    const target = exportScope(row);
    await this.requireExportRead(row.created_by, target, tx);
    const from = dayStart(row.range_from);
    const to = dayStart(row.range_to);
    if (row.kind === 'sales') {
      const report = await this.loadSalesReport(tx, target.id, from, to);
      const bytes =
        row.format === 'pdf'
          ? await salesReportToPdf(report)
          : Buffer.from(salesReportToCsv(report), 'utf8');
      assertRendered(bytes);
    } else {
      const dashboard = await this.loadCampusDashboard(tx, target.id, from, to);
      const bytes =
        row.format === 'pdf'
          ? await campusDashboardToPdf(dashboard)
          : Buffer.from(campusDashboardToCsv(dashboard), 'utf8');
      assertRendered(bytes);
    }
    const now = new Date();
    const next = await this.advanceExportSchedule(tx, row, now);
    await tx.query(
      `update report_exports
          set status = 'ready', error = null, generated_at = now(),
              next_run_at = $2, updated_at = now()
        where id = $1`,
      [row.id, next],
    );
  }

  private async recordExportFailure(
    tx: PoolClient,
    row: DueExportRow,
    error: unknown,
  ): Promise<void> {
    let next: Date | null;
    try {
      next = await this.advanceExportSchedule(tx, row, new Date());
    } catch {
      // The schedule itself is unusable (no hour, unknown zone, no previous
      // run): stop it rather than leave a row that is due forever.
      next = null;
    }
    await tx.query(
      `update report_exports
          set status = 'failed', error = $2, next_run_at = $3, updated_at = now()
        where id = $1`,
      [row.id, exportErrorMessage(error), next],
    );
  }

  /**
   * Next instant of the schedule, counted from the instant the export was due
   * so the cadence survives a worker that ran late. A one-off export is never
   * due again.
   */
  private async advanceExportSchedule(
    tx: PoolClient,
    row: DueExportRow,
    now: Date,
  ): Promise<Date | null> {
    if (row.schedule === 'manual') return null;
    const hour = row.schedule_hour;
    if (!isValidScheduleHour(hour))
      throw new RangeError('report export has no valid schedule hour');
    const previous = row.next_run_at_instant;
    if (!previous) throw new RangeError('report export has no previous run');
    const timeZone = await this.scopeTimeZone(tx, exportScope(row));
    return advanceNextRunAt(now, previous, row.schedule, hour, timeZone);
  }

  private firstRunAt(
    schedule: ReportSchedule,
    hour: number | null,
    timeZone: string,
    now: Date,
  ): Date {
    if (schedule === 'manual') return now;
    if (!isValidScheduleHour(hour))
      throw new BadRequestException({
        code: 'REPORT_EXPORT_SCHEDULE_INVALID',
        message: 'A daily or weekly schedule requires scheduleHour',
      });
    if (!isValidTimeZone(timeZone))
      throw new BadRequestException({
        code: 'REPORT_SCHEDULE_TIMEZONE_INVALID',
        message: 'The campus time zone is not a valid IANA zone',
      });
    return nextScheduledRunAt(now, schedule, hour, timeZone);
  }

  private async authorizeExportScope(
    actorUserId: string,
    target: ReportExportScope,
    tx: PoolClient,
  ): Promise<string> {
    if (target.type === 'tenant') {
      const authorization = await this.access.requireTenant(
        actorUserId,
        target.id,
        'tenant.sales.read',
        tx,
      );
      return this.campusTimeZone(tx, authorization.campusId);
    }
    await this.access.requireCampus(
      actorUserId,
      target.id,
      'campus.transactions.read',
      tx,
    );
    return this.campusTimeZone(tx, target.id);
  }

  private async requireExportRead(
    actorUserId: string,
    target: ReportExportScope,
    tx: PoolClient,
  ): Promise<void> {
    if (target.type === 'tenant')
      await this.access.requireTenant(
        actorUserId,
        target.id,
        'tenant.sales.read',
        tx,
      );
    else
      await this.access.requireCampus(
        actorUserId,
        target.id,
        'campus.transactions.read',
        tx,
      );
  }

  private async campusTimeZone(
    tx: PoolClient,
    campusId: string,
  ): Promise<string> {
    const result = await tx.query<{ timezone: string }>(
      'select timezone from campuses where id = $1',
      [campusId],
    );
    const row = result.rows[0];
    if (!row)
      throw new NotFoundException({
        code: 'REPORT_SCOPE_NOT_FOUND',
        message: 'Report scope not found',
      });
    return row.timezone;
  }

  /**
   * The campus timezone of the export's scope. campuses own the only timezone:
   * tenants carry none, so a tenant export follows its campus.
   */
  private async scopeTimeZone(
    tx: PoolClient,
    target: ReportExportScope,
  ): Promise<string> {
    if (target.type === 'campus') return this.campusTimeZone(tx, target.id);
    const result = await tx.query<{ timezone: string }>(
      `select c.timezone
         from tenants t
         join campuses c on c.id = t.campus_id
        where t.id = $1`,
      [target.id],
    );
    const row = result.rows[0];
    if (!row)
      throw new NotFoundException({
        code: 'REPORT_SCOPE_NOT_FOUND',
        message: 'Report scope not found',
      });
    return row.timezone;
  }

  private renderExport(row: ReportExportRow): ReportExportView {
    const scope = exportScope(row);
    return {
      id: row.id,
      scope,
      kind: row.kind,
      format: row.format,
      from: row.range_from,
      to: row.range_to,
      schedule: row.schedule,
      scheduleHour: row.schedule_hour,
      status: row.status,
      mediaAssetId: row.media_asset_id,
      error: row.error,
      nextRunAt: row.next_run_at,
      generatedAt: row.generated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      downloadPath: exportDownloadPath(scope, row.format),
    };
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

/**
 * The kind must match the scope: a tenant route can only produce a sales
 * report and a campus route only the dashboard. The other combination would
 * schedule a report the creator cannot read.
 */
function normalizeExportKind(
  target: ReportExportScope,
  value: string,
): ReportExportKind {
  if (!(REPORT_EXPORT_KINDS as readonly string[]).includes(value))
    throw new BadRequestException({
      code: 'REPORT_EXPORT_KIND_INVALID',
      message: 'kind must be one of: ' + REPORT_EXPORT_KINDS.join(', '),
    });
  const expected = target.type === 'tenant' ? 'sales' : 'dashboard';
  if (value !== expected)
    throw new BadRequestException({
      code: 'REPORT_EXPORT_KIND_SCOPE_MISMATCH',
      message: 'A ' + target.type + ' export can only be of kind ' + expected,
    });
  return value as ReportExportKind;
}

function normalizeExportFormat(value: string): ReportExportFormat {
  if (!(REPORT_EXPORT_FORMATS as readonly string[]).includes(value))
    throw new BadRequestException({
      code: 'REPORT_EXPORT_FORMAT_INVALID',
      message: 'format must be one of: ' + REPORT_EXPORT_FORMATS.join(', '),
    });
  return value as ReportExportFormat;
}

/**
 * A schedule without an hour cannot be placed on the calendar, and an hour
 * with no schedule would be silently ignored: both are rejected instead of
 * guessed.
 */
function normalizeExportSchedule(
  schedule: string | undefined,
  hour: number | undefined,
): { schedule: ReportSchedule; scheduleHour: number | null } {
  const value = schedule ?? 'manual';
  if (!(REPORT_EXPORT_SCHEDULES as readonly string[]).includes(value))
    throw new BadRequestException({
      code: 'REPORT_EXPORT_SCHEDULE_INVALID',
      message: 'schedule must be one of: ' + REPORT_EXPORT_SCHEDULES.join(', '),
    });
  if (value === 'manual') {
    if (hour !== undefined)
      throw new BadRequestException({
        code: 'REPORT_EXPORT_SCHEDULE_HOUR_NOT_ALLOWED',
        message: 'scheduleHour is only accepted for a daily or weekly schedule',
      });
    return { schedule: 'manual', scheduleHour: null };
  }
  if (!isValidScheduleHour(hour))
    throw new BadRequestException({
      code: 'REPORT_EXPORT_SCHEDULE_HOUR_REQUIRED',
      message:
        'scheduleHour (0..23) is required for a daily or weekly schedule',
    });
  return { schedule: value as ReportSchedule, scheduleHour: hour };
}

/**
 * report_exports stores calendar dates, so an export window is day-granular.
 * The stored dates are what the response shows and what the worker regenerates,
 * which keeps the requested window and the regenerated window identical instead
 * of silently shifting it. A window shorter than a day cannot be represented and
 * is rejected.
 */
function normalizeExportWindow(range: { from: string; to: string }): {
  from: string;
  to: string;
} {
  const { from, to } = normalizeRange(range);
  const dayFrom = from.slice(0, 10);
  const dayTo = to.slice(0, 10);
  if (dayFrom >= dayTo)
    throw new BadRequestException({
      code: 'REPORT_EXPORT_RANGE_INVALID',
      message:
        'The export window is stored as calendar dates: from and to must cover at least one whole day',
    });
  return { from: dayFrom, to: dayTo };
}

/** Scope of a stored row; the CHECK constraint guarantees exactly one owner. */
function exportScope(row: ReportExportRow): ReportExportScope {
  if (row.tenant_id) return { type: 'tenant', id: row.tenant_id };
  if (row.campus_id) return { type: 'campus', id: row.campus_id };
  throw new Error('report_exports row has neither a tenant nor a campus');
}

/**
 * Where a client fetches the file. Nothing is stored, so this is the on-demand
 * route that renders the report from live data, not a stored artefact.
 */
function exportDownloadPath(
  scope: ReportExportScope,
  format: ReportExportFormat,
): string {
  const base =
    scope.type === 'tenant'
      ? '/api/v1/tenants/' + scope.id + '/reports/sales'
      : '/api/v1/campuses/' + scope.id + '/reports/dashboard';
  return base + '.' + format;
}

/** Stored calendar date -> the half-open [from, to) window of the report. */
function dayStart(value: string | null): string {
  if (!value) throw new RangeError('report_exports row has no stored window');
  return value + 'T00:00:00.000Z';
}

/** A render that produced nothing is a failure, not a ready export. */
function assertRendered(bytes: Buffer): void {
  if (bytes.length === 0)
    throw new Error('REPORT_EXPORT_GENERATION_FAILED: empty render');
}

/**
 * Stable code for report_exports.error. A permission denial becomes a fixed
 * code rather than the internal exception text, so the stored message does not
 * leak other scopes; anything else keeps its bounded message.
 */
function exportErrorMessage(error: unknown): string {
  const httpError = error as
    { status?: number; getResponse?: () => unknown } | undefined;
  if (httpError?.status === 403) return 'REPORT_EXPORT_SCOPE_REVOKED';
  const body =
    typeof httpError?.getResponse === 'function'
      ? (httpError.getResponse() as { code?: unknown } | undefined)
      : undefined;
  if (body && typeof body.code === 'string') return body.code.slice(0, 500);
  const message = error instanceof Error ? error.message : '';
  return (message.trim() || 'REPORT_EXPORT_GENERATION_FAILED').slice(0, 500);
}

function assertUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value ?? ''))
    throw new BadRequestException('Invalid ' + name + ' id');
}
