import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { constants as zlibConstants, inflateSync } from 'node:zlib';
import {
  campusDashboardToPdf,
  pdfFilename,
  salesReportToPdf,
} from '../src/modules/reporting/reporting.pdf';

const RANGE = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
};

const SALES = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  currency: 'IDR',
  ...RANGE,
  orders: [
    { status: 'completed', count: 2, totalMinor: '80000' },
    { status: 'cancelled', count: 1, totalMinor: '15000' },
  ],
  refunds: [{ status: 'succeeded', count: 1, totalMinor: '50000' }],
};

const DASHBOARD = {
  campusId: '22222222-2222-4222-8222-222222222222',
  currency: 'IDR',
  ...RANGE,
  tenants: [{ status: 'open', count: 3 }],
  orders: [{ status: 'completed', count: 4, totalMinor: '120000' }],
  refunds: [],
  payouts: [{ status: 'succeeded', count: 1, totalMinor: '60000' }],
  cases: [{ status: 'reported', count: 2 }],
};

/**
 * pdfkit compresses page content streams, so the drawn text is not readable in
 * the raw bytes. Inflating every stream lets a test assert that a value really
 * reached the page instead of only that a PDF was produced.
 */
function inflateStreams(pdf: Buffer): string {
  const source = pdf.toString('latin1');
  const pattern = /stream\r?\n/g;
  const parts: string[] = [];
  let match = pattern.exec(source);
  // Each page keeps its own content stream, so a multi-page report has several.
  for (let guard = 0; match !== null && guard < 100; guard += 1) {
    const start = match.index + match[0].length;
    const end = source.indexOf('endstream', start);
    if (end < 0) break;
    try {
      parts.push(
        inflateSync(pdf.subarray(start, end), {
          finishFlush: zlibConstants.Z_SYNC_FLUSH,
        }).toString('latin1'),
      );
    } catch {
      // Not a Flate stream (images, metadata): nothing to read as text.
    }
    // Skip past the whole `endstream` token: a search starting inside it would
    // match its tail and jump over the next page's real stream header.
    pattern.lastIndex = end + 'endstream'.length;
    match = pattern.exec(source);
  }
  return parts.join('\n');
}

/**
 * The text a reader would see. pdfkit writes glyph runs as hex strings between
 * kerning numbers, so the numbers are dropped and the runs decoded in order.
 */
function drawnText(pdf: Buffer): string {
  const content = inflateStreams(pdf);
  const runs = /<([0-9a-fA-F\s]+)>/g;
  let text = '';
  let match = runs.exec(content);
  for (let guard = 0; match !== null && guard < 100000; guard += 1) {
    text += Buffer.from(match[1].replace(/\s+/g, ''), 'hex').toString('latin1');
    match = runs.exec(content);
  }
  return text;
}

describe('Sales report PDF', () => {
  it('is a real PDF document, not an HTML page or a text dump', async () => {
    const pdf = await salesReportToPdf(SALES);
    assert.ok(Buffer.isBuffer(pdf));
    // The header is the first thing a PDF reader checks; anything else (HTML,
    // CSV, an error page) must never reach the client.
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(
      pdf.subarray(-16).toString('latin1').includes('%%EOF'),
      'a truncated PDF has no EOF marker',
    );
    assert.ok(pdf.length > 500);
    assert.equal(pdf.toString('latin1').includes('<html'), false);
  });

  it('draws the window, the currency and every status row with its numbers', async () => {
    const text = drawnText(await salesReportToPdf(SALES));
    for (const expected of [
      RANGE.from,
      RANGE.to,
      'IDR',
      SALES.tenantId,
      'completed',
      '80000',
      'cancelled',
      'succeeded',
      '50000',
      'total_minor',
    ]) {
      assert.ok(text.includes(expected), expected + ' is missing from the PDF');
    }
  });

  it('grows with the number of rows instead of dropping them', async () => {
    const small = await salesReportToPdf(SALES);
    const many = await salesReportToPdf({
      ...SALES,
      orders: Array.from({ length: 40 }, (_, index) => ({
        status: 'status_' + String(index),
        count: index,
        totalMinor: String(1000 + index),
      })),
    });
    assert.ok(
      many.length > small.length,
      'a 40-row report should be larger than a 3-row one',
    );
    const text = drawnText(many);
    assert.ok(text.includes('status_39'));
    assert.ok(text.includes('1039'));
  });

  it('spans several pages when the rows do not fit on one', async () => {
    const pdf = await salesReportToPdf({
      ...SALES,
      orders: Array.from({ length: 200 }, (_, index) => ({
        status: 'status_' + String(index),
        count: index + 1,
        totalMinor: String(1000 + index),
      })),
    });
    const raw = pdf.toString('latin1');
    const pages = raw.match(/\/Type \/Page[^s]/g) ?? [];
    assert.ok(pages.length > 1, 'expected more than one page');
    const text = drawnText(pdf);
    // The last row has to survive the page break.
    assert.ok(text.includes('status_199'));
  });
});

describe('Campus dashboard PDF', () => {
  it('renders every section, including the count-only ones', async () => {
    const text = drawnText(await campusDashboardToPdf(DASHBOARD));
    for (const expected of [
      'tenants',
      'orders',
      'refunds',
      'payouts',
      'cases',
      '120000',
      '60000',
      'reported',
      DASHBOARD.campusId,
    ]) {
      assert.ok(text.includes(expected), expected + ' is missing from the PDF');
    }
  });

  it('says a section is empty instead of inventing a zero row', async () => {
    const text = drawnText(await campusDashboardToPdf(DASHBOARD));
    assert.ok(text.includes('No rows in this window.'));
    // tenants/cases have no money column: no zero is printed for them.
    assert.equal(/tenants[\s\S]{0,80}0\s/.test(text), false);
  });

  it('keeps the dashboard and the sales report distinct documents', async () => {
    const dashboard = await campusDashboardToPdf(DASHBOARD);
    const sales = await salesReportToPdf(SALES);
    assert.notEqual(dashboard.length, sales.length);
    assert.ok(drawnText(dashboard).includes('Campus oversight dashboard'));
    assert.ok(drawnText(sales).includes('Tenant sales report'));
  });
});

describe('PDF attachment name', () => {
  it('uses literals and the normalized window only', () => {
    assert.equal(
      pdfFilename('tenant-sales', RANGE),
      'tenant-sales-2026-01-01_2026-02-01.pdf',
    );
    assert.equal(
      pdfFilename('campus-dashboard', RANGE),
      'campus-dashboard-2026-01-01_2026-02-01.pdf',
    );
  });

  it('never lets a quote or a path through the header value', () => {
    const name = pdfFilename('tenant-sales', {
      from: RANGE.from,
      to: RANGE.to,
    });
    assert.equal(/[\r\n"]/.test(name), false);
    assert.equal(name.includes('..'), false);
  });
});
