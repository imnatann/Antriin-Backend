import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { campuses, tenants, users } from './index';
import { orders } from './orders';

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Operational case opened by a buyer, tenant staff or campus staff about an
 * order or a tenant. A case is a human decision record, never an automatic
 * sanction: AI/risk signals may only add items to a review queue.
 */
export const cases = pgTable(
  'cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    // Nullable: a case may concern a tenant without a specific order.
    orderId: uuid('order_id'),
    buyerId: uuid('buyer_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    openedByUserId: uuid('opened_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    category: varchar('category', { length: 32 }).notNull(),
    status: varchar('status', { length: 24 }).default('reported').notNull(),
    subject: varchar('subject', { length: 200 }).notNull(),
    details: varchar('details', { length: 4000 }).default('').notNull(),
    decisionReason: varchar('decision_reason', { length: 500 }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    version: integer('version').default(1).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('cases_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('cases_campus_id_id_uq').on(t.campusId, t.id),
    // campus_id and tenant_id are validated together in the service; a composite
    // FK would require UNIQUE(tenants.campus_id, id), which the foundation table
    // does not carry.
    foreignKey({
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'cases_tenant_order_fk',
    }).onDelete('restrict'),
    index('cases_campus_status_idx').on(t.campusId, t.status, t.createdAt),
    index('cases_tenant_status_idx').on(t.tenantId, t.status, t.createdAt),
    index('cases_buyer_idx').on(t.buyerId, t.createdAt),
    index('cases_order_idx').on(t.orderId),
    check(
      'cases_category_check',
      sql`${t.category} in ('order_issue','no_show','quality','payment','schedule','other')`,
    ),
    check(
      'cases_status_check',
      sql`${t.status} in ('reported','under_review','awaiting_information','approved_cancel','declined','resolved')`,
    ),
    check('cases_version_check', sql`${t.version} > 0`),
    check(
      'cases_decision_check',
      sql`(${t.status} in ('approved_cancel','declined','resolved') and ${t.decidedAt} is not null and ${t.decidedByUserId} is not null and ${t.decisionReason} is not null) or (${t.status} not in ('approved_cancel','declined','resolved') and ${t.decidedAt} is null and ${t.decidedByUserId} is null)`,
    ),
    check('cases_subject_check', sql`length(trim(${t.subject})) > 0`),
  ],
);
