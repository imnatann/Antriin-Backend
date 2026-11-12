import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenants, users } from './index';
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
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    preparingAt: timestamp('preparing_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
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
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('order_items_order_idx').on(table.orderId, table.createdAt),
    check(
      'order_items_quantity_check',
      sql`${table.quantity} between 1 and 99`,
    ),
    check('order_items_menu_version_check', sql`${table.menuVersion} > 0`),
    check(
      'order_items_prices_check',
      sql`${table.baseUnitPriceMinor} >= 0 and ${table.unitPriceMinor} >= 0 and ${table.lineTotalMinor} >= 0 and ${table.baseUnitPriceMinor} = trunc(${table.baseUnitPriceMinor}) and ${table.unitPriceMinor} = trunc(${table.unitPriceMinor}) and ${table.lineTotalMinor} = trunc(${table.lineTotalMinor}) and ${table.baseUnitPriceMinor} < 1e38 and ${table.unitPriceMinor} < 1e38 and ${table.lineTotalMinor} < 1e38`,
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
    check('order_events_version_check', sql`${table.version} > 0`),
    check(
      'order_events_type_check',
      sql`${table.eventType} in ('order.created', 'order.status_changed', 'schedule_proposal.created', 'schedule_proposal.decided')`,
    ),
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
    uniqueIndex('pickup_credentials_one_current_order_unique')
      .on(table.orderId)
      .where(sql`${table.revokedAt} is null`),
    uniqueIndex('pickup_credentials_code_hash_unique').on(table.codeHash),
    check(
      'pickup_credentials_hash_check',
      sql`${table.codeHash} ~ '^[a-f0-9]{64}$'`,
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
  ],
);
