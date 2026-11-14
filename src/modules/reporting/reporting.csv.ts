import type { CampusDashboard, SalesReport } from './reporting.service';

/**
 * CSV rendering for the reporting exports. These are pure functions with no
 * HTTP or database access so the escaping rules can be tested on their own.
 *
 * The column set is deliberately fixed: it only carries counts and sums of
 * existing columns, never a derived financial definition (REQUIREMENTS §3.8.8
 * leaves fees, taxes and gross/net undecided).
 */

export const CSV_COLUMNS = [
  'section',
  'status',
  'count',
  'total_minor',
  'currency',
] as const;

/** RFC 4180 uses CRLF between records. */
const CSV_RECORD_SEPARATOR = '\r\n';

/**
 * A leading =, +, -, @, TAB or CR makes a spreadsheet evaluate the cell as a
 * formula. A leading apostrophe is inert in a CSV cell and keeps the text
 * literal, which is the established mitigation for exported reports.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** Quotes one cell when it contains a delimiter, quote or line break. */
export function escapeCsvValue(value: string): string {
  const guarded = FORMULA_TRIGGER.test(value) ? "'" + value : value;
  if (/[",\r\n]/.test(guarded)) return '"' + guarded.replace(/"/g, '""') + '"';
  return guarded;
}

/** Joins one record's cells; the caller decides the record separator. */
export function toCsvRecord(values: readonly string[]): string {
  return values.map((value) => escapeCsvValue(value)).join(',');
}

/** Renders records (header included) as a CSV document with CRLF endings. */
export function toCsv(records: readonly (readonly string[])[]): string {
  return records
    .map((record) => toCsvRecord(record) + CSV_RECORD_SEPARATOR)
    .join('');
}

/**
 * Tenant sales export: the order and refund groups of getSalesReport, one row
 * per status. total_minor is the string the database produced (::text).
 */
export function salesReportToCsv(report: SalesReport): string {
  const records: string[][] = [[...CSV_COLUMNS]];
  for (const row of report.orders)
    records.push([
      'orders',
      row.status,
      String(row.count),
      row.totalMinor,
      report.currency,
    ]);
  for (const row of report.refunds)
    records.push([
      'refunds',
      row.status,
      String(row.count),
      row.totalMinor,
      report.currency,
    ]);
  return toCsv(records);
}

/**
 * Campus dashboard export. sections without money (tenants, cases) keep an
 * empty total_minor instead of an invented 0 so a reader can tell "no money
 * column" from "zero money".
 */
export function campusDashboardToCsv(dashboard: CampusDashboard): string {
  const records: string[][] = [[...CSV_COLUMNS]];
  for (const row of dashboard.tenants)
    records.push([
      'tenants',
      row.status,
      String(row.count),
      '',
      dashboard.currency,
    ]);
  for (const row of dashboard.orders)
    records.push([
      'orders',
      row.status,
      String(row.count),
      row.totalMinor,
      dashboard.currency,
    ]);
  for (const row of dashboard.refunds)
    records.push([
      'refunds',
      row.status,
      String(row.count),
      row.totalMinor,
      dashboard.currency,
    ]);
  for (const row of dashboard.payouts)
    records.push([
      'payouts',
      row.status,
      String(row.count),
      row.totalMinor,
      dashboard.currency,
    ]);
  for (const row of dashboard.cases)
    records.push([
      'cases',
      row.status,
      String(row.count),
      '',
      dashboard.currency,
    ]);
  return toCsv(records);
}

/**
 * Attachment name built from the normalized window, e.g.
 * "tenant-sales-2026-01-01_2026-02-01.csv". The prefix is a literal chosen by
 * the controller, so no client input reaches the header.
 */
export function csvFilename(
  prefix: string,
  range: { from: string; to: string },
): string {
  const day = (value: string) => value.slice(0, 10);
  return prefix + '-' + day(range.from) + '_' + day(range.to) + '.csv';
}
