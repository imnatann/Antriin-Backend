import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';

const MONEY_PATTERN = /^(0|[1-9][0-9]*)$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_MINOR_DIGITS = 38;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export type WalletBalance = {
  accountId: string | null;
  currency: string;
  balanceMinor: string;
};

export type TransferReference = {
  namespace: string;
  id: string;
};

export type PostTransferInput = {
  idempotencyScope: string;
  idempotencyKey: string;
  reference?: TransferReference;
  currency: string;
  /** Integer minor units encoded as a decimal string; must be positive. */
  amountMinor: string;
  /** Debit reduces the debit account; credit increases the credit account. */
  debitAccountId: string;
  creditAccountId: string;
  actor: { type: 'user' | 'service'; id: string };
  reason: string;
  /** Internal, non-secret audit context. Never include credentials or PII. */
  metadata?: Record<string, unknown>;
};

export type PostedTransfer = {
  transactionId: string;
  currency: string;
  amountMinor: string;
  debitAccountId: string;
  creditAccountId: string;
  createdAt: string;
  replayed: boolean;
};

export type WalletTransaction = {
  id: string;
  currency: string;
  direction: 'debit' | 'credit';
  amountMinor: string;
  createdAt: string;
};

export type WalletTransactionPage = {
  items: WalletTransaction[];
  nextCursor: string | null;
};

type Cursor = { createdAt: string; id: string };
type Queryable = Pick<PoolClient, 'query'>;

type LedgerTransactionRow = {
  id: string;
  request_hash: string;
  currency: string;
  created_at: Date;
};

@Injectable()
export class WalletService {
  constructor(private readonly database: DatabaseService) {}

  async getOrCreateWallet(
    userId: string,
    currency: string,
    client?: PoolClient,
  ): Promise<WalletBalance & { accountId: string }> {
    assertUuid(userId, 'userId');
    assertCurrency(currency);
    return this.withClient(client, async (connection) => {
      await connection.query(
        `insert into wallet_accounts (account_type, owner_user_id, currency)
         values ('wallet', $1, $2)
         on conflict do nothing`,
        [userId, currency],
      );
      const result = await connection.query<{
        id: string;
        currency: string;
        balance_minor: string;
      }>(
        `select id, currency, balance_minor::text
           from wallet_accounts
          where account_type = 'wallet' and owner_user_id = $1 and currency = $2`,
        [userId, currency],
      );
      const account = result.rows[0];
      if (!account) throw new NotFoundException('User account was not found');
      return {
        accountId: account.id,
        currency: account.currency,
        balanceMinor: account.balance_minor,
      };
    });
  }

  async ensureSystemAccount(
    systemKey: string,
    currency: string,
    client?: PoolClient,
  ): Promise<{ accountId: string; currency: string }> {
    if (!systemKey.trim() || systemKey.length > 120)
      throw new BadRequestException('Invalid system account key');
    assertCurrency(currency);
    return this.withClient(client, async (connection) => {
      await connection.query(
        `insert into wallet_accounts (account_type, system_key, currency)
         values ('system', $1, $2)
         on conflict do nothing`,
        [systemKey, currency],
      );
      const result = await connection.query<{
        id: string;
        currency: string;
      }>(
        `select id, currency from wallet_accounts
          where account_type = 'system' and system_key = $1 and currency = $2`,
        [systemKey, currency],
      );
      const account = result.rows[0];
      if (!account) throw new NotFoundException('System account was not found');
      return { accountId: account.id, currency: account.currency };
    });
  }

