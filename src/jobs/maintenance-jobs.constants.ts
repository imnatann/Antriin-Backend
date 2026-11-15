/**
 * Names, cadences and batch bounds for the scheduled maintenance jobs that the
 * worker registers on startup (src/jobs/maintenance.scheduler.ts).
 *
 * Every job runs in bounded batches so one pass can never scan or rewrite an
 * unbounded table, and every job is written so a second run is a no-op.
 */

/** Infrastructure probe; the only job that existed before the sweepers. */
export const MAINTENANCE_HEALTHCHECK_JOB = 'healthcheck';
/** Pending top-up intents past expires_at become 'expired'. */
export const EXPIRE_TOPUP_INTENTS_JOB = 'expire-topup-intents';
/** Expired order idempotency replay records are deleted. */
export const PURGE_ORDER_IDEMPOTENCY_JOB = 'purge-order-idempotency';
/** Media tombstones older than the retention window are removed with files. */
export const SWEEP_MEDIA_TOMBSTONES_JOB = 'sweep-media-tombstones';
/** Evidence-only risk detectors feed the campus review queue. */
export const RUN_RISK_DETECTORS_JOB = 'run-risk-detectors';
/** Report exports whose next_run_at has passed are regenerated. */
export const RUN_REPORT_EXPORTS_JOB = 'run-report-exports';

/** Hourly cron is deliberately avoided; these intervals are drift-free. */
export const EXPIRE_TOPUP_INTENTS_EVERY_MS = 60_000;
export const RUN_RISK_DETECTORS_EVERY_MS = 15 * 60_000;
/**
 * Report schedules are expressed in whole local hours, so a five-minute check
 * keeps a "daily at 07:00" export close to its hour without hammering the
 * database.
 */
export const RUN_REPORT_EXPORTS_EVERY_MS = 5 * 60_000;

/** Daily jobs run once a day (off-peak, UTC) because 60s was unnecessary noise. */
export const PURGE_ORDER_IDEMPOTENCY_CRON = '15 3 * * *';
export const SWEEP_MEDIA_TOMBSTONES_CRON = '45 3 * * *';
export const MAINTENANCE_SCHEDULE_TIMEZONE = 'UTC';

/** Rows handled per statement, and the per-pass batch cap. */
export const TOPUP_EXPIRY_BATCH_SIZE = 500;
export const TOPUP_EXPIRY_MAX_BATCHES = 20;
export const IDEMPOTENCY_PURGE_BATCH_SIZE = 500;
export const IDEMPOTENCY_PURGE_MAX_BATCHES = 20;
export const MEDIA_TOMBSTONE_BATCH_SIZE = 200;
export const MEDIA_TOMBSTONE_MAX_BATCHES = 10;

/**
 * A soft-deleted media row keeps its bytes for this long so an operator can
 * still investigate an upload; after that the row and its files are removed.
 * The media module documents the tombstone as "left for operator cleanup", and
 * this job is that cleanup.
 */
export const MEDIA_TOMBSTONE_RETENTION_DAYS = 30;

/** Audit actor for state changed by the top-up expiry sweep. */
export const TOPUP_EXPIRY_ACTOR_SERVICE = 'topup-expiry-sweep';
