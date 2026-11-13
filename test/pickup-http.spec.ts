import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { RedisService } from '../src/infrastructure/redis.service';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { PickupController } from '../src/modules/pickup/pickup.controller';
import { PickupRateLimitInterceptor } from '../src/modules/pickup/pickup-rate-limit.interceptor';
import { PickupService } from '../src/modules/pickup/pickup.service';
import {
  PICKUP_ERROR_CODES,
  PICKUP_RATE_LIMIT_MAX_FAILED_ATTEMPTS,
} from '../src/modules/pickup/pickup.constants';
import { TenantPickupController } from '../src/modules/pickup/tenant-pickup.controller';

const TEST_SECRET = 'pickup-http-test-secret-value-0123456789abcdef';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const CREDENTIAL_ID = '66666666-6666-4666-8666-666666666666';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const TS = '2026-11-12T10:00:00.000000Z';
const PLAINTEXT = 'K7XQ-2M9P';

type Method =
  | 'issueCredential'
  | 'revokeCredential'
  | 'verifyCode'
  | 'handover'
  | 'getBuyerCredential';

/**
 * Service double: records calls and can be told to fail, so the transport
 * layer (guards, interceptor, DTO validation, headers) is what is under test.
 */
class StubPickupService {
  readonly calls: Record<Method, number> = {
    issueCredential: 0,
    revokeCredential: 0,
    verifyCode: 0,
    handover: 0,
    getBuyerCredential: 0,
  };
  readonly failures: Partial<Record<Method, unknown>> = {};

  private record(method: Method): void {
    this.calls[method] += 1;
    const failure = this.failures[method];
    if (failure) throw failure;
  }

  async issueCredential() {
    this.record('issueCredential');
    return {
      data: {
        credentialId: CREDENTIAL_ID,
        orderId: ORDER_ID,
        code: PLAINTEXT,
        expiresAt: TS,
        rotatedFrom: null,
      },
    };
  }

  async revokeCredential() {
    this.record('revokeCredential');
    return {
      data: { credentialId: CREDENTIAL_ID, orderId: ORDER_ID, revokedAt: TS },
    };
  }

  async verifyCode() {
    this.record('verifyCode');
    return { data: { orderId: ORDER_ID, readyForHandover: true } };
  }

  async handover() {
    this.record('handover');
    return {
      data: {
        handoverId: randomUUID(),
        orderId: ORDER_ID,
        credentialId: CREDENTIAL_ID,
        status: 'completed',
        handedOverAt: TS,
      },
    };
  }

  async getBuyerCredential() {
    this.record('getBuyerCredential');
    return {
      data: {
        credentialId: CREDENTIAL_ID,
        orderId: ORDER_ID,
        code: PLAINTEXT,
        expiresAt: TS,
      },
    };
  }
}

class FakeRedis {
  readCount = 0;
  ttl = 90;
  failEval = false;
  failPing = false;
  readonly incrementKeys: string[] = [];

  async ping(): Promise<void> {
    if (this.failPing) throw new Error('redis unavailable');
  }

  readonly client = {
    eval: async (
      script: string,
      _keys: number,
      key: string,
    ): Promise<unknown> => {
      if (this.failEval) throw new Error('redis unavailable');
      if (script.includes("redis.call('GET'")) {
        return [this.readCount, this.ttl];
      }
      this.incrementKeys.push(key);
      return 1;
    },
  };
}

