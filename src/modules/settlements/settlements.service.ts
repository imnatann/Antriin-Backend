import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  forwardRef,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { CasesService } from '../cases/cases.service';
import { uuidPattern } from '../notifications/outbox.service';
import { OrdersService } from '../orders/orders.service';
import { WalletService } from '../wallet/wallet.service';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  ORDER_PAYMENT_ESCROW_ACCOUNT,
  SETTLEMENT_RELEASE_IDEMPOTENCY_SCOPE,
  SETTLEMENT_RELEASE_REFERENCE_NAMESPACE,
  TENANT_PAYABLE_SYSTEM_KEY_PREFIX,
  TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX,
} from './settlements.constants';

/** D7: response timestamps are the DB microsecond UTC strings themselves. */
const SQL_TS = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type Cursor = { createdAt: string; id: string };

export type SettlementActor =
  { type: 'user'; id: string } | { type: 'service'; id: string };

export type SettlementReleaseReason =
  | 'not_found'
  | 'not_completed'
  | 'open_case'
  | 'already_released'
  | 'refund_pending'
  | 'payment_missing'
  | 'currency_unsupported';

export type SettlementReleaseOutcome =
  | {
      released: true;
      settlementId: string;
      amountMinor: string;
      currency: string;
      ledgerTransactionId: string;
      replayed: boolean;
    }
  | {
      released: false;
      reason: SettlementReleaseReason;
      settlementId: string | null;
    };

export type TenantFinanceSummary = {
  tenantId: string;
  currency: 'IDR';
  /** Captured order payments (order_payments). */
  paidInMinor: string;
  /** Refunds confirmed successful by the provider. */
  refundedMinor: string;
  /** Orders that are not terminal yet (money still being worked on). */
  unfinishedMinor: string;
  /** Released and not yet paid out nor held (ledger projection). */
  availableMinor: string;
  /** Held by an active payout (ledger projection). */
  heldMinor: string;
  /** Payouts confirmed successful. */
  paidOutMinor: string;
  /** Sum of released settlements (available + paid_out). */
  releasedMinor: string;
};

export type FinanceTransactionType =
  | 'settlement_release'
  | 'payout_hold'
  | 'payout_settle'
  | 'payout_release'
  | 'other';

export type FinanceTransaction = {
  id: string;
  transactionId: string;
  type: FinanceTransactionType;
  direction: 'debit' | 'credit';
  amountMinor: string;
  currency: string;
  /** orderId for a release, payoutId for payout legs. */
  referenceId: string | null;
  occurredAt: string;
};

export type FinanceTransactionPage = {
  items: FinanceTransaction[];
  nextCursor: string | null;
};

type SettlementRow = {
  id: string;
  status: string;
  amount_minor: string;
  release_ledger_transaction_id: string | null;
};

/**
 * Settlement (tenant payable) rules of the pilot.
 *
 * Money moves from the shared escrow account to a per-tenant payable account
 * ONLY when an order is completed AND has no open operational case AND no
 * refund row (docs/PILOT-POLICY.md, D18 Q1/Q2/Q3). The balance is a ledger
 * projection, never a column, and every release is one balanced
 * WalletService.postTransfer with its own idempotency key, so a replay returns
 * the same transaction instead of posting a second one.
 *
 * The release is triggered from two slices (pickup handover and the terminal
 * case decision) inside THEIR transaction. Those calls must never fail a
 * legitimate business action, so they go through releaseAfterHandover /
 * releaseAfterCaseDecision, which own a savepoint, an audit row and a log line.
 */
