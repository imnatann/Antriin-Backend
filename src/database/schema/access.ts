import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { campuses, tenants, users } from './index';

export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: varchar('role', { length: 24 }).notNull(),
    permissions: text('permissions')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    status: varchar('status', { length: 16 }).default('active').notNull(),
    ownerVerifiedAt: timestamp('owner_verified_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('tenant_memberships_tenant_user_unique').on(
      table.tenantId,
      table.userId,
    ),
    index('tenant_memberships_user_status_idx').on(table.userId, table.status),
    check(
      'tenant_memberships_role_check',
      sql`${table.role} in ('owner', 'kitchen', 'pickup')`,
    ),
    check(
      'tenant_memberships_status_check',
      sql`${table.status} in ('active', 'revoked')`,
    ),
    check(
      'tenant_memberships_owner_verification_check',
      sql`${table.role} <> 'owner' or ${table.ownerVerifiedAt} is not null`,
    ),
    check(
      'tenant_memberships_revoked_at_check',
      sql`(${table.status} = 'active' and ${table.revokedAt} is null) or (${table.status} = 'revoked' and ${table.revokedAt} is not null)`,
    ),
  ],
);

export const campusMemberships = pgTable(
  'campus_memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    permissions: text('permissions')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    status: varchar('status', { length: 16 }).default('active').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('campus_memberships_campus_user_unique').on(
      table.campusId,
      table.userId,
    ),
    index('campus_memberships_user_status_idx').on(table.userId, table.status),
    check(
      'campus_memberships_status_check',
      sql`${table.status} in ('active', 'revoked')`,
    ),
    check(
      'campus_memberships_revoked_at_check',
      sql`(${table.status} = 'active' and ${table.revokedAt} is null) or (${table.status} = 'revoked' and ${table.revokedAt} is not null)`,
    ),
  ],
);

export const accessAuditEvents = pgTable(
  'access_audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    subjectUserId: uuid('subject_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    scopeType: varchar('scope_type', { length: 16 }).notNull(),
    scopeId: uuid('scope_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    action: varchar('action', { length: 16 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    details: text('details')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('access_audit_scope_occurred_idx').on(
      table.scopeType,
      table.scopeId,
      table.occurredAt,
    ),
    check(
      'access_audit_scope_type_check',
      sql`${table.scopeType} in ('tenant', 'campus')`,
    ),
    check(
      'access_audit_action_check',
      sql`${table.action} in ('grant', 'revoke')`,
    ),
  ],
);
