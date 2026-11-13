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
const RANGE = 'from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z';

class StubReportingService {
  calls: string[] = [];
  failure?: unknown;

  async getSalesReport() {
    this.calls.push('sales');
    if (this.failure) throw this.failure;
    return {
      tenantId: TENANT_ID,
      currency: 'IDR',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      orders: [{ status: 'completed', count: 2, totalMinor: '80000' }],
      refunds: [],
    };
  }

  async getCampusDashboard() {
    this.calls.push('dashboard');
    if (this.failure) throw this.failure;
    return {
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
  }
}

describe('Reporting HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubReportingService;

  const auth = { authorization: 'Bearer test-token' };
  const salesUrl = `/api/v1/tenants/${TENANT_ID}/reports/sales?${RANGE}`;
  const dashboardUrl = `/api/v1/campuses/${CAMPUS_ID}/dashboard?${RANGE}`;

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

  it('requires a bearer token on both report routes', async () => {
    for (const url of [salesUrl, dashboardUrl]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, url);
    }
    assert.deepEqual(stub.calls, []);
  });

  it('returns the tenant sales report as status groups', async () => {
    const response = await app.inject({
      method: 'GET',
      url: salesUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: {
        orders: { status: string; count: number; totalMinor: string }[];
      };
    };
    assert.equal(body.data.orders[0].status, 'completed');
    assert.equal(body.data.orders[0].count, 2);
    assert.equal(typeof body.data.orders[0].totalMinor, 'string');
    assert.deepEqual(stub.calls, ['sales']);
  });

  it('returns the campus dashboard with every status group', async () => {
    const response = await app.inject({
      method: 'GET',
      url: dashboardUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: {
        tenants: unknown[];
        orders: unknown[];
        refunds: unknown[];
        payouts: unknown[];
        cases: unknown[];
      };
    };
    assert.equal(body.data.tenants.length, 1);
    assert.equal(body.data.cases.length, 1);
    assert.deepEqual(stub.calls, ['dashboard']);
  });

  it('rejects a missing, malformed or unknown query parameter', async () => {
    const noRange = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${TENANT_ID}/reports/sales`,
      headers: auth,
    });
    assert.equal(noRange.statusCode, 400);
    const badDate = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${TENANT_ID}/reports/sales?from=yesterday&to=2026-02-01T00:00:00.000Z`,
      headers: auth,
    });
    assert.equal(badDate.statusCode, 400);
    const unknownField = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${TENANT_ID}/reports/sales?${RANGE}&groupBy=day`,
      headers: auth,
    });
    assert.equal(unknownField.statusCode, 400);
    assert.deepEqual(stub.calls, []);
  });

  it('maps service denials and invalid windows to stable codes', async () => {
    stub.failure = new ForbiddenException({
      code: 'tenant_permission_required',
      message: 'Tenant permission is required',
    });
    const forbidden = await app.inject({
      method: 'GET',
      url: salesUrl,
      headers: auth,
    });
    assert.equal(forbidden.statusCode, 403);

    stub.failure = new BadRequestException({
      code: 'REPORT_RANGE_TOO_LARGE',
      message: 'The report window must not exceed 366 days',
    });
    const tooLarge = await app.inject({
      method: 'GET',
      url: dashboardUrl,
      headers: auth,
    });
    assert.equal(tooLarge.statusCode, 400);
    assert.equal(
      (tooLarge.json() as { error: { code: string } }).error.code,
      'REPORT_RANGE_TOO_LARGE',
    );
  });

  it('rejects a malformed path id before the service runs', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/not-a-uuid/reports/sales?${RANGE}`,
      headers: auth,
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(stub.calls, []);
  });
});