  /**
   * Creates the system account when missing and locks its row FOR UPDATE,
   * returning the ledger projection balance (docs/design/settlement-payout.md
   * section 4.3, D18 Q10).
   *
   * A transaction client is REQUIRED: the lock only serializes the balance
   * check against a concurrent hold/release when it lives until that
   * transaction commits. Callers must take this lock before calling
   * postTransfer, which locks both accounts in ascending id order; a flow that
   * pre-locks one of them keeps the global order "tenant payable first".
   */
  async lockSystemAccount(
    systemKey: string,
    currency: string,
    client: PoolClient,
  ): Promise<{ accountId: string; balanceMinor: string }> {
    if (!systemKey.trim() || systemKey.length > 120)
      throw new BadRequestException('Invalid system account key');
    assertCurrency(currency);
    if (!client)
      throw new BadRequestException(
        'lockSystemAccount requires a transaction client',
      );
    await client.query(
      `insert into wallet_accounts (account_type, system_key, currency)
       values ('system', $1, $2)
       on conflict do nothing`,
      [systemKey, currency],
    );
    const result = await client.query<{ id: string; balance_minor: string }>(
      `select id, balance_minor::text
         from wallet_accounts
        where account_type = 'system' and system_key = $1 and currency = $2
        for update`,
      [systemKey, currency],
    );
    const account = result.rows[0];
    if (!account) throw new NotFoundException('System account was not found');
    return { accountId: account.id, balanceMinor: account.balance_minor };
  }

  /** Return wallet balances without creating or changing wallet accounts. */
  async getBalance(
    userId: string,
    currency?: string,
    client?: PoolClient,
  ): Promise<WalletBalance[]> {
    assertUuid(userId, 'userId');
    if (currency !== undefined) assertCurrency(currency);
    const connection: Queryable = client ?? this.database.pool;
    const result = await connection.query<{
      id: string | null;
      currency: string | null;
      balance_minor: string | null;
    }>(
      `select a.id, a.currency, a.balance_minor::text
           from users u
           left join wallet_accounts a
             on a.owner_user_id = u.id and a.account_type = 'wallet'
            and ($2::varchar is null or a.currency = $2)
          where u.id = $1
          order by a.currency asc`,
      [userId, currency ?? null],
    );
    if (result.rows.length === 0)
      throw new NotFoundException('User account was not found');
    if (currency !== undefined && result.rows[0].id === null)
      return [{ accountId: null, currency, balanceMinor: '0' }];
    return result.rows.flatMap((row) =>
      row.id && row.currency && row.balance_minor !== null
        ? [
            {
              accountId: row.id,
              currency: row.currency,
              balanceMinor: row.balance_minor,
            },
          ]
        : [],
    );
  }

