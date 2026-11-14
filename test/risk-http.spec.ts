import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
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
import { RiskController } from '../src/modules/risk/risk.controller';
import { RiskService } from '../src/modules/risk/risk.service';

const CAMPUS_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const SIGNAL_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '55555555-5555-4555-8555-555555555555';

const signalView = {
  id: SIGNAL_ID,
  campusId: CAMPUS_ID,
  tenantId: TENANT_ID,
  subjectType: 'tenant' as const,
  subjectId: TENANT_ID,
  category: 'rating_anomaly' as const,
  score: '0.8700',
  modelVersion: 'rating-detector-1.0.0',
  explanation: 'Rating burst',
  evidence: { reviewCount: 5 },
  occurredAt: '2026-02-01T10:00:00.000000Z',
  decision: null,
};

const decisionView = {
  id: '66666666-6666-4666-8666-666666666666',
  decision: 'no_violation' as const,
  reason: 'Shared campus event',
  decidedAt: '2026-02-01T11:00:00.000000Z',
  actorUserId: ACTOR_ID,
};

class StubRiskService {
  calls: { method: string; args: unknown[] }[] = [];
  failure?: unknown;

  async listRiskReviews(...args: unknown[]) {
    this.calls.push({ method: 'list', args });
    if (this.failure) throw this.failure;
    return { items: [signalView], nextCursor: 'cursor-page-2' };
  }

  async getRiskSignal(...args: unknown[]) {
    this.calls.push({ method: 'detail', args });
    if (this.failure) throw this.failure;
    return { ...signalView, decisions: [decisionView] };
  }

  async decideRiskSignal(...args: unknown[]) {
    this.calls.push({ method: 'decide', args });
    if (this.failure) throw this.failure;
    return decisionView;
  }
}

describe('Risk HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubRiskService;

  const auth = { authorization: 'Bearer test-token' };
  const listUrl = `/api/v1/campuses/${CAMPUS_ID}/risk-reviews`;
  const detailUrl = `${listUrl}/${SIGNAL_ID}`;
  const decisionUrl = `${detailUrl}/decision`;

  beforeEach(async () => {
    stub = new StubRiskService();
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
      controllers: [RiskController],
      providers: [{ provide: RiskService, useValue: stub }],
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

  it('requires a bearer token on all three risk routes', async () => {
    for (const request of [
      { method: 'GET' as const, url: listUrl },
      { method: 'GET' as const, url: detailUrl },
      {
        method: 'POST' as const,
        url: decisionUrl,
        payload: { decision: 'no_violation', reason: 'ok' },
      },
    ]) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 401, request.url);
    }
    assert.deepEqual(stub.calls, []);
  });

  it('returns the pending queue with a next cursor', async () => {
    const response = await app.inject({
      method: 'GET',
      url: listUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: (typeof signalView)[];
      meta: { next_cursor: string | null };
    };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, SIGNAL_ID);
    assert.equal(body.data[0].score, '0.8700');
    assert.equal(body.data[0].decision, null);
    assert.equal(body.meta.next_cursor, 'cursor-page-2');
    // state defaults to pending in the service, not in the controller.
    assert.equal(stub.calls[0].method, 'list');
    assert.deepEqual(stub.calls[0].args.slice(0, 2), [ACTOR_ID, CAMPUS_ID]);
  });

  it('passes the queue filters through to the service', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${listUrl}?state=decided&category=rating_anomaly&limit=10&cursor=abc`,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const query = stub.calls[0].args[2] as {
      state?: string;
      category?: string;
      limit?: number;
      cursor?: string;
    };
    assert.equal(query.state, 'decided');
    assert.equal(query.category, 'rating_anomaly');
    assert.equal(query.limit, 10);
    assert.equal(query.cursor, 'abc');
  });

  it('returns a signal with its full decision history', async () => {
    const response = await app.inject({
      method: 'GET',
      url: detailUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: typeof signalView & { decisions: (typeof decisionView)[] };
    };
    assert.equal(body.data.id, SIGNAL_ID);
    assert.equal(body.data.decisions.length, 1);
    assert.equal(body.data.decisions[0].decision, 'no_violation');
    assert.deepEqual(stub.calls[0].args, [ACTOR_ID, CAMPUS_ID, SIGNAL_ID]);
  });

  it('records a decision with 201', async () => {
    const response = await app.inject({
      method: 'POST',
      url: decisionUrl,
      headers: auth,
      payload: { decision: 'no_violation', reason: 'Shared campus event' },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as { data: typeof decisionView };
    assert.equal(body.data.decision, 'no_violation');
    assert.equal(body.data.actorUserId, ACTOR_ID);
    assert.deepEqual(stub.calls[0].args.slice(0, 3), [
      ACTOR_ID,
      CAMPUS_ID,
      SIGNAL_ID,
    ]);
    const input = stub.calls[0].args[3] as {
      decision: string;
      reason: string;
    };
    assert.equal(input.decision, 'no_violation');
    assert.equal(input.reason, 'Shared campus event');
  });

  it('rejects an invalid decision body before the service runs', async () => {
    const badBodies = [
      {},
      { decision: 'ban_account', reason: 'Not an allowed decision' },
      { decision: 'no_violation', reason: '' },
      { decision: 'no_violation', reason: 'x'.repeat(501) },
      { decision: 'no_violation', reason: 'ok', notify: true },
    ];
    for (const payload of badBodies) {
      const response = await app.inject({
        method: 'POST',
        url: decisionUrl,
        headers: auth,
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.deepEqual(stub.calls, []);
  });

  it('rejects invalid query filters and path ids before the service runs', async () => {
    const badUrls = [
      `${listUrl}?state=archived`,
      `${listUrl}?category=fraud`,
      `${listUrl}?limit=500`,
      `${listUrl}?limit=abc`,
      `${listUrl}?cursor=not%20a%20cursor`,
      `${listUrl}?groupBy=day`,
      `/api/v1/campuses/not-a-uuid/risk-reviews`,
      `${listUrl}/not-a-uuid`,
    ];
    for (const url of badUrls) {
      const response = await app.inject({ method: 'GET', url, headers: auth });
      assert.equal(response.statusCode, 400, url);
    }
    assert.deepEqual(stub.calls, []);
  });

  it('maps service denials to 403 and unknown signals to 404', async () => {
    stub.failure = new ForbiddenException({
      code: 'FORBIDDEN',
      message: 'Campus permission denied',
    });
    const forbidden = await app.inject({
      method: 'GET',
      url: listUrl,
      headers: auth,
    });
    assert.equal(forbidden.statusCode, 403);

    stub.failure = new ForbiddenException({
      code: 'FORBIDDEN',
      message: 'Campus permission denied',
    });
    const forbiddenDecision = await app.inject({
      method: 'POST',
      url: decisionUrl,
      headers: auth,
      payload: { decision: 'no_violation', reason: 'Shared campus event' },
    });
    assert.equal(forbiddenDecision.statusCode, 403);

    stub.failure = new NotFoundException('Risk signal was not found');
    const missing = await app.inject({
      method: 'GET',
      url: detailUrl,
      headers: auth,
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(
      (missing.json() as { error: { code: string } }).error.code,
      'NOT_FOUND',
    );

    stub.failure = new NotFoundException('Risk signal was not found');
    const missingDecision = await app.inject({
      method: 'POST',
      url: decisionUrl,
      headers: auth,
      payload: { decision: 'no_violation', reason: 'Shared campus event' },
    });
    assert.equal(missingDecision.statusCode, 404);
  });
});
