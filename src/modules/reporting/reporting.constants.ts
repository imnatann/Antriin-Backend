/**
 * Campus transaction monitoring page bounds. They match the other cursor pages
 * of the API (orders/wallet/reviews) so a client can reuse its pagination
 * helper, and they are shared by the service and its DTO so the two never
 * disagree about the accepted range.
 */
export const TRANSACTION_PAGE_LIMIT_DEFAULT = 25;
export const TRANSACTION_PAGE_LIMIT_MAX = 100;

/**
 * The values the report_exports CHECK constraints accept. They are declared
 * here as well so a request is rejected before the database sees it, and the
 * service and the DTO cannot drift apart.
 */
export const REPORT_EXPORT_KINDS = ['sales', 'dashboard'] as const;
export const REPORT_EXPORT_FORMATS = ['csv', 'pdf'] as const;
export const REPORT_EXPORT_SCHEDULES = ['manual', 'daily', 'weekly'] as const;
export const REPORT_EXPORT_STATUSES = ['pending', 'ready', 'failed'] as const;

export type ReportExportKind = (typeof REPORT_EXPORT_KINDS)[number];
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];
export type ReportSchedule = (typeof REPORT_EXPORT_SCHEDULES)[number];
export type ReportExportStatus = (typeof REPORT_EXPORT_STATUSES)[number];

/**
 * One list call returns the schedules of a single tenant or campus. A scope has
 * a handful of them, so there is no cursor: the cap is a bound, and `truncated`
 * tells a caller when it was reached instead of hiding rows silently.
 */
export const REPORT_EXPORT_LIST_LIMIT = 100;

/**
 * Rows one runDueExports() batch claims. Rows are locked with SKIP LOCKED, so a
 * second worker takes the next batch instead of waiting or repeating work.
 */
export const DUE_EXPORT_BATCH_LIMIT = 50;
