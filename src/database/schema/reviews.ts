import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
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
 * One buyer review per completed order (REQUIREMENTS §3.9). The buyer must
 * own the order and hold a verified campus email; the tenant may only read
 * and reply. A buyer deletion is a soft delete (deleted_at) so the order can
 * never be reviewed a second time — the UNIQUE(order_id) stays authoritative.
 */
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    rating: integer('rating').notNull(),
    body: varchar('body', { length: 2000 }).notNull(),
    status: varchar('status', { length: 16 }).default('visible').notNull(),
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    hiddenByUserId: uuid('hidden_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    // Buyer deletion. The row and its moderation history stay for audit and
    // the order stays un-reviewable.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // One review per order, soft-deleted ones included.
    uniqueIndex('reviews_order_unique').on(t.orderId),
    unique('reviews_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('reviews_campus_id_id_uq').on(t.campusId, t.id),
    // The review must belong to an order of the same tenant.
    foreignKey({
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'reviews_tenant_order_fk',
    }).onDelete('restrict'),
    index('reviews_tenant_status_created_idx').on(
      t.tenantId,
      t.status,
      t.createdAt,
    ),
    index('reviews_campus_status_created_idx').on(
      t.campusId,
      t.status,
      t.createdAt,
    ),
    index('reviews_buyer_created_idx').on(t.buyerId, t.createdAt),
    check('reviews_rating_check', sql`${t.rating} between 1 and 5`),
    check('reviews_body_check', sql`length(trim(${t.body})) > 0`),
    check(
      'reviews_status_check',
      sql`${t.status} in ('visible','reported','under_review','hidden','resolved')`,
    ),
    // status and the hiding columns must agree in both directions.
    check(
      'reviews_hidden_check',
      sql`(${t.status} = 'hidden' and ${t.hiddenAt} is not null and ${t.hiddenByUserId} is not null) or (${t.status} <> 'hidden' and ${t.hiddenAt} is null and ${t.hiddenByUserId} is null)`,
    ),
  ],
);

/** One public tenant reply per review (REQUIREMENTS §3.9 point 3). */
export const reviewReplies = pgTable(
  'review_replies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reviewId: uuid('review_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: varchar('body', { length: 2000 }).notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('review_replies_review_unique').on(t.reviewId),
    // A tenant can only reply to its own review.
    foreignKey({
      columns: [t.tenantId, t.reviewId],
      foreignColumns: [reviews.tenantId, reviews.id],
      name: 'review_replies_tenant_review_fk',
    }).onDelete('restrict'),
    check('review_replies_body_check', sql`length(trim(${t.body})) > 0`),
  ],
);

/** Buyer report asking campus moderation to look at a review. */
export const reviewReports = pgTable(
  'review_reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reason: varchar('reason', { length: 500 }).notNull(),
    status: varchar('status', { length: 16 }).default('open').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('review_reports_reporter_unique').on(
      t.reviewId,
      t.reporterUserId,
    ),
    index('review_reports_campus_status_idx').on(t.campusId, t.status),
    check(
      'review_reports_status_check',
      sql`${t.status} in ('open','resolved')`,
    ),
    check(
      'review_reports_resolved_check',
      sql`(${t.status} = 'resolved' and ${t.resolvedAt} is not null) or (${t.status} = 'open' and ${t.resolvedAt} is null)`,
    ),
    check('review_reports_reason_check', sql`length(trim(${t.reason})) > 0`),
  ],
);

/**
 * Append-only moderation decision trail. A low rating alone is never a
 * violation, and a decision never deletes the review or sanctions anyone.
 */
export const reviewModerationActions = pgTable(
  'review_moderation_actions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    action: varchar('action', { length: 16 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('review_moderation_actions_review_idx').on(t.reviewId, t.createdAt),
    index('review_moderation_actions_campus_idx').on(t.campusId, t.createdAt),
    check(
      'review_moderation_actions_action_check',
      sql`${t.action} in ('keep','hide')`,
    ),
    check(
      'review_moderation_actions_reason_check',
      sql`length(trim(${t.reason})) > 0`,
    ),
  ],
);
