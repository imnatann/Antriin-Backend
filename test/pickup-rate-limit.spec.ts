import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  GoneException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { CallHandler } from '@nestjs/common';
import { RedisService } from '../src/infrastructure/redis.service';
import { PickupRateLimitInterceptor } from '../src/modules/pickup/pickup-rate-limit.interceptor';
import {
  PICKUP_ERROR_CODES,
  PICKUP_RATE_LIMIT_KEY_PREFIX,
  PICKUP_RATE_LIMIT_MAX_FAILED_ATTEMPTS,
} from '../src/modules/pickup/pickup.constants';

const TEST_SECRET = 'pickup-rate-limit-test-secret-value-0123456789';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT2_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR2_ID = '44444444-4444-4444-8444-444444444444';
const CLIENT_IP = '203.0.113.9';

/**
 * Redis double that mirrors the two Lua scripts the interceptor uses:
 * a read returning {count, ttl} and an INCR returning the new count. Keeping
 * the script dispatch means a change of script shape is visible here too.
 */
class FakeRedis {
  readCount = 0;
  ttl = 120;
  failPing = false;
  failEval = false;
  readonly readKeys: string[] = [];
  readonly incrementKeys: string[] = [];
  private readonly counts = new Map<string, number>();

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
        this.readKeys.push(key);
        return [this.counts.get(key) ?? this.readCount, this.ttl];
      }
      this.incrementKeys.push(key);
      const next = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, next);
      return next;
    },
  };
}

interface RequestShape {
  ip?: string;
  tenantId?: string;
  userId?: string;
}

