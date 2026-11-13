import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { tenants, users } from './index';
import { settlements } from './settlements';
import { ledgerTransactions } from './wallet';

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Bank account a tenant owner registers for payouts
 * (docs/design/settlement-payout.md section 2.4).
 *
 * The full number is never stored in plaintext and never returned by the API:
 * account_number_ciphertext is AES-256-GCM, account_number_hash is a keyed
 * HMAC-SHA256 (low-entropy input, so a plain hash would be reversible by
 * enumeration) used for duplicate detection, and account_number_masked is the
 * only representation that may leave the server.
 *
 * Changing an account creates a NEW row and disables the previous one: existing
 * payouts keep their snapshot and history stays auditable.
 */
export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    bankCode: varchar('bank_code', { length: 20 }).notNull(),
    accountHolderName: varchar('account_holder_name', {
      length: 200,
    }).notNull(),
    accountNumberCiphertext: varchar('account_number_ciphertext', {
      length: 500,
    }).notNull(),
    accountNumberHash: varchar('account_number_hash', { length: 64 }).notNull(),
    accountNumberMasked: varchar('account_number_masked', {
      length: 32,
    }).notNull(),
    verificationStatus: varchar('verification_status', { length: 16 })
      .default('pending')
      .notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedByUserId: uuid('verified_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    verificationMethod: varchar('verification_method', { length: 32 }),
    status: varchar('status', { length: 16 }).default('active').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    version: integer('version').default(1).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('bank_accounts_tenant_id_id_uq').on(t.tenantId, t.id),
    // One active default account per tenant.
    uniqueIndex('bank_accounts_one_default_uq')
      .on(t.tenantId)
      .where(sql`${t.isDefault} and ${t.status} = 'active'`),
    // The same account cannot be registered twice while active.
    uniqueIndex('bank_accounts_tenant_number_uq')
      .on(t.tenantId, t.bankCode, t.accountNumberHash)
      .where(sql`${t.status} = 'active'`),
    index('bank_accounts_tenant_status_idx').on(t.tenantId, t.status),
    check(
      'bank_accounts_verification_check',
      sql`(${t.verificationStatus} = 'verified' and ${t.verifiedAt} is not null and ${t.verifiedByUserId} is not null and ${t.verificationMethod} is not null)
        or (${t.verificationStatus} <> 'verified' and ${t.verifiedAt} is null and ${t.verifiedByUserId} is null and ${t.verificationMethod} is null)`,
    ),
    check(
      'bank_accounts_verification_status_check',
      sql`${t.verificationStatus} in ('pending','verified','rejected')`,
    ),
    check(
      'bank_accounts_status_check',
      sql`${t.status} in ('active','disabled')`,
    ),
    check(
      'bank_accounts_hash_check',
      sql`${t.accountNumberHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'bank_accounts_masked_check',
      sql`length(${t.accountNumberMasked}) between 4 and 32`,
    ),
    check('bank_accounts_version_check', sql`${t.version} > 0`),
  ],
);

/**
 * One payout request from a verified tenant owner. The money leaves the
 * tenant's payable balance into a hold at request time, then either settles to
 * the provider or is released back - exactly once, enforced by
 * payouts_ledger_legs_check.
 */
export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    // Destination snapshot: a later account change must not retarget this payout.
    bankCode: varchar('bank_code', { length: 20 }).notNull(),
    accountNumberMasked: varchar('account_number_masked', {
      length: 32,
    }).notNull(),
    accountHolderName: varchar('account_holder_name', {
      length: 200,
    }).notNull(),
    amountMinor: numeric('amount_minor', { mode: 'string' }).notNull(),
    currency: varchar('currency', { length: 3 }).default('IDR').notNull(),
    status: varchar('status', { length: 16 }).default('requested').notNull(),
    provider: varchar('provider', { length: 32 }).default('sandbox').notNull(),
    providerReference: varchar('provider_reference', { length: 120 }),
    holdLedgerTransactionId: uuid('hold_ledger_transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    settleLedgerTransactionId: uuid('settle_ledger_transaction_id').references(
      () => ledgerTransactions.id,
      { onDelete: 'restrict' },
    ),
    releaseLedgerTransactionId: uuid(
      'release_ledger_transaction_id',
    ).references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    processingAt: timestamp('processing_at', { withTimezone: true }),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    failureCode: varchar('failure_code', { length: 64 }),
    lastError: varchar('last_error', { length: 500 }),
    version: integer('version').default(1).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('payouts_tenant_id_id_uq').on(t.tenantId, t.id),
    // One live payout per tenant: no parallel payouts draining the same balance.
    uniqueIndex('payouts_one_active_per_tenant_uq')
      .on(t.tenantId)
      .where(sql`${t.status} in ('requested','processing')`),
    uniqueIndex('payouts_provider_reference_uq')
      .on(t.provider, t.providerReference)
      .where(sql`${t.providerReference} is not null`),
    index('payouts_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('payouts_status_created_idx').on(t.status, t.createdAt),
    index('payouts_requester_idx').on(t.requestedByUserId),
    check(
      'payouts_amount_check',
      sql`${t.amountMinor} = trunc(${t.amountMinor}) and ${t.amountMinor} > 0 and ${t.amountMinor} < 1e38`,
    ),
    check('payouts_currency_check', sql`${t.currency} = 'IDR'`),
    check(
      'payouts_status_check',
      sql`${t.status} in ('requested','processing','succeeded','failed','cancelled')`,
    ),
    // The "exactly once" guard: one terminal ledger leg per payout.
    check(
      'payouts_ledger_legs_check',
      sql`${t.holdLedgerTransactionId} is not null
        and ((${t.status} = 'succeeded' and ${t.settleLedgerTransactionId} is not null and ${t.releaseLedgerTransactionId} is null)
          or (${t.status} in ('failed','cancelled') and ${t.settleLedgerTransactionId} is null and ${t.releaseLedgerTransactionId} is not null)
          or (${t.status} in ('requested','processing') and ${t.settleLedgerTransactionId} is null and ${t.releaseLedgerTransactionId} is null))`,
    ),
    check(
      'payouts_timestamps_check',
      sql`(${t.status} = 'requested' and ${t.processingAt} is null and ${t.succeededAt} is null and ${t.failedAt} is null and ${t.cancelledAt} is null)
        or (${t.status} = 'processing' and ${t.processingAt} is not null and ${t.succeededAt} is null and ${t.failedAt} is null and ${t.cancelledAt} is null)
        or (${t.status} = 'succeeded' and ${t.succeededAt} is not null and ${t.failedAt} is null and ${t.cancelledAt} is null)
        or (${t.status} = 'failed' and ${t.failedAt} is not null and ${t.succeededAt} is null and ${t.cancelledAt} is null)
        or (${t.status} = 'cancelled' and ${t.cancelledAt} is not null and ${t.succeededAt} is null and ${t.failedAt} is null)`,
    ),
    check('payouts_version_check', sql`${t.version} > 0`),
  ],
);

/** Which payout paid which settlement (written when a payout succeeds). */
export const payoutAllocations = pgTable(
  'payout_allocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    payoutId: uuid('payout_id').notNull(),
    settlementId: uuid('settlement_id').notNull(),
    amountMinor: numeric('amount_minor', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('payout_allocations_payout_settlement_uq').on(
      t.payoutId,
      t.settlementId,
    ),
    index('payout_allocations_settlement_idx').on(t.settlementId),
    foreignKey({
      columns: [t.tenantId, t.payoutId],
      foreignColumns: [payouts.tenantId, payouts.id],
      name: 'payout_allocations_tenant_payout_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.tenantId, t.settlementId],
      foreignColumns: [settlements.tenantId, settlements.id],
      name: 'payout_allocations_tenant_settlement_fk',
    }).onDelete('restrict'),
    check(
      'payout_allocations_amount_check',
      sql`${t.amountMinor} = trunc(${t.amountMinor}) and ${t.amountMinor} > 0 and ${t.amountMinor} < 1e38`,
    ),
  ],
);

/** One row per provider attempt; 'unknown' means an ambiguous outcome (timeout). */
export const payoutAttempts = pgTable(
  'payout_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => payouts.id, { onDelete: 'restrict' }),
    attemptNo: integer('attempt_no').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    providerReference: varchar('provider_reference', { length: 120 }),
    errorCode: varchar('error_code', { length: 64 }),
    errorMessage: varchar('error_message', { length: 500 }),
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    unique('payout_attempts_payout_attempt_uq').on(t.payoutId, t.attemptNo),
    index('payout_attempts_payout_idx').on(t.payoutId, t.startedAt),
    check('payout_attempts_no_check', sql`${t.attemptNo} > 0`),
    check(
      'payout_attempts_status_check',
      sql`${t.status} in ('pending','succeeded','failed','unknown')`,
    ),
    check(
      'payout_attempts_finished_check',
      sql`(${t.status} = 'pending' and ${t.finishedAt} is null) or (${t.status} <> 'pending' and ${t.finishedAt} is not null)`,
    ),
  ],
);

/** Provider callbacks, deduplicated so a replay cannot move money twice. */
export const payoutProviderEvents = pgTable(
  'payout_provider_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => payouts.id, { onDelete: 'restrict' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    eventId: varchar('event_id', { length: 120 }).notNull(),
    eventType: varchar('event_type', { length: 40 }).notNull(),
    amountMinor: numeric('amount_minor', { mode: 'string' }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    providerReference: varchar('provider_reference', { length: 120 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    unique('payout_provider_events_provider_event_uq').on(
      t.provider,
      t.eventId,
    ),
    index('payout_provider_events_payout_idx').on(t.payoutId, t.receivedAt),
    check(
      'payout_provider_events_type_check',
      sql`${t.eventType} in ('payout.succeeded','payout.failed','payout.pending')`,
    ),
    check(
      'payout_provider_events_amount_check',
      sql`${t.amountMinor} = trunc(${t.amountMinor}) and ${t.amountMinor} > 0`,
    ),
  ],
);

/** Transactional outbox for provider calls (same pattern as refunds). */
export const payoutRequestOutbox = pgTable(
  'payout_request_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => payouts.id, { onDelete: 'restrict' }),
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    lastError: varchar('last_error', { length: 500 }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('payout_request_outbox_payout_uq').on(t.payoutId),
    index('payout_request_outbox_due_idx').on(t.status, t.nextAttemptAt),
    check(
      'payout_request_outbox_status_check',
      sql`${t.status} in ('pending','processing','done','dead')`,
    ),
    check('payout_request_outbox_attempts_check', sql`${t.attempts} >= 0`),
  ],
);

/** Append-only payout timeline for the detail screen. */
export const payoutEvents = pgTable(
  'payout_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => payouts.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    fromStatus: varchar('from_status', { length: 16 }),
    toStatus: varchar('to_status', { length: 16 }).notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    actorService: varchar('actor_service', { length: 80 }),
    reason: varchar('reason', { length: 500 }).notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('payout_events_payout_version_uq').on(t.payoutId, t.version),
    index('payout_events_payout_occurred_idx').on(t.payoutId, t.occurredAt),
    check('payout_events_version_check', sql`${t.version} > 0`),
    check(
      'payout_events_actor_check',
      sql`(${t.actorUserId} is not null and ${t.actorService} is null) or (${t.actorUserId} is null and ${t.actorService} is not null)`,
    ),
  ],
);
