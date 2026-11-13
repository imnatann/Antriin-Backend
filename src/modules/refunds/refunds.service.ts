import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService, uuidPattern } from '../notifications/outbox.service';
import { OrdersService } from '../orders/orders.service';
import { WalletService } from '../wallet/wallet.service';
import {
  PermanentRefundRequestError,
  REFUNDS_PROVIDER_ADAPTER,
  type RefundProviderAdapter,
} from './refund.adapter';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const BACKOFF_BASE_SECONDS = 5;
const BACKOFF_MAX_SECONDS = 300;

/** Hard cap for provider submission attempts before human assistance. */
export const MAX_REFUND_REQUEST_ATTEMPTS = 5;

/** System ledger account holding captured order funds (D16.1). */
export const ORDER_PAYMENT_ESCROW_ACCOUNT = 'orders.payment.escrow';
export const REFUNDS_QUEUE_JOB_NAME = 'request';

export type RefundStatus =
  | 'requested'
  | 'under_review'
  | 'submitted'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'needs_assistance';

export type RefundView = {
  id: string;
  campusId: string;
  tenantId: string;
  orderId: string;
  orderPaymentId: string | null;
  caseId: string | null;
  buyerId: string;
  amountMinor: string;
  currency: string;
  status: RefundStatus;
  provider: string;
  providerReference: string | null;
  reason: string;
  requestedAt: string;
  submittedAt: string | null;
  succeededAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  attemptCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type RefundPage = {
  items: RefundView[];
  nextCursor: string | null;
};

export type RefundRequestProcessResult =
  | { outcome: 'succeeded'; refundId: string; attempts: number }
  | { outcome: 'failed'; refundId: string; attempts: number; errorCode: string }
  | {
      outcome: 'deferred';
      refundId: string;
      attempts: number;
      retryAfterSeconds: number;
    }
  | {
      outcome: 'needs_assistance';
      refundId: string;
      attempts: number;
      errorCode: string;
    }
  | { outcome: 'duplicate'; refundId: string }
  | {
      outcome: 'skipped';
      reason:
        | 'unknown'
        | 'not_due'
        | 'leased'
        | 'done'
        | 'dead'
        | 'lease_lost'
        | 'settled';
    };

export type InitiateRefundInput = {
  actorUserId: string;
  campusId: string;
  orderId: string;
  reason: string;
  caseId?: string | null;
};

export type RefundRow = {
  id: string;
  campus_id: string;
  tenant_id: string;
  order_id: string;
  order_payment_id: string | null;
  case_id: string | null;
  buyer_id: string;
  amount_minor: string;
  currency: string;
  status: RefundStatus;
  provider: string;
  provider_reference: string | null;
  reason: string;
  requested_at: string;
  submitted_at: string | null;
  succeeded_at: string | null;
  failed_at: string | null;
  last_error: string | null;
  attempt_count: number;
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

export const REFUND_COLUMNS = [
  'id::text',
  'campus_id::text',
  'tenant_id::text',
  'order_id::text',
  'order_payment_id::text',
  'case_id::text',
  'buyer_id::text',
  'amount_minor::text',
  'currency',
  'status',
  'provider',
  'provider_reference',
  'reason',
  microUtc('requested_at'),
  microUtc('submitted_at'),
  microUtc('succeeded_at'),
  microUtc('failed_at'),
  'last_error',
  'attempt_count',
  'version',
  microUtc('created_at'),
  microUtc('updated_at'),
].join(', ');

export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === '23505' &&
    (constraint === undefined ||
      (error as { constraint?: string }).constraint === constraint)
  );
}

