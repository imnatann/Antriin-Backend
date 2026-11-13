import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { orders, tenants } from './index';

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const menuCategories = pgTable(
  'menu_categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 100 }).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    status: varchar('status', { length: 16 }).default('active').notNull(),
    ...timestamps(),
  },
  (t) => [
    // Composite FK target: must be a real UNIQUE constraint, created with the
    // table, so `menu_items_tenant_category_fk` can reference (tenant_id, id).
    unique('menu_categories_tenant_id_id_uq').on(t.tenantId, t.id),
    uniqueIndex('menu_categories_tenant_name_uq').on(t.tenantId, t.name),
    index('menu_categories_tenant_status_idx').on(t.tenantId, t.status),
    check(
      'menu_categories_status_check',
      sql`${t.status} in ('active', 'archived')`,
    ),
    check('menu_categories_sort_order_check', sql`${t.sortOrder} >= 0`),
  ],
);

export const menuItems = pgTable(
  'menu_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id').notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    description: varchar('description', { length: 2000 }).notNull().default(''),
    priceMinor: numeric('price_minor', { mode: 'string' }).notNull(),
    currency: varchar('currency', { length: 3 }).default('IDR').notNull(),
    status: varchar('status', { length: 16 }).default('active').notNull(),
    version: integer('version').default(1).notNull(),
    // R1-11 (migration 0007): optional photo reference and archive timestamp
    // (REQUIREMENTS §7.2 `menu_items.image_ref`, `archived_at`).
    imageRef: varchar('image_ref', { length: 500 }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('menu_items_tenant_id_id_uq').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.categoryId],
      foreignColumns: [menuCategories.tenantId, menuCategories.id],
      name: 'menu_items_tenant_category_fk',
    }).onDelete('restrict'),
    index('menu_items_tenant_status_idx').on(t.tenantId, t.status, t.name),
    index('menu_items_category_status_idx').on(t.categoryId, t.status),
    check(
      'menu_items_price_check',
      sql`${t.priceMinor} = trunc(${t.priceMinor}) and ${t.priceMinor} >= 0 and ${t.priceMinor} < 1e38`,
    ),
    check('menu_items_currency_check', sql`${t.currency} = 'IDR'`),
    check(
      'menu_items_status_check',
      sql`${t.status} in ('active', 'sold_out', 'archived')`,
    ),
    check('menu_items_version_check', sql`${t.version} > 0`),
    // R1-11 (root directive): archived_at is set exactly for archived items;
    // reactivating an item must clear archived_at.
    check(
      'menu_items_archived_at_check',
      sql`(${t.status} = 'archived' and ${t.archivedAt} is not null) or (${t.status} <> 'archived' and ${t.archivedAt} is null)`,
    ),
  ],
);

export const menuOptionGroups = pgTable(
  'menu_option_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    menuItemId: uuid('menu_item_id').notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    minSelections: integer('min_selections').default(0).notNull(),
    maxSelections: integer('max_selections').default(1).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    status: varchar('status', { length: 16 }).default('active').notNull(),
    version: integer('version').default(1).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('menu_option_groups_tenant_id_id_uq').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
      name: 'menu_option_groups_tenant_item_fk',
    }).onDelete('cascade'),
    index('menu_option_groups_item_status_idx').on(
      t.menuItemId,
      t.status,
      t.sortOrder,
    ),
    check(
      'menu_option_groups_selection_bounds_check',
      sql`${t.minSelections} >= 0 and ${t.maxSelections} >= 1 and ${t.minSelections} <= ${t.maxSelections}`,
    ),
    check('menu_option_groups_sort_order_check', sql`${t.sortOrder} >= 0`),
    check(
      'menu_option_groups_status_check',
      sql`${t.status} in ('active', 'archived')`,
    ),
    check('menu_option_groups_version_check', sql`${t.version} > 0`),
  ],
);

export const menuOptionChoices = pgTable(
  'menu_option_choices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    groupId: uuid('group_id').notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    priceDeltaMinor: numeric('price_delta_minor', { mode: 'string' })
      .default('0')
      .notNull(),
    status: varchar('status', { length: 16 }).default('active').notNull(),
    version: integer('version').default(1).notNull(),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.groupId],
      foreignColumns: [menuOptionGroups.tenantId, menuOptionGroups.id],
      name: 'menu_option_choices_tenant_group_fk',
    }).onDelete('cascade'),
    uniqueIndex('menu_option_choices_group_name_uq').on(t.groupId, t.name),
    index('menu_option_choices_group_status_idx').on(t.groupId, t.status),
    check(
      'menu_option_choices_price_delta_check',
      sql`${t.priceDeltaMinor} = trunc(${t.priceDeltaMinor}) and ${t.priceDeltaMinor} >= 0 and ${t.priceDeltaMinor} < 1e38`,
    ),
    check(
      'menu_option_choices_status_check',
      sql`${t.status} in ('active', 'archived')`,
    ),
    check('menu_option_choices_version_check', sql`${t.version} > 0`),
  ],
);

/**
 * Weekly tenant operating hours.
 *
 * Weekday convention (root decision D12.9, binding): `weekday` uses
 * 0 = Sunday ... 6 = Saturday, matching JavaScript `Date.getDay()`, and is
 * evaluated in the tenant/campus IANA timezone - never in UTC. Midnight-
 * crossing windows remain unsupported in the pilot (`opens_at < closes_at`).
 * The same convention applies to `tenant_operating_hour_overrides.local_date`.
 */
