import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService, uuidPattern } from '../notifications/outbox.service';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PAYOUT_CLEARING_SYSTEM_KEY,
  PAYOUT_HOLD_IDEMPOTENCY_SCOPE,
  PAYOUT_HOLD_REFERENCE_NAMESPACE,
  PAYOUT_RELEASE_IDEMPOTENCY_SCOPE,
  PAYOUT_RELEASE_REFERENCE_NAMESPACE,
  PAYOUT_SETTLE_IDEMPOTENCY_SCOPE,
  PAYOUT_SETTLE_REFERENCE_NAMESPACE,
  TENANT_PAYABLE_SYSTEM_KEY_PREFIX,
  TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX,
} from '../settlements/settlements.constants';
import { SettlementsService } from '../settlements/settlements.service';
import { WalletService } from '../wallet/wallet.service';
import { bankAccountKeys, decryptAccountNumber } from './bank-account.crypto';
import {
  MAX_PAYOUT_REQUEST_ATTEMPTS,
  MAX_REASON_LENGTH,
  PAYOUT_AUDIT_ACTIONS,
  PAYOUT_BACKOFF_BASE_SECONDS,
  PAYOUT_BACKOFF_MAX_SECONDS,
  PAYOUT_ERROR_CODES,
} from './payouts.constants';
import {
  PAYOUTS_PROVIDER_ADAPTER,
  PermanentPayoutRequestError,
  type PayoutProviderAdapter,
} from './payout.adapter';

/** D7: response timestamps are the DB microsecond UTC strings themselves. */
const SQL_TS = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const MONEY_PATTERN = /^[1-9][0-9]*$/;
const MAX_MINOR_DIGITS = 38;

type Cursor = { createdAt: string; id: string };

export type PayoutStatus =
  'requested' | 'processing' | 'succeeded' | 'failed' | 'cancelled';

