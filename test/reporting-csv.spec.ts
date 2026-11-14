import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { ReportingController } from '../src/modules/reporting/reporting.controller';
import { ReportingService } from '../src/modules/reporting/reporting.service';
import type {
  CampusDashboard,
  SalesReport,
} from '../src/modules/reporting/reporting.service';
import {
  CSV_COLUMNS,
  campusDashboardToCsv,
  csvFilename,
  escapeCsvValue,
  salesReportToCsv,
  toCsv,
  toCsvRecord,
} from '../src/modules/reporting/reporting.csv';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CAMPUS_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const RANGE = 'from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z';

const SALES_REPORT: SalesReport = {
  tenantId: TENANT_ID,
  currency: 'IDR',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
  orders: [
    { status: 'completed', count: 2, totalMinor: '80000' },
    { status: 'cancelled', count: 1, totalMinor: '20000' },
  ],
  refunds: [{ status: 'succeeded', count: 1, totalMinor: '15000' }],
};

const DASHBOARD: CampusDashboard = {
  campusId: CAMPUS_ID,
  currency: 'IDR',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
  tenants: [{ status: 'open', count: 1 }],
  orders: [{ status: 'completed', count: 3, totalMinor: '120000' }],
  refunds: [],
  payouts: [{ status: 'requested', count: 1, totalMinor: '50000' }],
  cases: [{ status: 'reported', count: 2 }],
};

