import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  numeric,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users, walletAccounts } from './index';

export const topupIntents = pgTable(
  'topup_intents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(),
    walletAccountId: uuid('wallet_account_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerReference: varchar('provider_reference', { length: 160 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    amountMinor: numeric('amount_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    status: varchar('status', { length: 24 }).default('pending').notNull(),
    statusVersion: integer('status_version').default(1).notNull(),
    // R1-08 (migration 0007): lifecycle timestamps required by REQUIREMENTS
    // §7.2 (`topups.expires_at`, `succeeded_at`). Nullable so the change is
    // additive for code written against schema 0006; the CHECKs below only
    // bind once a value is present.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('topup_intents_user_idempotency_uq').on(
      table.userId,
      table.idempotencyKey,
    ),
    uniqueIndex('topup_intents_provider_reference_uq').on(
      table.provider,
      table.providerReference,
    ),
    index('topup_intents_user_created_idx').on(
      table.userId,
      table.createdAt,
      table.id,
    ),
    check('topup_intents_provider_check', sql`${table.provider} = 'sandbox'`),
    check('topup_intents_currency_check', sql`${table.currency} = 'IDR'`),
    check(
      'topup_intents_amount_check',
      sql`${table.amountMinor} > 0 and ${table.amountMinor} = trunc(${table.amountMinor}) and ${table.amountMinor} < 1e38`,
    ),
    check(
      'topup_intents_hash_check',
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'topup_intents_status_check',
      sql`${table.status} in ('pending', 'succeeded', 'failed', 'expired', 'needs_assistance')`,
    ),
    check('topup_intents_version_check', sql`${table.statusVersion} > 0`),
    // R1-08: expiry must be in the future relative to creation when set.
    check(
      'topup_intents_expires_at_check',
      sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`,
    ),
    // R1-08: succeeded_at may only be populated for the succeeded status.
    check(
      'topup_intents_succeeded_at_check',
      sql`${table.succeededAt} is null or ${table.status} = 'succeeded'`,
    ),
    foreignKey({
      name: 'topup_intents_user_fk',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'topup_intents_wallet_account_fk',
      columns: [table.walletAccountId],
      foreignColumns: [walletAccounts.id],
    }).onDelete('restrict'),
    // R1-04 (migration 0007): the credited wallet must belong to the top-up
    // user. Requires UNIQUE(owner_user_id, id) on wallet_accounts
    // (`wallet_accounts_owner_id_uq`).
    foreignKey({
      name: 'topup_intents_user_wallet_fk',
      columns: [table.userId, table.walletAccountId],
      foreignColumns: [walletAccounts.ownerUserId, walletAccounts.id],
    }).onDelete('restrict'),
  ],
);

export const paymentRequestOutbox = pgTable(
  'payment_request_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    topupId: uuid('topup_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('payment_request_outbox_topup_uq').on(table.topupId),
    index('payment_request_outbox_pending_idx').on(
      table.status,
      table.availableAt,
      table.leaseUntil,
      table.id,
    ),
    check(
      'payment_request_outbox_provider_check',
      sql`${table.provider} = 'sandbox'`,
    ),
    check(
      'payment_request_outbox_status_check',
      sql`${table.status} in ('pending', 'processing', 'complete', 'dead')`,
    ),
    check('payment_request_outbox_attempts_check', sql`${table.attempts} >= 0`),
    check(
      'payment_request_outbox_lease_check',
      sql`(${table.status} = 'processing' and ${table.leaseToken} is not null and ${table.leaseUntil} is not null) or (${table.status} <> 'processing' and ${table.leaseToken} is null and ${table.leaseUntil} is null)`,
    ),
    foreignKey({
      name: 'payment_request_outbox_topup_fk',
      columns: [table.topupId],
      foreignColumns: [topupIntents.id],
    }).onDelete('restrict'),
  ],
);

export const paymentProviderEvents = pgTable(
  'payment_provider_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: varchar('provider', { length: 32 }).notNull(),
    eventId: varchar('event_id', { length: 200 }).notNull(),
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    topupId: uuid('topup_id'),
    providerStatus: varchar('provider_status', { length: 16 }).notNull(),
    outcome: varchar('outcome', { length: 20 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('payment_provider_events_provider_event_uq').on(
      table.provider,
      table.eventId,
    ),
    index('payment_provider_events_topup_received_idx').on(
      table.topupId,
      table.receivedAt,
    ),
    check(
      'payment_provider_events_provider_check',
      sql`${table.provider} = 'sandbox'`,
    ),
    check(
      'payment_provider_events_hash_check',
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'payment_provider_events_status_check',
      sql`${table.providerStatus} in ('pending', 'succeeded', 'failed', 'expired')`,
    ),
    check(
      'payment_provider_events_outcome_check',
      sql`${table.outcome} in ('applied', 'unmatched', 'mismatch', 'duplicate', 'ignored')`,
    ),
    foreignKey({
      name: 'payment_provider_events_topup_fk',
      columns: [table.topupId],
      foreignColumns: [topupIntents.id],
    }).onDelete('restrict'),
  ],
);