export type PayoutView = {
  id: string;
  tenantId: string;
  bankAccountId: string;
  bankCode: string;
  accountNumberMasked: string;
  accountHolderName: string;
  amountMinor: string;
  currency: string;
  status: PayoutStatus;
  provider: string;
  providerReference: string | null;
  failureCode: string | null;
  lastError: string | null;
  requestedByUserId: string;
  requestedAt: string;
  processingAt: string | null;
  succeededAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PayoutEventView = {
  id: string;
  version: number;
  fromStatus: string | null;
  toStatus: string;
  actorUserId: string | null;
  actorService: string | null;
  reason: string;
  occurredAt: string;
};

export type PayoutAllocationView = {
  id: string;
  settlementId: string;
  amountMinor: string;
  createdAt: string;
};

export type PayoutDetail = {
  payout: PayoutView;
  events: PayoutEventView[];
  allocations: PayoutAllocationView[];
};

export type PayoutPage = { items: PayoutView[]; nextCursor: string | null };

export type RequestPayoutInput = {
  bankAccountId: string;
  amountMinor: string;
  idempotencyKey: string;
};

export type RequestPayoutResult = { payout: PayoutView; replayed: boolean };

export type PayoutRequestProcessResult =
  | { outcome: 'succeeded'; payoutId: string; attempts: number }
  | {
      outcome: 'failed';
      payoutId: string;
      attempts: number;
      errorCode: string;
    }
  | {
      outcome: 'deferred';
      payoutId: string;
      attempts: number;
      retryAfterSeconds: number;
    }
  | {
      outcome: 'needs_assistance';
      payoutId: string;
      attempts: number;
      errorCode: string;
    }
  | { outcome: 'duplicate'; payoutId: string }
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

type PayoutRow = {
  id: string;
  tenant_id: string;
  bank_account_id: string;
  bank_code: string;
  account_number_masked: string;
  account_holder_name: string;
  amount_minor: string;
  currency: string;
  status: PayoutStatus;
  provider: string;
  provider_reference: string | null;
  hold_ledger_transaction_id: string;
  settle_ledger_transaction_id: string | null;
  release_ledger_transaction_id: string | null;
  requested_by_user_id: string;
  requested_at: string;
  processing_at: string | null;
  succeeded_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  failure_code: string | null;
  last_error: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

const PAYOUT_COLUMNS = [
  'id::text',
  'tenant_id::text',
  'bank_account_id::text',
  'bank_code',
  'account_number_masked',
  'account_holder_name',
  'amount_minor::text',
  'currency',
  'status',
  'provider',
  'provider_reference',
  'hold_ledger_transaction_id::text',
  'settle_ledger_transaction_id::text',
  'release_ledger_transaction_id::text',
  'requested_by_user_id::text',
  `${SQL_TS('requested_at')} as requested_at`,
  `${SQL_TS('processing_at')} as processing_at`,
  `${SQL_TS('succeeded_at')} as succeeded_at`,
  `${SQL_TS('failed_at')} as failed_at`,
  `${SQL_TS('cancelled_at')} as cancelled_at`,
  'failure_code',
  'last_error',
  'version',
  `${SQL_TS('created_at')} as created_at`,
  `${SQL_TS('updated_at')} as updated_at`,
].join(', ');

/**
 * Payout lifecycle (docs/design/settlement-payout.md sections 3.2 and 4).
 *
 * request  : ONE transaction - owner permission, destination account check,
 *            payable FOR UPDATE + BigInt balance check, ledger hold
 *            (payable -> hold), payouts + payout_request_outbox +
 *            payout_events + audit.
 * process  : worker - lease the outbox row, move requested -> processing in its
 *            own transaction, call the provider adapter OUTSIDE any
 *            transaction/lock, then apply the outcome in one transaction.
 * settle   : hold -> payout.clearing, FIFO allocation to released settlements,
 *            status succeeded. Exactly once (payouts_ledger_legs_check, the
 *            conditional UPDATE, ledger idempotency and the provider-event
 *            dedupe).
 * release  : hold -> payable again on a definite failure or an owner
 *            cancellation. Exactly once.
 *
 * An ambiguous provider outcome never releases the hold: the payout stays
 * 'processing', the attempt is 'unknown' and a human reconciles it (D18 Q9,
 * R6). Funds never move inside the provider call.
 */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly wallet: WalletService,
    private readonly settlements: SettlementsService,
    private readonly config: ConfigService,
    @Inject(PAYOUTS_PROVIDER_ADAPTER)
    private readonly adapter: PayoutProviderAdapter,
  ) {}

  /** Effective mode; production is always treated as disabled (D18 Q10). */
  providerMode(): 'disabled' | 'sandbox' {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'production')
      return 'disabled';
    return this.config.get<string>('PAYOUTS_PROVIDER_MODE') === 'sandbox'
      ? 'sandbox'
      : 'disabled';
  }

  // -------------------------------------------------------------------------
  // Owner-facing operations
  // -------------------------------------------------------------------------

  /**
   * Requests a payout. The payout id is DERIVED from (tenantId, Idempotency-Key)
   * so an HTTP retry maps onto the same row: the second call returns the
   * existing payout (replayed) instead of holding the money twice, and the same
   * key with different input is rejected with PAYOUT_IDEMPOTENCY_REUSED.
   */
  async requestPayout(
    actorUserId: string,
    tenantId: string,
    input: RequestPayoutInput,
  ): Promise<RequestPayoutResult> {
    if (this.providerMode() !== 'sandbox')
      throw new ServiceUnavailableException({
        code: PAYOUT_ERROR_CODES.providerDisabled,
        message: 'Payouts are not available while the provider is disabled',
      });
    this.assertUuid(actorUserId, 'user id');
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(input.bankAccountId, 'bank account id');
    const amountMinor = normalizeMoney(input.amountMinor);
    const idempotencyKey = (input.idempotencyKey ?? '').trim();
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))
      throw new BadRequestException({
        code: PAYOUT_ERROR_CODES.idempotencyKeyInvalid,
        message: 'Idempotency-Key must be 8-200 characters: A-Z a-z 0-9 . _ :',
      });
    const payoutId = payoutIdFor(tenantId, idempotencyKey);

    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.payout.request',
        tx,
      );

      const existing = await tx.query<PayoutRow>(
        'select ' + PAYOUT_COLUMNS + ' from payouts where id = $1',
        [payoutId],
      );
      if (existing.rows[0])
        return this.replay(existing.rows[0], tenantId, input, amountMinor);

      // Destination account: another tenant's account is a 404, an unverified
      // or disabled account is a 409 (D18 Q4 - never pay an unproven account).
      const account = await tx.query<{
        id: string;
        bank_code: string;
        account_number_masked: string;
        account_holder_name: string;
        verification_status: string;
        status: string;
      }>(
        `select id::text, bank_code, account_number_masked,
                account_holder_name, verification_status, status
           from bank_accounts
          where id = $1 and tenant_id = $2
          for update`,
        [input.bankAccountId, tenantId],
      );
      const destination = account.rows[0];
      if (!destination)
        throw new NotFoundException('Bank account was not found');
      if (
        destination.status !== 'active' ||
        destination.verification_status !== 'verified'
      )
        throw new ConflictException({
          code: PAYOUT_ERROR_CODES.bankAccountUnverified,
          message:
            'Payouts require an active, verified bank account of this tenant',
        });

      const active = await tx.query<{ id: string }>(
        `select id::text from payouts
          where tenant_id = $1 and status in ('requested', 'processing')`,
        [tenantId],
      );
      if (active.rows[0])
        throw new ConflictException({
          code: PAYOUT_ERROR_CODES.activeExists,
          message: 'Another payout of this tenant is still active',
        });

      // Atomic funds check: lock the payable row, compare as BigInt (never
      // Number), then hold. The lock is taken before postTransfer so the
      // account locks inside it cannot upgrade this one.
      const payable = await this.wallet.lockSystemAccount(
        TENANT_PAYABLE_SYSTEM_KEY_PREFIX + tenantId,
        'IDR',
        tx,
      );
      if (BigInt(amountMinor) > BigInt(payable.balanceMinor))
        throw new ConflictException({
          code: PAYOUT_ERROR_CODES.amountExceedsAvailable,
          message: 'Requested amount exceeds the available tenant balance',
        });
      const hold = await this.wallet.ensureSystemAccount(
        TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + tenantId,
        'IDR',
        tx,
      );
      const posted = await this.wallet.postTransfer(
        {
          idempotencyScope: PAYOUT_HOLD_IDEMPOTENCY_SCOPE,
          idempotencyKey: payoutId,
          reference: {
            namespace: PAYOUT_HOLD_REFERENCE_NAMESPACE,
            id: payoutId,
          },
          currency: 'IDR',
          amountMinor,
          debitAccountId: payable.accountId,
          creditAccountId: hold.accountId,
          actor: { type: 'user', id: actorUserId },
          reason: 'Payout requested by the verified tenant owner',
          metadata: { payoutId, tenantId },
        },
        tx,
      );

      try {
        await tx.query(
          `insert into payouts
             (id, tenant_id, bank_account_id, bank_code, account_number_masked,
              account_holder_name, amount_minor, currency, status, provider,
              hold_ledger_transaction_id, requested_by_user_id, requested_at,
              version, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'IDR', 'requested', $8, $9, $10,
                   now(), 1, now(), now())`,
          [
            payoutId,
            tenantId,
            destination.id,
            destination.bank_code,
            destination.account_number_masked,
            destination.account_holder_name,
            amountMinor,
            this.adapter.provider,
            posted.transactionId,
            actorUserId,
          ],
        );
      } catch (error) {
        if (isUniqueViolation(error, 'payouts_one_active_per_tenant_uq'))
          throw new ConflictException({
            code: PAYOUT_ERROR_CODES.activeExists,
            message: 'Another payout of this tenant is still active',
          });
        if (isUniqueViolation(error, 'payouts_pkey')) {
          const raced = await tx.query<PayoutRow>(
            'select ' + PAYOUT_COLUMNS + ' from payouts where id = $1',
            [payoutId],
          );
          if (raced.rows[0])
            return this.replay(raced.rows[0], tenantId, input, amountMinor);
        }
        throw error;
      }

      await tx.query(
        `insert into payout_request_outbox
           (payout_id, status, attempts, next_attempt_at, created_at, updated_at)
         values ($1, 'pending', 0, now(), now(), now())`,
        [payoutId],
      );
      await this.appendEvent(tx, {
        payoutId,
        fromStatus: null,
        toStatus: 'requested',
        actorUserId,
        reason: 'Payout requested by the verified tenant owner',
        metadata: { amountMinor, bankAccountId: destination.id },
      });
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: PAYOUT_AUDIT_ACTIONS.payoutRequested,
        targetType: 'payout',
        targetId: payoutId,
        reason: 'Payout requested by the verified tenant owner',
        metadata: {
          amountMinor,
          currency: 'IDR',
          bankCode: destination.bank_code,
          accountNumberMasked: destination.account_number_masked,
        },
      });
      await this.outbox.append(tx, {
        eventKey: 'payout:' + payoutId + ':requested',
        eventType: 'payout.status_changed',
        aggregateType: 'payout',
        aggregateId: payoutId,
        recipientIds: [actorUserId],
      });
      return {
        payout: await this.loadView(tx, tenantId, payoutId),
        replayed: posted.replayed,
      };
    });
  }

  /**
   * Owner cancellation: only a payout that was never submitted to the provider
   * ('requested') may be cancelled (D18 Q9). The hold returns to payable
   * exactly once and the outbox row is closed so no worker can submit it.
   */
  async cancelPayout(
    actorUserId: string,
    tenantId: string,
    payoutId: string,
    reason?: string,
  ): Promise<PayoutView> {
    this.assertUuid(actorUserId, 'user id');
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(payoutId, 'payout id');
    const normalizedReason = normalizeReason(reason);
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.payout.request',
        tx,
      );
      const locked = await tx.query<{ status: PayoutStatus }>(
        `select status from payouts
          where id = $1 and tenant_id = $2 for update`,
        [payoutId, tenantId],
      );
      const current = locked.rows[0];
      if (!current) throw new NotFoundException('Payout was not found');
      if (current.status === 'cancelled')
        return this.loadView(tx, tenantId, payoutId);
      if (current.status !== 'requested')
        throw new ConflictException({
          code: PAYOUT_ERROR_CODES.stateConflict,
          message:
            'Only a requested payout can be cancelled; ' +
            current.status +
            ' cannot',
        });
      const hold = await this.wallet.ensureSystemAccount(
        TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + tenantId,
        'IDR',
        tx,
      );
      const payable = await this.wallet.lockSystemAccount(
        TENANT_PAYABLE_SYSTEM_KEY_PREFIX + tenantId,
        'IDR',
        tx,
      );
      const posted = await this.wallet.postTransfer(
        {
          idempotencyScope: PAYOUT_RELEASE_IDEMPOTENCY_SCOPE,
          idempotencyKey: payoutId,
          reference: {
            namespace: PAYOUT_RELEASE_REFERENCE_NAMESPACE,
            id: payoutId,
          },
          currency: 'IDR',
          amountMinor: await this.amountOf(tx, payoutId),
          debitAccountId: hold.accountId,
          creditAccountId: payable.accountId,
          actor: { type: 'user', id: actorUserId },
          reason: 'Payout cancelled by the verified tenant owner',
          metadata: { payoutId, tenantId },
        },
        tx,
      );
      const updated = await tx.query(
        `update payouts
            set status = 'cancelled',
                cancelled_at = now(),
                release_ledger_transaction_id = $3,
                version = version + 1,
                updated_at = now()
          where id = $1 and tenant_id = $2 and status = 'requested'`,
        [payoutId, tenantId, posted.transactionId],
      );
      if (updated.rowCount !== 1)
        throw new ConflictException({
          code: PAYOUT_ERROR_CODES.stateConflict,
          message: 'Payout changed concurrently; reload and retry',
        });
      await tx.query(
        `update payout_request_outbox
            set status = 'done', lease_until = null,
                last_error = 'PAYOUT_CANCELLED', processed_at = now(),
                updated_at = now()
          where payout_id = $1 and status in ('pending', 'processing')`,
        [payoutId],
      );
      await this.appendEvent(tx, {
        payoutId,
        fromStatus: 'requested',
        toStatus: 'cancelled',
        actorUserId,
        reason: normalizedReason,
        metadata: {},
      });
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: PAYOUT_AUDIT_ACTIONS.payoutCancelled,
        targetType: 'payout',
        targetId: payoutId,
        reason: normalizedReason,
        metadata: {},
      });
      await this.outbox.append(tx, {
        eventKey: 'payout:' + payoutId + ':cancelled',
        eventType: 'payout.status_changed',
        aggregateType: 'payout',
        aggregateId: payoutId,
        recipientIds: [actorUserId],
      });
      return this.loadView(tx, tenantId, payoutId);
    });
  }

  async listTenantPayouts(
    actorUserId: string,
    tenantId: string,
    options: { status?: string; cursor?: string; limit?: number } = {},
  ): Promise<PayoutPage> {
    this.assertUuid(actorUserId, 'user id');
    this.assertUuid(tenantId, 'tenant id');
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      'tenant.finance.read',
    );
    const limit = normalizeLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    if (options.status !== undefined && !isPayoutStatus(options.status))
      throw new BadRequestException('Invalid payout status filter');
    const values: unknown[] = [tenantId];
    let where = 'tenant_id = $1';
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
    const result = await this.database.pool.query<PayoutRow>(
      `select ${PAYOUT_COLUMNS},
              ${SQL_TS('created_at')} as cursor_created_at
         from payouts
        where ${where}
        order by created_at desc, id desc
        limit $${String(values.length)}`,
      values,
    );
    const rows = result.rows as unknown as (PayoutRow & {
      cursor_created_at: string;
    })[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toView(row)),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              createdAt: String(last.cursor_created_at),
              id: last.id,
            })
          : null,
    };
  }

  async getTenantPayout(
    actorUserId: string,
    tenantId: string,
    payoutId: string,
  ): Promise<PayoutDetail> {
    this.assertUuid(actorUserId, 'user id');
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(payoutId, 'payout id');
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      'tenant.finance.read',
    );
    return this.loadDetail(this.database.pool, tenantId, payoutId);
  }

  // -------------------------------------------------------------------------
  // Provider-request processing (processor-driven sandbox; no webhook)
  // -------------------------------------------------------------------------

  /**
   * Due rows for the dispatcher; includes processing rows whose lease expired.
   * `nonce` is updated_at in epoch microseconds so a dispatcher jobId changes
   * on every state cycle (payments review P2-01, D17).
   */
  async listDuePayoutRequests(limit = 20): Promise<
    {
      payoutId: string;
      attempts: number;
      nonce: string;
      staleForSeconds: number;
    }[]
  > {
    const result = await this.database.pool.query<{
      payout_id: string;
      attempts: number;
      nonce: string;
      stale_for_seconds: number;
    }>(
      `select payout_id::text, attempts,
              floor(extract(epoch from updated_at) * 1000000)::bigint::text as nonce,
              floor(extract(epoch from (now() - updated_at)))::int as stale_for_seconds
         from payout_request_outbox
        where (status = 'pending' and next_attempt_at <= now())
           or (status = 'processing' and lease_until < now())
        order by next_attempt_at, id
        limit $1`,
      [Math.min(Math.max(Math.trunc(limit), 1), 100)],
    );
    return result.rows.map((row) => ({
      payoutId: row.payout_id,
      attempts: Number(row.attempts),
      nonce: row.nonce,
      staleForSeconds: Number(row.stale_for_seconds),
    }));
  }

  /**
   * Leases one outbox row, calls the provider adapter OUTSIDE any transaction
   * or lock, then applies the deterministic outcome in one transaction. Money
   * moves only on a confirmed outcome and only once.
   */
  async processPayoutRequest(
    payoutId: string,
  ): Promise<PayoutRequestProcessResult> {
    if (!uuidPattern.test(payoutId))
      throw new BadRequestException('Invalid payout id');
    const leased = await this.database.pool.query<{ attempts: number }>(
      `update payout_request_outbox
          set status = 'processing',
              attempts = attempts + 1,
              lease_until = now() + interval '60 seconds',
              updated_at = now()
        where payout_id = $1
          and ((status = 'pending' and next_attempt_at <= now())
               or (status = 'processing' and lease_until < now()))
        returning attempts`,
      [payoutId],
    );
    if (leased.rowCount === 0) {
      const current = await this.database.pool.query<{ status: string }>(
        'select status from payout_request_outbox where payout_id = $1',
        [payoutId],
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

    const found = await this.database.pool.query<PayoutRow>(
      'select ' + PAYOUT_COLUMNS + ' from payouts where id = $1',
      [payoutId],
    );
    const payout = found.rows[0];
    if (!payout) {
      await this.markOutboxDead(payoutId, 'PAYOUT_NOT_FOUND');
      return { outcome: 'skipped', reason: 'unknown' };
    }
    if (isTerminal(payout.status)) {
      await this.markOutboxDone(payoutId, null);
      return { outcome: 'skipped', reason: 'settled' };
    }
    // requested -> processing happens in its own committed transaction BEFORE
    // the provider call, so an owner cancellation either wins (and nothing is
    // submitted) or is rejected with a state conflict.
    const transition = await this.markProcessing(payoutId);
    if (transition !== 'processing') {
      await this.markOutboxDone(payoutId, null);
      return { outcome: 'skipped', reason: 'settled' };
    }
    await this.database.pool.query(
      `insert into payout_attempts
         (payout_id, attempt_no, provider, status, started_at)
       values ($1, $2, $3, 'pending', now())`,
      [payoutId, attempts, payout.provider],
    );

    const providerReference =
      payout.provider_reference ??
      this.adapter.buildProviderReference({
        payoutId,
        amountMinor: payout.amount_minor,
      });
    let accountNumber: string;
    try {
      accountNumber = await this.loadAccountNumber(payout);
    } catch (error) {
      const code = providerErrorCode(error);
      await this.finishAttempt(payoutId, attempts, 'failed', null, code, code);
      const result = await this.applyPayoutFailure(
        payout,
        providerReference,
        new Date(),
        code,
        attempts,
      );
      return result;
    }

    let submission;
    try {
      // No transaction or row lock is held during the provider call.
      submission = await this.adapter.submitPayout({
        payoutId,
        providerReference,
        amountMinor: payout.amount_minor,
        currency: payout.currency,
        bankCode: payout.bank_code,
        accountHolderName: payout.account_holder_name,
        accountNumber,
        attempt: attempts,
      });
    } catch (error) {
      const code = providerErrorCode(error);
      if (
        error instanceof PermanentPayoutRequestError ||
        attempts >= MAX_PAYOUT_REQUEST_ATTEMPTS
      ) {
        if (error instanceof PermanentPayoutRequestError) {
          await this.finishAttempt(
            payoutId,
            attempts,
            'failed',
            providerReference,
            code,
            code,
          );
          return this.applyPayoutFailure(
            payout,
            providerReference,
            new Date(),
            code,
            attempts,
          );
        }
        // Transient error after the last attempt: the provider outcome is
        // ambiguous, so the hold is NOT released (D18 Q9 / R6).
        await this.finishAttempt(
          payoutId,
          attempts,
          'unknown',
          providerReference,
          code,
          code,
        );
        return this.markNeedsAssistance(payout, code, attempts);
      }
      await this.finishAttempt(
        payoutId,
        attempts,
        'unknown',
        providerReference,
        code,
        code,
      );
      const retryAfterSeconds = backoffSeconds(attempts);
      await this.deferOutbox(payoutId, code, retryAfterSeconds);
      return {
        outcome: 'deferred',
        payoutId,
        attempts,
        retryAfterSeconds,
      };
    }

    switch (submission.status) {
      case 'succeeded':
        await this.finishAttempt(
          payoutId,
          attempts,
          'succeeded',
          submission.providerReference,
          null,
          null,
        );
        return this.applyPayoutSuccess(
          payout,
          submission.providerReference,
          submission.occurredAt,
          attempts,
        );
      case 'failed':
        await this.finishAttempt(
          payoutId,
          attempts,
          'failed',
          submission.providerReference,
          submission.errorCode ?? 'PROVIDER_REJECTED',
          submission.errorCode ?? 'PROVIDER_REJECTED',
        );
        return this.applyPayoutFailure(
          payout,
          submission.providerReference,
          submission.occurredAt,
          submission.errorCode ?? 'PROVIDER_REJECTED',
          attempts,
        );
      case 'pending':
        await this.finishAttempt(
          payoutId,
          attempts,
          'unknown',
          submission.providerReference,
          'PROVIDER_PENDING',
          'PROVIDER_PENDING',
        );
        if (attempts >= MAX_PAYOUT_REQUEST_ATTEMPTS)
          return this.markNeedsAssistance(
            payout,
            'PROVIDER_PENDING_TIMEOUT',
            attempts,
          );
        {
          const retryAfterSeconds = backoffSeconds(attempts);
          await this.deferOutbox(
            payoutId,
            'PROVIDER_PENDING',
            retryAfterSeconds,
          );
          return {
            outcome: 'deferred',
            payoutId,
            attempts,
            retryAfterSeconds,
          };
        }
    }
  }

  /** requested -> processing in its own transaction plus a timeline row. */
  private async markProcessing(
    payoutId: string,
  ): Promise<'processing' | 'settled' | 'unknown'> {
    return this.withTransaction(undefined, async (tx) => {
      const locked = await tx.query<{ status: PayoutStatus }>(
        'select status from payouts where id = $1 for update',
        [payoutId],
      );
      const row = locked.rows[0];
      if (!row) return 'unknown';
      if (row.status === 'processing') return 'processing';
      if (row.status !== 'requested') return 'settled';
      const updated = await tx.query(
        `update payouts
            set status = 'processing', processing_at = now(),
                version = version + 1, updated_at = now()
          where id = $1 and status = 'requested'`,
        [payoutId],
      );
      if (updated.rowCount !== 1) return 'settled';
      await this.appendEvent(tx, {
        payoutId,
        fromStatus: 'requested',
        toStatus: 'processing',
        actorService: 'payouts-processor',
        reason: 'Provider submission started',
        metadata: {},
      });
      return 'processing';
    });
  }

  private async applyPayoutSuccess(
    payout: PayoutRow,
    providerReference: string,
    occurredAt: Date,
    attempts: number,
  ): Promise<PayoutRequestProcessResult> {
    try {
      const result = await this.withTransaction(undefined, async (tx) => {
        const locked = await tx.query<{
          status: PayoutStatus;
          amount_minor: string;
          currency: string;
          tenant_id: string;
          requested_by_user_id: string;
          provider: string;
        }>(
          `select status, amount_minor::text, currency, tenant_id::text,
                  requested_by_user_id::text, provider
             from payouts where id = $1 for update`,
          [payout.id],
        );
        const current = locked.rows[0];
        if (!current) throw new NotFoundException('Payout was not found');
        if (current.status === 'succeeded')
          return { kind: 'duplicate' as const };
        if (current.status !== 'processing')
          return { kind: 'mismatch' as const };
        const eventRow = await tx.query(
          `insert into payout_provider_events
             (payout_id, provider, event_id, event_type, amount_minor, currency,
              provider_reference, occurred_at, received_at, processed_at)
           values ($1, $2, $3, 'payout.succeeded', $4, $5, $6, $7, now(), now())
           on conflict (provider, event_id) do nothing
           returning id::text`,
          [
            payout.id,
            current.provider,
            providerReference + ':payout.succeeded',
            current.amount_minor,
            current.currency,
            providerReference,
            occurredAt,
          ],
        );
        if (eventRow.rowCount === 0) return { kind: 'duplicate' as const };

        const hold = await this.wallet.ensureSystemAccount(
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + current.tenant_id,
          'IDR',
          tx,
        );
        const clearing = await this.wallet.ensureSystemAccount(
          PAYOUT_CLEARING_SYSTEM_KEY,
          'IDR',
          tx,
        );
        const posted = await this.wallet.postTransfer(
          {
            idempotencyScope: PAYOUT_SETTLE_IDEMPOTENCY_SCOPE,
            idempotencyKey: payout.id,
            reference: {
              namespace: PAYOUT_SETTLE_REFERENCE_NAMESPACE,
              id: payout.id,
            },
            currency: 'IDR',
            amountMinor: current.amount_minor,
            debitAccountId: hold.accountId,
            creditAccountId: clearing.accountId,
            actor: { type: 'service', id: 'payouts-processor' },
            reason: 'Payout settled to the provider after confirmed success',
            metadata: { payoutId: payout.id, tenantId: current.tenant_id },
          },
          tx,
        );
        await this.allocateFifo(
          tx,
          current.tenant_id,
          payout.id,
          current.amount_minor,
        );
        const transition = await tx.query(
          `update payouts
              set status = 'succeeded',
                  succeeded_at = now(),
                  settle_ledger_transaction_id = $2,
                  provider_reference = $3,
                  failure_code = null,
                  last_error = null,
                  version = version + 1,
                  updated_at = now()
            where id = $1 and status = 'processing'
            returning id::text`,
          [payout.id, posted.transactionId, providerReference],
        );
        if (transition.rowCount !== 1)
          throw new ConflictException({
            code: PAYOUT_ERROR_CODES.stateConflict,
            message: 'Payout changed concurrently; redeliver the request',
          });
        await this.appendEvent(tx, {
          payoutId: payout.id,
          fromStatus: 'processing',
          toStatus: 'succeeded',
          actorService: 'payouts-processor',
          reason: 'Sandbox provider confirmed payout success',
          metadata: { provider: current.provider, providerReference },
        });
        await this.audit.append(tx, {
          actor: { service: 'payouts-processor' },
          scopeType: 'tenant',
          scopeId: current.tenant_id,
          action: PAYOUT_AUDIT_ACTIONS.payoutSucceeded,
          targetType: 'payout',
          targetId: payout.id,
          reason: 'Sandbox provider confirmed payout success',
          metadata: {
            provider: current.provider,
            amountMinor: current.amount_minor,
            currency: 'IDR',
            providerReference,
          },
        });
        await this.outbox.append(tx, {
          eventKey: 'payout:' + payout.id + ':succeeded',
          eventType: 'payout.status_changed',
          aggregateType: 'payout',
          aggregateId: payout.id,
          recipientIds: [current.requested_by_user_id],
        });
        await this.fenceOutboxDone(tx, payout.id);
        return { kind: 'applied' as const };
      });
      if (result.kind === 'duplicate') {
        await this.markOutboxDone(payout.id, null);
        return { outcome: 'duplicate', payoutId: payout.id };
      }
      if (result.kind === 'mismatch')
        return this.markNeedsAssistance(
          payout,
          'PAYOUT_STATE_CONFLICT',
          attempts,
        );
      return { outcome: 'succeeded', payoutId: payout.id, attempts };
    } catch (error) {
      if (error instanceof ConflictException && isLeaseLost(error))
        return { outcome: 'skipped', reason: 'lease_lost' };
      return this.deferOrEscalate(payout, attempts, 'PAYOUT_APPLY_FAILED');
    }
  }

  private async applyPayoutFailure(
    payout: PayoutRow,
    providerReference: string,
    occurredAt: Date,
    errorCode: string,
    attempts: number,
  ): Promise<PayoutRequestProcessResult> {
    try {
      const result = await this.withTransaction(undefined, async (tx) => {
        const locked = await tx.query<{
          status: PayoutStatus;
          amount_minor: string;
          currency: string;
          tenant_id: string;
          requested_by_user_id: string;
          provider: string;
        }>(
          `select status, amount_minor::text, currency, tenant_id::text,
                  requested_by_user_id::text, provider
             from payouts where id = $1 for update`,
          [payout.id],
        );
        const current = locked.rows[0];
        if (!current) throw new NotFoundException('Payout was not found');
        if (current.status === 'failed') return { kind: 'duplicate' as const };
        if (current.status !== 'processing')
          return { kind: 'mismatch' as const };
        const eventRow = await tx.query(
          `insert into payout_provider_events
             (payout_id, provider, event_id, event_type, amount_minor, currency,
              provider_reference, occurred_at, received_at, processed_at)
           values ($1, $2, $3, 'payout.failed', $4, $5, $6, $7, now(), now())
           on conflict (provider, event_id) do nothing
           returning id::text`,
          [
            payout.id,
            current.provider,
            providerReference + ':payout.failed',
            current.amount_minor,
            current.currency,
            providerReference,
            occurredAt,
          ],
        );
        if (eventRow.rowCount === 0) return { kind: 'duplicate' as const };

        const hold = await this.wallet.ensureSystemAccount(
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + current.tenant_id,
          'IDR',
          tx,
        );
        const payable = await this.wallet.lockSystemAccount(
          TENANT_PAYABLE_SYSTEM_KEY_PREFIX + current.tenant_id,
          'IDR',
          tx,
        );
        const posted = await this.wallet.postTransfer(
          {
            idempotencyScope: PAYOUT_RELEASE_IDEMPOTENCY_SCOPE,
            idempotencyKey: payout.id,
            reference: {
              namespace: PAYOUT_RELEASE_REFERENCE_NAMESPACE,
              id: payout.id,
            },
            currency: 'IDR',
            amountMinor: current.amount_minor,
            debitAccountId: hold.accountId,
            creditAccountId: payable.accountId,
            actor: { type: 'service', id: 'payouts-processor' },
            reason: 'Payout failed at the provider; hold released to payable',
            metadata: { payoutId: payout.id, tenantId: current.tenant_id },
          },
          tx,
        );
        const transition = await tx.query(
          `update payouts
              set status = 'failed',
                  failed_at = now(),
                  release_ledger_transaction_id = $2,
                  provider_reference = $3,
                  failure_code = $4,
                  last_error = $4,
                  version = version + 1,
                  updated_at = now()
            where id = $1 and status = 'processing'
            returning id::text`,
          [payout.id, posted.transactionId, providerReference, errorCode],
        );
        if (transition.rowCount !== 1)
          throw new ConflictException({
            code: PAYOUT_ERROR_CODES.stateConflict,
            message: 'Payout changed concurrently; redeliver the request',
          });
        await this.appendEvent(tx, {
          payoutId: payout.id,
          fromStatus: 'processing',
          toStatus: 'failed',
          actorService: 'payouts-processor',
          reason: 'Payout failed at the provider; the hold was released',
          metadata: { provider: current.provider, errorCode },
        });
        await this.audit.append(tx, {
          actor: { service: 'payouts-processor' },
          scopeType: 'tenant',
          scopeId: current.tenant_id,
          action: PAYOUT_AUDIT_ACTIONS.payoutFailed,
          targetType: 'payout',
          targetId: payout.id,
          reason: 'Payout failed at the provider; the hold was released',
          metadata: {
            provider: current.provider,
            errorCode,
            amountMinor: current.amount_minor,
            currency: 'IDR',
          },
        });
        await this.outbox.append(tx, {
          eventKey: 'payout:' + payout.id + ':failed',
          eventType: 'payout.status_changed',
          aggregateType: 'payout',
          aggregateId: payout.id,
          recipientIds: [current.requested_by_user_id],
        });
        await this.fenceOutboxDone(tx, payout.id);
        return { kind: 'applied' as const };
      });
      if (result.kind === 'duplicate') {
        await this.markOutboxDone(payout.id, null);
        return { outcome: 'duplicate', payoutId: payout.id };
      }
      if (result.kind === 'mismatch')
        return this.markNeedsAssistance(
          payout,
          'PAYOUT_STATE_CONFLICT',
          attempts,
        );
      return { outcome: 'failed', payoutId: payout.id, attempts, errorCode };
    } catch (error) {
      if (error instanceof ConflictException && isLeaseLost(error))
        return { outcome: 'skipped', reason: 'lease_lost' };
      return this.deferOrEscalate(payout, attempts, 'PAYOUT_APPLY_FAILED');
    }
  }

  /**
   * Ambiguous outcome: keep the money held and stop retrying. A human must
   * reconcile the provider reference before the payout is resolved (D18 Q9).
   */
  private async markNeedsAssistance(
    payout: PayoutRow,
    errorCode: string,
    attempts: number,
  ): Promise<PayoutRequestProcessResult> {
    await this.withTransaction(undefined, async (tx) => {
      const current = await tx.query<{
        status: PayoutStatus;
        tenant_id: string;
      }>(
        'select status, tenant_id::text from payouts where id = $1 for update',
        [payout.id],
      );
      const row = current.rows[0];
      if (!row) return;
      if (row.status === 'processing') {
        await tx.query(
          `update payouts
              set last_error = $2, failure_code = $2,
                  version = version + 1, updated_at = now()
            where id = $1 and status = 'processing'`,
          [payout.id, errorCode.slice(0, 64)],
        );
        await this.appendEvent(tx, {
          payoutId: payout.id,
          fromStatus: 'processing',
          toStatus: 'processing',
          actorService: 'payouts-processor',
          reason:
            'Provider outcome is ambiguous; funds stay held for reconciliation',
          metadata: { errorCode, attempts },
        });
      }
      await this.audit.append(tx, {
        actor: { service: 'payouts-processor' },
        scopeType: 'tenant',
        scopeId: row.tenant_id,
        action: PAYOUT_AUDIT_ACTIONS.payoutNeedsAssistance,
        targetType: 'payout',
        targetId: payout.id,
        reason:
          'Provider outcome is ambiguous; funds stay held for reconciliation',
        metadata: { errorCode, attempts },
      });
    });
    await this.markOutboxDead(payout.id, errorCode);
    return {
      outcome: 'needs_assistance',
      payoutId: payout.id,
      attempts,
      errorCode,
    };
  }

  private async deferOrEscalate(
    payout: PayoutRow,
    attempts: number,
    errorCode: string,
  ): Promise<PayoutRequestProcessResult> {
    if (attempts >= MAX_PAYOUT_REQUEST_ATTEMPTS)
      return this.markNeedsAssistance(payout, errorCode, attempts);
    const retryAfterSeconds = backoffSeconds(attempts);
    await this.deferOutbox(payout.id, errorCode, retryAfterSeconds);
    return {
      outcome: 'deferred',
      payoutId: payout.id,
      attempts,
      retryAfterSeconds,
    };
  }

  /**
   * FIFO allocation of a settled payout to the tenant released settlements
   * (design section 2.2): oldest release first, partial settlement allowed.
   * The payout amount must be fully covered - anything else is an accounting
   * inconsistency and rolls the settle transaction back.
   */
  private async allocateFifo(
    tx: PoolClient,
    tenantId: string,
    payoutId: string,
    amountMinor: string,
  ): Promise<void> {
    const settlements = await tx.query<{
      id: string;
      amount_minor: string;
      paid_out_minor: string;
    }>(
      `select id::text, amount_minor::text, paid_out_minor::text
         from settlements
        where tenant_id = $1 and status = 'available'
        order by released_at asc, id asc
        for update`,
      [tenantId],
    );
    let remaining = BigInt(amountMinor);
    for (const row of settlements.rows) {
      if (remaining <= 0n) break;
      const capacity = BigInt(row.amount_minor) - BigInt(row.paid_out_minor);
      if (capacity <= 0n) continue;
      const take = capacity < remaining ? capacity : remaining;
      await tx.query(
        `insert into payout_allocations
           (tenant_id, payout_id, settlement_id, amount_minor, created_at)
         values ($1, $2, $3, $4, now())`,
        [tenantId, payoutId, row.id, take.toString()],
      );
      await tx.query(
        `update settlements
            set paid_out_minor = paid_out_minor + $2,
                status = case
                  when paid_out_minor + $2 = amount_minor then 'paid_out'
                  else 'available'
                end,
                updated_at = now()
          where id = $1`,
        [row.id, take.toString()],
      );
      remaining -= take;
    }
    if (remaining !== 0n)
      throw new ConflictException({
        code: PAYOUT_ERROR_CODES.allocationMismatch,
        message:
          'Released settlements do not cover the payout amount; reconcile before settling',
      });
  }

  /** Decrypts the destination number OUTSIDE any transaction or lock. */
  private async loadAccountNumber(payout: PayoutRow): Promise<string> {
    const result = await this.database.pool.query<{
      account_number_ciphertext: string;
    }>(
      `select account_number_ciphertext from bank_accounts
        where id = $1 and tenant_id = $2`,
      [payout.bank_account_id, payout.tenant_id],
    );
    const row = result.rows[0];
    if (!row)
      throw new PermanentPayoutRequestError(
        'BANK_ACCOUNT_NOT_FOUND',
        'Payout destination account no longer exists',
      );
    try {
      const keys = bankAccountKeys(this.config);
      return decryptAccountNumber(
        keys.encryptionKey,
        row.account_number_ciphertext,
      );
    } catch {
      throw new PermanentPayoutRequestError(
        'BANK_ACCOUNT_CIPHERTEXT_INVALID',
        'Payout destination account could not be decrypted',
      );
    }
  }

  private async amountOf(tx: PoolClient, payoutId: string): Promise<string> {
    const result = await tx.query<{ amount_minor: string }>(
      'select amount_minor::text from payouts where id = $1',
      [payoutId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Payout was not found');
    return row.amount_minor;
  }

  private async appendEvent(
    tx: PoolClient,
    input: {
      payoutId: string;
      fromStatus: string | null;
      toStatus: string;
      actorUserId?: string;
      actorService?: string;
      reason: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const next = await tx.query<{ version: number }>(
      `select coalesce(max(version), 0) + 1 as version
         from payout_events where payout_id = $1`,
      [input.payoutId],
    );
    await tx.query(
      `insert into payout_events
         (payout_id, version, from_status, to_status, actor_user_id,
          actor_service, reason, metadata, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())`,
      [
        input.payoutId,
        next.rows[0].version,
        input.fromStatus,
        input.toStatus,
        input.actorUserId ?? null,
        input.actorService ?? null,
        input.reason,
        JSON.stringify(input.metadata),
      ],
    );
  }

  private async finishAttempt(
    payoutId: string,
    attemptNo: number,
    status: 'succeeded' | 'failed' | 'unknown',
    providerReference: string | null,
    errorCode: string | null,
    errorMessage: string | null,
  ): Promise<void> {
    await this.database.pool.query(
      `update payout_attempts
          set status = $3, finished_at = now(), provider_reference = $4,
              error_code = $5, error_message = $6
        where payout_id = $1 and attempt_no = $2`,
      [
        payoutId,
        attemptNo,
        status,
        providerReference,
        errorCode ? errorCode.slice(0, 64) : null,
        errorMessage ? errorMessage.slice(0, 500) : null,
      ],
    );
  }

  /** Completes the outbox row under the active lease; throws when lost. */
  private async fenceOutboxDone(
    tx: PoolClient,
    payoutId: string,
  ): Promise<void> {
    const fenced = await tx.query(
      `update payout_request_outbox
          set status = 'done', lease_until = null, last_error = null,
              processed_at = now(), updated_at = now()
        where payout_id = $1 and status = 'processing' and lease_until > now()
        returning id::text`,
      [payoutId],
    );
    if (fenced.rowCount !== 1)
      throw new ConflictException({
        code: 'PAYOUT_LEASE_LOST',
        message: 'Outbox lease was lost; another worker owns this payout',
      });
  }

  private async markOutboxDone(
    payoutId: string,
    lastError: string | null,
  ): Promise<void> {
    await this.database.pool.query(
      `update payout_request_outbox
          set status = 'done', lease_until = null, last_error = $2,
              processed_at = now(), updated_at = now()
        where payout_id = $1 and status in ('pending', 'processing')`,
      [payoutId, lastError ? lastError.slice(0, 500) : null],
    );
  }

  private async markOutboxDead(
    payoutId: string,
    lastError: string,
  ): Promise<void> {
    await this.database.pool.query(
      `update payout_request_outbox
          set status = 'dead', lease_until = null, last_error = $2,
              updated_at = now()
        where payout_id = $1 and status in ('pending', 'processing')`,
      [payoutId, lastError.slice(0, 500)],
    );
  }

  private async deferOutbox(
    payoutId: string,
    lastError: string,
    retryAfterSeconds: number,
  ): Promise<void> {
    await this.database.pool.query(
      `update payout_request_outbox
          set status = 'pending', lease_until = null, last_error = $2,
              next_attempt_at = now() + make_interval(secs => $3::int),
              updated_at = now()
        where payout_id = $1 and status = 'processing' and lease_until > now()`,
      [payoutId, lastError.slice(0, 500), retryAfterSeconds],
    );
  }

  private replay(
    row: PayoutRow,
    tenantId: string,
    input: RequestPayoutInput,
    amountMinor: string,
  ): RequestPayoutResult {
    if (
      row.tenant_id !== tenantId ||
      row.bank_account_id !== input.bankAccountId ||
      row.amount_minor !== amountMinor
    )
      throw new ConflictException({
        code: PAYOUT_ERROR_CODES.idempotencyReused,
        message: 'Idempotency-Key was already used with different input',
      });
    return { payout: toView(row), replayed: true };
  }

  async loadView(
    client: Pick<PoolClient, 'query'>,
    tenantId: string,
    payoutId: string,
  ): Promise<PayoutView> {
    const result = await client.query<PayoutRow>(
      `select ${PAYOUT_COLUMNS} from payouts
        where id = $1 and tenant_id = $2`,
      [payoutId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Payout was not found');
    return toView(row);
  }

  private async loadDetail(
    client: Pick<PoolClient, 'query'>,
    tenantId: string,
    payoutId: string,
  ): Promise<PayoutDetail> {
    const payout = await this.loadView(client, tenantId, payoutId);
    const events = await client.query<{
      id: string;
      version: number;
      from_status: string | null;
      to_status: string;
      actor_user_id: string | null;
      actor_service: string | null;
      reason: string;
      occurred_at: string;
    }>(
      `select id::text, version, from_status, to_status,
              actor_user_id::text, actor_service, reason,
              ${SQL_TS('occurred_at')} as occurred_at
         from payout_events
        where payout_id = $1
        order by version asc`,
      [payoutId],
    );
    const allocations = await client.query<{
      id: string;
      settlement_id: string;
      amount_minor: string;
      created_at: string;
    }>(
      // FIFO display order: the settlement release order decides, not the
      // allocation row id (both rows are written in the same transaction).
      `select a.id::text, a.settlement_id::text, a.amount_minor::text,
              ${SQL_TS('a.created_at')} as created_at
         from payout_allocations a
         join settlements s on s.id = a.settlement_id
        where a.payout_id = $1
        order by s.released_at asc, s.id asc`,
      [payoutId],
    );
    return {
      payout,
      events: events.rows.map((row) => ({
        id: row.id,
        version: Number(row.version),
        fromStatus: row.from_status,
        toStatus: row.to_status,
        actorUserId: row.actor_user_id,
        actorService: row.actor_service,
        reason: row.reason,
        occurredAt: row.occurred_at,
      })),
      allocations: allocations.rows.map((row) => ({
        id: row.id,
        settlementId: row.settlement_id,
        amountMinor: row.amount_minor,
        createdAt: row.created_at,
      })),
    };
  }

  private assertUuid(value: string, field: string): void {
    if (!uuidPattern.test(value ?? ''))
      throw new BadRequestException('Invalid ' + field);
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

function toView(row: PayoutRow): PayoutView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    bankAccountId: row.bank_account_id,
    bankCode: row.bank_code,
    accountNumberMasked: row.account_number_masked,
    accountHolderName: row.account_holder_name,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status,
    provider: row.provider,
    providerReference: row.provider_reference,
    failureCode: row.failure_code,
    lastError: row.last_error,
    requestedByUserId: row.requested_by_user_id,
    requestedAt: row.requested_at,
    processingAt: row.processing_at,
    succeededAt: row.succeeded_at,
    failedAt: row.failed_at,
    cancelledAt: row.cancelled_at,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isTerminal(status: PayoutStatus): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'cancelled'
  );
}

function isPayoutStatus(value: string): value is PayoutStatus {
  return [
    'requested',
    'processing',
    'succeeded',
    'failed',
    'cancelled',
  ].includes(value);
}

/**
 * Deterministic payout id (UUIDv5-style, SHA-1 based) derived from the tenant
 * and the client Idempotency-Key. No schema column is needed for replay
 * detection: a retried request lands on the same row and the same ledger
 * idempotency key, while a different payload is rejected as key reuse.
 */
function payoutIdFor(tenantId: string, idempotencyKey: string): string {
  const digest = createHash('sha1')
    .update('antriin.payout.v1:' + tenantId + ':' + idempotencyKey, 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  );
}

function normalizeMoney(value: string): string {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value))
    throw new BadRequestException({
      code: PAYOUT_ERROR_CODES.amountInvalid,
      message: 'amountMinor must be a positive decimal integer string',
    });
  if (value.length > MAX_MINOR_DIGITS)
    throw new BadRequestException({
      code: PAYOUT_ERROR_CODES.amountInvalid,
      message: 'amountMinor exceeds supported precision',
    });
  return value;
}

function normalizeReason(reason: string | undefined): string {
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  if (!normalized) return 'Payout cancelled by the verified tenant owner';
  if (normalized.length > MAX_REASON_LENGTH)
    throw new BadRequestException('reason must be at most 500 characters');
  return normalized;
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
    throw new BadRequestException('Invalid payout list cursor');
  }
}

function providerErrorCode(error: unknown): string {
  if (error instanceof PermanentPayoutRequestError) return error.code;
  return 'PROVIDER_REQUEST_FAILED';
}

function backoffSeconds(attempts: number): number {
  return Math.min(
    PAYOUT_BACKOFF_BASE_SECONDS * 2 ** Math.max(attempts - 1, 0),
    PAYOUT_BACKOFF_MAX_SECONDS,
  );
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === '23505' &&
    (error as { constraint?: string }).constraint === constraint
  );
}

function isLeaseLost(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response: unknown }).response === 'object' &&
    (error as { response: { code?: unknown } }).response?.code ===
      'PAYOUT_LEASE_LOST'
  );
}
