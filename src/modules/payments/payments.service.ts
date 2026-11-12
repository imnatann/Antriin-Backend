import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService, uuidPattern } from '../notifications/outbox.service';
import { WalletService } from '../wallet/wallet.service';
import type { SandboxWebhookEventDto } from './dto/sandbox-webhook.dto';
import {
  PAYMENTS_PROVIDER_ADAPTER,
  PermanentPaymentRequestError,
  type TopupProviderAdapter,
} from './payments.adapter';

const MONEY_PATTERN = /^(0|[1-9][0-9]*)$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,200}$/;
const MAX_AMOUNT_DIGITS = 38;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const REQUEST_BACKOFF_BASE_SECONDS = 5;
const REQUEST_BACKOFF_MAX_SECONDS = 300;

/** Hard cap for provider-request attempts before a row is marked dead. */
export const MAX_PAYMENT_REQUEST_ATTEMPTS = 5;
/** System ledger account that funds sandbox top-up credits. */
export const SANDBOX_TOPUP_CLEARING_ACCOUNT = 'payments.sandbox.topup-clearing';
export const PAYMENTS_QUEUE_JOB_NAME = 'request';
/**
 * Default/fallback sandbox top-up intent time-to-live in seconds. The
 * effective value is read from PAYMENTS_SANDBOX_TOPUP_TTL_SECONDS (ConfigService);
 * this constant is the documented default and the fallback used by tests.
 * Expiry is informational: a pending intent is only moved to 'expired' by a
 * provider event (or a future reconciliation sweep), never implicitly by age.
 */
export const SANDBOX_TOPUP_TTL_SECONDS = 3600;

export type TopupIntentStatus =
  'pending' | 'succeeded' | 'failed' | 'expired' | 'needs_assistance';

export type TopupIntentView = {
  id: string;
  provider: string;
  providerReference: string;
  amountMinor: string;
  currency: string;
  status: TopupIntentStatus;
  statusVersion: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  succeededAt: string | null;
  qrisPayload: string | null;
};

export type CreateTopupIntentResult = {
  view: TopupIntentView;
  walletAccountId: string;
  replayed: boolean;
};

export type TopupIntentPage = {
  items: TopupIntentView[];
  nextCursor: string | null;
};

export type WebhookHandleResult =
  | {
      kind: 'applied';
      intentId: string;
      status: 'succeeded' | 'failed' | 'expired';
    }
  | { kind: 'duplicate'; intentId: string; previousOutcome: string }
  | { kind: 'ignored'; intentId: string }
  | { kind: 'unmatched' }
  | { kind: 'mismatch'; reason: 'currency' | 'amount' | 'state' }
  | { kind: 'conflict' };

export type PaymentRequestProcessResult =
  | { outcome: 'completed'; attempts: number }
  | {
      outcome: 'skipped';
      reason:
        'unknown' | 'not_due' | 'leased' | 'settled' | 'dead' | 'lease_lost';
    }
  | {
      outcome: 'deferred';
      attempts: number;
      errorCode: string;
      retryAfterSeconds: number;
    }
  | { outcome: 'dead'; attempts: number; errorCode: string };

type TopupIntentRow = {
  id: string;
  user_id: string;
  wallet_account_id: string;
  provider: string;
  provider_reference: string;
  request_hash: string;
  amount_minor: string;
  currency: string;
  status: TopupIntentStatus;
  status_version: number;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  succeeded_at: Date | null;
};

type Correlation =
  | { outcome: 'ignored' }
  | { outcome: 'mismatch'; reason: 'currency' | 'amount' | 'state' }
  | { outcome: 'duplicate' }
  | { outcome: 'applied'; terminal: 'succeeded' | 'failed' | 'expired' };

type Cursor = { createdAt: string; id: string };