@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
    private readonly orders: OrdersService,
    @Inject(forwardRef(() => CasesService))
    private readonly cases: CasesService,
  ) {}

  // -------------------------------------------------------------------------
  // Release
  // -------------------------------------------------------------------------

  /**
   * Releases the order payable into `tenant.payable.<tenantId>`.
   *
   * Lock order (docs/design section 6): settlements row lookup -> order row
   * FOR UPDATE (orders slice) -> cases FOR SHARE -> refund row -> escrow
   * account -> payable account FOR UPDATE -> postTransfer -> INSERT
   * settlements -> audit. The payable lock is always taken before
   * postTransfer, which itself locks both accounts in ascending id order, so
   * concurrent releases/payouts of the same tenant serialize on the payable
   * row instead of deadlocking.
   *
   * Idempotent: a replay (settlement row already present, or a ledger replay
   * of the same order key) reports already_released without a second posting.
   */
  async releaseForOrder(
    client: PoolClient,
    tenantId: string,
    orderId: string,
    actor: SettlementActor,
  ): Promise<SettlementReleaseOutcome> {
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(orderId, 'order id');
    this.assertActor(actor);

    const existing = await client.query<SettlementRow>(
      `select id::text, status, amount_minor::text,
              release_ledger_transaction_id::text
         from settlements where order_id = $1`,
      [orderId],
    );
    if (existing.rows[0])
      return {
        released: false,
        reason: 'already_released',
        settlementId: existing.rows[0].id,
      };

    const context = await this.orders.getOrderSettlementContext(
      client,
      tenantId,
      orderId,
    );
    if (!context)
      return { released: false, reason: 'not_found', settlementId: null };
    if (context.status !== 'completed')
      return { released: false, reason: 'not_completed', settlementId: null };

    if (await this.cases.hasOpenCasesForOrder(client, tenantId, orderId))
      return { released: false, reason: 'open_case', settlementId: null };

    // Pilot: a refund row and a release are mutually exclusive for one order
    // (D18 Q3 - no clawback after release).
    const refund = await client.query<{ id: string }>(
      `select id::text from refunds where order_id = $1 limit 1`,
      [orderId],
    );
    if (refund.rows[0])
      return { released: false, reason: 'refund_pending', settlementId: null };

    if (!context.orderPaymentId)
      return { released: false, reason: 'payment_missing', settlementId: null };
    const payment = await client.query<{
      amount_minor: string;
      currency: string;
    }>(
      `select amount_minor::text, currency from order_payments
        where id = $1 and order_id = $2 and status = 'succeeded'`,
      [context.orderPaymentId, orderId],
    );
    const captured = payment.rows[0];
    if (!captured)
      return { released: false, reason: 'payment_missing', settlementId: null };
    if (captured.currency !== 'IDR')
      return {
        released: false,
        reason: 'currency_unsupported',
        settlementId: null,
      };

    const escrow = await this.wallet.ensureSystemAccount(
      ORDER_PAYMENT_ESCROW_ACCOUNT,
      'IDR',
      client,
    );
    const payable = await this.wallet.lockSystemAccount(
      TENANT_PAYABLE_SYSTEM_KEY_PREFIX + tenantId,
      'IDR',
      client,
    );

    const posted = await this.wallet.postTransfer(
      {
        idempotencyScope: SETTLEMENT_RELEASE_IDEMPOTENCY_SCOPE,
        idempotencyKey: orderId,
        reference: {
          namespace: SETTLEMENT_RELEASE_REFERENCE_NAMESPACE,
          id: orderId,
        },
        currency: 'IDR',
        amountMinor: captured.amount_minor,
        debitAccountId: escrow.accountId,
        creditAccountId: payable.accountId,
        actor,
        reason: 'Order payable released after handover without open case',
        metadata: { orderId, tenantId },
      },
      client,
    );

    let settlementId: string;
    // Savepoint: a concurrent release that already inserted the settlement row
    // makes this INSERT fail, and a bare catch would leave the caller's
    // transaction aborted (every later statement would be rejected).
    await client.query('savepoint settlement_insert');
    try {
      const inserted = await client.query<{ id: string }>(
        `insert into settlements
           (tenant_id, order_id, order_payment_id, amount_minor, currency,
            status, paid_out_minor, release_ledger_transaction_id, released_at,
            created_at, updated_at)
         values ($1, $2, $3, $4, 'IDR', 'available', 0, $5, now(), now(), now())
         returning id::text`,
        [
          tenantId,
          orderId,
          context.orderPaymentId,
          captured.amount_minor,
          posted.transactionId,
        ],
      );
      settlementId = inserted.rows[0].id;
      await client.query('release savepoint settlement_insert');
    } catch (error) {
      await client.query('rollback to savepoint settlement_insert');
      await client.query('release savepoint settlement_insert');
      if (isUniqueViolation(error, 'settlements_one_per_order_uq')) {
        const raced = await client.query<{ id: string }>(
          `select id::text from settlements where order_id = $1`,
          [orderId],
        );
        return {
          released: false,
          reason: 'already_released',
          settlementId: raced.rows[0]?.id ?? null,
        };
      }
      throw error;
    }

    await this.audit.append(client, {
      actor:
        actor.type === 'user' ? { userId: actor.id } : { service: actor.id },
      scopeType: 'tenant',
      scopeId: tenantId,
      action: 'tenant.payable.released',
      targetType: 'settlement',
      targetId: settlementId,
      reason: 'Order payable released after handover without open case',
      metadata: {
        orderId,
        amountMinor: captured.amount_minor,
        currency: 'IDR',
        replayed: posted.replayed,
      },
    });

    return {
      released: true,
      settlementId,
      amountMinor: captured.amount_minor,
      currency: 'IDR',
      ledgerTransactionId: posted.transactionId,
      replayed: posted.replayed,
    };
  }

  /**
   * Release attempt from the pickup handover transaction (D18 Q2a). Runs after
   * OrdersService.markHandedOver succeeded, in the SAME transaction, and never
   * fails the handover: business blocks are reported as a deferred audit row
   * and unexpected errors are contained by a savepoint (a PostgreSQL error
   * aborts the transaction, so a bare try/catch is not enough).
   */
  async releaseAfterHandover(
    client: PoolClient,
    tenantId: string,
    orderId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.releaseQuietly(
      client,
      tenantId,
      orderId,
      actorUserId,
      'handover',
    );
  }

  /**
   * Release attempt after a terminal, non-cancelling case decision
   * ('resolved'/'declined'), in the SAME transaction as the decision (D18 Q2b).
   * A blocked or failed release leaves the decision intact; the money stays in
   * escrow for a later manual/retry release.
   */
  async releaseAfterCaseDecision(
    client: PoolClient,
    tenantId: string,
    orderId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.releaseQuietly(
      client,
      tenantId,
      orderId,
      actorUserId,
      'case_decision',
    );
  }

  private async releaseQuietly(
    client: PoolClient,
    tenantId: string,
    orderId: string,
    actorUserId: string,
    source: 'handover' | 'case_decision',
  ): Promise<void> {
    await client.query('savepoint settlement_release_attempt');
    let outcome: SettlementReleaseOutcome;
    try {
      outcome = await this.releaseForOrder(client, tenantId, orderId, {
        type: 'user',
        id: actorUserId,
      });
    } catch (error) {
      await client.query('rollback to savepoint settlement_release_attempt');
      await client.query('release savepoint settlement_release_attempt');
      const code = errorCodeOf(error);
      this.logger.warn(
        'Settlement release failed for order ' +
          orderId +
          ' (' +
          source +
          '); money stays in escrow until a retry release succeeds (code ' +
          code +
          ')',
      );
      await this.appendQuietAudit(client, {
        tenantId,
        orderId,
        actorUserId,
        action: 'tenant.payable.release_failed',
        reason: 'Automatic settlement release failed; retry is required',
        metadata: { source, errorCode: code },
      });
      return;
    }
    await client.query('release savepoint settlement_release_attempt');

    if (outcome.released) return;
    if (outcome.reason === 'already_released' || outcome.reason === 'not_found')
      return;
    await this.appendQuietAudit(client, {
      tenantId,
      orderId,
      actorUserId,
      action: 'tenant.payable.release_deferred',
      reason: 'Settlement release is deferred by a business rule',
      metadata: { source, reason: outcome.reason },
    });
  }

  private async appendQuietAudit(
    client: PoolClient,
    input: {
      tenantId: string;
      orderId: string;
      actorUserId: string;
      action: string;
      reason: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.audit.append(client, {
        actor: { userId: input.actorUserId },
        scopeType: 'tenant',
        scopeId: input.tenantId,
        action: input.action,
        targetType: 'order',
        targetId: input.orderId,
        reason: input.reason,
        metadata: input.metadata,
      });
    } catch {
      // The audit trail must never turn a contained release problem into a
      // failed handover/decision; the warning log above is the fallback.
      this.logger.warn(
        'Could not record settlement audit ' +
          input.action +
          ' for order ' +
          input.orderId,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Read models (finance summary / transaction feed)
  // -------------------------------------------------------------------------

  /**
   * Tenant finance summary derived from rows and ledger projections
   * (REQUIREMENTS section 3.8.1). Only the verified owner reaches this method:
   * AccessService rejects every non-owner role for tenant.finance.read.
   */
  async getFinanceSummary(
    actorUserId: string,
    tenantId: string,
  ): Promise<TenantFinanceSummary> {
    this.assertUuid(actorUserId, 'user id');
    this.assertUuid(tenantId, 'tenant id');
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.finance.read',
        tx,
      );
      const paidIn = await tx.query<{ total: string }>(
        `select coalesce(sum(op.amount_minor), 0)::text as total
           from order_payments op
           join orders o on o.id = op.order_id
          where o.tenant_id = $1 and op.status = 'succeeded'`,
        [tenantId],
      );
      const refunded = await tx.query<{ total: string }>(
        `select coalesce(sum(amount_minor), 0)::text as total
           from refunds
          where tenant_id = $1 and status = 'succeeded'`,
        [tenantId],
      );
      const unfinished = await tx.query<{ total: string }>(
        `select coalesce(sum(total_minor), 0)::text as total
           from orders
          where tenant_id = $1
            and status not in ('completed', 'cancelled', 'declined')`,
        [tenantId],
      );
      const paidOut = await tx.query<{ total: string }>(
        `select coalesce(sum(amount_minor), 0)::text as total
           from payouts
          where tenant_id = $1 and status = 'succeeded'`,
        [tenantId],
      );
      const released = await tx.query<{ total: string }>(
        `select coalesce(sum(amount_minor), 0)::text as total
           from settlements
          where tenant_id = $1 and status in ('available', 'paid_out')`,
        [tenantId],
      );
      const balances = await this.getAvailableBalance(tx, tenantId, 'IDR');
      return {
        tenantId,
        currency: 'IDR' as const,
        paidInMinor: paidIn.rows[0].total,
        refundedMinor: refunded.rows[0].total,
        unfinishedMinor: unfinished.rows[0].total,
        availableMinor: balances.availableMinor,
        heldMinor: balances.heldMinor,
        paidOutMinor: paidOut.rows[0].total,
        releasedMinor: released.rows[0].total,
      };
    });
  }

  /**
   * Available/held tenant funds as ledger projections (D18 Q1). Missing
   * accounts read as zero; nothing is created here.
   */
  async getAvailableBalance(
    client: PoolClient | undefined,
    tenantId: string,
    currency: 'IDR',
  ): Promise<{ availableMinor: string; heldMinor: string }> {
    this.assertUuid(tenantId, 'tenant id');
    const query = client
      ? client.query.bind(client)
      : this.database.pool.query.bind(this.database.pool);
    const result = await query<{ system_key: string; balance_minor: string }>(
      `select system_key, balance_minor::text
         from wallet_accounts
        where account_type = 'system'
          and currency = $2
          and system_key = any($1::text[])`,
      [
        [
          TENANT_PAYABLE_SYSTEM_KEY_PREFIX + tenantId,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + tenantId,
        ],
        currency,
      ],
    );
    let availableMinor = '0';
    let heldMinor = '0';
    for (const row of result.rows) {
      if (row.system_key === TENANT_PAYABLE_SYSTEM_KEY_PREFIX + tenantId)
        availableMinor = row.balance_minor;
      else heldMinor = row.balance_minor;
    }
    return { availableMinor, heldMinor };
  }

  /**
   * Cursor-paged ledger feed of the tenant payable/hold accounts: the single
   * source of truth for "what moved and why" (settlement release, payout hold,
   * payout settle, payout release).
   */
  async listFinanceTransactions(
    actorUserId: string,
    tenantId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<FinanceTransactionPage> {
    this.assertUuid(actorUserId, 'user id');
    this.assertUuid(tenantId, 'tenant id');
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.finance.read',
        tx,
      );
      const limit = normalizeLimit(options.limit);
      const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
      const values: unknown[] = [
        [
          TENANT_PAYABLE_SYSTEM_KEY_PREFIX + tenantId,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + tenantId,
        ],
      ];
      let where =
        "a.account_type = 'system' and a.system_key = any($1::text[]) and a.currency = 'IDR'";
      if (cursor) {
        values.push(cursor.createdAt, cursor.id);
        where +=
          ' and (e.created_at, e.id) < ($' +
          String(values.length - 1) +
          '::timestamptz, $' +
          String(values.length) +
          '::uuid)';
      }
      values.push(limit + 1);
      const result = await tx.query<{
        id: string;
        transaction_id: string;
        direction: 'debit' | 'credit';
        amount_minor: string;
        currency: string;
        reference_namespace: string | null;
        reference_id: string | null;
        occurred_at: string;
        cursor_created_at: string;
      }>(
        `select e.id::text, e.transaction_id::text, e.direction,
                e.amount_minor::text, t.currency, t.reference_namespace,
                t.reference_id, ${SQL_TS('e.created_at')} as occurred_at,
                ${SQL_TS('e.created_at')} as cursor_created_at
           from ledger_entries e
           join ledger_transactions t on t.id = e.transaction_id
           join wallet_accounts a on a.id = e.account_id
          where ${where}
          order by e.created_at desc, e.id desc
          limit $${String(values.length)}`,
        values,
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.id,
          transactionId: row.transaction_id,
          type: transactionTypeOf(row.reference_namespace),
          direction: row.direction,
          amountMinor: row.amount_minor,
          currency: row.currency,
          referenceId: row.reference_id,
          occurredAt: row.occurred_at,
        })),
        nextCursor:
          hasMore && last
            ? encodeCursor({ createdAt: last.cursor_created_at, id: last.id })
            : null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private assertUuid(value: string, field: string): void {
    if (!uuidPattern.test(value ?? ''))
      throw new BadRequestException('Invalid ' + field);
  }

  private assertActor(actor: SettlementActor): void {
    if (!actor || (actor.type !== 'user' && actor.type !== 'service'))
      throw new BadRequestException('Invalid settlement actor');
    if (actor.type === 'user' && !uuidPattern.test(actor.id))
      throw new BadRequestException('Invalid settlement actor');
    if (actor.type === 'service' && !/^[a-z][a-z0-9._-]{0,79}$/.test(actor.id))
      throw new BadRequestException('Invalid settlement actor');
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

function transactionTypeOf(namespace: string | null): FinanceTransactionType {
  switch (namespace) {
    case SETTLEMENT_RELEASE_REFERENCE_NAMESPACE:
      return 'settlement_release';
    case 'payout_hold':
      return 'payout_hold';
    case 'payout_settle':
      return 'payout_settle';
    case 'payout_release':
      return 'payout_release';
    default:
      return 'other';
  }
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
    throw new BadRequestException('Invalid finance transaction cursor');
  }
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === '23505' &&
    (constraint === undefined ||
      (error as { constraint?: string }).constraint === constraint)
  );
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const withCode = error as { code?: unknown; response?: { code?: unknown } };
    if (typeof withCode.response?.code === 'string')
      return withCode.response.code;
    if (typeof withCode.code === 'string') return withCode.code;
  }
  return 'SETTLEMENT_RELEASE_FAILED';
}
