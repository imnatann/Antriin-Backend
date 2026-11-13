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
import { SettlementsController } from '../src/modules/settlements/settlements.controller';
import { SettlementsService } from '../src/modules/settlements/settlements.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const TS = '2026-11-13T10:00:00.000000Z';

class StubSettlementsService {
  summaryCalls = 0;
  transactionCalls: { tenantId: string; limit?: number; cursor?: string }[] =
    [];
  failure?: unknown;

  async getFinanceSummary() {
    this.summaryCalls += 1;
    if (this.failure) throw this.failure;
    return {
      tenantId: TENANT_ID,
      currency: 'IDR' as const,
      paidInMinor: '150000',
      refundedMinor: '0',
      unfinishedMinor: '0',
      availableMinor: '150000',
      heldMinor: '0',
      paidOutMinor: '0',
      releasedMinor: '150000',
    };
  }

  async listFinanceTransactions(
    _actorUserId: string,
    tenantId: string,
    options: { limit?: number; cursor?: string },
  ) {
    this.transactionCalls.push({ tenantId, ...options });
    if (this.failure) throw this.failure;
    return {
      items: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          transactionId: '55555555-5555-4555-8555-555555555555',
          type: 'settlement_release' as const,
          direction: 'credit' as const,
          amountMinor: '50000',
          currency: 'IDR',
          referenceId: '66666666-6666-4666-8666-666666666666',
          occurredAt: TS,
        },
      ],
      nextCursor: null,
    };
  }
}

describe('Settlements HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubSettlementsService;

  const auth = { authorization: 'Bearer test-token' };
  const summaryUrl = `/v1/tenants/${TENANT_ID}/finance/summary`;
  const transactionsUrl = `/v1/tenants/${TENANT_ID}/finance/transactions`;

  beforeEach(async () => {
    stub = new StubSettlementsService();
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
      controllers: [SettlementsController],
      providers: [{ provide: SettlementsService, useValue: stub }],
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

  it('requires a bearer token on both finance routes', async () => {
    for (const url of [summaryUrl, transactionsUrl]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, url);
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        'unauthorized',
      );
    }
    assert.equal(stub.summaryCalls, 0);
    assert.equal(stub.transactionCalls.length, 0);
  });

  it('returns the derived summary with string minor units and microsecond timestamps', async () => {
    const response = await app.inject({
      method: 'GET',
      url: summaryUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: { availableMinor: string; currency: string; heldMinor: string };
    };
    assert.equal(body.data.currency, 'IDR');
    assert.equal(body.data.availableMinor, '150000');
    assert.equal(typeof body.data.availableMinor, 'string');
    assert.equal(body.data.heldMinor, '0');
  });

  it('returns 403 when the service denies a non-owner role', async () => {
    stub.failure = new ForbiddenException('Tenant finance access denied');
    for (const url of [summaryUrl, transactionsUrl]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: auth,
      });
      assert.equal(response.statusCode, 403, url);
    }
  });

  it('pages the transaction feed and rejects an out-of-range limit', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: transactionsUrl + '?limit=10',
      headers: auth,
    });
    assert.equal(ok.statusCode, 200);
    const body = ok.json() as {
      data: { type: string; amountMinor: string; occurredAt: string }[];
      meta: { next_cursor: string | null };
    };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].type, 'settlement_release');
    assert.equal(body.data[0].amountMinor, '50000');
    assert.match(body.data[0].occurredAt, /^\d{4}-\d\d-\d\dT.*\.\d{6}Z$/);
    assert.equal(body.meta.next_cursor, null);
    assert.equal(stub.transactionCalls[0].limit, 10);

    const tooLarge = await app.inject({
      method: 'GET',
      url: transactionsUrl + '?limit=101',
      headers: auth,
    });
    assert.equal(tooLarge.statusCode, 400);
    const badCursor = await app.inject({
      method: 'GET',
      url: transactionsUrl + '?cursor=not%20a%20cursor',
      headers: auth,
    });
    assert.equal(badCursor.statusCode, 400);
    const unknownField = await app.inject({
      method: 'GET',
      url: transactionsUrl + '?status=succeeded',
      headers: auth,
    });
    assert.equal(unknownField.statusCode, 400);
  });

  it('rejects a malformed tenant id before the service runs', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/not-a-uuid/finance/summary',
      headers: auth,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(stub.summaryCalls, 0);
  });
});
