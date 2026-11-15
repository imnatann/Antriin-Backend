import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  Controller,
  ExecutionContext,
  Get,
  Global,
  HttpException,
  Module,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { RedisService } from '../src/infrastructure/redis.service';
import { RateLimitGuard } from '../src/common/rate-limit.guard';
import { RateLimitModule } from '../src/common/rate-limit.module';
import { RedisRateLimitStore } from '../src/common/rate-limit.store';
import { RATE_LIMIT_KEY_PREFIX } from '../src/common/rate-limit.policy';

const redisHost =
  process.env.TEST_REDIS_HOST ?? process.env.REDIS_HOST ?? '127.0.0.1';
const redisPort = Number(process.env.TEST_REDIS_PORT ?? process.env.REDIS_PORT);
const canTestRedis = Number.isInteger(redisPort) && redisPort > 0;
const TEST_SECRET = 'integration-rate-limit-secret-0123456789abcdef';

interface FakeReply {
  header(name: string, value: string): FakeReply;
}

function contextFor(input: {
  ip: string;
  userId?: string;
  method?: string;
  url?: string;
  routeTemplate?: string;
}): ExecutionContext {
  const headers: Record<string, string> = {};
  const reply: FakeReply = {
    header(name, value) {
      headers[name.toLowerCase()] = String(value);
      return reply;
    },
  };
  const request = {
    ip: input.ip,
    socket: { remoteAddress: input.ip },
    method: input.method ?? 'GET',
    url: input.url ?? '/api/v1/search',
    headers: {},
    routeOptions: { url: input.routeTemplate ?? input.url ?? '/api/v1/search' },
    user: input.userId ? { userId: input.userId } : undefined,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
}

/** Unique IP per request so no counter from an earlier run leaks into this one. */
function freshIp(): string {
  const octets = randomBytes(3);
  return (
    '10.' +
    octets[0] +
    '.' +
    octets[1] +
    '.' +
    (Math.max(1, octets[2] % 254) + 1)
  );
}

const sharedConfig = {
  get: (key: string) => (key === 'AUTH_SECRET' ? TEST_SECRET : undefined),
  getOrThrow: (key: string) => {
    const values: Record<string, string | number> = {
      REDIS_HOST: redisHost,
      REDIS_PORT: redisPort,
    };
    const value = values[key];
    if (value === undefined) throw new Error('Missing test Redis setting');
    return value;
  },
};

/** Route bucket unique to this app so its counters cannot collide with others. */
@Controller('b3-probe')
class ProbeController {
  @Get()
  ok() {
    return { data: { status: 'ok' } };
  }
}

@Global()
@Module({
  providers: [{ provide: ConfigService, useValue: sharedConfig }],
  exports: [ConfigService],
})
class TestConfigModule {}

/**
 * Registers the guard exactly the way the root is asked to: RateLimitModule in
 * imports, APP_GUARD provider. This is the wiring that has to resolve, so the
 * test goes through real HTTP instead of calling the guard directly.
 */
async function createApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TestConfigModule, RateLimitModule],
    controllers: [ProbeController],
    providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

async function scanKeys(
  redis: RedisService,
  pattern: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const reply = (await redis.client.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      200,
    )) as unknown as [string, string[]];
    cursor = reply[0];
    keys.push(...reply[1]);
  } while (cursor !== '0');
  return keys;
}

