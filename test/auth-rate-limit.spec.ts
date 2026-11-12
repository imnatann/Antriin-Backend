import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/infrastructure/redis.service';
import { AuthRateLimitGuard } from '../src/modules/auth/auth-rate-limit.guard';

const testRedisPort = Number(process.env.TEST_REDIS_PORT);
const canTestRedis = Number.isInteger(testRedisPort) && testRedisPort > 0;

describe(
  'Auth IP rate limit Redis integration',
  { skip: !canTestRedis },
  () => {
    let redis: RedisService;
    let guard: AuthRateLimitGuard;

    before(async () => {
      const secret = randomBytes(48).toString('base64url');
      const config = {
        get: <T>(key: string): T | undefined => {
          const values: Record<string, string | number> = {
            REDIS_HOST: '127.0.0.1',
            REDIS_PORT: testRedisPort,
            AUTH_SECRET: secret,
          };
          return values[key] as T | undefined;
        },
        getOrThrow: <T>(key: string): T => {
          const values: Record<string, string | number> = {
            REDIS_HOST: '127.0.0.1',
            REDIS_PORT: testRedisPort,
          };
          const value = values[key];
          if (value === undefined)
            throw new Error('Missing test Redis setting');
          return value as T;
        },
      };
      redis = new RedisService(config as ConfigService);
      guard = new AuthRateLimitGuard(redis, config as ConfigService);
      await redis.ping();
    });

    after(() => redis?.onApplicationShutdown());

    it('enforces an atomic create window without storing the raw IP in Redis keys', async () => {
      const requestIp = `auth-test-${randomUUID()}`;
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({
            ip: requestIp,
            url: '/v1/auth/otp-challenges',
          }),
        }),
      } as unknown as ExecutionContext;
      for (let attempt = 0; attempt < 10; attempt += 1)
        assert.equal(await guard.canActivate(context), true);
      await assert.rejects(
        () => guard.canActivate(context),
        (error: unknown) =>
          error instanceof HttpException && error.getStatus() === 429,
      );
    });

    it('uses a separate verify window', async () => {
      const requestIp = `auth-verify-test-${randomUUID()}`;
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({
            ip: requestIp,
            url: '/v1/auth/otp-challenges/id/verify',
          }),
        }),
      } as unknown as ExecutionContext;
      for (let attempt = 0; attempt < 60; attempt += 1)
        assert.equal(await guard.canActivate(context), true);
      await assert.rejects(
        () => guard.canActivate(context),
        (error: unknown) =>
          error instanceof HttpException && error.getStatus() === 429,
      );
    });
  },
);