  async listTransactions(
    userId: string,
    options: { currency?: string; cursor?: string; limit?: number } = {},
  ): Promise<WalletTransactionPage> {
    assertUuid(userId, 'userId');
    if (options.currency !== undefined) assertCurrency(options.currency);
    const user = await this.database.pool.query(
      'select 1 from users where id = $1',
      [userId],
    );
    if (user.rowCount === 0)
      throw new NotFoundException('User account was not found');
    const limit = normalizeLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    const queryValues: unknown[] = [userId];
    let where = `a.account_type = 'wallet' and a.owner_user_id = $1`;
    if (options.currency !== undefined) {
      queryValues.push(options.currency);
      where += ` and a.currency = $${queryValues.length}`;
    }
    if (cursor) {
      queryValues.push(cursor.createdAt, cursor.id);
      where += ` and (t.created_at, t.id) < ($${queryValues.length - 1}::timestamptz, $${queryValues.length}::uuid)`;
    }
    queryValues.push(limit + 1);
    const result = await this.database.pool.query<{
      id: string;
      currency: string;
      direction: 'debit' | 'credit';
      amount_minor: string;
      created_at: Date;
      cursor_created_at: string;
    }>(
      `select t.id, t.currency, e.direction, e.amount_minor::text,
              t.created_at,
              to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
         from wallet_accounts a
         join ledger_entries e on e.account_id = a.id
         join ledger_transactions t on t.id = e.transaction_id
        where ${where}
        order by t.created_at desc, t.id desc
        limit $${queryValues.length}`,
      queryValues,
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        currency: row.currency,
        direction: row.direction,
        amountMinor: row.amount_minor,
        createdAt: row.created_at.toISOString(),
      })),
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.cursor_created_at, id: last.id })
          : null,
    };
  }

  /**
   * Atomically post a balanced two-account transfer. If `client` is supplied,
   * the caller owns its transaction; this method uses a savepoint and never
   * commits or rolls back that outer transaction. Debit reduces its account;
   * credit increases its account.
   */
  async postTransfer(
    input: PostTransferInput,
    client?: PoolClient,
  ): Promise<PostedTransfer> {
    const normalized = normalizeTransfer(input);
    return this.withClient(client, async (connection) => {
      await connection.query('savepoint wallet_post_transfer');
      try {
        const inserted = await connection.query<{ id: string }>(
          `insert into ledger_transactions
             (currency, idempotency_scope, idempotency_key, request_hash,
              actor_type, actor_id, reason, reference_namespace, reference_id, metadata)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           on conflict (idempotency_scope, idempotency_key) do nothing
           returning id`,
          [
            normalized.currency,
            normalized.idempotencyScope,
            normalized.idempotencyKey,
            normalized.requestHash,
            normalized.actor.type,
            normalized.actor.id,
            normalized.reason,
            normalized.reference?.namespace ?? null,
            normalized.reference?.id ?? null,
            JSON.stringify(normalized.metadata),
          ],
        );

        if (inserted.rowCount === 0) {
          const existing = await connection.query<LedgerTransactionRow>(
            `select id, request_hash, currency, created_at
               from ledger_transactions
              where idempotency_scope = $1 and idempotency_key = $2`,
            [normalized.idempotencyScope, normalized.idempotencyKey],
          );
          const transaction = existing.rows[0];
          if (!transaction)
            throw new ConflictException({
              code: 'IDEMPOTENCY_RESULT_UNAVAILABLE',
              message: 'The original ledger result could not be loaded',
            });
          if (transaction.request_hash !== normalized.requestHash)
            throw new ConflictException({
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: 'Idempotency key was already used with different input',
            });
          await connection.query('release savepoint wallet_post_transfer');
          return {
            transactionId: transaction.id,
            currency: transaction.currency,
            amountMinor: normalized.amountMinor,
            debitAccountId: normalized.debitAccountId,
            creditAccountId: normalized.creditAccountId,
            createdAt: transaction.created_at.toISOString(),
            replayed: true,
          };
        }

        const transactionId = inserted.rows[0].id;
        const accounts = await connection.query<{
          id: string;
          account_type: 'wallet' | 'system';
          currency: string;
          balance_minor: string;
        }>(
          `select id, account_type, currency, balance_minor::text
             from wallet_accounts
            where id = any($1::uuid[])
            order by id asc
            for update`,
          [[normalized.debitAccountId, normalized.creditAccountId]],
        );
        if (accounts.rows.length !== 2)
          throw new NotFoundException(
            'One or more ledger accounts were not found',
          );
        for (const account of accounts.rows) {
          if (account.currency !== normalized.currency)
            throw new ConflictException({
              code: 'LEDGER_CURRENCY_MISMATCH',
              message: 'Transfer accounts must use the transaction currency',
            });
        }
        const debit = accounts.rows.find(
          (account) => account.id === normalized.debitAccountId,
        );
        if (!debit) throw new NotFoundException('Debit account was not found');
        if (
          debit.account_type === 'wallet' &&
          BigInt(debit.balance_minor) < BigInt(normalized.amountMinor)
        )
          throw new ConflictException({
            code: 'INSUFFICIENT_WALLET_BALANCE',
            message: 'Wallet balance is insufficient',
          });

        await connection.query(
          `insert into ledger_entries (transaction_id, account_id, direction, amount_minor)
           values ($1, $2, 'debit', $3), ($1, $4, 'credit', $3)`,
          [
            transactionId,
            normalized.debitAccountId,
            normalized.amountMinor,
            normalized.creditAccountId,
          ],
        );
        await connection.query(
          `insert into wallet_outbox_events
             (event_type, aggregate_type, aggregate_id, payload)
           values ('ledger.transfer.posted', 'ledger_transaction', $1, $2::jsonb)`,
          [
            transactionId,
            JSON.stringify({
              transactionId,
              currency: normalized.currency,
            }),
          ],
        );
        await connection.query(
          `update ledger_transactions set posted_at = now() where id = $1`,
          [transactionId],
        );
        const transaction = await connection.query<{ created_at: Date }>(
          `select created_at from ledger_transactions where id = $1`,
          [transactionId],
        );
        await connection.query('release savepoint wallet_post_transfer');
        return {
          transactionId,
          currency: normalized.currency,
          amountMinor: normalized.amountMinor,
          debitAccountId: normalized.debitAccountId,
          creditAccountId: normalized.creditAccountId,
          createdAt: transaction.rows[0].created_at.toISOString(),
          replayed: false,
        };
      } catch (error) {
        await connection.query('rollback to savepoint wallet_post_transfer');
        await connection.query('release savepoint wallet_post_transfer');
        if (isUniqueViolation(error))
          throw new ConflictException({
            code: 'LEDGER_REFERENCE_ALREADY_POSTED',
            message: 'A ledger transaction already uses this reference',
          });
        throw error;
      }
    });
  }

  private async withClient<T>(
    client: PoolClient | undefined,
    operation: (connection: Queryable) => Promise<T>,
  ): Promise<T> {
    if (client) return operation(client);
    const connection = await this.database.pool.connect();
    try {
      await connection.query('begin');
      const result = await operation(connection);
      await connection.query('commit');
      return result;
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }
  }
}

