import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { campuses, tenants, users } from './index';

/**
 * Immutable risk/AI signal (REQUIREMENTS §3.10.4, §7.2).
 *
 * A signal is evidence, never a sanction: the row records the score, the
 * explanation and the model version that produced it, and nothing in this
 * schema can block an account, hide a review or move money. Only a human
 * decision (risk_review_decisions) may follow, and it is recorded separately.
 *
 * Signals are append-only: there is no status column to mutate. The queue state
 * is derived from whether a decision exists, so the original observation can
 * never be rewritten after the fact.
 */
export const riskSignals = pgTable(
  'risk_signals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    // Optional: some signals are campus-wide (e.g. an account pattern that is
    // not tied to one stall).
    tenantId: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'restrict',
    }),
    subjectType: varchar('subject_type', { length: 16 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    category: varchar('category', { length: 32 }).notNull(),
    score: numeric('score', { precision: 5, scale: 4 }).notNull(),
    modelVersion: varchar('model_version', { length: 64 }).notNull(),
    explanation: text('explanation').notNull(),
    evidence: jsonb('evidence').default({}).notNull(),
    // Stable producer key so a re-run of the same detector cannot duplicate a
    // signal (REQUIREMENTS §7.2 "UNIQUE dedupe key per sinyal").
    dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('risk_signals_dedupe_key_unique').on(table.dedupeKey),
    index('risk_signals_campus_created_idx').on(
      table.campusId,
      table.createdAt,
      table.id,
    ),
    check(
      'risk_signals_subject_type_check',
      sql`${table.subjectType} in ('tenant', 'buyer', 'order')`,
    ),
    check(
      'risk_signals_category_check',
      sql`${table.category} in ('rating_anomaly', 'payment_refund_chain', 'tenant_status_change')`,
    ),
    check(
      'risk_signals_score_check',
      sql`${table.score} >= 0 and ${table.score} <= 1`,
    ),
    check(
      'risk_signals_explanation_check',
      sql`length(trim(${table.explanation})) > 0`,
    ),
  ],
);

/**
 * A campus manager's decision on one signal. Append-only so the whole review
 * history stays readable ("Riwayat keputusan dapat dibaca sesuai izin",
 * §3.10.6); the newest row is the current outcome.
 */
export const riskReviewDecisions = pgTable(
  'risk_review_decisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    signalId: uuid('signal_id')
      .notNull()
      .references(() => riskSignals.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decision: varchar('decision', { length: 32 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('risk_review_decisions_signal_idx').on(
      table.signalId,
      table.decidedAt,
    ),
    index('risk_review_decisions_campus_idx').on(
      table.campusId,
      table.decidedAt,
    ),
    check(
      'risk_review_decisions_decision_check',
      sql`${table.decision} in ('no_violation', 'explanation_requested')`,
    ),
    check(
      'risk_review_decisions_reason_check',
      sql`length(trim(${table.reason})) > 0`,
    ),
  ],
);
