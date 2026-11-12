import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { pickupSlots, tenants, users } from './index';
import { ledgerTransactions } from './wallet';

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    pickupSlotId: uuid('pickup_slot_id').notNull(),
    // R1-10 (migration 0007): public display number. Nullable for now because
    // 0007 must stay additive on tables that may hold rows; wave 2 generates
    // it (collision-safe retry on unique violation) and a later migration
    // promotes it to NOT NULL (D12.4 end state).
    orderNumber: varchar('order_number', { length: 32 }),
    tenantNameSnapshot: varchar('tenant_name_snapshot', {
      length: 200,
    }).notNull(),
    tenantTimezoneSnapshot: varchar('tenant_timezone_snapshot', {
      length: 100,
    }).notNull(),
    pickupStartsAt: timestamp('pickup_starts_at', {
      withTimezone: true,
    }).notNull(),
    pickupEndsAt: timestamp('pickup_ends_at', { withTimezone: true }).notNull(),
    status: varchar('status', { length: 32 })
      .default('paid_awaiting_tenant')
      .notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    subtotalMinor: numeric('subtotal_minor').notNull(),
    totalMinor: numeric('total_minor').notNull(),
    specialRequest: varchar('special_request', { length: 500 })
      .default('')
      .notNull(),
    version: integer('version').default(1).notNull(),
    // R1-05/R1-10 (migration 0007): transition timestamps from REQUIREMENTS
    // §7.2. paid_at is set by checkout (payment precedes order creation);
    // cancelled_at/declined_at record terminal transitions.
    paidAt: timestamp('paid_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    preparingAt: timestamp('preparing_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    // Composite FK targets (D12.3): real UNIQUE constraints (not unique
    // indexes) so child tables can reference (tenant_id, id) / (buyer_id, id).
    unique('orders_tenant_id_id_uq').on(table.tenantId, table.id),
    unique('orders_buyer_id_id_uq').on(table.buyerId, table.id),
    // R1-01 (BLOCKER): the chosen slot must exist and belong to the order's
    // tenant. Requires UNIQUE(tenant_id, id) on pickup_slots (exists, 0006).
    foreignKey({
      name: 'orders_tenant_slot_fk',
      columns: [table.tenantId, table.pickupSlotId],
      foreignColumns: [pickupSlots.tenantId, pickupSlots.id],
    }).onDelete('restrict'),
    index('orders_buyer_created_idx').on(table.buyerId, table.createdAt),
    index('orders_tenant_status_pickup_idx').on(
      table.tenantId,
      table.status,
      table.pickupStartsAt,
    ),
    check(
      'orders_status_check',
      sql`${table.status} in ('paid_awaiting_tenant', 'confirmed', 'preparing', 'ready_for_pickup', 'completed', 'declined', 'cancelled')`,
    ),
    check('orders_currency_check', sql`${table.currency} = 'IDR'`),
    check(
      'orders_amounts_check',
      sql`${table.subtotalMinor} >= 0 and ${table.totalMinor} >= 0 and ${table.subtotalMinor} = trunc(${table.subtotalMinor}) and ${table.totalMinor} = trunc(${table.totalMinor}) and ${table.subtotalMinor} < 1e38 and ${table.totalMinor} < 1e38`,
    ),
    check('orders_version_check', sql`${table.version} > 0`),
    check(
      'orders_pickup_window_check',
      sql`${table.pickupEndsAt} > ${table.pickupStartsAt}`,
    ),
    // R1-05 (D12.4): status and transition timestamps must agree.
    // - paid_awaiting_tenant: no production/terminal timestamp yet
    // - confirmed/preparing/ready_for_pickup: confirmed_at and paid_at set
    // - completed: additionally ready_at and completed_at set
    // - cancelled/declined: cancelled_at/declined_at set
    check(
      'orders_status_timestamps_check',
      sql`(${table.status} = 'paid_awaiting_tenant' and ${table.confirmedAt} is null and ${table.preparingAt} is null and ${table.readyAt} is null and ${table.completedAt} is null) or (${table.status} in ('confirmed', 'preparing', 'ready_for_pickup') and ${table.confirmedAt} is not null and ${table.paidAt} is not null) or (${table.status} = 'completed' and ${table.confirmedAt} is not null and ${table.paidAt} is not null and ${table.readyAt} is not null and ${table.completedAt} is not null) or (${table.status} = 'cancelled' and ${table.cancelledAt} is not null) or (${table.status} = 'declined' and ${table.declinedAt} is not null)`,
    ),
    // R1-05 (D12.4): timestamps only advance; NULL comparisons yield NULL so
    // the chain binds only timestamps that are actually set.
    check(
      'orders_timestamps_monotonic_check',
      sql`${table.createdAt} <= ${table.confirmedAt} and ${table.confirmedAt} <= ${table.preparingAt} and ${table.preparingAt} <= ${table.readyAt} and ${table.readyAt} <= ${table.completedAt}`,
    ),
    // R1-07 (D12.1): pilot has no fee/tax/discount, so the total equals the
    // subtotal. Cross-table checks (SUM(line totals), payment amount) are
    // enforced transactionally in the checkout service + reconciliation tests.
    check(
      'orders_total_equals_subtotal_check',
      sql`${table.totalMinor} = ${table.subtotalMinor}`,
    ),
    // R1-07/R1-20 (D12.5): zero-total orders are rejected in the pilot;
    // an order is only born from a successful wallet payment (> 0).
    check(
      'orders_positive_totals_check',
      sql`${table.subtotalMinor} > 0 and ${table.totalMinor} > 0`,
    ),
    // R1-10: uniqueness for the public order number once wave 2 fills it.
    // A unique INDEX (nullable column): NULLs stay distinct until backfill.
    uniqueIndex('orders_order_number_uq').on(table.orderNumber),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    sourceMenuItemId: uuid('source_menu_item_id').notNull(),
    sourceCategoryId: uuid('source_category_id').notNull(),
    nameSnapshot: varchar('name_snapshot', { length: 160 }).notNull(),
    descriptionSnapshot: text('description_snapshot').notNull(),
    menuVersion: integer('menu_version').notNull(),
    quantity: integer('quantity').notNull(),
    baseUnitPriceMinor: numeric('base_unit_price_minor').notNull(),
    unitPriceMinor: numeric('unit_price_minor').notNull(),
    lineTotalMinor: numeric('line_total_minor').notNull(),
    // R1-12 (migration 0007): per-item note snapshot; NOT NULL DEFAULT ''
    // keeps existing inserts valid.
    notes: varchar('notes', { length: 500 }).default('').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('order_items_order_idx').on(table.orderId, table.createdAt),
    // R1-22 (D12): loose DB bound 1..999; the operational pilot bound (1..200)
    // lives in DTO validation so product can change it without a migration.
    check(
      'order_items_quantity_check',
      sql`${table.quantity} between 1 and 999`,
    ),
    check('order_items_menu_version_check', sql`${table.menuVersion} > 0`),
    check(
      'order_items_prices_check',
      sql`${table.baseUnitPriceMinor} >= 0 and ${table.unitPriceMinor} >= 0 and ${table.lineTotalMinor} >= 0 and ${table.baseUnitPriceMinor} = trunc(${table.baseUnitPriceMinor}) and ${table.unitPriceMinor} = trunc(${table.unitPriceMinor}) and ${table.lineTotalMinor} = trunc(${table.lineTotalMinor}) and ${table.baseUnitPriceMinor} < 1e38 and ${table.unitPriceMinor} < 1e38 and ${table.lineTotalMinor} < 1e38`,
    ),
    // R1-07 (D12.1, locked price formula): line_total = unit_price * quantity.
    // unit_price itself = base_unit_price + SUM(option deltas per unit),
    // enforced transactionally in the checkout service (cross-row).
    check(
      'order_items_line_total_check',
      sql`${table.lineTotalMinor} = ${table.unitPriceMinor} * ${table.quantity}`,
    ),
  ],
);

