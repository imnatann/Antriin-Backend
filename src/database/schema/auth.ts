import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { campuses, users } from './index';

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 16 }).notNull(),
    identityHash: varchar('identity_hash', { length: 64 }).notNull(),
    destinationCiphertext: text('destination_ciphertext').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('auth_identities_channel_hash_unique').on(
      table.channel,
      table.identityHash,
    ),
    index('auth_identities_user_idx').on(table.userId),
    check(
      'auth_identities_channel_check',
      sql`${table.channel} in ('email', 'phone')`,
    ),
  ],
);

export const campusEmailDomains = pgTable(
  'campus_email_domains',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    domain: varchar('domain', { length: 253 }).notNull(),
    active: boolean('active').default(true).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('campus_email_domains_domain_unique').on(table.domain),
    index('campus_email_domains_campus_idx').on(table.campusId, table.active),
    check(
      'campus_email_domains_lowercase_check',
      sql`${table.domain} = lower(${table.domain})`,
    ),
  ],
);

export const authOtpChallenges = pgTable(
  'auth_otp_challenges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    campusId: uuid('campus_id').references(() => campuses.id, {
      onDelete: 'restrict',
    }),
    purpose: varchar('purpose', { length: 32 }).notNull(),
    channel: varchar('channel', { length: 16 }).notNull(),
    identityHash: varchar('identity_hash', { length: 64 }).notNull(),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    destinationCiphertext: text('destination_ciphertext').notNull(),
    displayName: varchar('display_name', { length: 200 }),
    status: varchar('status', { length: 24 }).default('created').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    index('auth_otp_challenges_identity_created_idx').on(
      table.identityHash,
      table.createdAt,
    ),
    index('auth_otp_challenges_expiry_idx').on(table.status, table.expiresAt),
    check(
      'auth_otp_challenges_purpose_check',
      sql`${table.purpose} in ('login', 'campus_email')`,
    ),
    check(
      'auth_otp_challenges_channel_check',
      sql`${table.channel} in ('email', 'phone')`,
    ),
    check(
      'auth_otp_challenges_status_check',
      sql`${table.status} in ('created', 'sent', 'delivery_failed', 'consumed', 'expired', 'locked', 'revoked')`,
    ),
    check('auth_otp_challenges_attempts_check', sql`${table.attempts} >= 0`),
    check(
      'auth_otp_challenges_max_attempts_check',
      sql`${table.maxAttempts} > 0`,
    ),
  ],
);

export const authOtpDeliveries = pgTable(
  'auth_otp_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    challengeId: uuid('challenge_id')
      .notNull()
      .references(() => authOtpChallenges.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 16 }).notNull(),
    destinationCiphertext: text('destination_ciphertext'),
    codeCiphertext: text('code_ciphertext'),
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('auth_otp_deliveries_challenge_unique').on(table.challengeId),
    index('auth_otp_deliveries_queue_idx').on(table.status, table.availableAt),
    check(
      'auth_otp_deliveries_channel_check',
      sql`${table.channel} in ('email', 'phone')`,
    ),
    check(
      'auth_otp_deliveries_status_check',
      sql`${table.status} in ('pending', 'processing', 'sent', 'dead')`,
    ),
    check('auth_otp_deliveries_attempts_check', sql`${table.attempts} >= 0`),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    rotatedToSessionId: uuid('rotated_to_session_id'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('auth_sessions_token_hash_unique').on(table.tokenHash),
    index('auth_sessions_user_active_idx').on(table.userId, table.expiresAt),
  ],
);

export const campusEmailVerifications = pgTable(
  'campus_email_verifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    identityHash: varchar('identity_hash', { length: 64 }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('campus_email_verifications_user_unique').on(table.userId),
    uniqueIndex('campus_email_verifications_identity_unique').on(
      table.identityHash,
    ),
  ],
);
