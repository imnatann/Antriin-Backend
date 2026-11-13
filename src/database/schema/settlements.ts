import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenants } from './index';
import { orderPayments, orders } from './orders';
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
 * Money released to a tenant for one completed order (docs/design/settlement-payout.md).
 *
 * Pilot behaviour: a row is born at RELEASE with status 'available' - there is no
 * persisted 'pending' row, so checkout (already accepted) never has to write here.
 * 'pending' stays in the enum so a future product decision can record the intent
 * earlier without a new migration.
 *
 * The release ledger transaction is the only proof of movement: the balance is a
 * projection over ledger entries, never a column.
 */
export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    orderPaymentId: uuid('order_payment_id').notNull(),
    amountMinor: numeric('amount_minor', { mode: 'string' }).notNull(),
    currency: varchar('currency', { length: 3 }).default('IDR').notNull(),
    status: varchar('status', { length: 16 }).default('available').notNull(),
    paidOutMinor: numeric('paid_out_minor', { mode: 'string' })
      .default('0')
      .notNull(),
    releaseLedgerTransactionId: uuid(
      'release_ledger_transaction_id',
    ).references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // [REQ] exactly one settlement per order.
    unique('settlements_one_per_order_uq').on(t.orderId),
    // Composite FK target for payout_allocations (pattern D12.3).
    unique('settlements_tenant_id_id_uq').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'settlements_tenant_order_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orderId, t.orderPaymentId],
      foreignColumns: [orderPayments.orderId, orderPayments.id],
      name: 'settlements_order_payment_fk',
    }).onDelete('restrict'),
    index('settlements_tenant_status_idx').on(
      t.tenantId,
      t.status,
      t.releasedAt,
    ),
    index('settlements_status_released_idx').on(t.status, t.releasedAt),
    check(
      'settlements_amount_check',
      sql`${t.amountMinor} = trunc(${t.amountMinor}) and ${t.amountMinor} > 0 and ${t.amountMinor} < 1e38`,
    ),
    check('settlements_currency_check', sql`${t.currency} = 'IDR'`),
    check(
      'settlements_status_check',
      sql`${t.status} in ('pending','available','paid_out','voided','reversed')`,
    ),
    check(
      'settlements_paid_out_check',
      sql`${t.paidOutMinor} = trunc(${t.paidOutMinor}) and ${t.paidOutMinor} >= 0 and ${t.paidOutMinor} <= ${t.amountMinor}`,
    ),
    check(
      'settlements_status_timestamps_check',
      sql`(${t.status} = 'pending' and ${t.releasedAt} is null and ${t.releaseLedgerTransactionId} is null and ${t.paidOutMinor} = 0)
        or (${t.status} = 'available' and ${t.releasedAt} is not null and ${t.releaseLedgerTransactionId} is not null and ${t.paidOutMinor} < ${t.amountMinor})
        or (${t.status} = 'paid_out' and ${t.releasedAt} is not null and ${t.releaseLedgerTransactionId} is not null and ${t.paidOutMinor} = ${t.amountMinor})
        or (${t.status} = 'voided' and ${t.voidedAt} is not null and ${t.paidOutMinor} = 0)
        or (${t.status} = 'reversed' and ${t.reversedAt} is not null and ${t.paidOutMinor} = 0)`,
    ),
  ],
);