/**
 * Refund business rules for the pilot: a single FULL refund per order,
 * initiated only by an authorized campus manager decision that cancels the
 * order (OrdersService.cancelForRefundDecision, same transaction), executed
 * by a processor-driven sandbox provider, and credited to the buyer wallet
 * EXACTLY ONCE via the double-entry ledger after confirmed provider success.
 * Partial refunds are rejected by design; the client never supplies amounts
 * or statuses.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly access: AccessService,
    private readonly orders: OrdersService,
    private readonly config: ConfigService,
    @Inject(REFUNDS_PROVIDER_ADAPTER)
    private readonly adapter: RefundProviderAdapter,
  ) {}

  /** Effective mode; production is always treated as disabled. */
  providerMode(): 'disabled' | 'sandbox' {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'production')
      return 'disabled';
    return this.config.get<string>('REFUNDS_PROVIDER_MODE') === 'sandbox'
      ? 'sandbox'
      : 'disabled';
  }

  /**
   * Campus-manager cancellation decision -> refund pending. Runs in ONE
   * transaction: permission check (serialized on the transaction client),
   * campus/tenant scoping, order cancellation through the orders slice
   * (single writer, D4), full-amount refund row from order_payments, and the
   * provider-request outbox row. NO wallet credit happens here.
   */
  async initiateCancellationRefund(
    input: InitiateRefundInput,
    client?: PoolClient,
  ): Promise<RefundView> {
    if (this.providerMode() !== 'sandbox')
      throw new ServiceUnavailableException({
        code: 'REFUNDS_PROVIDER_DISABLED',
        message: 'Refunds are not available while the provider is disabled',
      });
    if (!uuidPattern.test(input.actorUserId ?? ''))
      throw new BadRequestException('Invalid actor id');
    if (!uuidPattern.test(input.campusId ?? ''))
      throw new BadRequestException('Invalid campus id');
    if (!uuidPattern.test(input.orderId ?? ''))
      throw new BadRequestException('Invalid order id');
    if (input.caseId != null && !uuidPattern.test(input.caseId))
      throw new BadRequestException('Invalid case id');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 500)
      throw new BadRequestException({
        code: 'REFUND_REASON_REQUIRED',
        message: 'A decision reason of 1 to 500 characters is required',
      });

    return this.withTransaction(client, async (tx) => {
      // Permission first, serialized on the transaction client so a
      // concurrent revoke cannot slip through (cross-slice contract).
      await this.access.requireCampus(
        input.actorUserId,
        input.campusId,
        'campus.refunds.initiate',
        tx,
      );
      // Campus scoping: the order's tenant must belong to this campus.
      // campus_id has no composite FK, so validate server-side; never trust
      // client-supplied campus/tenant relationships.
      const scoped = await tx.query<{ tenant_id: string; campus_id: string }>(
        `select o.tenant_id::text, t.campus_id::text
           from orders o
           join tenants t on t.id = o.tenant_id
          where o.id = $1`,
        [input.orderId],
      );
      const order = scoped.rows[0];
      if (!order || order.campus_id !== input.campusId)
        throw new NotFoundException('Order was not found for this campus');
      if (input.caseId != null) {
        const caseRow = await tx.query<{ id: string }>(
          `select id::text from cases
            where id = $1 and campus_id = $2 and tenant_id = $3
              and order_id = $4`,
          [input.caseId, input.campusId, order.tenant_id, input.orderId],
        );
        if (!caseRow.rows[0])
          throw new NotFoundException('Case was not found for this refund');
      }

      // Orders slice stays the single writer of orders/order_events; it locks
      // the order, cancels it, releases the reservation and records its
      // event/audit/outbox in THIS transaction. Money does not move here.
      const cancelled = await this.orders.cancelForRefundDecision(
        tx,
        input.orderId,
        input.actorUserId,
        reason,
      );

      // Full refund only: the amount comes from the captured payment row,
      // never from client input.
      const payment = await tx.query<{
        amount_minor: string;
        currency: string;
      }>(
        `select amount_minor::text, currency from order_payments
          where id = $1 and order_id = $2 and status = 'succeeded'`,
        [cancelled.orderPaymentId, input.orderId],
      );
      const captured = payment.rows[0];
      if (!captured)
        throw new ConflictException({
          code: 'ORDER_PAYMENT_NOT_REFUNDABLE',
          message: 'Order has no successful payment that could be refunded',
        });
      if (captured.currency !== 'IDR')
        throw new ConflictException({
          code: 'REFUND_CURRENCY_UNSUPPORTED',
          message: 'Only IDR refunds are supported in the pilot',
        });

      let refundId: string;
      try {
        const inserted = await tx.query<{ id: string }>(
          `insert into refunds
             (campus_id, tenant_id, order_id, order_payment_id, case_id,
              buyer_id, amount_minor, currency, status, provider, reason,
              requested_by_user_id, decided_by_user_id, requested_at,
              attempt_count, version, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'IDR', 'requested', 'sandbox',
                   $8, $9, $9, now(), 0, 1, now(), now())
           returning id::text`,
          [
            input.campusId,
            order.tenant_id,
            input.orderId,
            cancelled.orderPaymentId,
            input.caseId ?? null,
            cancelled.buyerId,
            captured.amount_minor,
            reason,
            input.actorUserId,
          ],
        );
        refundId = inserted.rows[0].id;
      } catch (error) {
        if (isUniqueViolation(error, 'refunds_one_per_order_uq'))
          throw new ConflictException({
            code: 'REFUND_ALREADY_EXISTS',
            message: 'This order already has a live or succeeded refund',
          });
        throw error;
      }
      await tx.query(
        `insert into refund_request_outbox
           (refund_id, status, attempts, next_attempt_at, created_at, updated_at)
         values ($1, 'pending', 0, now(), now(), now())`,
        [refundId],
      );
      await this.audit.append(tx, {
        actor: { userId: input.actorUserId },
        scopeType: 'campus',
        scopeId: input.campusId,
        action: 'campus.refunds.initiated',
        targetType: 'refund',
        targetId: refundId,
        reason,
        metadata: {
          orderId: input.orderId,
          amountMinor: captured.amount_minor,
          currency: 'IDR',
          provider: 'sandbox',
          ...(input.caseId ? { caseId: input.caseId } : {}),
        },
      });
      await this.outbox.append(tx, {
        eventKey: 'refund:' + refundId + ':requested',
        eventType: 'refund.status_changed',
        aggregateType: 'refund',
        aggregateId: refundId,
        recipientIds: [cancelled.buyerId],
      });
      return this.loadRefundView(tx, refundId);
    });
  }

  /** Buyer-scoped refund read for one of their orders (latest refund row). */
  async getRefundForOrder(
    buyerId: string,
    orderId: string,
  ): Promise<RefundView | null> {
    if (!uuidPattern.test(buyerId))
      throw new BadRequestException('Invalid user');
    if (!uuidPattern.test(orderId))
      throw new NotFoundException('Order was not found');
    const order = await this.database.pool.query<{ id: string }>(
      'select id::text from orders where id = $1 and buyer_id = $2',
      [orderId, buyerId],
    );
    if (!order.rows[0]) throw new NotFoundException('Order was not found');
    const result = await this.database.pool.query<RefundRow>(
      'select ' +
        REFUND_COLUMNS +
        ' from refunds where order_id = $1 order by created_at desc, id desc limit 1',
      [orderId],
    );
    return result.rows[0] ? this.toView(result.rows[0]) : null;
  }

  /** Campus-scoped refund list (campus.transactions.read). */
  async listCampusRefunds(
    actorUserId: string,
    campusId: string,
    options: { status?: string; cursor?: string; limit?: number } = {},
  ): Promise<RefundPage> {
    await this.access.requireCampus(
      actorUserId,
      campusId,
      'campus.transactions.read',
    );
    const limit = normalizeLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    if (options.status !== undefined && !isRefundStatus(options.status))
      throw new BadRequestException('Invalid refund status filter');
    const values: unknown[] = [campusId];
    let where = 'campus_id = $1';
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
    const result = await this.database.pool.query<RefundRow>(
      `select ${REFUND_COLUMNS}
         from refunds r
        where ${where}
        order by r.created_at desc, r.id desc
        limit $${values.length}`,
      values,
    );
    const rows = result.rows as unknown as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.toView(row as unknown as RefundRow)),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              createdAt: String(last.created_at),
              id: String(last.id),
            })
          : null,
    };
  }

  async loadRefundView(
    client: PoolClient,
    refundId: string,
  ): Promise<RefundView> {
    const result = await client.query<RefundRow>(
      'select ' + REFUND_COLUMNS + ' from refunds where id = $1',
      [refundId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Refund was not found');
    return this.toView(row);
  }

  toView(row: RefundRow): RefundView {
    return {
      id: row.id,
      campusId: row.campus_id,
      tenantId: row.tenant_id,
      orderId: row.order_id,
      orderPaymentId: row.order_payment_id,
      caseId: row.case_id,
      buyerId: row.buyer_id,
      amountMinor: row.amount_minor,
      currency: row.currency,
      status: row.status,
      provider: row.provider,
      providerReference: row.provider_reference,
      reason: row.reason,
      requestedAt: row.requested_at,
      submittedAt: row.submitted_at,
      succeededAt: row.succeeded_at,
      failedAt: row.failed_at,
      lastError: row.last_error,
      attemptCount: Number(row.attempt_count),
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // -------------------------------------------------------------------------
  // Provider-request processing (processor-driven sandbox; no webhook)
  // -------------------------------------------------------------------------

  /**
   * Due rows for the dispatcher; includes processing rows whose lease
   * expired. `nonce` is updated_at in epoch microseconds so a dispatcher
   * jobId embedding it changes on every state cycle (payments review P2-01).
   */
  async listDueRefundRequests(limit = 20): Promise<
    {
      refundId: string;
      attempts: number;
      nonce: string;
      staleForSeconds: number;
    }[]
  > {
    const result = await this.database.pool.query<{
      refund_id: string;
      attempts: number;
      nonce: string;
      stale_for_seconds: number;
    }>(
      `select refund_id::text, attempts,
              floor(extract(epoch from updated_at) * 1000000)::bigint::text as nonce,
              floor(extract(epoch from (now() - updated_at)))::int as stale_for_seconds
         from refund_request_outbox
        where (status = 'pending' and next_attempt_at <= now())
           or (status = 'processing' and lease_until < now())
        order by next_attempt_at, id
        limit $1`,
      [Math.min(Math.max(Math.trunc(limit), 1), 100)],
    );
    return result.rows.map((row) => ({
      refundId: row.refund_id,
      attempts: Number(row.attempts),
      nonce: row.nonce,
      staleForSeconds: Number(row.stale_for_seconds),
    }));
  }

  /**
   * Leases one outbox row, calls the provider adapter OUTSIDE any
   * transaction or lock, then applies the deterministic outcome in a single
   * transaction guarded by (a) the refund row lock + status guard, (b) the
   * unique (provider, event_id) event dedupe, (c) ledger idempotency and the
   * unique refund reference, and (d) lease fencing on the outbox row. Money
   * moves ONLY on confirmed provider success and only once.
   */
  async processRefundRequest(
    refundId: string,
  ): Promise<RefundRequestProcessResult> {
    if (!uuidPattern.test(refundId))
      throw new BadRequestException('Invalid refund id');
    const leased = await this.database.pool.query<{ attempts: number }>(
      `update refund_request_outbox
          set status = 'processing',
              attempts = attempts + 1,
              lease_until = now() + interval '60 seconds',
              updated_at = now()
        where refund_id = $1
          and ((status = 'pending' and next_attempt_at <= now())
               or (status = 'processing' and lease_until < now()))
        returning attempts`,
      [refundId],
    );
    if (leased.rowCount === 0) {
      const current = await this.database.pool.query<{ status: string }>(
        'select status from refund_request_outbox where refund_id = $1',
        [refundId],
      );
      const status = current.rows[0]?.status;
      if (!status) return { outcome: 'skipped', reason: 'unknown' };
      if (status === 'done') return { outcome: 'skipped', reason: 'done' };
      if (status === 'dead') return { outcome: 'skipped', reason: 'dead' };
      if (status === 'processing')
        return { outcome: 'skipped', reason: 'leased' };
      return { outcome: 'skipped', reason: 'not_due' };
    }
    const attempts = Number(leased.rows[0].attempts);
    const refundResult = await this.database.pool.query<RefundRow>(
      'select ' + REFUND_COLUMNS + ' from refunds where id = $1',
      [refundId],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      await this.markOutboxDead(refundId, 'REFUND_NOT_FOUND');
      return { outcome: 'skipped', reason: 'unknown' };
    }
    if (refund.status === 'succeeded' || refund.status === 'failed') {
      await this.markOutboxDone(refundId, null);
      return { outcome: 'skipped', reason: 'settled' };
    }
    if (refund.status === 'needs_assistance') {
      await this.markOutboxDead(
        refundId,
        refund.last_error ?? 'NEEDS_ASSISTANCE',
      );
      return { outcome: 'skipped', reason: 'settled' };
    }
    const providerReference =
      refund.provider_reference ??
      this.adapter.buildProviderReference({
        refundId,
        orderId: refund.order_id,
        amountMinor: refund.amount_minor,
      });
    let submission;
    try {
      // No transaction or row lock is held during the provider call.
      submission = await this.adapter.submitRefund({
        refundId,
        providerReference,
        amountMinor: refund.amount_minor,
        currency: refund.currency,
        attempt: attempts,
      });
    } catch (error) {
      const code = providerErrorCode(error);
      if (
        error instanceof PermanentRefundRequestError ||
        attempts >= MAX_REFUND_REQUEST_ATTEMPTS
      ) {
        await this.markNeedsAssistance(refund, code);
        await this.markOutboxDead(refundId, code);
        return {
          outcome: 'needs_assistance',
          refundId,
          attempts,
          errorCode: code,
        };
      }
      const retryAfterSeconds = backoffSeconds(attempts);
      await this.deferOutbox(refundId, code, retryAfterSeconds);
      return { outcome: 'deferred', refundId, attempts, retryAfterSeconds };
    }
    switch (submission.status) {
      case 'succeeded':
        return this.applyRefundSuccess(
          refund,
          providerReference,
          submission.occurredAt,
          attempts,
        );
      case 'failed':
        return this.applyRefundFailure(
          refund,
          providerReference,
          submission.occurredAt,
          submission.errorCode ?? 'PROVIDER_REJECTED',
          attempts,
        );
      case 'pending':
        return this.applyRefundPending(refund, providerReference, attempts);
    }
  }

  private async applyRefundSuccess(
    refund: RefundRow,
    providerReference: string,
    occurredAt: Date,
    attempts: number,
  ): Promise<RefundRequestProcessResult> {
    try {
      const result = await this.withTransaction(undefined, async (tx) => {
        const locked = await tx.query<{
          status: RefundStatus;
          amount_minor: string;
          buyer_id: string;
          order_id: string;
          provider_reference: string | null;
          currency: string;
          id: string;
        }>(
          `select id::text, status, amount_minor::text, buyer_id::text,
                  order_id::text, provider_reference, currency
             from refunds where id = $1 for update`,
          [refund.id],
        );
        const current = locked.rows[0];
        if (!current) throw new NotFoundException('Refund was not found');
        if (current.status === 'succeeded')
          return { kind: 'duplicate' as const };
        if (
          current.status === 'failed' ||
          current.status === 'needs_assistance'
        )
          throw new ConflictException({
            code: 'REFUND_STATE_CONFLICT',
            message: 'Refund is terminal and cannot succeed anymore',
          });
        if (
          current.provider_reference !== null &&
          current.provider_reference !== providerReference
        )
          throw new ConflictException({
            code: 'REFUND_REFERENCE_CONFLICT',
            message: 'Provider reference does not match the stored refund',
          });
        // Event dedupe: a replayed provider result cannot apply twice.
        const eventRow = await tx.query(
          `insert into refund_provider_events
             (refund_id, provider, event_id, event_type, amount_minor, currency,
              provider_reference, occurred_at, received_at, processed_at)
           values ($1, 'sandbox', $2, 'refund.succeeded', $3, $4, $5, $6, now(), now())
           on conflict (provider, event_id) do nothing
           returning id::text`,
          [
            current.id,
            providerReference + ':refund.succeeded',
            current.amount_minor,
            current.currency,
            providerReference,
            occurredAt,
          ],
        );
        if (eventRow.rowCount === 0) return { kind: 'duplicate' as const };
        // Credit EXACTLY ONCE: escrow (D16.1) -> buyer wallet through the
        // double-entry ledger; idempotency key and unique reference derive
        // from the refund id.
        const escrow = await this.wallet.ensureSystemAccount(
          ORDER_PAYMENT_ESCROW_ACCOUNT,
          'IDR',
          tx,
        );
        const buyerWallet = await this.wallet.getOrCreateWallet(
          current.buyer_id,
          'IDR',
          tx,
        );
        const posted = await this.wallet.postTransfer(
          {
            idempotencyScope: 'refunds.sandbox.credit',
            idempotencyKey: current.id,
            reference: { namespace: 'refund', id: current.id },
            currency: 'IDR',
            amountMinor: current.amount_minor,
            debitAccountId: escrow.accountId,
            creditAccountId: buyerWallet.accountId,
            actor: { type: 'service', id: 'refunds-processor' },
            reason: 'Sandbox refund settled by confirmed provider success',
            metadata: { provider: 'sandbox', orderId: current.order_id },
          },
          tx,
        );
        const transition = await tx.query(
          `update refunds
              set status = 'succeeded',
                  succeeded_at = now(),
                  ledger_transaction_id = $2,
                  provider_reference = $3,
                  submitted_at = coalesce(submitted_at, now()),
                  last_error = null,
                  next_attempt_at = null,
                  attempt_count = $4,
                  version = version + 1,
                  updated_at = now()
            where id = $1
              and status in ('requested', 'under_review', 'submitted', 'processing')
              and succeeded_at is null
            returning id::text`,
          [current.id, posted.transactionId, providerReference, attempts],
        );
        if (transition.rowCount !== 1)
          throw new ConflictException({
            code: 'REFUND_STATE_CONFLICT',
            message: 'Refund changed concurrently; redeliver the request',
          });
        await this.audit.append(tx, {
          actor: { service: 'refunds-processor' },
          scopeType: 'user',
          scopeId: current.buyer_id,
          action: 'refund.succeeded',
          targetType: 'refund',
          targetId: current.id,
          reason: 'Sandbox provider confirmed refund success',
          metadata: {
            provider: 'sandbox',
            amountMinor: current.amount_minor,
            currency: 'IDR',
            orderId: current.order_id,
          },
        });
        await this.outbox.append(tx, {
          eventKey: 'refund:' + current.id + ':succeeded',
          eventType: 'refund.status_changed',
          aggregateType: 'refund',
          aggregateId: current.id,
          recipientIds: [current.buyer_id],
        });
        await this.fenceOutboxDone(tx, refund.id);
        return { kind: 'applied' as const };
      });
      if (result.kind === 'duplicate') {
        await this.markOutboxDone(refund.id, null);
        return { outcome: 'duplicate', refundId: refund.id };
      }
      return { outcome: 'succeeded', refundId: refund.id, attempts };
    } catch (error) {
      if (error instanceof ConflictException && isLeaseLost(error))
        return { outcome: 'skipped', reason: 'lease_lost' };
      return this.deferOrEscalate(refund, attempts, 'REFUND_APPLY_FAILED');
    }
  }

  private async applyRefundFailure(
    refund: RefundRow,
    providerReference: string,
    occurredAt: Date,
    errorCode: string,
    attempts: number,
  ): Promise<RefundRequestProcessResult> {
    try {
      const result = await this.withTransaction(undefined, async (tx) => {
        const locked = await tx.query<{
          status: RefundStatus;
          id: string;
          amount_minor: string;
          currency: string;
          buyer_id: string;
        }>(
          `select id::text, status, amount_minor::text, currency, buyer_id::text
             from refunds where id = $1 for update`,
          [refund.id],
        );
        const current = locked.rows[0];
        if (!current) throw new NotFoundException('Refund was not found');
        if (current.status === 'failed') return { kind: 'duplicate' as const };
        if (
          current.status === 'succeeded' ||
          current.status === 'needs_assistance'
        )
          throw new ConflictException({
            code: 'REFUND_STATE_CONFLICT',
            message: 'Refund is terminal; a late failure needs human review',
          });
        const eventRow = await tx.query(
          `insert into refund_provider_events
             (refund_id, provider, event_id, event_type, amount_minor, currency,
              provider_reference, occurred_at, received_at, processed_at)
           values ($1, 'sandbox', $2, 'refund.failed', $3, $4, $5, $6, now(), now())
           on conflict (provider, event_id) do nothing
           returning id::text`,
          [
            current.id,
            providerReference + ':refund.failed',
            current.amount_minor,
            current.currency,
            providerReference,
            occurredAt,
          ],
        );
        if (eventRow.rowCount === 0) return { kind: 'duplicate' as const };
        const transition = await tx.query(
          `update refunds
              set status = 'failed',
                  failed_at = now(),
                  last_error = $2,
                  provider_reference = $3,
                  submitted_at = coalesce(submitted_at, now()),
                  next_attempt_at = null,
                  attempt_count = $4,
                  version = version + 1,
                  updated_at = now()
            where id = $1
              and status in ('requested', 'under_review', 'submitted', 'processing')
              and failed_at is null
            returning id::text`,
          [current.id, errorCode.slice(0, 500), providerReference, attempts],
        );
        if (transition.rowCount !== 1)
          throw new ConflictException({
            code: 'REFUND_STATE_CONFLICT',
            message: 'Refund changed concurrently; redeliver the request',
          });
        await this.audit.append(tx, {
          actor: { service: 'refunds-processor' },
          scopeType: 'user',
          scopeId: current.buyer_id,
          action: 'refund.failed',
          targetType: 'refund',
          targetId: current.id,
          reason: 'Sandbox provider reported refund failure',
          metadata: { provider: 'sandbox', errorCode },
        });
        await this.outbox.append(tx, {
          eventKey: 'refund:' + current.id + ':failed',
          eventType: 'refund.status_changed',
          aggregateType: 'refund',
          aggregateId: current.id,
          recipientIds: [current.buyer_id],
        });
        await this.fenceOutboxDone(tx, refund.id);
        return { kind: 'applied' as const };
      });
      if (result.kind === 'duplicate') {
        await this.markOutboxDone(refund.id, null);
        return { outcome: 'duplicate', refundId: refund.id };
      }
      return { outcome: 'failed', refundId: refund.id, attempts, errorCode };
    } catch (error) {
      if (error instanceof ConflictException && isLeaseLost(error))
        return { outcome: 'skipped', reason: 'lease_lost' };
      return this.deferOrEscalate(refund, attempts, 'REFUND_APPLY_FAILED');
    }
  }

  private async applyRefundPending(
    refund: RefundRow,
    providerReference: string,
    attempts: number,
  ): Promise<RefundRequestProcessResult> {
    const retryAfterSeconds = backoffSeconds(attempts);
    if (attempts >= MAX_REFUND_REQUEST_ATTEMPTS) {
      await this.markNeedsAssistance(refund, 'PROVIDER_PENDING_TIMEOUT');
      await this.markOutboxDead(refund.id, 'PROVIDER_PENDING_TIMEOUT');
      return {
        outcome: 'needs_assistance',
        refundId: refund.id,
        attempts,
        errorCode: 'PROVIDER_PENDING_TIMEOUT',
      };
    }
    try {
      await this.withTransaction(undefined, async (tx) => {
        const locked = await tx.query<{
          status: RefundStatus;
          id: string;
          amount_minor: string;
          currency: string;
        }>(
          `select id::text, status, amount_minor::text, currency
             from refunds where id = $1 for update`,
          [refund.id],
        );
        const current = locked.rows[0];
        if (!current) throw new NotFoundException('Refund was not found');
        if (
          current.status === 'succeeded' ||
          current.status === 'failed' ||
          current.status === 'needs_assistance'
        )
          return;
        await tx.query(
          `insert into refund_provider_events
             (refund_id, provider, event_id, event_type, amount_minor, currency,
              provider_reference, occurred_at, received_at, processed_at)
           values ($1, 'sandbox', $2, 'refund.pending', $3, $4, $5, now(), now(), null)
           on conflict (provider, event_id) do nothing`,
          [
            current.id,
            providerReference + ':refund.pending:' + String(attempts),
            current.amount_minor,
            current.currency,
            providerReference,
          ],
        );
        await tx.query(
          `update refunds
              set status = 'processing',
                  provider_reference = coalesce(provider_reference, $2),
                  submitted_at = coalesce(submitted_at, now()),
                  last_error = 'PROVIDER_PENDING',
                  next_attempt_at = now() + make_interval(secs => $3::int),
                  attempt_count = $4,
                  version = version + 1,
                  updated_at = now()
            where id = $1
              and status in ('requested', 'under_review', 'submitted', 'processing')`,
          [current.id, providerReference, retryAfterSeconds, attempts],
        );
        await this.deferOutboxTx(
          tx,
          refund.id,
          'PROVIDER_PENDING',
          retryAfterSeconds,
        );
      });
      return {
        outcome: 'deferred',
        refundId: refund.id,
        attempts,
        retryAfterSeconds,
      };
    } catch (error) {
      if (error instanceof ConflictException && isLeaseLost(error))
        return { outcome: 'skipped', reason: 'lease_lost' };
      return this.deferOrEscalate(refund, attempts, 'REFUND_APPLY_FAILED');
    }
  }

  private async markNeedsAssistance(
    refund: RefundRow,
    errorCode: string,
  ): Promise<void> {
    await this.withTransaction(undefined, async (tx) => {
      const transition = await tx.query(
        `update refunds
            set status = 'needs_assistance',
                last_error = $2,
                next_attempt_at = null,
                version = version + 1,
                updated_at = now()
          where id = $1
            and status not in ('succeeded', 'failed', 'needs_assistance')
          returning buyer_id::text`,
        [refund.id, errorCode.slice(0, 500)],
      );
      if (transition.rowCount === 0) return;
      const buyerId = transition.rows[0].buyer_id as string;
      await this.audit.append(tx, {
        actor: { service: 'refunds-processor' },
        scopeType: 'user',
        scopeId: buyerId,
        action: 'refund.needs_assistance',
        targetType: 'refund',
        targetId: refund.id,
        reason: 'Refund provider outcome unresolved; human assistance required',
        metadata: { provider: 'sandbox', errorCode },
      });
      await this.outbox.append(tx, {
        eventKey: 'refund:' + refund.id + ':needs_assistance',
        eventType: 'refund.status_changed',
        aggregateType: 'refund',
        aggregateId: refund.id,
        recipientIds: [buyerId],
      });
    });
  }

  private async deferOrEscalate(
    refund: RefundRow,
    attempts: number,
    errorCode: string,
  ): Promise<RefundRequestProcessResult> {
    if (attempts >= MAX_REFUND_REQUEST_ATTEMPTS) {
      await this.markNeedsAssistance(refund, errorCode);
      await this.markOutboxDead(refund.id, errorCode);
      return {
        outcome: 'needs_assistance',
        refundId: refund.id,
        attempts,
        errorCode,
      };
    }
    const retryAfterSeconds = backoffSeconds(attempts);
    await this.deferOutbox(refund.id, errorCode, retryAfterSeconds);
    return {
      outcome: 'deferred',
      refundId: refund.id,
      attempts,
      retryAfterSeconds,
    };
  }

  /** Completes the outbox row under the active lease; throws when lost. */
  private async fenceOutboxDone(
    tx: PoolClient,
    refundId: string,
  ): Promise<void> {
    const fenced = await tx.query(
      `update refund_request_outbox
          set status = 'done',
              lease_until = null,
              last_error = null,
              processed_at = now(),
              updated_at = now()
        where refund_id = $1 and status = 'processing' and lease_until > now()
        returning id::text`,
      [refundId],
    );
    if (fenced.rowCount !== 1)
      throw new ConflictException({
        code: 'REFUND_LEASE_LOST',
        message: 'Outbox lease was lost; another worker owns this refund',
      });
  }

  private async markOutboxDone(
    refundId: string,
    lastError: string | null,
  ): Promise<void> {
    await this.database.pool.query(
      `update refund_request_outbox
          set status = 'done',
              lease_until = null,
              last_error = $2,
              processed_at = now(),
              updated_at = now()
        where refund_id = $1 and status in ('pending', 'processing')`,
      [refundId, lastError ? lastError.slice(0, 500) : null],
    );
  }

  private async markOutboxDead(
    refundId: string,
    lastError: string,
  ): Promise<void> {
    await this.database.pool.query(
      `update refund_request_outbox
          set status = 'dead',
              lease_until = null,
              last_error = $2,
              updated_at = now()
        where refund_id = $1 and status in ('pending', 'processing')`,
      [refundId, lastError.slice(0, 500)],
    );
  }

  private async deferOutbox(
    refundId: string,
    lastError: string,
    retryAfterSeconds: number,
  ): Promise<void> {
    const connection = await this.database.pool.connect();
    try {
      await this.deferOutboxTx(
        connection,
        refundId,
        lastError,
        retryAfterSeconds,
      );
    } finally {
      connection.release();
    }
  }

  private async deferOutboxTx(
    tx: Pick<PoolClient, 'query'>,
    refundId: string,
    lastError: string,
    retryAfterSeconds: number,
  ): Promise<void> {
    await tx.query(
      `update refund_request_outbox
          set status = 'pending',
              lease_until = null,
              last_error = $2,
              next_attempt_at = now() + make_interval(secs => $3::int),
              updated_at = now()
        where refund_id = $1 and status = 'processing' and lease_until > now()`,
      [refundId, lastError.slice(0, 500), retryAfterSeconds],
    );
  }
  async withTransaction<T>(
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

function isRefundStatus(value: string): value is RefundStatus {
  return [
    'requested',
    'under_review',
    'submitted',
    'processing',
    'succeeded',
    'failed',
    'needs_assistance',
  ].includes(value);
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
    throw new BadRequestException('Invalid refund list cursor');
  }
}

function providerErrorCode(error: unknown): string {
  if (error instanceof PermanentRefundRequestError) return error.code;
  return 'PROVIDER_REQUEST_FAILED';
}

function backoffSeconds(attempts: number): number {
  return Math.min(
    BACKOFF_BASE_SECONDS * 2 ** Math.max(attempts - 1, 0),
    BACKOFF_MAX_SECONDS,
  );
}

function isLeaseLost(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response: unknown }).response === 'object' &&
    (error as { response: { code?: unknown } }).response?.code ===
      'REFUND_LEASE_LOST'
  );
}
