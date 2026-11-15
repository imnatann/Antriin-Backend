import PDFDocument from 'pdfkit';
import type { CampusDashboard, SalesReport } from './reporting.service';

/**
 * PDF rendering for the report exports.
 *
 * A PDF is rendered from the same object the JSON and CSV endpoints use, so it
 * can never disagree with them: there is no second query and no second
 * aggregation. It carries only counts and sums of existing columns - no fee,
 * tax, gross or net figure is invented here (REQUIREMENTS 3.8.8 leaves those
 * undecided).
 *
 * Rendering is local and offline: the standard PDF fonts pdfkit bundles are
 * used, so no font file is read from disk and no network call happens while a
 * report is produced.
 */

const PAGE_MARGIN = 40;
const BODY_SIZE = 10;
const ROW_HEIGHT = 16;
const RULE_GAP = 4;

/** A4 portrait minus the margins: 595.28 x 841.89 points. */
const CONTENT_WIDTH = 595.28 - PAGE_MARGIN * 2;

const COLUMNS = [
  { key: 'status', header: 'status', width: 210, align: 'left' as const },
  { key: 'count', header: 'count', width: 90, align: 'right' as const },
  {
    key: 'totalMinor',
    header: 'total_minor',
    width: 205,
    align: 'right' as const,
  },
];

const FOOTER_NOTE =
  'count is a row count; total_minor is the sum of the existing order, refund or ' +
  'payout column for that status, not revenue. Fees, taxes and gross/net ' +
  'definitions are undecided (REQUIREMENTS 3.8.8).';

type TableRow = {
  status: string;
  count: number;
  /** null for sections without money (tenants, cases): not zero, just absent. */
  totalMinor: string | null;
};

export type PdfSection = { title: string; rows: TableRow[] };

type ReportHeader = {
  title: string;
  scopeLabel: string;
  scopeId: string;
  currency: string;
  from: string;
  to: string;
};

/** Tenant sales export: one table per section, exactly the CSV rows. */
export async function salesReportToPdf(report: SalesReport): Promise<Buffer> {
  return renderReport(
    {
      title: 'Tenant sales report',
      scopeLabel: 'Tenant',
      scopeId: report.tenantId,
      currency: report.currency,
      from: report.from,
      to: report.to,
    },
    [
      { title: 'orders', rows: report.orders },
      { title: 'refunds', rows: report.refunds },
    ],
  );
}

/** Campus oversight export: orders, refunds, payouts and the two count-only sections. */
export async function campusDashboardToPdf(
  dashboard: CampusDashboard,
): Promise<Buffer> {
  return renderReport(
    {
      title: 'Campus oversight dashboard',
      scopeLabel: 'Campus',
      scopeId: dashboard.campusId,
      currency: dashboard.currency,
      from: dashboard.from,
      to: dashboard.to,
    },
    [
      { title: 'tenants', rows: dashboard.tenants.map(asCountOnly) },
      { title: 'orders', rows: dashboard.orders },
      { title: 'refunds', rows: dashboard.refunds },
      { title: 'payouts', rows: dashboard.payouts },
      { title: 'cases', rows: dashboard.cases.map(asCountOnly) },
    ],
  );
}

/**
 * Attachment name built from literals and the normalized window, e.g.
 * "tenant-sales-2026-01-01_2026-02-01.pdf". No client input reaches the header.
 */
export function pdfFilename(
  prefix: string,
  range: { from: string; to: string },
): string {
  const day = (value: string) => value.slice(0, 10);
  return prefix + '-' + day(range.from) + '_' + day(range.to) + '.pdf';
}

/** Sections without a money column keep total_minor empty, never an invented 0. */
function asCountOnly(row: { status: string; count: number }): TableRow {
  return { status: row.status, count: row.count, totalMinor: null };
}

function renderReport(
  header: ReportHeader,
  sections: PdfSection[],
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE_MARGIN,
      info: {
        Title: header.title,
        Author: 'Antriin',
        Creator: 'Antriin API',
        Producer: 'Antriin API',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      drawReport(doc, header, sections);
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function drawReport(
  doc: PDFKit.PDFDocument,
  header: ReportHeader,
  sections: PdfSection[],
): void {
  let y = PAGE_MARGIN;
  doc.font('Helvetica-Bold').fontSize(16);
  doc.text(header.title, PAGE_MARGIN, y, { width: CONTENT_WIDTH });
  y = doc.y + 6;

  doc.font('Helvetica').fontSize(BODY_SIZE);
  for (const line of [
    header.scopeLabel + ': ' + header.scopeId,
    'Window: ' + header.from + ' (inclusive) to ' + header.to + ' (exclusive)',
    'Currency: ' + header.currency,
  ]) {
    doc.text(line, PAGE_MARGIN, y, { width: CONTENT_WIDTH });
    y = doc.y + 2;
  }
  y += 10;

  for (const section of sections) {
    if (y + ROW_HEIGHT * 3 > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      y = PAGE_MARGIN;
    }
    doc.font('Helvetica-Bold').fontSize(12);
    doc.text(section.title, PAGE_MARGIN, y, { width: CONTENT_WIDTH });
    y = doc.y + 4;

    doc.font('Helvetica-Bold').fontSize(9);
    y = drawColumns(
      doc,
      y,
      COLUMNS.map((column) => column.header),
      true,
    );
    doc
      .moveTo(PAGE_MARGIN, y + RULE_GAP)
      .lineTo(PAGE_MARGIN + CONTENT_WIDTH, y + RULE_GAP)
      .lineWidth(0.5)
      .strokeColor('#888888')
      .stroke();
    y += RULE_GAP * 2 + 2;

    if (section.rows.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(BODY_SIZE);
      doc.text('No rows in this window.', PAGE_MARGIN, y, {
        width: CONTENT_WIDTH,
      });
      y = doc.y + 12;
      continue;
    }

    doc.font('Helvetica').fontSize(BODY_SIZE);
    for (const row of section.rows) {
      if (y + ROW_HEIGHT > doc.page.height - PAGE_MARGIN) {
        doc.addPage();
        y = PAGE_MARGIN;
        doc.font('Helvetica-Bold').fontSize(9);
        y = drawColumns(
          doc,
          y,
          COLUMNS.map((column) => column.header),
          true,
        );
        y += RULE_GAP * 2 + 2;
        doc.font('Helvetica').fontSize(BODY_SIZE);
      }
      y = drawColumns(
        doc,
        y,
        [
          row.status,
          String(row.count),
          row.totalMinor === null ? '' : row.totalMinor,
        ],
        false,
      );
    }
    y += 14;
  }

  if (y + ROW_HEIGHT * 3 > doc.page.height - PAGE_MARGIN) {
    doc.addPage();
    y = PAGE_MARGIN;
  }
  doc.font('Helvetica').fontSize(8).fillColor('#444444');
  doc.text(FOOTER_NOTE, PAGE_MARGIN, y + 8, { width: CONTENT_WIDTH });
  doc.fillColor('#000000');
}

/**
 * Draws one aligned table row. lineBreak is disabled so a value can never wrap
 * and shift the numbers below the wrong column; every value written here is a
 * status name, a count or a digit string.
 */
function drawColumns(
  doc: PDFKit.PDFDocument,
  y: number,
  cells: readonly string[],
  bold: boolean,
): number {
  let x = PAGE_MARGIN;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
  cells.forEach((value, index) => {
    const column = COLUMNS[index] ?? COLUMNS[0];
    doc.text(value, x, y, {
      width: column.width,
      align: column.align,
      lineBreak: false,
    });
    x += column.width;
  });
  return y + ROW_HEIGHT;
}
