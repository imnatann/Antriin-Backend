import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './index';
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    actorService: varchar('actor_service', { length: 80 }),
    scopeType: varchar('scope_type', { length: 16 }).notNull(),
    scopeId: uuid('scope_id').notNull(),
    action: varchar('action', { length: 100 }).notNull(),
    targetType: varchar('target_type', { length: 40 }).notNull(),
    targetId: uuid('target_id').notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      'audit_events_actor_check',
      sql`(${t.actorUserId} is not null and ${t.actorService} is null) or (${t.actorUserId} is null and ${t.actorService} is not null)`,
    ),
    check(
      'audit_events_scope_check',
      sql`${t.scopeType} in ('user','tenant','campus')`,
    ),
    index('audit_events_scope_cursor_idx').on(
      t.scopeType,
      t.scopeId,
      t.occurredAt,
      t.id,
    ),
    index('audit_events_target_idx').on(t.targetType, t.targetId, t.occurredAt),
  ],
);
