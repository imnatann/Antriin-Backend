import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './index';

/**
 * Record of a self-service account closure (REQUIREMENTS §7.6 retention).
 *
 * Closing an account never deletes rows: financial and audit history has to
 * survive for reconciliation, so the user row is closed and its display name is
 * pseudonymised while orders, ledger entries and reviews keep pointing at the
 * same id. This table is the durable record of who asked, when, and what was
 * kept, so the decision is auditable after the fact.
 */
export const accountDeletionRequests = pgTable(
  'account_deletion_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 }).default('completed').notNull(),
    reason: text('reason'),
    // What the closure did, recorded so a later reader does not have to guess
    // why some rows still exist for a "deleted" account.
    retainedSummary: jsonb('retained_summary').default({}).notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...{
      createdAt: timestamp('created_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
  },
  (table) => [
    index('account_deletion_requests_user_idx').on(
      table.userId,
      table.requestedAt,
    ),
    check(
      'account_deletion_requests_status_check',
      sql`${table.status} in ('requested', 'completed')`,
    ),
  ],
);