describe('Pickup HTTP contract (R3-02b)', () => {
  let app: NestFastifyApplication;
  let stub: StubPickupService;
  let fake: FakeRedis;

  const auth = { authorization: 'Bearer test-token' };
  const issueUrl = `/api/v1/tenants/${TENANT_ID}/orders/${ORDER_ID}/pickup-credential`;
  const revokeUrl = `${issueUrl}/revocation`;
  const verifyUrl = `/api/v1/tenants/${TENANT_ID}/pickup/verification`;
  const handoverUrl = `/api/v1/tenants/${TENANT_ID}/pickup/handovers`;
  const buyerUrl = `/api/v1/orders/${ORDER_ID}/pickup-credential`;

  beforeEach(async () => {
    stub = new StubPickupService();
    fake = new FakeRedis();
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
      controllers: [PickupController, TenantPickupController],
      providers: [
        { provide: PickupService, useValue: stub },
        PickupRateLimitInterceptor,
        { provide: RedisService, useValue: fake },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: unknown) =>
              key === 'AUTH_SECRET' ? TEST_SECRET : fallback,
          },
        },
      ],
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

  it('requires a bearer token on every pickup route', async () => {
    const routes: [string, string, object?][] = [
      ['POST', issueUrl],
      ['POST', revokeUrl, { reason: 'x' }],
      ['POST', verifyUrl, { code: PLAINTEXT }],
      ['POST', handoverUrl, { code: PLAINTEXT }],
      ['GET', buyerUrl],
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
    assert.equal(
      Object.values(stub.calls).reduce((sum, value) => sum + value, 0),
      0,
      'no handler may run without a session',
    );
  });

  it('returns 403 when the actor lacks tenant.orders.handover', async () => {
    stub.failures.verifyCode = new ForbiddenException(
      'Tenant permission denied',
    );
    const response = await app.inject({
      method: 'POST',
      url: verifyUrl,
      headers: auth,
      payload: { code: PLAINTEXT },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(stub.calls.verifyCode, 1);
  });

  it('rejects malformed codes and ids with 400 before the service runs', async () => {
    const badCode = await app.inject({
      method: 'POST',
      url: verifyUrl,
      headers: auth,
      payload: { code: 'x' },
    });
    assert.equal(badCode.statusCode, 400);

    const unknownField = await app.inject({
      method: 'POST',
      url: handoverUrl,
      headers: auth,
      payload: { code: PLAINTEXT, tenantId: randomUUID() },
    });
    assert.equal(unknownField.statusCode, 400);

    const badTenant = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants/not-a-uuid/pickup/verification',
      headers: auth,
      payload: { code: PLAINTEXT },
    });
    assert.equal(badTenant.statusCode, 400);

    const missingReason = await app.inject({
      method: 'POST',
      url: revokeUrl,
      headers: auth,
      payload: {},
    });
    assert.equal(missingReason.statusCode, 400);
    assert.equal(
      stub.calls.verifyCode + stub.calls.handover + stub.calls.revokeCredential,
      0,
    );
  });

  it('rate limits code presentation only, after the failed quota, with retry_after', async () => {
    fake.readCount = PICKUP_RATE_LIMIT_MAX_FAILED_ATTEMPTS;
    for (const [url, payload] of [
      [verifyUrl, { code: PLAINTEXT }],
      [handoverUrl, { code: PLAINTEXT }],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: auth,
        payload,
      });
      assert.equal(response.statusCode, 429, url);
      assert.equal(response.headers['retry-after'], String(fake.ttl));
      const body = response.json() as {
        error: { code: string; retry_after_seconds?: number };
      };
      assert.equal(body.error.code, PICKUP_ERROR_CODES.rateLimited);
      assert.equal(body.error.retry_after_seconds, fake.ttl);
    }
    assert.equal(
      stub.calls.verifyCode + stub.calls.handover,
      0,
      'a limited request must never reach the domain service',
    );

    // Issuance/revocation require a session + permission, not a code guess, so
    // they are deliberately outside the brute-force quota.
    const issued = await app.inject({
      method: 'POST',
      url: issueUrl,
      headers: auth,
    });
    assert.equal(issued.statusCode, 201);
    assert.equal(stub.calls.issueCredential, 1);
  });

  it('fails closed with 503 when Redis is unavailable', async () => {
    fake.failEval = true;
    const response = await app.inject({
      method: 'POST',
      url: verifyUrl,
      headers: auth,
      payload: { code: PLAINTEXT },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      PICKUP_ERROR_CODES.rateLimitUnavailable,
    );
    assert.equal(stub.calls.verifyCode, 0);
  });

  it('never caches responses that carry the plaintext code', async () => {
    const issued = await app.inject({
      method: 'POST',
      url: issueUrl,
      headers: auth,
    });
    assert.equal(issued.statusCode, 201);
    assert.equal(issued.headers['cache-control'], 'no-store');
    assert.equal(
      (issued.json() as { data: { code: string } }).data.code,
      PLAINTEXT,
    );

    const buyer = await app.inject({
      method: 'GET',
      url: buyerUrl,
      headers: auth,
    });
    assert.equal(buyer.statusCode, 200);
    assert.equal(buyer.headers['cache-control'], 'no-store');
    assert.equal(
      (buyer.json() as { data: { code: string } }).data.code,
      PLAINTEXT,
    );
  });

  it('does not spend the failure budget on successful verification or handover', async () => {
    const verified = await app.inject({
      method: 'POST',
      url: verifyUrl,
      headers: auth,
      payload: { code: PLAINTEXT.toLowerCase() },
    });
    assert.equal(verified.statusCode, 200);

    const handedOver = await app.inject({
      method: 'POST',
      url: handoverUrl,
      headers: auth,
      payload: { code: PLAINTEXT },
    });
    assert.equal(handedOver.statusCode, 200);
    assert.deepEqual(fake.incrementKeys, []);
    assert.equal(stub.calls.verifyCode, 1);
    assert.equal(stub.calls.handover, 1);
  });
});
