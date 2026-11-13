import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './index';

/**
 * All monetary values are integer minor units encoded as decimal strings.
 * System accounts may have a negative projection (for example, provider
 * clearing); user wallet accounts may not.
 */
export const walletAccounts = pgTable(
  'wallet_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountType: varchar('account_type', { length: 16 }).notNull(),
    ownerUserId: uuid('owner_user_id'),
    systemKey: varchar('system_key', { length: 120 }),
    currency: varchar('currency', { length: 3 }).notNull(),
    balanceMinor: numeric('balance_minor').default('0').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Composite FK target (migration 0007, decision D12.3): a real UNIQUE
    // constraint so `topup_intents_user_wallet_fk` can reference
    // (owner_user_id, id) and prove the wallet belongs to the top-up user.
    // System accounts (owner_user_id NULL) stay safe: NULLs are distinct.
    unique('wallet_accounts_owner_id_uq').on(table.ownerUserId, table.id),
    uniqueIndex('wallet_accounts_owner_currency_uq')
      .on(table.ownerUserId, table.currency)
      .where(sql`${table.ownerUserId} is not null`),
    uniqueIndex('wallet_accounts_system_currency_uq')
      .on(table.systemKey, table.currency)
      .where(sql`${table.systemKey} is not null`),
    index('wallet_accounts_owner_idx').on(table.ownerUserId),
    check(
      'wallet_accounts_type_owner_check',
      sql`(${table.accountType} = 'wallet' and ${table.ownerUserId} is not null and ${table.systemKey} is null) or (${table.accountType} = 'system' and ${table.ownerUserId} is null and ${table.systemKey} is not null)`,
    ),
    check(
      'wallet_accounts_currency_check',
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      'wallet_accounts_balance_nonnegative_check',
      sql`${table.accountType} = 'system' or ${table.balanceMinor} >= 0`,
    ),
    check(
      'wallet_accounts_balance_integer_precision_check',
      sql`${table.balanceMinor} = trunc(${table.balanceMinor}) and abs(${table.balanceMinor}) < 1e38`,
    ),
    check(
      'wallet_accounts_system_key_check',
      sql`${table.systemKey} is null or length(trim(${table.systemKey})) > 0`,
    ),
    foreignKey({
      name: 'wallet_accounts_owner_user_fk',
      columns: [table.ownerUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
  ],
);

export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    currency: varchar('currency', { length: 3 }).notNull(),
    idempotencyScope: varchar('idempotency_scope', { length: 120 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    actorType: varchar('actor_type', { length: 16 }).notNull(),
    actorId: varchar('actor_id', { length: 200 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    referenceNamespace: varchar('reference_namespace', { length: 120 }),
    referenceId: varchar('reference_id', { length: 200 }),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('ledger_transactions_idempotency_uq').on(
      table.idempotencyScope,
      table.idempotencyKey,
    ),
    uniqueIndex('ledger_transactions_reference_uq')
      .on(table.referenceNamespace, table.referenceId)
      .where(sql`${table.referenceId} is not null`),
    index('ledger_transactions_created_idx').on(table.createdAt, table.id),
    check(
      'ledger_transactions_currency_check',
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      'ledger_transactions_actor_type_check',
      sql`${table.actorType} in ('user', 'service')`,
    ),
    check(
      'ledger_transactions_reference_pair_check',
      sql`(${table.referenceNamespace} is null and ${table.referenceId} is null) or (${table.referenceNamespace} is not null and ${table.referenceId} is not null)`,
    ),
    check(
      'ledger_transactions_request_hash_check',
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    transactionId: uuid('transaction_id').notNull(),
    accountId: uuid('account_id').notNull(),
    direction: varchar('direction', { length: 8 }).notNull(),
    amountMinor: numeric('amount_minor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('ledger_entries_transaction_account_uq').on(
      table.transactionId,
      table.accountId,
    ),
    index('ledger_entries_account_transaction_idx').on(
      table.accountId,
      table.transactionId,
    ),
    check(
      'ledger_entries_direction_check',
      sql`${table.direction} in ('debit', 'credit')`,
    ),
    check(
      'ledger_entries_amount_positive_check',
      sql`${table.amountMinor} > 0`,
    ),
    check(
      'ledger_entries_amount_integer_precision_check',
      sql`${table.amountMinor} = trunc(${table.amountMinor}) and ${table.amountMinor} < 1e38`,
    ),
    foreignKey({
      name: 'ledger_entries_transaction_fk',
      columns: [table.transactionId],
      foreignColumns: [ledgerTransactions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ledger_entries_account_fk',
      columns: [table.accountId],
      foreignColumns: [walletAccounts.id],
    }).onDelete('restrict'),
  ],
);

export const walletOutboxEvents = pgTable(
  'wallet_outbox_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventType: varchar('event_type', { length: 120 }).notNull(),
    aggregateType: varchar('aggregate_type', { length: 80 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').default(0).notNull(),
  },
  (table) => [
    uniqueIndex('wallet_outbox_event_aggregate_uq').on(
      table.eventType,
      table.aggregateType,
      table.aggregateId,
    ),
    index('wallet_outbox_unpublished_idx')
      .on(table.occurredAt, table.id)
      .where(sql`${table.publishedAt} is null`),
    check(
      'wallet_outbox_attempts_nonnegative_check',
      sql`${table.attempts} >= 0`,
    ),
    foreignKey({
      name: 'wallet_outbox_transaction_fk',
      columns: [table.aggregateId],
      foreignColumns: [ledgerTransactions.id],
    }).onDelete('restrict'),
  ],
);