function contextFor(request: RequestShape = {}): ExecutionContext {
  const req = {
    ip: request.ip ?? CLIENT_IP,
    socket: { remoteAddress: request.ip ?? CLIENT_IP },
    params: request.tenantId ? { tenantId: request.tenantId } : {},
    user: request.userId ? { userId: request.userId } : undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const successHandler = (value: unknown): CallHandler => ({
  handle: () => of(value),
});

const failingHandler = (error: unknown): CallHandler => ({
  handle: () => throwError(() => error),
});

function build(options: { secret?: string | null; redis?: FakeRedis } = {}) {
  const redis = options.redis ?? new FakeRedis();
  const secret = options.secret === undefined ? TEST_SECRET : options.secret;
  const config = {
    get: (key: string, fallback?: unknown) =>
      key === 'AUTH_SECRET' ? (secret ?? undefined) : fallback,
  } as unknown as ConfigService;
  return {
    redis,
    interceptor: new PickupRateLimitInterceptor(
      redis as unknown as RedisService,
      config,
    ),
  };
}

function expectedKey(
  tenantId: string = TENANT_ID,
  actorId: string = ACTOR_ID,
  ip: string = CLIENT_IP,
): string {
  const ipHash = createHmac('sha256', TEST_SECRET)
    .update(ip, 'utf8')
    .digest('hex');
  return `${PICKUP_RATE_LIMIT_KEY_PREFIX}:${ipHash}:${tenantId}:${actorId}`;
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  if (typeof body === 'object' && body !== null && 'code' in body) {
    return String((body as { code: unknown }).code);
  }
  return undefined;
}

describe('PickupRateLimitInterceptor (R3-01/R3-02a)', () => {
  it('lets a request through below the failed-attempt quota and never counts a success', async () => {
    const { interceptor, redis } = build();
    redis.readCount = PICKUP_RATE_LIMIT_MAX_FAILED_ATTEMPTS - 1;
    const value = await firstValueFrom(
      interceptor.intercept(
        contextFor({ tenantId: TENANT_ID, userId: ACTOR_ID }),
        successHandler({ data: { ok: true } }),
      ),
    );
    assert.deepEqual(value, { data: { ok: true } });
    assert.equal(redis.readKeys.length, 1);
    assert.equal(
      redis.incrementKeys.length,
      0,
      'a successful verification must not consume the failure budget',
    );
  });

  it('answers 429 with retry_after on the failed attempt after the quota', async () => {
    const { interceptor, redis } = build();
    redis.readCount = PICKUP_RATE_LIMIT_MAX_FAILED_ATTEMPTS;
    redis.ttl = 137;
    let handlerRan = false;
    await assert.rejects(
      firstValueFrom(
        interceptor.intercept(
          contextFor({ tenantId: TENANT_ID, userId: ACTOR_ID }),
          {
            handle: () => {
              handlerRan = true;
              return of(null);
            },
          },
        ),
      ),
      (error: unknown) => {
        assert.ok(error instanceof HttpException);
        assert.equal(error.getStatus(), 429);
        assert.equal(errorCode(error), PICKUP_ERROR_CODES.rateLimited);
        const body = error.getResponse() as { retryAfterSeconds?: number };
        assert.equal(body.retryAfterSeconds, 137);
        return true;
      },
    );
    assert.equal(handlerRan, false, 'the handler must not run when limited');
    assert.equal(redis.incrementKeys.length, 0);
  });

  it('counts invalid, expired, revoked and consumed codes as failed attempts', async () => {
    const cases: { label: string; error: unknown }[] = [
      {
        label: 'invalid',
        error: new ConflictException({ code: PICKUP_ERROR_CODES.codeInvalid }),
      },
      {
        label: 'expired',
        error: new GoneException({
          code: PICKUP_ERROR_CODES.credentialExpired,
        }),
      },
      {
        label: 'revoked',
        error: new ConflictException({
          code: PICKUP_ERROR_CODES.credentialRevoked,
        }),
      },
      {
        label: 'consumed',
        error: new ConflictException({
          code: PICKUP_ERROR_CODES.credentialConsumed,
        }),
      },
    ];
    for (const testCase of cases) {
      const { interceptor, redis } = build();
      await assert.rejects(
        firstValueFrom(
          interceptor.intercept(
            contextFor({ tenantId: TENANT_ID, userId: ACTOR_ID }),
            failingHandler(testCase.error),
          ),
        ),
        (error: unknown) => error === testCase.error,
        testCase.label,
      );
      assert.equal(redis.incrementKeys.length, 1, testCase.label);
      assert.equal(redis.incrementKeys[0], expectedKey(), testCase.label);
    }
  });

  it('does not count permission, cross-tenant or order-state rejections', async () => {
    const cases: { label: string; error: unknown }[] = [
      { label: 'forbidden', error: new ForbiddenException('nope') },
      {
        label: 'cross-tenant',
        error: new NotFoundException({
          code: PICKUP_ERROR_CODES.credentialNotFound,
        }),
      },
      {
        label: 'order not eligible',
        error: new ConflictException({
          code: PICKUP_ERROR_CODES.orderNotEligible,
        }),
      },
    ];
    for (const testCase of cases) {
      const { interceptor, redis } = build();
      await assert.rejects(
        firstValueFrom(
          interceptor.intercept(
            contextFor({ tenantId: TENANT_ID, userId: ACTOR_ID }),
            failingHandler(testCase.error),
          ),
        ),
        (error: unknown) => error === testCase.error,
        testCase.label,
      );
      assert.equal(
        redis.incrementKeys.length,
        0,
        testCase.label + ' must not spend the brute-force budget',
      );
    }
  });

  it('fails closed with 503 when Redis cannot be read', async () => {
    for (const failure of ['eval', 'ping'] as const) {
      const { interceptor, redis } = build();
      if (failure === 'eval') redis.failEval = true;
      else redis.failPing = true;
      let handlerRan = false;
      await assert.rejects(
        firstValueFrom(
          interceptor.intercept(
            contextFor({ tenantId: TENANT_ID, userId: ACTOR_ID }),
            {
              handle: () => {
                handlerRan = true;
                return of(null);
              },
            },
          ),
        ),
        (error: unknown) => {
          assert.ok(error instanceof HttpException);
          assert.equal(error.getStatus(), 503);
          assert.equal(
            errorCode(error),
            PICKUP_ERROR_CODES.rateLimitUnavailable,
          );
          return true;
        },
        failure,
      );
      assert.equal(handlerRan, false, 'Redis down must never allow the code');
    }
  });

  it('refuses with 503 pickup_not_configured when AUTH_SECRET is unusable', async () => {
    for (const secret of [null, 'too-short']) {
      const { interceptor, redis } = build({ secret });
      // The interceptor refuses synchronously: no Redis round trip happens.
      assert.throws(
        () =>
          interceptor.intercept(
            contextFor({ tenantId: TENANT_ID, userId: ACTOR_ID }),
            successHandler(null),
          ),
        (error: unknown) => {
          assert.ok(error instanceof HttpException);
          assert.equal(error.getStatus(), 503);
          assert.equal(errorCode(error), PICKUP_ERROR_CODES.notConfigured);
          return true;
        },
      );
      assert.equal(redis.readKeys.length, 0);
    }
  });

  it('buckets per (IP, tenant, actor) and never stores the raw IP', async () => {
    const { interceptor, redis } = build();
    const run = async (request: RequestShape) => {
      await firstValueFrom(
        interceptor.intercept(contextFor(request), successHandler(null)),
      );
      return redis.readKeys.at(-1) as string;
    };

    const base = await run({ tenantId: TENANT_ID, userId: ACTOR_ID });
    const sameAgain = await run({ tenantId: TENANT_ID, userId: ACTOR_ID });
    const otherTenant = await run({ tenantId: TENANT2_ID, userId: ACTOR_ID });
    const otherActor = await run({ tenantId: TENANT_ID, userId: ACTOR2_ID });
    const otherIp = await run({
      tenantId: TENANT_ID,
      userId: ACTOR_ID,
      ip: '198.51.100.7',
    });

    assert.equal(base, expectedKey());
    assert.equal(sameAgain, base, 'same (ip, tenant, actor) shares one bucket');
    assert.notEqual(otherTenant, base);
    assert.notEqual(otherActor, base);
    assert.notEqual(otherIp, base);
    assert.ok(base.startsWith(PICKUP_RATE_LIMIT_KEY_PREFIX + ':'));
    assert.ok(
      !base.includes(CLIENT_IP),
      'the raw client IP must never be written to Redis',
    );
    assert.ok(base.includes(expectedKey().split(':')[1]));
  });
});
