import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './index';

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Server-side copy of the buyer's notification switches (REQUIREMENTS §3.1.5
 * calls device notification preferences a client control). Storing them lets a
 * second device inherit the same choice; nothing here changes how the outbox
 * delivers an in-app notification, because no external channel is enabled yet.
 *
 * Every switch defaults to true: a user who never opened the screen keeps
 * receiving the notifications the product already sends.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    orderUpdates: boolean('order_updates').default(true).notNull(),
    reviewReplies: boolean('review_replies').default(true).notNull(),
    caseUpdates: boolean('case_updates').default(true).notNull(),
    pushEnabled: boolean('push_enabled').default(false).notNull(),
    ...timestamps(),
  },
  (table) => [
    check(
      'notification_preferences_push_check',
      // Push is only meaningful once a device is registered; the service
      // enforces the pairing, this CHECK keeps the flag a real boolean.
      sql`${table.pushEnabled} in (true, false)`,
    ),
  ],
);

/**
 * Push/device registration only. No push provider is integrated, so a row here
 * records the device the client wants notifications on and nothing is ever
 * delivered from it (REQUIREMENTS §3.1 "pencatatan perangkat/sesi").
 *
 * The raw push token is never stored: `token_hash` is the SHA-256 of the token
 * the client presented, which is enough to deduplicate and to revoke.
 */
export const userDevices = pgTable(
  'user_devices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 16 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    label: varchar('label', { length: 100 }).default('').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('user_devices_token_hash_unique').on(table.tokenHash),
    index('user_devices_user_active_idx').on(table.userId, table.revokedAt),
    check(
      'user_devices_platform_check',
      sql`${table.platform} in ('ios', 'android', 'web')`,
    ),
  ],
);
