import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './index';

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventKey: varchar('event_key', { length: 200 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    aggregateType: varchar('aggregate_type', { length: 40 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    recipientIds: uuid('recipient_ids').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('outbox_events_event_key_uq').on(t.eventKey),
    index('outbox_events_pending_idx')
      .on(t.createdAt, t.id)
      .where(sql`${t.publishedAt} is null and ${t.failedAt} is null`),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => outboxEvents.id, { onDelete: 'restrict' }),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    template: varchar('template', { length: 100 }).notNull(),
    data: jsonb('data')
      .$type<{ aggregateType: string; aggregateId: string }>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('notifications_event_recipient_uq').on(
      t.eventId,
      t.recipientUserId,
    ),
    index('notifications_recipient_cursor_idx').on(
      t.recipientUserId,
      t.createdAt,
      t.id,
    ),
    check('notifications_template_check', sql`length(${t.template}) > 0`),
  ],
);