export const orderItemOptions = pgTable(
  'order_item_options',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    sourceGroupId: uuid('source_group_id').notNull(),
    sourceChoiceId: uuid('source_choice_id').notNull(),
    groupNameSnapshot: varchar('group_name_snapshot', {
      length: 100,
    }).notNull(),
    nameSnapshot: varchar('name_snapshot', { length: 100 }).notNull(),
    priceDeltaMinor: numeric('price_delta_minor').notNull(),
    groupVersion: integer('group_version').notNull(),
    choiceVersion: integer('choice_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('order_item_options_order_item_idx').on(table.orderItemId),
    check(
      'order_item_options_price_delta_check',
      sql`${table.priceDeltaMinor} >= 0 and ${table.priceDeltaMinor} = trunc(${table.priceDeltaMinor}) and ${table.priceDeltaMinor} < 1e38`,
    ),
    check(
      'order_item_options_versions_check',
      sql`${table.groupVersion} > 0 and ${table.choiceVersion} > 0`,
    ),
  ],
);

export const orderPayments = pgTable(
  'order_payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    method: varchar('method', { length: 16 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    amountMinor: numeric('amount_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    ledgerTransactionId: uuid('ledger_transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('order_payments_order_unique').on(table.orderId),
    uniqueIndex('order_payments_ledger_transaction_unique').on(
      table.ledgerTransactionId,
    ),
    check('order_payments_method_check', sql`${table.method} = 'wallet'`),
    check('order_payments_status_check', sql`${table.status} in ('succeeded')`),
    check(
      'order_payments_amount_check',
      sql`${table.amountMinor} > 0 and ${table.amountMinor} = trunc(${table.amountMinor}) and ${table.amountMinor} < 1e38`,
    ),
    check('order_payments_currency_check', sql`${table.currency} = 'IDR'`),
  ],
);

