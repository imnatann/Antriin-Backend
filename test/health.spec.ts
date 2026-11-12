import 'reflect-metadata';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { HealthController } from '../src/modules/health/health.controller';
import { DatabaseService } from '../src/database/database.service';
import { RedisService } from '../src/infrastructure/redis.service';

describe('Health HTTP contract', () => {
  let app: NestFastifyApplication;
  let database: { ping: ReturnType<typeof mock.fn<() => Promise<void>>> };
  let redis: { ping: ReturnType<typeof mock.fn<() => Promise<void>>> };
  beforeEach(async () => {
    database = { ping: mock.fn(async () => undefined) };
    redis = { ping: mock.fn(async () => undefined) };
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DatabaseService, useValue: database },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(async () => {
    await app.close();
  });
  it('keeps liveness independent of external dependencies', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/health/live',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(database.ping.mock.callCount(), 0);
    assert.equal(redis.ping.mock.callCount(), 0);
  });
  it('reports ready only when both dependencies respond', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/health/ready',
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: 'ok',
      dependencies: { database: true, redis: true },
    });
  });
  for (const dependency of ['database', 'redis'] as const) {
    it(`returns 503 when ${dependency} is unavailable without leaking errors`, async () => {
      (dependency === 'database'
        ? database
        : redis
      ).ping.mock.mockImplementation(async () => {
        throw new Error('private-provider-details');
      });
      const response = await app.inject({
        method: 'GET',
        url: '/v1/health/ready',
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().dependencies[dependency], false);
      assert.equal(response.body.includes('private-provider-details'), false);
    });
  }
});
