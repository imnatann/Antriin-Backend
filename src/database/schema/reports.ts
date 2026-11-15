import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  smallint,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { campuses, mediaAssets, tenants, users } from './index';

/**
 * A generated report file (sales or campus dashboard) plus, when a schedule is
 * set, the next time the worker should regenerate it.
 *
 * The file itself lives in media storage: `media_asset_id` points at it, so
 * downloads reuse the same authenticated/streamed path as every other upload
 * instead of adding a second storage mechanism.
 */
export const reportExports = pgTable(
  'report_exports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    campusId: uuid('campus_id').references(() => campuses.id, {
      onDelete: 'cascade',
    }),
    kind: varchar('kind', { length: 16 }).notNull(),
    format: varchar('format', { length: 8 }).notNull(),
    // Report window. Stored as plain calendar dates because a sales report is
    // defined in the tenant's local calendar, not in UTC instants.
    rangeFrom: varchar('range_from', { length: 10 }),
    rangeTo: varchar('range_to', { length: 10 }),
    schedule: varchar('schedule', { length: 16 }).default('manual').notNull(),
    // Local hour (0..23) used by a scheduled regeneration; null for manual.
    scheduleHour: smallint('schedule_hour'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    mediaAssetId: uuid('media_asset_id').references(() => mediaAssets.id, {
      onDelete: 'set null',
    }),
    error: varchar('error', { length: 500 }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
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
    index('report_exports_tenant_idx').on(table.tenantId, table.createdAt),
    index('report_exports_campus_idx').on(table.campusId, table.createdAt),
    index('report_exports_due_idx').on(table.nextRunAt, table.status),
    check(
      'report_exports_kind_check',
      sql`${table.kind} in ('sales', 'dashboard')`,
    ),
    check(
      'report_exports_format_check',
      sql`${table.format} in ('csv', 'pdf')`,
    ),
    check(
      'report_exports_schedule_check',
      sql`${table.schedule} in ('manual', 'daily', 'weekly')`,
    ),
    check(
      'report_exports_status_check',
      sql`${table.status} in ('pending', 'ready', 'failed')`,
    ),
    check(
      'report_exports_owner_check',
      sql`(${table.tenantId} is not null) <> (${table.campusId} is not null)`,
    ),
    check(
      'report_exports_schedule_hour_check',
      sql`${table.scheduleHour} is null or (${table.scheduleHour} >= 0 and ${table.scheduleHour} <= 23)`,
    ),
  ],
);
