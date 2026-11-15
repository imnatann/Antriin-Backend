import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BadRequestException,
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

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CAMPUS_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const EXPORT_ID = '44444444-4444-4444-8444-444444444444';
const RANGE = 'from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z';

const SALES = {
  tenantId: TENANT_ID,
  currency: 'IDR',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
  orders: [{ status: 'completed', count: 2, totalMinor: '80000' }],
  refunds: [],
};

const DASHBOARD = {
  campusId: CAMPUS_ID,
  currency: 'IDR',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
  tenants: [{ status: 'open', count: 1 }],
  orders: [{ status: 'completed', count: 1, totalMinor: '50000' }],
  refunds: [],
  payouts: [],
  cases: [{ status: 'reported', count: 1 }],
};

type CreateCall = {
  actorUserId: string;
  target: { type: 'tenant' | 'campus'; id: string };
  input: Record<string, unknown>;
};

class StubReportingService {
  calls: string[] = [];
  failure?: unknown;
  createCalls: CreateCall[] = [];

  async getSalesReport() {
    this.calls.push('sales');
    if (this.failure) throw this.failure;
    return SALES;
  }

  async getCampusDashboard() {
    this.calls.push('dashboard');
    if (this.failure) throw this.failure;
    return DASHBOARD;
  }

  async createExport(
    actorUserId: string,
    target: { type: 'tenant' | 'campus'; id: string },
    input: Record<string, unknown>,
  ) {
    this.calls.push('createExport');
    if (this.failure) throw this.failure;
    this.createCalls.push({ actorUserId, target, input });
    return {
      id: EXPORT_ID,
      scope: target,
      kind: input.kind,
      format: input.format,
      from: '2026-01-01',
      to: '2026-02-01',
      schedule: input.schedule ?? 'manual',
      scheduleHour: input.scheduleHour ?? null,
      status: 'pending',
      mediaAssetId: null,
      error: null,
      nextRunAt: null,
      generatedAt: null,
      createdAt: '2026-11-15T00:00:00.000000Z',
      updatedAt: '2026-11-15T00:00:00.000000Z',
      downloadPath: '/api/v1/tenants/' + TENANT_ID + '/reports/sales.pdf',
    };
  }

  async listExports(
    actorUserId: string,
    target: { type: 'tenant' | 'campus'; id: string },
  ) {
    this.calls.push('listExports');
    if (this.failure) throw this.failure;
    return {
      items: [
        {
          id: EXPORT_ID,
          scope: target,
          kind: 'sales',
          format: 'pdf',
          from: '2026-01-01',
          to: '2026-02-01',
          schedule: 'daily',
          scheduleHour: 7,
          status: 'ready',
          mediaAssetId: null,
          error: null,
          nextRunAt: '2026-11-16T00:00:00.000000Z',
          generatedAt: '2026-11-15T00:00:00.000000Z',
          createdAt: '2026-11-15T00:00:00.000000Z',
          updatedAt: '2026-11-15T00:00:00.000000Z',
          downloadPath: '/api/v1/tenants/' + TENANT_ID + '/reports/sales.pdf',
        },
      ],
      truncated: false,
    };
  }

  async runDueExports() {
    throw new Error('runDueExports must never be reachable from HTTP');
  }
}