function normalizeTransfer(input: PostTransferInput) {
  assertCurrency(input.currency);
  assertUuid(input.debitAccountId, 'debitAccountId');
  assertUuid(input.creditAccountId, 'creditAccountId');
  if (input.debitAccountId === input.creditAccountId)
    throw new BadRequestException('Transfer accounts must be different');
  const amountMinor = normalizeMoney(input.amountMinor);
  if (amountMinor === '0')
    throw new BadRequestException('Transfer amount must be positive');
  assertText(input.idempotencyScope, 120, 'idempotencyScope');
  assertText(input.idempotencyKey, 200, 'idempotencyKey');
  if (input.reference) {
    assertText(input.reference.namespace, 120, 'reference.namespace');
    assertText(input.reference.id, 200, 'reference.id');
  }
  if (
    !input.actor ||
    !['user', 'service'].includes(input.actor.type) ||
    !input.actor.id.trim() ||
    input.actor.id.length > 200
  )
    throw new BadRequestException('Invalid actor');
  if (input.actor.type === 'user') assertUuid(input.actor.id, 'actor.id');
  assertText(input.reason, 500, 'reason');
  const metadata = input.metadata ?? {};
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        idempotencyScope: input.idempotencyScope,
        currency: input.currency,
        amountMinor,
        debitAccountId: input.debitAccountId,
        creditAccountId: input.creditAccountId,
        reference: input.reference ?? null,
        actor: input.actor,
        reason: input.reason,
        metadata: sortObject(metadata),
      }),
    )
    .digest('hex');
  return {
    ...input,
    currency: input.currency,
    amountMinor,
    metadata,
    requestHash,
  };
}

function normalizeMoney(value: string): string {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value))
    throw new BadRequestException('Money must be a decimal integer string');
  if (value.length > MAX_MINOR_DIGITS)
    throw new BadRequestException('Money value exceeds supported precision');
  return value;
}

function assertCurrency(currency: string): void {
  if (!CURRENCY_PATTERN.test(currency))
    throw new BadRequestException(
      'Currency must be a three-letter uppercase code',
    );
}

function assertText(value: string, maxLength: number, field: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength)
    throw new BadRequestException(`Invalid ${field}`);
}

function assertUuid(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new BadRequestException(`Invalid ${field}`);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT)
    throw new BadRequestException(
      `limit must be an integer from 1 to ${MAX_LIMIT}`,
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
    ) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.createdAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(parsed.createdAt) ||
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.id,
      )
    )
      throw new Error('invalid cursor shape');
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid transaction cursor');
  }
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortObject(item)]),
    );
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
