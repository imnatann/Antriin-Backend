import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
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
import { RefundsController } from '../src/modules/refunds/refunds.controller';
import { RefundsService } from '../src/modules/refunds/refunds.service';
import type { RefundView } from '../src/modules/refunds/refunds.service';

const CAMPUS_ID = randomUUID();
const ORDER_ID = randomUUID();
const CASE_ID = randomUUID();
const ACTOR_ID = randomUUID();
const REFUND_ID = randomUUID();
const TS = '2026-11-13T10:00:00.123456Z';

type Call = { method: string; args: unknown[] };

function refundView(): RefundView {
  return {
    id: REFUND_ID,
    campusId: CAMPUS_ID,
    tenantId: randomUUID(),
    orderId: ORDER_ID,
    orderPaymentId: randomUUID(),
    caseId: null,
    buyerId: randomUUID(),
    amountMinor: '50000',
    currency: 'IDR',
    status: 'requested',
    provider: 'sandbox',
    providerReference: null,
    reason: 'Tenant could not fulfil the order',
    requestedAt: TS,
    submittedAt: null,
    succeededAt: null,
    failedAt: null,
    lastError: null,
    attemptCount: 0,
    version: 1,
    createdAt: TS,
    updatedAt: TS,
  };
}

/**
 * Service double: the transport layer (route registration, guard, DTO
 * validation, error mapping, envelope, status codes) is what is under test.
 */
class StubRefundsService {
  readonly calls: Call[] = [];
  readonly failures: Record<string, unknown> = {};
  buyerRefund: RefundView | null = refundView();

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.failures[method];
    if (failure) throw failure;
  }

  async getRefundForOrder(...args: unknown[]): Promise<RefundView | null> {
    this.record('getRefundForOrder', args);
    return this.buyerRefund;
  }

  async initiateCancellationRefund(...args: unknown[]): Promise<RefundView> {
    this.record('initiateCancellationRefund', args);
    return refundView();
  }

  async listCampusRefunds(...args: unknown[]) {
    this.record('listCampusRefunds', args);
    return { items: [refundView()], nextCursor: 'cursor-2' };
  }
}

