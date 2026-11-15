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
import { tenants, users } from './index';

/**
 * A pending invitation to join a tenant's staff (REQUIREMENTS §6 StaffInvite).
 *
 * The owner creates the invite for a specific user id and hands over a
 * one-time token; the invited user accepts it and the membership is created.
 * Inviting by user id rather than by email is deliberate: no external delivery
 * channel is live yet, so an invite addressed to an email would be a promise
 * the backend cannot keep. When a provider exists this table still works - only
 * the delivery of the token changes.
 *
 * Only the SHA-256 of the token is stored, exactly like sessions and pickup
 * codes, so a leaked database cannot be replayed as an invitation.
 */
export const tenantStaffInvites = pgTable(
  'tenant_staff_invites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // The user who will accept. Fixed at creation so a forwarded token cannot
    // be redeemed by somebody else.
    invitedUserId: uuid('invited_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: varchar('role', { length: 16 }).notNull(),
    // JSON array of granted permission codes, validated by the service against
    // the tenant permission catalogue before it is stored.
    permissions: jsonb('permissions').default([]).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
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
    uniqueIndex('tenant_staff_invites_token_unique').on(table.tokenHash),
    index('tenant_staff_invites_tenant_idx').on(
      table.tenantId,
      table.createdAt,
    ),
    index('tenant_staff_invites_user_idx').on(
      table.invitedUserId,
      table.acceptedAt,
    ),
    check(
      'tenant_staff_invites_role_check',
      sql`${table.role} in ('owner', 'kitchen', 'pickup')`,
    ),
    check(
      'tenant_staff_invites_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);
