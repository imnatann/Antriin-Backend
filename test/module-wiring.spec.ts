import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';

/**
 * Whole-application wiring check.
 *
 * Every other HTTP spec in this repository builds a TestingModule from a
 * single controller and a stub service, so a controller that uses AuthGuard
 * inside a module that never imports AuthModule still passes them all and
 * only fails when the API is actually started. That happened once
 * (CampusesModule after the campus access/email-domain routes landed), so the
 * real AppModule and WorkerModule graphs are compiled here.
 *
 * Nothing is dialled: the pg Pool and the ioredis client are lazy and no
 * request is issued, so this needs neither PostgreSQL nor Redis.
 */
const env = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 3000,
  CORS_ORIGINS: 'http://localhost:3001',
  SWAGGER_ENABLED: 'false',
  // Never connected: both clients connect lazily on first use.
  DATABASE_URL: 'postgresql://local:local@127.0.0.1:1/unused',
  DATABASE_POOL_MAX: '1',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6381',
  LOG_LEVEL: 'silent',
  AUTH_SECRET: 'wiring-test-secret-value-0123456789abcdef',
  AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PAYOUTS_PROVIDER_MODE: 'disabled',
  REFUNDS_PROVIDER_MODE: 'disabled',
  PAYMENTS_PROVIDER_MODE: 'disabled',
};

for (const [key, value] of Object.entries(env))
  process.env[key] = String(value);

describe('Application module graph', () => {
  it('compiles AppModule with every module, controller and guard resolved', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    try {
      // A controller that cannot resolve its dependencies makes compile()
      // throw, so reaching this point already proves the graph is sound.
      assert.ok(moduleRef);
    } finally {
      await moduleRef.close();
    }
  });

  it('compiles WorkerModule so the worker process can start', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    try {
      assert.ok(moduleRef);
    } finally {
      await moduleRef.close();
    }
  });
});