describe('Refunds HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubRefundsService;

  const auth = { authorization: 'Bearer test-token' };
  const buyerUrl = `/v1/orders/${ORDER_ID}/refund`;
  const campusRefundsUrl = `/v1/campuses/${CAMPUS_ID}/refunds`;

  beforeEach(async () => {
    stub = new StubRefundsService();
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
      controllers: [RefundsController],
      providers: [{ provide: RefundsService, useValue: stub }],
    })
      .overrideGuard(AuthGuard)
      .useValue(guard)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('v1');
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

  it('requires a bearer token on every refund route', async () => {
    const routes: [string, string, object?][] = [
      ['GET', buyerUrl],
      ['POST', campusRefundsUrl, { orderId: ORDER_ID, reason: 'x' }],
      ['GET', campusRefundsUrl],
    ];
    for (const [method, url, payload] of routes) {
      const response = await app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
      });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        'unauthorized',
      );
    }
    assert.equal(stub.calls.length, 0, 'no handler may run without a session');
  });

  it('forwards the session principal and path/body values to the service', async () => {
    const read = await app.inject({
      method: 'GET',
      url: buyerUrl,
      headers: auth,
    });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(stub.calls.at(-1), {
      method: 'getRefundForOrder',
      args: [ACTOR_ID, ORDER_ID],
    });

    const created = await app.inject({
      method: 'POST',
      url: campusRefundsUrl,
      headers: auth,
      payload: {
        orderId: ORDER_ID,
        reason: '  tenant closed  ',
        caseId: CASE_ID,
      },
    });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(stub.calls.at(-1), {
      method: 'initiateCancellationRefund',
      args: [
        {
          actorUserId: ACTOR_ID,
          campusId: CAMPUS_ID,
          orderId: ORDER_ID,
          reason: '  tenant closed  ',
          caseId: CASE_ID,
        },
      ],
    });

    const listed = await app.inject({
      method: 'GET',
      url: `${campusRefundsUrl}?status=requested&limit=10`,
      headers: auth,
    });
    assert.equal(listed.statusCode, 200);
    const listCall = stub.calls.at(-1);
    assert.equal(listCall?.method, 'listCampusRefunds');
    assert.deepEqual(listCall?.args.slice(0, 2), [ACTOR_ID, CAMPUS_ID]);
    const listQuery = listCall?.args[2] as {
      status?: string;
      limit?: number;
      cursor?: string;
    };
    assert.equal(listQuery.status, 'requested');
    assert.equal(listQuery.limit, 10);
    assert.equal(listQuery.cursor, undefined);
  });

  it('maps domain failures to 403, 404, 409 and 503 with stable codes', async () => {
    stub.failures.getRefundForOrder = new ForbiddenException(
      'Campus access denied',
    );
    const forbidden = await app.inject({
      method: 'GET',
      url: buyerUrl,
      headers: auth,
    });
    assert.equal(forbidden.statusCode, 403);

    stub.failures.getRefundForOrder = new NotFoundException(
      'Order was not found for this campus',
    );
    const notFound = await app.inject({
      method: 'GET',
      url: buyerUrl,
      headers: auth,
    });
    assert.equal(notFound.statusCode, 404);

    stub.failures.initiateCancellationRefund = new ConflictException({
      code: 'ORDER_CANCEL_CONFLICT',
      message: 'Order cannot be cancelled for a refund from completed',
    });
    const conflict = await app.inject({
      method: 'POST',
      url: campusRefundsUrl,
      headers: auth,
      payload: { orderId: ORDER_ID, reason: 'late decision' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(
      (conflict.json() as { error: { code: string } }).error.code,
      'ORDER_CANCEL_CONFLICT',
    );

    stub.failures.initiateCancellationRefund = new ServiceUnavailableException({
      code: 'REFUNDS_PROVIDER_DISABLED',
      message: 'Refunds are not available while the provider is disabled',
    });
    const disabled = await app.inject({
      method: 'POST',
      url: campusRefundsUrl,
      headers: auth,
      payload: { orderId: ORDER_ID, reason: 'provider off' },
    });
    assert.equal(disabled.statusCode, 503);
    assert.equal(
      (disabled.json() as { error: { code: string } }).error.code,
      'REFUNDS_PROVIDER_DISABLED',
    );
    assert.equal(stub.calls.at(-1)?.method, 'initiateCancellationRefund');
  });

  it('rejects client-supplied money, status and malformed input with 400', async () => {
    const rejected: [string, string, object?][] = [
      // amountMinor/status/buyerId are server-derived: unknown fields are refused.
      [
        'POST',
        campusRefundsUrl,
        { orderId: ORDER_ID, reason: 'x', amountMinor: '1' },
      ],
      [
        'POST',
        campusRefundsUrl,
        { orderId: ORDER_ID, reason: 'x', status: 'succeeded' },
      ],
      [
        'POST',
        campusRefundsUrl,
        { orderId: ORDER_ID, reason: 'x', buyerId: randomUUID() },
      ],
      // orderId is not a UUID.
      ['POST', campusRefundsUrl, { orderId: 'not-a-uuid', reason: 'x' }],
      // reason is required and must not be empty.
      ['POST', campusRefundsUrl, { orderId: ORDER_ID }],
      ['POST', campusRefundsUrl, { orderId: ORDER_ID, reason: '' }],
      // caseId must be a UUID when present.
      [
        'POST',
        campusRefundsUrl,
        { orderId: ORDER_ID, reason: 'x', caseId: 'nope' },
      ],
    ];
    for (const [method, url, payload] of rejected) {
      const response = await app.inject({
        method,
        url,
        headers: auth,
        payload: payload ?? {},
      });
      assert.equal(
        response.statusCode,
        400,
        `${method} ${url} ${JSON.stringify(payload)}`,
      );
    }
    // Non-UUID path parameters never reach the service.
    for (const url of [
      '/v1/orders/not-a-uuid/refund',
      '/v1/campuses/not-a-uuid/refunds',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: auth });
      assert.equal(response.statusCode, 400, url);
    }
    assert.equal(
      stub.calls.length,
      0,
      'invalid input must not reach the service',
    );
  });

  it('validates the campus refund list query', async () => {
    for (const query of [
      'status=bogus',
      'cursor=bad%20cursor!',
      'limit=0',
      'limit=101',
      'limit=abc',
      'unknown=1',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `${campusRefundsUrl}?${query}`,
        headers: auth,
      });
      assert.equal(response.statusCode, 400, query);
    }
    assert.equal(stub.calls.length, 0);
  });

  it('serves the documented envelope and status codes', async () => {
    const read = await app.inject({
      method: 'GET',
      url: buyerUrl,
      headers: auth,
    });
    assert.equal(read.statusCode, 200);
    const readBody = read.json() as {
      data: { id: string; amountMinor: string; requestedAt: string };
    };
    assert.equal(readBody.data.id, REFUND_ID);
    assert.equal(readBody.data.amountMinor, '50000');
    assert.match(readBody.data.requestedAt, /\.\d{6}Z$/);

    stub.buyerRefund = null;
    const empty = await app.inject({
      method: 'GET',
      url: buyerUrl,
      headers: auth,
    });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { data: null });

    const created = await app.inject({
      method: 'POST',
      url: campusRefundsUrl,
      headers: auth,
      payload: { orderId: ORDER_ID, reason: 'cancelled by manager' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(
      (created.json() as { data: { id: string } }).data.id,
      REFUND_ID,
    );

    const listed = await app.inject({
      method: 'GET',
      url: campusRefundsUrl,
      headers: auth,
    });
    assert.equal(listed.statusCode, 200);
    const listedBody = listed.json() as {
      data: { id: string }[];
      meta: { next_cursor: string | null };
    };
    assert.equal(listedBody.data.length, 1);
    assert.equal(listedBody.meta.next_cursor, 'cursor-2');
  });
});
