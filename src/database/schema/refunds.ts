import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { campuses, tenants, users } from './index';
import { cases } from './cases';
import { orders, orderPayments } from './orders';
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
 * Refund intent for an order. The pilot supports a single full refund per
 * order, decided by an authorized campus manager and only credited to the
 * wallet once the provider confirms success (docs/PILOT-POLICY.md).
 */
export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    orderPaymentId: uuid('order_payment_id'),
    caseId: uuid('case_id'),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    amountMinor: numeric('amount_minor', { mode: 'string' }).notNull(),
    currency: varchar('currency', { length: 3 }).default('IDR').notNull(),
    status: varchar('status', { length: 20 }).default('requested').notNull(),
    provider: varchar('provider', { length: 32 }).default('sandbox').notNull(),
    providerReference: varchar('provider_reference', { length: 120 }),
    reason: varchar('reason', { length: 500 }).notNull(),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    ledgerTransactionId: uuid('ledger_transaction_id').references(
      () => ledgerTransactions.id,
      { onDelete: 'restrict' },
    ),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    lastError: varchar('last_error', { length: 500 }),
    attemptCount: integer('attempt_count').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    version: integer('version').default(1).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('refunds_tenant_id_id_uq').on(t.tenantId, t.id),
    // campus_id must match the tenant's campus; enforced in the service because
    // tenants has no UNIQUE(campus_id, id) constraint.
    foreignKey({
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'refunds_tenant_order_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orderId, t.orderPaymentId],
      foreignColumns: [orderPayments.orderId, orderPayments.id],
      name: 'refunds_order_payment_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.tenantId, t.caseId],
      foreignColumns: [cases.tenantId, cases.id],
      name: 'refunds_tenant_case_fk',
    }).onDelete('restrict'),
    // One live or succeeded refund per order: prevents duplicate refunds.
    uniqueIndex('refunds_one_per_order_uq')
      .on(t.orderId)
      .where(
        sql`${t.status} in ('requested','under_review','submitted','processing','succeeded','needs_assistance')`,
      ),
    uniqueIndex('refunds_provider_reference_uq')
      .on(t.provider, t.providerReference)
      .where(sql`${t.providerReference} is not null`),
    index('refunds_campus_status_idx').on(t.campusId, t.status, t.createdAt),
    index('refunds_tenant_status_idx').on(t.tenantId, t.status, t.createdAt),
    index('refunds_buyer_idx').on(t.buyerId, t.createdAt),
    index('refunds_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.nextAttemptAt} is not null`),
    check(
      'refunds_amount_check',
      sql`${t.amountMinor} = trunc(${t.amountMinor}) and ${t.amountMinor} > 0 and ${t.amountMinor} < 1e38`,
    ),
    check('refunds_currency_check', sql`${t.currency} = 'IDR'`),
    check(
      'refunds_status_check',
      sql`${t.status} in ('requested','under_review','submitted','processing','succeeded','failed','needs_assistance')`,
    ),
    check(
      'refunds_succeeded_check',
      sql`(${t.status} = 'succeeded' and ${t.succeededAt} is not null and ${t.ledgerTransactionId} is not null) or (${t.status} <> 'succeeded' and ${t.succeededAt} is null and ${t.ledgerTransactionId} is null)`,
    ),
    check(
      'refunds_failed_check',
      sql`(${t.status} = 'failed' and ${t.failedAt} is not null) or (${t.status} <> 'failed' and ${t.failedAt} is null)`,
    ),
    check('refunds_attempts_check', sql`${t.attemptCount} >= 0`),
    check('refunds_version_check', sql`${t.version} > 0`),
    check('refunds_reason_check', sql`length(trim(${t.reason})) > 0`),
  ],
);

/**
 * Provider callbacks for refunds, deduplicated on (provider, event_id) so a
 * replayed callback cannot credit the wallet twice.
 */
export const refundProviderEvents = pgTable(
  'refund_provider_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'restrict' }),
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
    unique('refund_provider_events_provider_event_uq').on(
      t.provider,
      t.eventId,
    ),
    index('refund_provider_events_refund_idx').on(t.refundId, t.receivedAt),
    check(
      'refund_provider_events_type_check',
      sql`${t.eventType} in ('refund.succeeded','refund.failed','refund.pending')`,
    ),
    check(
      'refund_provider_events_amount_check',
      sql`${t.amountMinor} = trunc(${t.amountMinor}) and ${t.amountMinor} > 0`,
    ),
  ],
);

/**
 * Transactional outbox for refund provider requests: written in the same
 * transaction as the refund decision, processed by a worker outside any lock.
 */
export const refundRequestOutbox = pgTable(
  'refund_request_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'restrict' }),
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
    unique('refund_request_outbox_refund_uq').on(t.refundId),
    index('refund_request_outbox_due_idx').on(t.status, t.nextAttemptAt),
    check(
      'refund_request_outbox_status_check',
      sql`${t.status} in ('pending','processing','done','dead')`,
    ),
    check('refund_request_outbox_attempts_check', sql`${t.attempts} >= 0`),
  ],
);
