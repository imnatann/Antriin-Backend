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

const CAMPUS_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-02-01T00:00:00.000Z';
const RANGE = `from=${FROM}&to=${TO}`;

type RecordedCall = {
  actorUserId: string;
  campusId: string;
  query: Record<string, unknown>;
};

class StubReportingService {
  calls: RecordedCall[] = [];
  failure?: unknown;

  async listCampusTransactions(
    actorUserId: string,
    campusId: string,
    query: Record<string, unknown>,
  ) {
    this.calls.push({ actorUserId, campusId, query });
    // Mirrors the service contract: a cursor that is not the opaque page token
    // of this endpoint is a 400, never an empty page.
    if (typeof query.cursor === 'string' && query.cursor === 'garbage')
      throw new BadRequestException({
        code: 'REPORT_CURSOR_INVALID',
        message: 'Invalid transaction list cursor',
      });
    if (this.failure) throw this.failure;
    return {
      items: [
        {
          orderId: ORDER_ID,
          orderNumber: 'AN-20260105-7K3M2Q',
          tenantId: TENANT_ID,
          tenantName: 'Kantin Teknik',
          buyerDisplayName: 'Sari',
          status: 'completed',
          currency: 'IDR',
          totalMinor: '50000',
          pickupStartsAt: '2026-01-05T12:00:00.000000Z',
          createdAt: '2026-01-05T10:00:00.000000Z',
          updatedAt: '2026-01-05T10:00:00.000000Z',
        },
      ],
      nextCursor: 'next-page-cursor',
    };
  }
}

describe('Campus transactions HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubReportingService;

  const auth = { authorization: 'Bearer test-token' };
  const url = `/api/v1/campuses/${CAMPUS_ID}/transactions?${RANGE}`;

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

  it('requires a bearer token', async () => {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(stub.calls, []);
  });

  it('returns the campus page with a next_cursor envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${url}&status=completed&tenantId=${TENANT_ID}&limit=10&cursor=page-1`,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: {
        orderId: string;
        tenantName: string;
        currency: string;
        totalMinor: string;
        createdAt: string;
      }[];
      meta: { next_cursor: string | null };
    };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].orderId, ORDER_ID);
    assert.equal(body.data[0].currency, 'IDR');
    assert.equal(body.data[0].totalMinor, '50000');
    assert.match(body.data[0].createdAt, /\.\d{6}Z$/);
    assert.equal(body.meta.next_cursor, 'next-page-cursor');

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(call.actorUserId, ACTOR_ID);
    assert.equal(call.campusId, CAMPUS_ID);
    assert.equal(call.query.from, FROM);
    assert.equal(call.query.to, TO);
    assert.equal(call.query.status, 'completed');
    assert.equal(call.query.tenantId, TENANT_ID);
    assert.equal(call.query.cursor, 'page-1');
    assert.equal(call.query.limit, 10);
  });

  it('defaults to no filters and no limit', async () => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(stub.calls[0].query.status, undefined);
    assert.equal(stub.calls[0].query.tenantId, undefined);
    assert.equal(stub.calls[0].query.limit, undefined);
  });

  it('rejects an unknown status, cursor shape, limit or query parameter', async () => {
    const cases = [
      `${url}&status=shipped`,
      `${url}&limit=0`,
      `${url}&limit=101`,
      `${url}&limit=abc`,
      `${url}&tenantId=not-a-uuid`,
      `${url}&cursor=${encodeURIComponent('not a cursor!')}`,
      `${url}&groupBy=day`,
    ];
    for (const target of cases) {
      const response = await app.inject({
        method: 'GET',
        url: target,
        headers: auth,
      });
      assert.equal(response.statusCode, 400, target);
    }
    assert.deepEqual(stub.calls, []);
  });

  it('maps a malformed opaque cursor to a stable 400 code', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${url}&cursor=garbage`,
      headers: auth,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'REPORT_CURSOR_INVALID',
    );
  });

  it('rejects a malformed campus id before the service runs', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/campuses/not-a-uuid/transactions?${RANGE}`,
      headers: auth,
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(stub.calls, []);
  });

  it('propagates a tenant outside the campus scope as 403', async () => {
    stub.failure = new ForbiddenException({
      code: 'REPORT_TENANT_OUT_OF_SCOPE',
      message: 'tenantId does not belong to this campus',
    });
    const response = await app.inject({
      method: 'GET',
      url: `${url}&tenantId=${OTHER_TENANT_ID}`,
      headers: auth,
    });
    assert.equal(response.statusCode, 403);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'REPORT_TENANT_OUT_OF_SCOPE',
    );
  });

  it('propagates an invalid window from the service as 400', async () => {
    stub.failure = new BadRequestException({
      code: 'REPORT_RANGE_TOO_LARGE',
      message: 'The report window must not exceed 366 days',
    });
    const response = await app.inject({
      method: 'GET',
      url,
      headers: auth,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'REPORT_RANGE_TOO_LARGE',
    );
  });
});