const INTENT_COLUMNS =
  'id::text, user_id::text, wallet_account_id::text, provider, ' +
  'provider_reference, request_hash, amount_minor::text, currency, ' +
  'status, status_version, created_at, updated_at, expires_at, succeeded_at';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
    @Inject(PAYMENTS_PROVIDER_ADAPTER)
    private readonly adapter: TopupProviderAdapter,
  ) {}

  /** Effective mode; production is always treated as disabled. */
  providerMode(): 'disabled' | 'sandbox' {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'production')
      return 'disabled';
    return this.config.getOrThrow<string>('PAYMENTS_PROVIDER_MODE') ===
      'sandbox'
      ? 'sandbox'
      : 'disabled';
  }

  /**
   * Creates a pending top-up intent plus its provider-request outbox row in
   * ONE PostgreSQL transaction. Replaying the same (user, idempotencyKey)
   * with an identical request returns the stored intent without new rows;
   * a different amount under the same key is a 409. No balance moves here.
   */
  async createTopupIntent(
    userId: string,
    input: { amountMinor: string; idempotencyKey: string },
  ): Promise<CreateTopupIntentResult> {
    if (!uuidPattern.test(userId))
      throw new BadRequestException('Invalid user');
    if (this.providerMode() !== 'sandbox')
      throw new ServiceUnavailableException({
        code: 'PAYMENTS_PROVIDER_DISABLED',
        message: 'Top-up is currently unavailable',
      });
    const amountMinor = this.validateAmount(input.amountMinor);
    const idempotencyKey = this.validateIdempotencyKey(input.idempotencyKey);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          userId,
          amountMinor,
          currency: 'IDR',
          provider: 'sandbox',
          idempotencyKey,
        }),
      )
      .digest('hex');
    const providerReference = this.adapter.buildProviderReference({
      userId,
      idempotencyKey,
      requestHash,
    });
    // Sandbox top-up TTL is configuration-driven (root owns environment.ts).
    const ttlSeconds = this.config.getOrThrow<number>(
      'PAYMENTS_SANDBOX_TOPUP_TTL_SECONDS',
    );

    const result = await this.withTransaction(async (client) => {
      // Snapshot the buyer wallet account (same user) inside the transaction.
      const walletAccount = await this.wallet.getOrCreateWallet(
        userId,
        'IDR',
        client,
      );
      const inserted = await client.query<TopupIntentRow>(
        `insert into topup_intents
           (user_id, wallet_account_id, provider, provider_reference,
            idempotency_key, request_hash, amount_minor, currency,
            status, status_version, created_at, updated_at, expires_at)
         values ($1, $2, 'sandbox', $3, $4, $5, $6, 'IDR', 'pending', 1,
                 now(), now(), now() + make_interval(secs => $7::int))
         on conflict (user_id, idempotency_key) do nothing
         returning ${INTENT_COLUMNS}`,
        [
          userId,
          walletAccount.accountId,
          providerReference,
          idempotencyKey,
          requestHash,
          amountMinor,
          ttlSeconds,
        ],
      );
      let row = inserted.rows[0];
      let replayed = false;
      if (row) {
        await client.query(
          `insert into payment_request_outbox
             (topup_id, provider, status, attempts, available_at, created_at, updated_at)
           values ($1, 'sandbox', 'pending', 0, now(), now(), now())`,
          [row.id],
        );
        await this.audit.append(client, {
          actor: { userId },
          scopeType: 'user',
          scopeId: userId,
          action: 'topup.created',
          targetType: 'topup_intent',
          targetId: row.id,
          reason: 'Buyer requested a sandbox QRIS top-up',
          metadata: {
            provider: 'sandbox',
            amountMinor: row.amount_minor,
            currency: 'IDR',
          },
        });
      } else {
        const existing = await client.query<TopupIntentRow>(
          `select ${INTENT_COLUMNS} from topup_intents
            where user_id = $1 and idempotency_key = $2`,
          [userId, idempotencyKey],
        );
        row = existing.rows[0];
        if (!row)
          // Concurrent insert still in flight; a client retry replays safely.
          throw new ConflictException({
            code: 'TOPUP_IDEMPOTENCY_IN_PROGRESS',
            message:
              'A concurrent top-up request with the same idempotency key is in progress',
          });
        if (row.request_hash !== requestHash)
          throw new ConflictException({
            code: 'TOPUP_IDEMPOTENCY_KEY_REUSED',
            message:
              'Idempotency key was already used for a different top-up request',
          });
        replayed = true;
      }
      return { row, replayed, walletAccountId: walletAccount.accountId };
    });
    return {
      view: this.toView(result.row),
      walletAccountId: result.row.wallet_account_id,
      replayed: result.replayed,
    };
  }

  /** Buyer-scoped detail; other users' intents are indistinguishable from missing. */
  async getTopupForUser(userId: string, id: string): Promise<TopupIntentView> {
    if (!uuidPattern.test(userId))
      throw new BadRequestException('Invalid user');
    if (!uuidPattern.test(id))
      throw new NotFoundException('Top-up intent was not found');
    const result = await this.database.pool.query<TopupIntentRow>(
      `select ${INTENT_COLUMNS} from topup_intents
        where id = $1 and user_id = $2`,
      [id, userId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Top-up intent was not found');
    return this.toView(row);
  }

  /** Buyer-scoped cursor page over the caller's own intents. */
  async listTopupsForUser(
    userId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<TopupIntentPage> {
    if (!uuidPattern.test(userId))
      throw new BadRequestException('Invalid user');
    const limit = normalizeLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    const values: unknown[] = [userId];
    let where = 'user_id = $1';
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      where += ' and (created_at, id) < ($2::timestamptz, $3::uuid)';
    }
    values.push(limit + 1);
    const result = await this.database.pool.query<
      TopupIntentRow & { cursor_created_at: string }
    >(
      `select ${INTENT_COLUMNS},
              to_char(created_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
         from topup_intents
        where ${where}
        order by created_at desc, id desc
        limit $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => this.toView(row, { includeQrisPayload: false })),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              createdAt: last.cursor_created_at,
              id: last.id,
            })
          : null,
    };
  }

  /**
   * Applies an authenticated sandbox provider event. The caller (webhook
   * controller) MUST have verified the HMAC signature over the exact raw
   * bytes first. Correlation happens before any state change; a success
   * credits the buyer wallet exactly once via the double-entry ledger inside
   * one transaction together with audit and notification outbox rows.
   */
  async handleProviderEvent(
    rawBody: Buffer,
    event: SandboxWebhookEventDto,
  ): Promise<WebhookHandleResult> {
    if (this.providerMode() !== 'sandbox')
      throw new ServiceUnavailableException({
        code: 'PAYMENTS_PROVIDER_DISABLED',
        message: 'Top-up webhooks are not accepted while payments are disabled',
      });
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const occurredAt = new Date(event.occurredAt);
    if (Number.isNaN(occurredAt.getTime()))
      throw new BadRequestException({
        code: 'PAYMENT_EVENT_INVALID',
        message: 'occurredAt is not a valid timestamp',
      });
    return this.withTransaction(async (client) => {
      const intentResult = await client.query<{
        id: string;
        user_id: string;
        wallet_account_id: string;
        amount_minor: string;
        currency: string;
        status: TopupIntentStatus;
        status_version: number;
      }>(
        `select id::text, user_id::text, wallet_account_id::text,
                amount_minor::text, currency, status, status_version
           from topup_intents
          where provider = 'sandbox' and provider_reference = $1
          for update`,
        [event.reference],
      );
      const intent = intentResult.rows[0];
      if (!intent) {
        // Signed but unknown reference: record for reconciliation, never credit.
        await this.recordProviderEvent(client, {
          eventId: event.eventId,
          payloadHash,
          topupId: null,
          providerStatus: event.status,
          outcome: 'unmatched',
          occurredAt,
        });
        return { kind: 'unmatched' as const };
      }

      const correlation = this.correlate(event, intent);
      const inserted = await this.recordProviderEvent(client, {
        eventId: event.eventId,
        payloadHash,
        topupId: intent.id,
        providerStatus: event.status,
        outcome: correlation.outcome,
        occurredAt,
      });
      if (!inserted) {
        const existing = await client.query<{
          payload_hash: string;
          outcome: string;
        }>(
          `select payload_hash, outcome from payment_provider_events
            where provider = 'sandbox' and event_id = $1`,
          [event.eventId],
        );
        if (existing.rows[0].payload_hash !== payloadHash)
          // Same event id, different payload: refuse, change nothing.
          return { kind: 'conflict' as const };
        return {
          kind: 'duplicate' as const,
          intentId: intent.id,
          previousOutcome: existing.rows[0].outcome,
        };
      }
      if (correlation.outcome === 'mismatch')
        return { kind: 'mismatch' as const, reason: correlation.reason };
      // A different event id that repeats an already-terminal state is still a
      // duplicate outcome (no new effect), distinct from an informational
      // 'pending' event which is simply ignored.
      if (correlation.outcome === 'duplicate')
        return {
          kind: 'duplicate' as const,
          intentId: intent.id,
          previousOutcome: intent.status,
        };
      if (correlation.outcome !== 'applied')
        return { kind: 'ignored' as const, intentId: intent.id };

      const terminal = correlation.terminal;
      if (terminal === 'succeeded') {
        const clearing = await this.wallet.ensureSystemAccount(
          SANDBOX_TOPUP_CLEARING_ACCOUNT,
          'IDR',
          client,
        );
        await this.wallet.postTransfer(
          {
            idempotencyScope: 'payments.sandbox.webhook',
            idempotencyKey: 'sandbox:' + event.eventId,
            reference: { namespace: 'topup_intent', id: intent.id },
            currency: 'IDR',
            amountMinor: intent.amount_minor,
            debitAccountId: clearing.accountId,
            creditAccountId: intent.wallet_account_id,
            actor: { type: 'service', id: 'payments-webhook' },
            reason: 'Sandbox QRIS top-up settled by a validated provider event',
            metadata: { provider: 'sandbox' },
          },
          client,
        );
      }
      const transition = await client.query(
        `update topup_intents
            set status = $2::varchar,
                status_version = status_version + 1,
                succeeded_at = case when $2::varchar = 'succeeded' then now() else null end,
                updated_at = now()
          where id = $1 and status = 'pending' and status_version = $3`,
        [intent.id, terminal, intent.status_version],
      );
      if (transition.rowCount !== 1)
        throw new ConflictException({
          code: 'TOPUP_STATE_CONFLICT',
          message: 'Top-up intent changed concurrently; redeliver the event',
        });
      await this.audit.append(client, {
        actor: { service: 'payments-webhook' },
        scopeType: 'user',
        scopeId: intent.user_id,
        action: 'topup.' + terminal,
        targetType: 'topup_intent',
        targetId: intent.id,
        reason:
          'Validated sandbox provider event moved the top-up to ' + terminal,
        metadata: {
          provider: 'sandbox',
          amountMinor: intent.amount_minor,
          currency: 'IDR',
        },
      });
      await this.outbox.append(client, {
        eventKey: 'topup_intent:' + intent.id + ':' + terminal,
        eventType: 'topup.status_changed',
        aggregateType: 'topup_intent',
        aggregateId: intent.id,
        recipientIds: [intent.user_id],
      });
      return {
        kind: 'applied' as const,
        intentId: intent.id,
        status: terminal,
      };
    });
  }

  /**
   * Due rows for the dispatcher; includes processing rows whose lease expired.
   * `nonce` is the row's updated_at in epoch microseconds: it changes on every
   * lease/defer/settle cycle, so a dispatcher jobId embedding it is stable
   * while nothing happened and fresh after ANY row state change (review
   * P2-01). `staleForSeconds` measures how long the row has been waiting
   * since its last state change; the dispatcher alarms above a threshold.
   */
  async listDuePaymentRequests(limit = 20): Promise<
    {
      topupId: string;
      attempts: number;
      nonce: string;
      staleForSeconds: number;
    }[]
  > {
    const result = await this.database.pool.query<{
      topup_id: string;
      attempts: number;
      nonce: string;
      stale_for_seconds: number;
    }>(
      `select topup_id::text, attempts,
              floor(extract(epoch from updated_at) * 1000000)::bigint::text as nonce,
              floor(extract(epoch from (now() - updated_at)))::int as stale_for_seconds
         from payment_request_outbox
        where (status = 'pending' and available_at <= now())
           or (status = 'processing' and lease_until < now())
        order by available_at, id
        limit $1`,
      [Math.min(Math.max(Math.trunc(limit), 1), 100)],
    );
    return result.rows.map((row) => ({
      topupId: row.topup_id,
      attempts: Number(row.attempts),
      nonce: row.nonce,
      staleForSeconds: Number(row.stale_for_seconds),
    }));
  }

  /**
   * Leases one outbox row, calls the provider adapter OUTSIDE any
   * transaction or lock, then records the outcome idempotently under lease
   * fencing. Transient failures return the row to pending with explicit
   * exponential backoff; permanent failures or the attempt cap mark it dead.
   * No step duplicates financial effects on retry.
   */
  async processPaymentRequest(
    topupId: string,
  ): Promise<PaymentRequestProcessResult> {
    if (!uuidPattern.test(topupId))
      throw new BadRequestException('Invalid top-up id');
    const leaseToken = randomUUID();
    const leased = await this.database.pool.query<{ attempts: number }>(
      `update payment_request_outbox
          set status = 'processing',
              attempts = attempts + 1,
              lease_token = $2,
              lease_until = now() + interval '60 seconds',
              updated_at = now()
        where topup_id = $1
          and ((status = 'pending' and available_at <= now())
               or (status = 'processing' and lease_until < now()))
        returning attempts`,
      [topupId, leaseToken],
    );
    if (leased.rowCount === 0) {
      const current = await this.database.pool.query<{ status: string }>(
        'select status from payment_request_outbox where topup_id = $1',
        [topupId],
      );
      const status = current.rows[0]?.status;
      if (!status) return { outcome: 'skipped', reason: 'unknown' };
      if (status === 'complete')
        return { outcome: 'skipped', reason: 'settled' };
      if (status === 'dead') return { outcome: 'skipped', reason: 'dead' };
      if (status === 'processing')
        return { outcome: 'skipped', reason: 'leased' };
      return { outcome: 'skipped', reason: 'not_due' };
    }
    const attempts = Number(leased.rows[0].attempts);
    const intentResult = await this.database.pool.query<{
      id: string;
      provider_reference: string;
      amount_minor: string;
      currency: string;
    }>(
      `select id::text, provider_reference, amount_minor::text, currency
         from topup_intents where id = $1`,
      [topupId],
    );
    const intent = intentResult.rows[0];
    if (!intent) {
      await this.settleRequest(topupId, leaseToken, 'INTENT_NOT_FOUND');
      return { outcome: 'dead', attempts, errorCode: 'INTENT_NOT_FOUND' };
    }
    let providerReference: string;
    try {
      // No transaction or row lock is held during the provider call.
      const registered = await this.adapter.createPaymentRequest({
        id: intent.id,
        providerReference: intent.provider_reference,
        amountMinor: intent.amount_minor,
        currency: intent.currency,
      });
      providerReference = registered.providerReference;
    } catch (error) {
      const code = providerErrorCode(error);
      if (
        error instanceof PermanentPaymentRequestError ||
        attempts >= MAX_PAYMENT_REQUEST_ATTEMPTS
      ) {
        await this.settleRequest(topupId, leaseToken, code);
        return { outcome: 'dead', attempts, errorCode: code };
      }
      const retryAfterSeconds = backoffSeconds(attempts);
      await this.deferRequest(topupId, leaseToken, code, retryAfterSeconds);
      return {
        outcome: 'deferred',
        attempts,
        errorCode: code,
        retryAfterSeconds,
      };
    }
    if (providerReference !== intent.provider_reference) {
      await this.settleRequest(
        topupId,
        leaseToken,
        'PROVIDER_REFERENCE_MISMATCH',
      );
      return {
        outcome: 'dead',
        attempts,
        errorCode: 'PROVIDER_REFERENCE_MISMATCH',
      };
    }
    const completed = await this.database.pool.query(
      `update payment_request_outbox
          set status = 'complete',
              lease_token = null,
              lease_until = null,
              last_error_code = null,
              updated_at = now()
        where topup_id = $1 and lease_token = $2
        returning id::text`,
      [topupId, leaseToken],
    );
    if (completed.rowCount === 0)
      return { outcome: 'skipped', reason: 'lease_lost' };
    return { outcome: 'completed', attempts };
  }

  private correlate(
    event: SandboxWebhookEventDto,
    intent: {
      amount_minor: string;
      currency: string;
      status: TopupIntentStatus;
    },
  ): Correlation {
    if (event.status === 'pending') return { outcome: 'ignored' };
    if (event.currency !== intent.currency)
      return { outcome: 'mismatch', reason: 'currency' };
    // Decimal-string money: compare with BigInt, never Number (precision).
    if (BigInt(event.amountMinor) !== BigInt(intent.amount_minor))
      return { outcome: 'mismatch', reason: 'amount' };
    if (intent.status === 'pending')
      return { outcome: 'applied', terminal: event.status };
    if (intent.status === event.status) return { outcome: 'duplicate' };
    return { outcome: 'mismatch', reason: 'state' };
  }

  /** Returns true when this delivery inserted the dedupe row. */
  private async recordProviderEvent(
    client: PoolClient,
    input: {
      eventId: string;
      payloadHash: string;
      topupId: string | null;
      providerStatus: string;
      outcome: string;
      occurredAt: Date;
    },
  ): Promise<boolean> {
    const result = await client.query(
      `insert into payment_provider_events
         (provider, event_id, payload_hash, topup_id, provider_status,
          outcome, occurred_at, received_at)
       values ('sandbox', $1, $2, $3, $4, $5, $6, now())
       on conflict (provider, event_id) do nothing
       returning id::text`,
      [
        input.eventId,
        input.payloadHash,
        input.topupId,
        input.providerStatus,
        input.outcome,
        input.occurredAt,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async settleRequest(
    topupId: string,
    leaseToken: string,
    errorCode: string,
  ): Promise<void> {
    await this.database.pool.query(
      `update payment_request_outbox
          set status = 'dead',
              lease_token = null,
              lease_until = null,
              last_error_code = $3,
              updated_at = now()
        where topup_id = $1 and lease_token = $2`,
      [topupId, leaseToken, errorCode.slice(0, 64)],
    );
  }

  private async deferRequest(
    topupId: string,
    leaseToken: string,
    errorCode: string,
    retryAfterSeconds: number,
  ): Promise<void> {
    await this.database.pool.query(
      `update payment_request_outbox
          set status = 'pending',
              lease_token = null,
              lease_until = null,
              last_error_code = $3,
              available_at = now() + make_interval(secs => $4::int),
              updated_at = now()
        where topup_id = $1 and lease_token = $2`,
      [topupId, leaseToken, errorCode.slice(0, 64), retryAfterSeconds],
    );
  }

  private validateAmount(value: string): string {
    if (
      typeof value !== 'string' ||
      !MONEY_PATTERN.test(value) ||
      value.length > MAX_AMOUNT_DIGITS
    )
      throw new BadRequestException({
        code: 'TOPUP_AMOUNT_INVALID',
        message: 'amountMinor must be a decimal integer string',
      });
    const amount = BigInt(value);
    const min = BigInt(
      this.config.getOrThrow<number>('PAYMENTS_TOPUP_MIN_MINOR'),
    );
    const max = BigInt(
      this.config.getOrThrow<number>('PAYMENTS_TOPUP_MAX_MINOR'),
    );
    if (amount < min || amount > max)
      throw new BadRequestException({
        code: 'TOPUP_AMOUNT_OUT_OF_BOUNDS',
        message: 'amountMinor is outside the allowed top-up bounds',
      });
    return value;
  }

  private validateIdempotencyKey(value: string): string {
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value))
      throw new BadRequestException({
        code: 'TOPUP_IDEMPOTENCY_KEY_INVALID',
        message: 'idempotencyKey must be 8-200 chars from [A-Za-z0-9_.:-]',
      });
    return value;
  }

  private toView(
    row: TopupIntentRow,
    options: { includeQrisPayload?: boolean } = {},
  ): TopupIntentView {
    const includeQris = options.includeQrisPayload !== false;
    return {
      id: row.id,
      provider: row.provider,
      providerReference: row.provider_reference,
      amountMinor: row.amount_minor,
      currency: row.currency,
      status: row.status,
      statusVersion: Number(row.status_version),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      succeededAt: row.succeeded_at ? row.succeeded_at.toISOString() : null,
      qrisPayload:
        includeQris &&
        row.status === 'pending' &&
        this.providerMode() === 'sandbox'
          ? this.adapter.renderQrisPayload({
              providerReference: row.provider_reference,
              amountMinor: row.amount_minor,
              currency: row.currency,
            })
          : null,
    };
  }

  private async withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('begin');
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function providerErrorCode(error: unknown): string {
  if (error instanceof PermanentPaymentRequestError) return error.code;
  return 'PROVIDER_REQUEST_FAILED';
}

function backoffSeconds(attempts: number): number {
  return Math.min(
    REQUEST_BACKOFF_BASE_SECONDS * 2 ** Math.max(attempts - 1, 0),
    REQUEST_BACKOFF_MAX_SECONDS,
  );
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
    throw new BadRequestException('Invalid top-up list cursor');
  }
}