describe('Reporting PDF and export HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubReportingService;

  const auth = { authorization: 'Bearer test-token' };
  const salesPdfUrl = `/api/v1/tenants/${TENANT_ID}/reports/sales.pdf?${RANGE}`;
  const dashboardPdfUrl = `/api/v1/campuses/${CAMPUS_ID}/reports/dashboard.pdf?${RANGE}`;
  const tenantExportsUrl = `/api/v1/tenants/${TENANT_ID}/reports/exports`;
  const campusExportsUrl = `/api/v1/campuses/${CAMPUS_ID}/reports/exports`;

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

  it('serves the tenant sales report as a real PDF attachment', async () => {
    const response = await app.inject({
      method: 'GET',
      url: salesPdfUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    assert.match(
      response.headers['content-type'] as string,
      /^application\/pdf/,
    );
    assert.equal(
      response.headers['content-disposition'],
      'attachment; filename="tenant-sales-2026-01-01_2026-02-01.pdf"',
    );
    // The body must be a PDF, not the JSON report or an HTML wrapper around it.
    assert.equal(
      response.rawPayload.subarray(0, 5).toString('latin1'),
      '%PDF-',
    );
    assert.ok(response.rawPayload.length > 500);
    assert.equal(
      response.rawPayload.toString('latin1').includes('<html'),
      false,
    );
    assert.equal(
      Number(response.headers['content-length']),
      response.rawPayload.length,
    );
  });

  it('serves the campus dashboard as its own PDF attachment', async () => {
    const response = await app.inject({
      method: 'GET',
      url: dashboardPdfUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    assert.match(
      response.headers['content-type'] as string,
      /^application\/pdf/,
    );
    assert.equal(
      response.headers['content-disposition'],
      'attachment; filename="campus-dashboard-2026-01-01_2026-02-01.pdf"',
    );
    assert.equal(
      response.rawPayload.subarray(0, 5).toString('latin1'),
      '%PDF-',
    );
    assert.deepEqual(stub.calls, ['dashboard']);
  });

  it('requires a bearer token on both PDF routes', async () => {
    for (const url of [salesPdfUrl, dashboardPdfUrl]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, url);
    }
    assert.deepEqual(stub.calls, []);
  });

  it('rejects an invalid window and an unknown query parameter on the PDF routes', async () => {
    const noRange = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${TENANT_ID}/reports/sales.pdf`,
      headers: auth,
    });
    assert.equal(noRange.statusCode, 400);
    const badDate = await app.inject({
      method: 'GET',
      url: `/api/v1/campuses/${CAMPUS_ID}/reports/dashboard.pdf?from=yesterday&to=2026-02-01T00:00:00.000Z`,
      headers: auth,
    });
    assert.equal(badDate.statusCode, 400);
    const unknownField = await app.inject({
      method: 'GET',
      url: `${salesPdfUrl}&layout=wide`,
      headers: auth,
    });
    assert.equal(unknownField.statusCode, 400);
    assert.deepEqual(stub.calls, []);
  });

  it('maps a permission denial on the PDF route to 403', async () => {
    stub.failure = new ForbiddenException({
      code: 'tenant_permission_required',
      message: 'Tenant permission is required',
    });
    const response = await app.inject({
      method: 'GET',
      url: salesPdfUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 403);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'tenant_permission_required',
    );
  });

  it('creates a manual export request for a tenant and a campus', async () => {
    const body = {
      kind: 'sales',
      format: 'pdf',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    };
    const tenant = await app.inject({
      method: 'POST',
      url: tenantExportsUrl,
      headers: auth,
      payload: body,
    });
    assert.equal(tenant.statusCode, 201);
    const created = tenant.json() as { data: { id: string; schedule: string } };
    assert.equal(created.data.id, EXPORT_ID);
    assert.equal(created.data.schedule, 'manual');

    const campus = await app.inject({
      method: 'POST',
      url: campusExportsUrl,
      headers: auth,
      payload: { ...body, kind: 'dashboard', format: 'csv' },
    });
    assert.equal(campus.statusCode, 201);

    assert.deepEqual(
      stub.createCalls.map((call) => call.target),
      [
        { type: 'tenant', id: TENANT_ID },
        { type: 'campus', id: CAMPUS_ID },
      ],
    );
    assert.equal(stub.createCalls[0]?.actorUserId, ACTOR_ID);
  });

  it('accepts a daily schedule with an hour and passes it through', async () => {
    const response = await app.inject({
      method: 'POST',
      url: tenantExportsUrl,
      headers: auth,
      payload: {
        kind: 'sales',
        format: 'pdf',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
        schedule: 'daily',
        scheduleHour: 7,
      },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(stub.createCalls[0]?.input.schedule, 'daily');
    assert.equal(stub.createCalls[0]?.input.scheduleHour, 7);
  });

  it('rejects a schedule hour outside 0..23 and a non-integer hour', async () => {
    for (const scheduleHour of [24, -1, 7.5, 'seven']) {
      const response = await app.inject({
        method: 'POST',
        url: tenantExportsUrl,
        headers: auth,
        payload: {
          kind: 'sales',
          format: 'pdf',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-02-01T00:00:00.000Z',
          schedule: 'daily',
          scheduleHour,
        },
      });
      assert.equal(
        response.statusCode,
        400,
        'scheduleHour=' + String(scheduleHour),
      );
    }
    assert.deepEqual(stub.createCalls, []);
  });

  it('rejects an unknown schedule value before the service runs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: tenantExportsUrl,
      headers: auth,
      payload: {
        kind: 'sales',
        format: 'pdf',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
        schedule: 'hourly',
        scheduleHour: 7,
      },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(stub.createCalls, []);
  });

  it('rejects an unknown kind, format, schedule and unknown fields', async () => {
    const base = {
      kind: 'sales',
      format: 'pdf',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    };
    for (const payload of [
      { ...base, kind: 'payouts' },
      { ...base, format: 'xlsx' },
      { ...base, schedule: 'hourly', scheduleHour: 7 },
      { ...base, tenantId: TENANT_ID },
      { ...base, kind: undefined },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: tenantExportsUrl,
        headers: auth,
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.deepEqual(stub.createCalls, []);
  });

  // Cross-field rules (from < to, the 366-day cap, a schedule without an hour,
  // a sub-day window) live in the service so the worker path obeys them too;
  // they are covered against PostgreSQL in reporting-exports.spec.ts.
  it('rejects a non-ISO window and a missing bound before the service runs', async () => {
    for (const payload of [
      {
        kind: 'sales',
        format: 'pdf',
        from: 'not-a-date',
        to: '2026-02-01T00:00:00.000Z',
      },
      { kind: 'sales', format: 'pdf', to: '2026-02-01T00:00:00.000Z' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: tenantExportsUrl,
        headers: auth,
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.deepEqual(stub.createCalls, []);
  });

  it('rejects a kind that does not belong to the scope', async () => {
    stub.failure = new BadRequestException({
      code: 'REPORT_EXPORT_KIND_SCOPE_MISMATCH',
      message: 'A campus export can only be of kind dashboard',
    });
    const response = await app.inject({
      method: 'POST',
      url: campusExportsUrl,
      headers: auth,
      payload: {
        kind: 'sales',
        format: 'pdf',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'REPORT_EXPORT_KIND_SCOPE_MISMATCH',
    );
  });

  it('lists the scope exports with their status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: campusExportsUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: {
        id: string;
        status: string;
        schedule: string;
        mediaAssetId: null;
      }[];
      meta: { truncated: boolean };
    };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].status, 'ready');
    assert.equal(body.data[0].schedule, 'daily');
    assert.equal(body.data[0].mediaAssetId, null);
    assert.equal(body.meta.truncated, false);
    assert.deepEqual(stub.calls, ['listExports']);
  });
});
