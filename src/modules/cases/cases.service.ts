import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService, uuidPattern } from '../notifications/outbox.service';
import { RefundsService, type RefundView } from '../refunds/refunds.service';
import { SettlementsService } from '../settlements/settlements.service';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const CASE_CATEGORIES = [
  'order_issue',
  'no_show',
  'quality',
  'payment',
  'schedule',
  'other',
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

export const CASE_STATUSES = [
  'reported',
  'under_review',
  'awaiting_information',
  'approved_cancel',
  'declined',
  'resolved',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

const TERMINAL_CASE_STATUSES: readonly CaseStatus[] = [
  'approved_cancel',
  'declined',
  'resolved',
];
const DECISION_TARGETS: readonly string[] = [
  'under_review',
  'awaiting_information',
  'approved_cancel',
  'declined',
  'resolved',
];

export type CaseView = {
  id: string;
  campusId: string;
  tenantId: string;
  orderId: string | null;
  buyerId: string | null;
  openedByUserId: string;
  category: CaseCategory;
  status: CaseStatus;
  subject: string;
  details: string;
  decisionReason: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CasePage = { items: CaseView[]; nextCursor: string | null };

export type OpenCaseInput = {
  category: string;
  subject: string;
  details?: string;
};

export type CaseDecisionInput = {
  status: string;
  reason: string;
};

export type CaseDecisionResult = {
  case: CaseView;
  refund: RefundView | null;
};

type CaseRow = {
  id: string;
  campus_id: string;
  tenant_id: string;
  order_id: string | null;
  buyer_id: string | null;
  opened_by_user_id: string;
  category: CaseCategory;
  status: CaseStatus;
  subject: string;
  details: string;
  decision_reason: string | null;
  decided_by_user_id: string | null;
  decided_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type Cursor = { createdAt: string; id: string };

/**
 * Response timestamps must be the DB microsecond UTC strings themselves (D7):
 * re-serializing through Date/toISOString truncates to milliseconds and would
 * break optimistic concurrency the moment a client echoes the value back.
 */
function microUtc(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${column}`;
}

const CASE_COLUMNS = [
  'id::text',
  'campus_id::text',
  'tenant_id::text',
  'order_id::text',
  'buyer_id::text',
  'opened_by_user_id::text',
  'category',
  'status',
  'subject',
  'details',
  'decision_reason',
  'decided_by_user_id::text',
  microUtc('decided_at'),
  'version',
  microUtc('created_at'),
  microUtc('updated_at'),
].join(', ');

/**
 * Operational cases: a human decision record about an order or tenant.
 * Opening a case never sanctions anyone and never moves money. Only a campus
 * manager with campus.cases.decide may transition status; only
 * 'approved_cancel' (which additionally requires campus.refunds.initiate and
 * a pre-handover order) creates a refund, through RefundsService in the SAME
 * transaction. Post-handover cases stay available for human review but the
 * cancellation path is rejected by the orders slice (no automatic refund).
 */
@Injectable()
export class CasesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly refunds: RefundsService,
    // Optional so hand-built constructions (tests, scripts) keep working; Nest
    // always injects it (forwardRef: settlements <-> cases).
    @Optional()
    @Inject(forwardRef(() => SettlementsService))
    private readonly settlements?: SettlementsService,
  ) {}

  /**
   * Buyer opens a case about their own order. The order scope is read with
   * FOR SHARE inside the SAME transaction that inserts the case (review F11):
   * a concurrent cancellation/refund decision cannot slip between the
   * ownership check and the insert, so a case is never written against a
   * scope that changed after it was validated.
   */
  async openBuyerCase(
    buyerId: string,
    orderId: string,
    input: OpenCaseInput,
  ): Promise<CaseView> {
    this.assertUuid(buyerId, 'user');
    this.assertUuid(orderId, 'order');
    return this.withTransaction(undefined, async (tx) => {
      const order = await this.loadOrderScope(orderId, tx);
      if (order.buyer_id !== buyerId)
        throw new NotFoundException('Order was not found');
      return this.insertCase(tx, {
        campusId: order.campus_id,
        tenantId: order.tenant_id,
        orderId,
        buyerId: order.buyer_id,
        openedByUserId: buyerId,
        openedByRole: 'buyer',
        input,
      });
    });
  }

  /**
   * Tenant staff opens a case (tenant.incidents.report), order optional. The
   * permission check, the order scope read (FOR SHARE) and the insert share
   * one transaction (review F11).
   */
  async openTenantCase(
    actorUserId: string,
    tenantId: string,
    input: OpenCaseInput & { orderId?: string | null },
  ): Promise<CaseView> {
    this.assertUuid(actorUserId, 'user');
    this.assertUuid(tenantId, 'tenant');
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.incidents.report',
        tx,
      );
      const campusId = await this.loadTenantCampus(tenantId, tx);
      let orderId: string | null = null;
      let buyerId: string | null = null;
      if (input.orderId != null) {
        this.assertUuid(input.orderId, 'order');
        const order = await this.loadOrderScope(input.orderId, tx);
        if (order.tenant_id !== tenantId)
          throw new NotFoundException('Order was not found for this tenant');
        orderId = input.orderId;
        buyerId = order.buyer_id;
      }
      return this.insertCase(tx, {
        campusId,
        tenantId,
        orderId,
        buyerId,
        openedByUserId: actorUserId,
        openedByRole: 'tenant',
        input,
      });
    });
  }

  /**
   * Campus staff opens a case (campus.cases.read), order optional. The
   * permission check, the order scope read (FOR SHARE) and the insert share
   * one transaction (review F11).
   */
  async openCampusCase(
    actorUserId: string,
    campusId: string,
    input: OpenCaseInput & { tenantId: string; orderId?: string | null },
  ): Promise<CaseView> {
    this.assertUuid(actorUserId, 'user');
    this.assertUuid(campusId, 'campus');
    this.assertUuid(input.tenantId, 'tenant');
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.cases.read',
        tx,
      );
      const tenantCampus = await this.loadTenantCampus(input.tenantId, tx);
      if (tenantCampus !== campusId)
        throw new NotFoundException('Tenant was not found for this campus');
      let orderId: string | null = null;
      let buyerId: string | null = null;
      if (input.orderId != null) {
        this.assertUuid(input.orderId, 'order');
        const order = await this.loadOrderScope(input.orderId, tx);
        if (order.tenant_id !== input.tenantId)
          throw new NotFoundException('Order was not found for this tenant');
        orderId = input.orderId;
        buyerId = order.buyer_id;
      }
      return this.insertCase(tx, {
        campusId,
        tenantId: input.tenantId,
        orderId,
        buyerId,
        openedByUserId: actorUserId,
        openedByRole: 'campus',
        input,
      });
    });
  }

  /**
   * Campus-manager status transition. Terminal decisions require a reason,
   * write audit and notify; 'approved_cancel' additionally requires
   * campus.refunds.initiate, an order-linked case, and cancels the order +
   * creates the pending refund in the SAME transaction (a completed order
   * rejects with 409 and the case stays untouched).
   */
  async decideCase(
    actorUserId: string,
    campusId: string,
    caseId: string,
    input: CaseDecisionInput,
  ): Promise<CaseDecisionResult> {
    this.assertUuid(actorUserId, 'user');
    this.assertUuid(campusId, 'campus');
    this.assertUuid(caseId, 'case');
    if (!DECISION_TARGETS.includes(input.status ?? ''))
      throw new BadRequestException({
        code: 'CASE_STATUS_INVALID',
        message: 'status must be one of: ' + DECISION_TARGETS.join(', '),
      });
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 500)
      throw new BadRequestException({
        code: 'CASE_REASON_REQUIRED',
        message: 'A decision reason of 1 to 500 characters is required',
      });
    const target = input.status as CaseStatus;

    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.cases.decide',
        tx,
      );
      const locked = await tx.query<CaseRow>(
        'select ' +
          CASE_COLUMNS +
          ' from cases where id = $1 and campus_id = $2 for update',
        [caseId, campusId],
      );
      const current = locked.rows[0];
      if (!current) throw new NotFoundException('Case was not found');
      if (TERMINAL_CASE_STATUSES.includes(current.status))
        throw new ConflictException({
          code: 'CASE_ALREADY_DECIDED',
          message:
            'Case is already ' +
            current.status +
            ' and cannot be decided again',
        });

      let refund: RefundView | null = null;
      if (target === 'approved_cancel') {
        if (!current.order_id)
          throw new BadRequestException({
            code: 'CASE_ORDER_REQUIRED',
            message: 'Only a case linked to an order can approve cancellation',
          });
        await this.access.requireCampus(
          actorUserId,
          campusId,
          'campus.refunds.initiate',
          tx,
        );
        // Same transaction: cancels the order (orders slice is the single
        // writer), releases the reservation, and creates the pending refund.
        // A post-handover order rejects with 409 and NOTHING changes here.
        refund = await this.refunds.initiateCancellationRefund(
          {
            actorUserId,
            campusId,
            orderId: current.order_id,
            reason,
            caseId,
          },
          tx,
        );
      }

      const isTerminal = TERMINAL_CASE_STATUSES.includes(target);
      const updated = await tx.query<CaseRow>(
        `update cases
            set status = $2,
                decision_reason = case when $3 then $4::varchar else null end,
                decided_by_user_id = case when $3 then $5::uuid else null end,
                decided_at = case when $3 then now() else null end,
                version = version + 1,
                updated_at = now()
          where id = $1 and version = $6
          returning ` + CASE_COLUMNS,
        [caseId, target, isTerminal, reason, actorUserId, current.version],
      );
      if (updated.rowCount !== 1)
        throw new ConflictException({
          code: 'CASE_STATE_CONFLICT',
          message: 'Case changed concurrently; reload and retry',
        });

      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'campus',
        scopeId: campusId,
        action: isTerminal
          ? 'campus.cases.decided'
          : 'campus.cases.status_changed',
        targetType: 'case',
        targetId: caseId,
        reason,
        metadata: {
          from: current.status,
          to: target,
          ...(refund ? { refundId: refund.id, orderId: refund.orderId } : {}),
        },
      });
      if (isTerminal) {
        const recipients = [
          ...new Set(
            [current.opened_by_user_id, current.buyer_id].filter(
              (id): id is string => typeof id === 'string',
            ),
          ),
        ];
        await this.outbox.append(tx, {
          eventKey: 'case:' + caseId + ':' + target,
          eventType: 'case.decided',
          aggregateType: 'case',
          aggregateId: caseId,
          recipientIds: recipients,
        });
      }

      // D18 Q2b: a terminal, NON-cancelling decision is also a release trigger.
      // The order is only released when it is completed and no case is still
      // open; the settlements slice contains its own failure with a savepoint,
      // so a release problem can never roll back the human decision.
      if (
        isTerminal &&
        target !== 'approved_cancel' &&
        current.order_id &&
        this.settlements
      ) {
        try {
          await this.settlements.releaseAfterCaseDecision(
            tx,
            current.tenant_id,
            current.order_id,
            actorUserId,
          );
        } catch {
          // Never fail a valid decision because money could not be released;
          // the payable stays in escrow for a retry/manual release.
        }
      }
      return { case: this.toView(updated.rows[0]), refund };
    });
  }

  // ---------------------------------------------------------------------------
  // Contract for the settlements slice (wave 3)
  // ---------------------------------------------------------------------------

  /**
   * True when the order still has an operational case that blocks a release
   * (reported / under_review / awaiting_information - docs/design section 6).
   *
   * The matching rows are locked FOR SHARE inside the caller's transaction, so
   * a release cannot commit in parallel with a decision that would reopen or
   * close a case (write-skew guard, R3). Cases are the single writer of this
   * table (D4): settlements only asks.
   */
  async hasOpenCasesForOrder(
    client: PoolClient,
    tenantId: string,
    orderId: string,
  ): Promise<boolean> {
    this.assertUuid(tenantId, 'tenant');
    this.assertUuid(orderId, 'order');
    const result = await client.query<{ id: string }>(
      `select id::text from cases
        where tenant_id = $1 and order_id = $2
          and status in ('reported', 'under_review', 'awaiting_information')
        for share`,
      [tenantId, orderId],
    );
    return result.rows.length > 0;
  }

  async listCampusCases(
    actorUserId: string,
    campusId: string,
    options: { status?: string; cursor?: string; limit?: number } = {},
  ): Promise<CasePage> {
    this.assertUuid(campusId, 'campus');
    await this.access.requireCampus(actorUserId, campusId, 'campus.cases.read');
    return this.listScoped('campus_id = $1', campusId, options);
  }

  async getCampusCase(
    actorUserId: string,
    campusId: string,
    caseId: string,
  ): Promise<CaseView> {
    this.assertUuid(campusId, 'campus');
    this.assertUuid(caseId, 'case');
    await this.access.requireCampus(actorUserId, campusId, 'campus.cases.read');
    return this.getScoped('campus_id', campusId, caseId);
  }

  async listTenantCases(
    actorUserId: string,
    tenantId: string,
    options: { status?: string; cursor?: string; limit?: number } = {},
  ): Promise<CasePage> {
    this.assertUuid(tenantId, 'tenant');
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      'tenant.orders.read',
    );
    return this.listScoped('tenant_id = $1', tenantId, options);
  }

  async getTenantCase(
    actorUserId: string,
    tenantId: string,
    caseId: string,
  ): Promise<CaseView> {
    this.assertUuid(tenantId, 'tenant');
    this.assertUuid(caseId, 'case');
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      'tenant.orders.read',
    );
    return this.getScoped('tenant_id', tenantId, caseId);
  }

  async listBuyerCases(
    userId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<CasePage> {
    this.assertUuid(userId, 'user');
    return this.listScoped(
      '(buyer_id = $1 or opened_by_user_id = $1)',
      userId,
      options,
    );
  }

  async getBuyerCase(userId: string, caseId: string): Promise<CaseView> {
    this.assertUuid(userId, 'user');
    this.assertUuid(caseId, 'case');
    const result = await this.database.pool.query<CaseRow>(
      'select ' +
        CASE_COLUMNS +
        ' from cases where id = $1 and (buyer_id = $2 or opened_by_user_id = $2)',
      [caseId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Case was not found');
    return this.toView(row);
  }

  /** Inserts the case, its audit row and its notification in the caller's transaction. */
  private async insertCase(
    tx: PoolClient,
    data: {
      campusId: string;
      tenantId: string;
      orderId: string | null;
      buyerId: string | null;
      openedByUserId: string;
      openedByRole: 'buyer' | 'tenant' | 'campus';
      input: OpenCaseInput;
    },
  ): Promise<CaseView> {
    const category = data.input.category as CaseCategory;
    if (!CASE_CATEGORIES.includes(category))
      throw new BadRequestException({
        code: 'CASE_CATEGORY_INVALID',
        message: 'category must be one of: ' + CASE_CATEGORIES.join(', '),
      });
    const subject =
      typeof data.input.subject === 'string' ? data.input.subject.trim() : '';
    if (!subject || subject.length > 200)
      throw new BadRequestException({
        code: 'CASE_SUBJECT_INVALID',
        message: 'subject must be 1 to 200 characters',
      });
    const details =
      typeof data.input.details === 'string' ? data.input.details.trim() : '';
    if (details.length > 4000)
      throw new BadRequestException({
        code: 'CASE_DETAILS_TOO_LONG',
        message: 'details must be at most 4000 characters',
      });
    const inserted = await tx.query<CaseRow>(
      `insert into cases
         (campus_id, tenant_id, order_id, buyer_id, opened_by_user_id,
          category, status, subject, details, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'reported', $7, $8, 1, now(), now())
       returning ` + CASE_COLUMNS,
      [
        data.campusId,
        data.tenantId,
        data.orderId,
        data.buyerId,
        data.openedByUserId,
        category,
        subject,
        details,
      ],
    );
    const row = inserted.rows[0];
    await this.audit.append(tx, {
      actor: { userId: data.openedByUserId },
      scopeType: 'campus',
      scopeId: data.campusId,
      action: 'campus.cases.reported',
      targetType: 'case',
      targetId: row.id,
      reason: subject,
      metadata: {
        category,
        openedByRole: data.openedByRole,
        tenantId: data.tenantId,
        ...(data.orderId ? { orderId: data.orderId } : {}),
      },
    });
    // Recipients are computed server-side: campus staff allowed to see cases.
    const staff = await tx.query<{ user_id: string }>(
      `select user_id::text from campus_memberships
        where campus_id = $1 and status = 'active'
          and permissions && array['campus.cases.read', 'campus.cases.decide']::text[]`,
      [data.campusId],
    );
    await this.outbox.append(tx, {
      eventKey: 'case:' + row.id + ':reported',
      eventType: 'case.reported',
      aggregateType: 'case',
      aggregateId: row.id,
      recipientIds: staff.rows.map((r) => r.user_id),
    });
    return this.toView(row);
  }

  private async listScoped(
    scopePredicate: string,
    scopeId: string,
    options: { status?: string; cursor?: string; limit?: number },
  ): Promise<CasePage> {
    const limit = normalizeLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    if (options.status !== undefined && !isCaseStatus(options.status))
      throw new BadRequestException('Invalid case status filter');
    const values: unknown[] = [scopeId];
    let where = scopePredicate;
    if (options.status !== undefined) {
      values.push(options.status);
      where += ' and status = $' + String(values.length);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      where +=
        ' and (created_at, id) < ($' +
        String(values.length - 1) +
        '::timestamptz, $' +
        String(values.length) +
        '::uuid)';
    }
    values.push(limit + 1);
    const result = await this.database.pool.query<CaseRow>(
      `select ${CASE_COLUMNS}
         from cases c
        where ${where}
        order by c.created_at desc, c.id desc
        limit $${values.length}`,
      values,
    );
    const rows = result.rows as unknown as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.toView(row as unknown as CaseRow)),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              createdAt: String(last.created_at),
              id: String(last.id),
            })
          : null,
    };
  }

  private async getScoped(
    column: 'campus_id' | 'tenant_id',
    scopeId: string,
    caseId: string,
  ): Promise<CaseView> {
    const result = await this.database.pool.query<CaseRow>(
      'select ' +
        CASE_COLUMNS +
        ' from cases where id = $1 and ' +
        column +
        ' = $2',
      [caseId, scopeId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Case was not found');
    return this.toView(row);
  }

  /**
   * Reads the order's ownership scope INSIDE the caller's transaction and
   * takes FOR SHARE on the order row, so a concurrent cancellation/refund
   * decision (which takes FOR UPDATE on the same row) cannot commit between
   * this read and the case insert (review F11).
   */
  private async loadOrderScope(
    orderId: string,
    client: Pick<PoolClient, 'query'>,
  ): Promise<{
    buyer_id: string;
    tenant_id: string;
    campus_id: string;
  }> {
    const result = await client.query<{
      buyer_id: string;
      tenant_id: string;
      campus_id: string;
    }>(
      `select o.buyer_id::text, o.tenant_id::text, t.campus_id::text
         from orders o
         join tenants t on t.id = o.tenant_id
        where o.id = $1
        for share of o`,
      [orderId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Order was not found');
    return row;
  }

  private async loadTenantCampus(
    tenantId: string,
    client: Pick<PoolClient, 'query'>,
  ): Promise<string> {
    const result = await client.query<{ campus_id: string }>(
      'select campus_id::text from tenants where id = $1',
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Tenant was not found');
    return row.campus_id;
  }

  private toView(row: CaseRow): CaseView {
    return {
      id: row.id,
      campusId: row.campus_id,
      tenantId: row.tenant_id,
      orderId: row.order_id,
      buyerId: row.buyer_id,
      openedByUserId: row.opened_by_user_id,
      category: row.category,
      status: row.status,
      subject: row.subject,
      details: row.details,
      decisionReason: row.decision_reason,
      decidedByUserId: row.decided_by_user_id,
      decidedAt: row.decided_at,
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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

  private assertUuid(value: string, name: string): void {
    if (!uuidPattern.test(value ?? ''))
      throw new BadRequestException('Invalid ' + name + ' id');
  }
}

function isCaseStatus(value: string): value is CaseStatus {
  return (CASE_STATUSES as readonly string[]).includes(value);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT)
    throw new BadRequestException(
      'limit must be an integer from 1 to ' + String(MAX_LIMIT),
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
    throw new BadRequestException('Invalid case list cursor');
  }
}