export const tenantOperatingHours = pgTable(
  'tenant_operating_hours',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    weekday: integer('weekday').notNull(),
    opensAt: time('opens_at'),
    closesAt: time('closes_at'),
    isOpen: boolean('is_open').default(true).notNull(),
    // R1-17 (migration 0007): created_at with a safe default (additive).
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // R1-17: real PRIMARY KEY constraint (was unique index only). The legacy
    // unique index is kept (additive migration); the PK backs replication and
    // tooling that require a primary key.
    primaryKey({
      columns: [t.tenantId, t.weekday],
      name: 'tenant_operating_hours_pk',
    }),
    uniqueIndex('tenant_operating_hours_tenant_weekday_uq').on(
      t.tenantId,
      t.weekday,
    ),
    check(
      'tenant_operating_hours_weekday_check',
      sql`${t.weekday} between 0 and 6`,
    ),
    check(
      'tenant_operating_hours_time_check',
      sql`(${t.isOpen} = true and ${t.opensAt} is not null and ${t.closesAt} is not null and ${t.opensAt} < ${t.closesAt}) or (${t.isOpen} = false and ${t.opensAt} is null and ${t.closesAt} is null)`,
    ),
  ],
);

/**
 * Per-date tenant operating hour overrides; an override beats the weekly
 * schedule (see TenantOperatingHoursService.resolveOperatingWindow, D8).
 * `local_date` is a tenant/campus local calendar date ('YYYY-MM-DD'); the
 * weekday convention of `tenant_operating_hours` (0 = Sunday ... 6 = Saturday,
 * D12.9) applies when deriving the weekday from it.
 */
export const tenantOperatingHourOverrides = pgTable(
  'tenant_operating_hour_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    localDate: date('local_date').notNull(),
    isClosed: boolean('is_closed').default(false).notNull(),
    opensAt: time('opens_at'),
    closesAt: time('closes_at'),
    reason: varchar('reason', { length: 300 }).notNull().default(''),
    // R1-17 (migration 0007): created_at with a safe default (additive).
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // R1-17: real PRIMARY KEY constraint (was unique index only); the legacy
    // unique index is kept because migration 0007 is strictly additive.
    primaryKey({
      columns: [t.tenantId, t.localDate],
      name: 'tenant_operating_hour_overrides_pk',
    }),
    uniqueIndex('tenant_operating_overrides_tenant_date_uq').on(
      t.tenantId,
      t.localDate,
    ),
    check(
      'tenant_operating_overrides_window_check',
      sql`(${t.isClosed} = true and ${t.opensAt} is null and ${t.closesAt} is null) or (${t.isClosed} = false and ${t.opensAt} is not null and ${t.closesAt} is not null and ${t.opensAt} < ${t.closesAt})`,
    ),
  ],
);

export const pickupSlots = pgTable(
  'pickup_slots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    capacity: integer('capacity').notNull(),
    reservedCount: integer('reserved_count').default(0).notNull(),
    status: varchar('status', { length: 16 }).default('open').notNull(),
    version: integer('version').default(1).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('pickup_slots_tenant_id_id_uq').on(t.tenantId, t.id),
    uniqueIndex('pickup_slots_tenant_window_uq').on(
      t.tenantId,
      t.startsAt,
      t.endsAt,
    ),
    index('pickup_slots_tenant_window_status_idx').on(
      t.tenantId,
      t.startsAt,
      t.status,
    ),
    check('pickup_slots_window_check', sql`${t.endsAt} > ${t.startsAt}`),
    check(
      'pickup_slots_capacity_check',
      sql`${t.capacity} >= 1 and ${t.reservedCount} >= 0 and ${t.reservedCount} <= ${t.capacity}`,
    ),
    check('pickup_slots_status_check', sql`${t.status} in ('open', 'closed')`),
    check('pickup_slots_version_check', sql`${t.version} > 0`),
  ],
);

export const slotReservations = pgTable(
  'slot_reservations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    slotId: uuid('slot_id').notNull(),
    orderId: uuid('order_id').notNull(),
    status: varchar('status', { length: 16 }).default('reserved').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    // R1-13 (migration 0007): consume timestamp (symmetry with released_at)
    // and updated_at (set explicitly by the application; AGENTS.md).
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('slot_reservations_order_unique').on(t.orderId),
    foreignKey({
      columns: [t.tenantId, t.slotId],
      foreignColumns: [pickupSlots.tenantId, pickupSlots.id],
      name: 'slot_reservations_tenant_slot_fk',
    }).onDelete('restrict'),
    // R1-02 (migration 0007): a reservation must reference a real order; the
    // capacity hold stays referentially auditable (ON DELETE RESTRICT).
    foreignKey({
      columns: [t.orderId],
      foreignColumns: [orders.id],
      name: 'slot_reservations_order_fk',
    }).onDelete('restrict'),
    index('slot_reservations_tenant_slot_status_idx').on(
      t.tenantId,
      t.slotId,
      t.status,
    ),
    check(
      'slot_reservations_status_check',
      sql`${t.status} in ('reserved', 'released', 'consumed')`,
    ),
    check(
      'slot_reservations_released_at_check',
      sql`(${t.status} = 'released' and ${t.releasedAt} is not null) or (${t.status} <> 'released' and ${t.releasedAt} is null)`,
    ),
    // R1-13 (D12): consumed_at mirrors the released_at pattern - it is set
    // exactly for consumed reservations.
    check(
      'slot_reservations_consumed_at_check',
      sql`(${t.status} = 'consumed' and ${t.consumedAt} is not null) or (${t.status} <> 'consumed' and ${t.consumedAt} is null)`,
    ),
  ],
);