export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    eventType: varchar('event_type', { length: 40 }).notNull(),
    fromStatus: varchar('from_status', { length: 32 }),
    toStatus: varchar('to_status', { length: 32 }),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    actorService: varchar('actor_service', { length: 80 }),
    // R1-15 (migration 0007): optional correlation to the idempotency record
    // of the request that produced the event (REQUIREMENTS §7.2 request_id).
    requestId: uuid('request_id'),
    reason: varchar('reason', { length: 500 }).notNull(),
    metadata: jsonb('metadata').default({}).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('order_events_version_unique').on(table.orderId, table.version),
    index('order_events_order_time_idx').on(
      table.orderId,
      table.occurredAt,
      table.id,
    ),
    // R1-15: correlation lookup per order/request.
    index('order_events_order_request_idx').on(table.orderId, table.requestId),
    check('order_events_version_check', sql`${table.version} > 0`),
    // R1-15 (D12.7): closed enum widened from 4 to 8 lifecycle event types.
    check(
      'order_events_type_check',
      sql`${table.eventType} in ('order.created', 'order.status_changed', 'order.cancelled', 'order.declined', 'schedule_proposal.created', 'schedule_proposal.decided', 'pickup_credential.issued', 'pickup_credential.revoked')`,
    ),
    // R1-15: request_id, when present, must reference a real idempotency
    // record (resolved lazily; orderRequestIdempotency is declared below).
    foreignKey({
      name: 'order_events_request_fk',
      columns: [table.requestId],
      foreignColumns: [orderRequestIdempotency.id],
    }).onDelete('restrict'),
    check(
      'order_events_actor_check',
      sql`(${table.actorUserId} is not null and ${table.actorService} is null) or (${table.actorUserId} is null and ${table.actorService} is not null)`,
    ),
  ],
);

