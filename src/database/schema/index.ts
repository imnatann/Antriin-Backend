import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
// Foundation only. Financial/order schema follows the requirements before feature work.
export const campuses = pgTable(
  'campuses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    timezone: varchar('timezone', { length: 100 })
      .default('Asia/Jakarta')
      .notNull(),
    status: varchar('status', { length: 20 }).default('active').notNull(),
    ...timestamps(),
  },
  (table) => [
    check(
      'campuses_status_check',
      sql`${table.status} in ('active', 'inactive')`,
    ),
  ],
);
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    phoneE164: varchar('phone_e164', { length: 16 }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    status: varchar('status', { length: 20 }).default('active').notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('users_phone_unique').on(table.phoneE164),
    check(
      'users_status_check',
      sql`${table.status} in ('active', 'suspended', 'closed')`,
    ),
  ],
);
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 200 }).notNull(),
    location: varchar('location', { length: 500 }).notNull(),
    status: varchar('status', { length: 20 }).default('closed').notNull(),
    ...timestamps(),
  },
  (table) => [
    index('tenants_campus_status_idx').on(table.campusId, table.status),
    check(
      'tenants_status_check',
      sql`${table.status} in ('open', 'closed', 'paused', 'archived')`,
    ),
  ],
);

export * from './access';
export * from './auth';
export * from './events';
export * from './wallet';
export * from './audit';
export * from './catalog';
export * from './orders';
export * from './payments';