describe(
  'Global rate limit against real Redis',
  { skip: !canTestRedis },
  () => {
    let redis: RedisService;
    let guard: RateLimitGuard;

    before(async () => {
      redis = new RedisService(sharedConfig as unknown as ConfigService);
      await redis.ping();
      guard = new RateLimitGuard(
        new RedisRateLimitStore(redis),
        sharedConfig as unknown as ConfigService,
      );
    });

    after(() => redis?.onApplicationShutdown());

    it('rejects request 121 from one public IP and leaves another identity alone', async () => {
      const ip = freshIp();
      const context = contextFor({ ip });

      for (let attempt = 1; attempt <= 120; attempt += 1)
        assert.equal(
          await guard.canActivate(context),
          true,
          'attempt ' + attempt,
        );

      await assert.rejects(
        () => guard.canActivate(context),
        (error: unknown) => {
          assert.ok(error instanceof HttpException);
          assert.equal(error.getStatus(), 429);
          const body = error.getResponse() as {
            code?: string;
            retryAfterSeconds?: number;
          };
          assert.equal(body.code, 'RATE_LIMITED');
          assert.ok(
            Number.isInteger(body.retryAfterSeconds) &&
              (body.retryAfterSeconds as number) >= 1 &&
              (body.retryAfterSeconds as number) <= 60,
            'Retry-After must be the real remaining TTL inside the window',
          );
          return true;
        },
      );

      // A different identity has its own counter and is not affected at all.
      const other = contextFor({ ip: freshIp() });
      for (let attempt = 0; attempt < 5; attempt += 1)
        assert.equal(await guard.canActivate(other), true);
    });

    it('gives one user 60 mutations per minute without touching their reads', async () => {
      const userId = randomUUID();
      const ip = freshIp();
      const write = contextFor({
        ip,
        userId,
        method: 'POST',
        url: '/api/v1/orders',
        routeTemplate: '/api/v1/orders',
      });

      for (let attempt = 1; attempt <= 60; attempt += 1)
        assert.equal(
          await guard.canActivate(write),
          true,
          'attempt ' + attempt,
        );

      await assert.rejects(
        () => guard.canActivate(write),
        (error: unknown) => {
          assert.ok(error instanceof HttpException);
          assert.equal(error.getStatus(), 429);
          return true;
        },
      );

      // Reads use a different policy and bucket: still allowed.
      const read = contextFor({ ip, userId, url: '/api/v1/orders' });
      for (let attempt = 0; attempt < 5; attempt += 1)
        assert.equal(await guard.canActivate(read), true);

      // Clean up the user-keyed counters we know the exact name of (the IP
      // buckets are hashed and simply expire after the 60s window).
      await redis.client.del(
        RATE_LIMIT_KEY_PREFIX + ':authenticated-write:orders:user:' + userId,
        RATE_LIMIT_KEY_PREFIX + ':authenticated-read:orders:user:' + userId,
      );
    });

    it('stores only HMACs of the client IP in Redis keys', async () => {
      const ip = freshIp();
      const context = contextFor({ ip });
      assert.equal(await guard.canActivate(context), true);

      // Scan only our own namespace and only the one bucket this test used.
      const keys = await scanKeys(
        redis,
        RATE_LIMIT_KEY_PREFIX + ':public-read:search:ip:*',
      );
      assert.ok(keys.length > 0, 'the limiter must have written a counter');
      for (const key of keys)
        assert.ok(
          !key.includes(ip),
          'raw client IP must never be a key: ' + key,
        );
    });

    it('works as a global APP_GUARD over real HTTP and answers 429 with Retry-After', async () => {
      const app = await createApp();
      try {
        const ip = freshIp();
        for (let attempt = 1; attempt <= 120; attempt += 1) {
          const allowed = await app.inject({
            method: 'GET',
            url: '/api/v1/b3-probe',
            remoteAddress: ip,
          });
          assert.equal(allowed.statusCode, 200, 'attempt ' + attempt);
          assert.equal(allowed.headers['ratelimit-limit'], '120');
        }

        const limited = await app.inject({
          method: 'GET',
          url: '/api/v1/b3-probe',
          remoteAddress: ip,
        });
        assert.equal(limited.statusCode, 429);
        const body = limited.json() as {
          error: { code: string; retry_after_seconds: number };
        };
        assert.equal(body.error.code, 'RATE_LIMITED');
        assert.ok(body.error.retry_after_seconds >= 1);
        assert.equal(
          limited.headers['retry-after'],
          String(body.error.retry_after_seconds),
        );

        // The bucket is the Fastify route template ("b3-probe"), which proves
        // request.routeOptions.url is available inside a global guard.
        const keys = await scanKeys(
          redis,
          RATE_LIMIT_KEY_PREFIX + ':public-read:b3-probe:*',
        );
        assert.ok(
          keys.length > 0,
          'a counter must exist for the resolved route bucket',
        );
        assert.ok(
          keys.every((key) => !key.includes(ip)),
          'the raw IP must never appear in a key',
        );
      } finally {
        await app.close();
        app.get(RedisService).onApplicationShutdown();
      }
    });
  },
);