describe('CSV rendering helpers', () => {
  it('writes the fixed header and CRLF record separators', () => {
    assert.deepEqual(CSV_COLUMNS, [
      'section',
      'status',
      'count',
      'total_minor',
      'currency',
    ]);
    const csv = toCsv([
      [...CSV_COLUMNS],
      ['orders', 'completed', '2', '80000', 'IDR'],
    ]);
    assert.equal(
      csv,
      'section,status,count,total_minor,currency\r\n' +
        'orders,completed,2,80000,IDR\r\n',
    );
  });

  it('quotes values with a comma, quote or line break (RFC 4180)', () => {
    assert.equal(escapeCsvValue('plain'), 'plain');
    assert.equal(escapeCsvValue('a,b'), '"a,b"');
    assert.equal(escapeCsvValue('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsvValue('line1\nline2'), '"line1\nline2"');
    assert.equal(escapeCsvValue('line1\rline2'), '"line1\rline2"');
    assert.equal(toCsvRecord(['a,b', 'plain', 'q"q']), '"a,b",plain,"q""q"');
  });

  it('defuses spreadsheet formulas with a leading apostrophe', () => {
    assert.equal(escapeCsvValue('=SUM(A1:A9)'), "'=SUM(A1:A9)");
    assert.equal(escapeCsvValue('+1234'), "'+1234");
    assert.equal(escapeCsvValue('-1234'), "'-1234");
    assert.equal(escapeCsvValue('@cmd|calc'), "'@cmd|calc");
    assert.equal(escapeCsvValue('\tleading tab'), "'\tleading tab");
    assert.equal(escapeCsvValue('\rleading cr'), '"\'\rleading cr"');
    // A formula that also carries a delimiter stays quoted after the prefix.
    assert.equal(escapeCsvValue('=a,b'), '"\'=a,b"');
  });

  it('renders the tenant sales report as orders and refunds rows', () => {
    const csv = salesReportToCsv(SALES_REPORT);
    const lines = csv.split('\r\n').filter((line) => line !== '');
    assert.deepEqual(lines, [
      'section,status,count,total_minor,currency',
      'orders,completed,2,80000,IDR',
      'orders,cancelled,1,20000,IDR',
      'refunds,succeeded,1,15000,IDR',
    ]);
    assert.equal(csv.endsWith('\r\n'), true);
  });

  it('renders the campus dashboard and leaves total_minor empty without money', () => {
    const csv = campusDashboardToCsv(DASHBOARD);
    const lines = csv.split('\r\n').filter((line) => line !== '');
    assert.deepEqual(lines, [
      'section,status,count,total_minor,currency',
      'tenants,open,1,,IDR',
      'orders,completed,3,120000,IDR',
      'payouts,requested,1,50000,IDR',
      'cases,reported,2,,IDR',
    ]);
  });

  it('builds an attachment name from the normalized window', () => {
    assert.equal(
      csvFilename('tenant-sales', SALES_REPORT),
      'tenant-sales-2026-01-01_2026-02-01.csv',
    );
    assert.equal(
      csvFilename('campus-dashboard', DASHBOARD),
      'campus-dashboard-2026-01-01_2026-02-01.csv',
    );
  });
});

class StubReportingService {
  calls: string[] = [];
  failure?: unknown;

  async getSalesReport() {
    this.calls.push('sales');
    if (this.failure) throw this.failure;
    return SALES_REPORT;
  }

  async getCampusDashboard() {
    this.calls.push('dashboard');
    if (this.failure) throw this.failure;
    return DASHBOARD;
  }

  async listCampusTransactions() {
    this.calls.push('transactions');
    if (this.failure) throw this.failure;
    return { items: [], nextCursor: null };
  }
}

describe('CSV export HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubReportingService;

  const auth = { authorization: 'Bearer test-token' };
  const salesCsvUrl = `/api/v1/tenants/${TENANT_ID}/reports/sales.csv?${RANGE}`;
  const dashboardCsvUrl = `/api/v1/campuses/${CAMPUS_ID}/dashboard.csv?${RANGE}`;

  beforeEach(async () => {
    stub = new StubReportingService();
    const guard = {
      canActivate: (context: ExecutionContext) => {
        const request = context.switchToHttp().getRequest<{
          headers: { authorization?: string };
          user?: { userId: string; sessionId: string };
        }>();
        if (request.headers.authorization !== 'Bearer test-token') {
          throw new UnauthorizedException({
            code: 'unauthorized',
            message: 'A valid bearer token is required',
          });
        }
        request.user = { userId: ACTOR_ID, sessionId: 'session-1' };
        return true;
      },
    };
    const module = await Test.createTestingModule({
      controllers: [ReportingController],
      providers: [{ provide: ReportingService, useValue: stub }],
    })
      .overrideGuard(AuthGuard)
      .useValue(guard)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the tenant sales report as a CSV attachment', async () => {
    const response = await app.inject({
      method: 'GET',
      url: salesCsvUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/csv; charset=utf-8');
    assert.equal(
      response.headers['content-disposition'],
      'attachment; filename="tenant-sales-2026-01-01_2026-02-01.csv"',
    );
    const lines = response.body.split('\r\n').filter((line) => line !== '');
    assert.equal(lines[0], 'section,status,count,total_minor,currency');
    assert.ok(lines.includes('orders,completed,2,80000,IDR'));
    assert.ok(lines.includes('refunds,succeeded,1,15000,IDR'));
    assert.equal(response.body.trimStart().startsWith('{'), false);
    assert.deepEqual(stub.calls, ['sales']);
  });

  it('serves the campus dashboard as a CSV attachment', async () => {
    const response = await app.inject({
      method: 'GET',
      url: dashboardCsvUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/csv; charset=utf-8');
    assert.equal(
      response.headers['content-disposition'],
      'attachment; filename="campus-dashboard-2026-01-01_2026-02-01.csv"',
    );
    const lines = response.body.split('\r\n').filter((line) => line !== '');
    assert.ok(lines.includes('tenants,open,1,,IDR'));
    assert.ok(lines.includes('orders,completed,3,120000,IDR'));
    assert.ok(lines.includes('cases,reported,2,,IDR'));
    assert.deepEqual(stub.calls, ['dashboard']);
  });

  it('requires a bearer token before any CSV work', async () => {
    for (const url of [salesCsvUrl, dashboardCsvUrl]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, url);
      assert.equal(
        response.headers['content-type'],
        'application/json; charset=utf-8',
      );
    }
    assert.deepEqual(stub.calls, []);
  });

  it('rejects an invalid window before the service runs', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${TENANT_ID}/reports/sales.csv?from=2026-01-01T00:00:00.000Z`,
      headers: auth,
    });
    assert.equal(missing.statusCode, 400);
    const unknownField = await app.inject({
      method: 'GET',
      url: `${salesCsvUrl}&delimiter=%3B`,
      headers: auth,
    });
    assert.equal(unknownField.statusCode, 400);
    assert.deepEqual(stub.calls, []);
  });

  it('maps a denied permission to 403 instead of a CSV body', async () => {
    stub.failure = new ForbiddenException({
      code: 'tenant_permission_required',
      message: 'Tenant permission is required',
    });
    const response = await app.inject({
      method: 'GET',
      url: salesCsvUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 403);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'tenant_permission_required',
    );
  });
});
