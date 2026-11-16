import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Controller, Get, Module, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

/**
 * The pilot host terminates TLS in nginx and proxies to a loopback-bound API.
 * Without `trustProxy`, Fastify reports 127.0.0.1 for every request, which
 * would collapse all anonymous rate-limit buckets into one and let a single
 * client exhaust the shared public quota. This pins the behaviour so the
 * limiter keeps keying on the real client address.
 */
@Controller('probe')
class ProbeController {
  @Get()
  read(@Req() request: FastifyRequest) {
    return { data: { ip: request.ip } };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('Proxy-aware client address', () => {
  let app: NestFastifyApplication;

  before(async () => {
    const module = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
    );
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  after(async () => {
    await app.close();
  });

  it('reports the client address from X-Forwarded-For, not the proxy', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(
      (first.json() as { data: { ip: string } }).data.ip,
      '203.0.113.7',
    );

    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { 'x-forwarded-for': '198.51.100.9' },
    });
    assert.equal(
      (second.json() as { data: { ip: string } }).data.ip,
      '198.51.100.9',
      'two clients behind the proxy must stay distinguishable',
    );
  });

  it('falls back to the socket address when the header is absent', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/probe' });
    assert.equal(
      (response.json() as { data: { ip: string } }).data.ip,
      '127.0.0.1',
    );
  });
});