export const orderRequestIdempotency = pgTable(
  'order_request_idempotency',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    routeName: varchar('route_name', { length: 180 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    responseBody: jsonb('response_body').notNull(),
    // R1-16 (migration 0007): retention expiry for the cleanup job (wave
    // operasional); nullable so records may opt out of expiry for now.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('order_request_idempotency_actor_route_key_unique').on(
      table.actorUserId,
      table.routeName,
      table.keyHash,
    ),
    index('order_request_idempotency_order_idx').on(table.orderId),
    // R1-16: partial index for the retention cleanup scan.
    index('order_request_idempotency_expires_idx')
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} is not null`),
    check(
      'order_request_idempotency_hashes_check',
      sql`${table.keyHash} ~ '^[a-f0-9]{64}$' and ${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const scheduleProposals = pgTable(
  'schedule_proposals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    oldSlotId: uuid('old_slot_id').notNull(),
    proposedSlotId: uuid('proposed_slot_id').notNull(),
    oldStartsAt: timestamp('old_starts_at', { withTimezone: true }).notNull(),
    oldEndsAt: timestamp('old_ends_at', { withTimezone: true }).notNull(),
    proposedStartsAt: timestamp('proposed_starts_at', {
      withTimezone: true,
    }).notNull(),
    proposedEndsAt: timestamp('proposed_ends_at', {
      withTimezone: true,
    }).notNull(),
    expectedSlotVersion: integer('expected_slot_version').notNull(),
    expectedOrderVersion: integer('expected_order_version').notNull(),
    status: varchar('status', { length: 20 })
      .default('pending_buyer')
      .notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('schedule_proposals_one_pending_per_order')
      .on(table.orderId)
      .where(sql`${table.status} = 'pending_buyer'`),
    index('schedule_proposals_buyer_status_expiry_idx').on(
      table.buyerId,
      table.status,
      table.expiresAt,
    ),
    check(
      'schedule_proposals_status_check',
      sql`${table.status} in ('pending_buyer', 'accepted', 'rejected', 'expired', 'cancelled')`,
    ),
    check(
      'schedule_proposals_slot_diff_check',
      sql`${table.oldSlotId} <> ${table.proposedSlotId}`,
    ),
    check(
      'schedule_proposals_windows_check',
      sql`${table.oldEndsAt} > ${table.oldStartsAt} and ${table.proposedEndsAt} > ${table.proposedStartsAt}`,
    ),
    check(
      'schedule_proposals_versions_check',
      sql`${table.expectedSlotVersion} > 0 and ${table.expectedOrderVersion} > 0`,
    ),
    // R1-06 (D12): a proposal must expire strictly after it was created.
    check(
      'schedule_proposals_expires_at_check',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    // R1-06 (D12): decided_at is set exactly once the proposal left
    // pending_buyer (accepted/rejected/expired/cancelled are decisions;
    // timeout expiry must never read as acceptance - AGENTS.md).
    check(
      'schedule_proposals_decided_at_check',
      sql`(${table.status} = 'pending_buyer' and ${table.decidedAt} is null) or (${table.status} <> 'pending_buyer' and ${table.decidedAt} is not null)`,
    ),
    // R1-03 (migration 0007): proposals stay inside the order's tenant and
    // both slots must belong to that tenant (old_slot_id is NOT NULL here, so
    // the composite FK always applies).
    foreignKey({
      name: 'schedule_proposals_tenant_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'schedule_proposals_tenant_proposed_slot_fk',
      columns: [table.tenantId, table.proposedSlotId],
      foreignColumns: [pickupSlots.tenantId, pickupSlots.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'schedule_proposals_tenant_old_slot_fk',
      columns: [table.tenantId, table.oldSlotId],
      foreignColumns: [pickupSlots.tenantId, pickupSlots.id],
    }).onDelete('restrict'),
  ],
);

export const pickupCredentials = pgTable(
  'pickup_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    codeCiphertext: text('code_ciphertext').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    // Composite FK target (D12.3): real UNIQUE constraint so
    // `order_handovers_order_credential_fk` can reference (order_id, id).
    unique('pickup_credentials_order_id_id_uq').on(table.orderId, table.id),
    uniqueIndex('pickup_credentials_one_current_order_unique')
      .on(table.orderId)
      .where(sql`${table.revokedAt} is null`),
    uniqueIndex('pickup_credentials_code_hash_unique').on(table.codeHash),
    check(
      'pickup_credentials_hash_check',
      sql`${table.codeHash} ~ '^[a-f0-9]{64}$'`,
    ),
    // R1-14 (D12): expiry must be in the future relative to creation.
    check(
      'pickup_credentials_expires_at_check',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    // R1-14 (D12): a credential is either consumed or revoked, never both
    // (rotation replaces: old credential revoked, one active per order).
    check(
      'pickup_credentials_consume_revoke_check',
      sql`${table.consumedAt} is null or ${table.revokedAt} is null`,
    ),
  ],
);

export const orderHandovers = pgTable(
  'order_handovers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => pickupCredentials.id, { onDelete: 'restrict' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    handedOverAt: timestamp('handed_over_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('order_handovers_order_unique').on(table.orderId),
    uniqueIndex('order_handovers_credential_unique').on(table.credentialId),
    index('order_handovers_tenant_time_idx').on(
      table.tenantId,
      table.handedOverAt,
    ),
    // R1-03 (migration 0007): the handover must belong to the order's tenant
    // and the credential must belong to the SAME order (pickup validation is
    // enforced for the right order and tenant - AGENTS.md).
    foreignKey({
      name: 'order_handovers_tenant_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'order_handovers_order_credential_fk',
      columns: [table.orderId, table.credentialId],
      foreignColumns: [pickupCredentials.orderId, pickupCredentials.id],
    }).onDelete('restrict'),
  ],
);
