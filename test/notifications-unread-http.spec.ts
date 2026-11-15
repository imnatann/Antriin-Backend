import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ExecutionContext,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { NotificationsController } from '../src/modules/notifications/notifications.controller';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

const notificationId = randomUUID();
const cursorId = randomUUID();

const page = {
  data: [
    {
      id: notificationId,
      template: 'order.status_changed',
      data: { aggregateType: 'order', aggregateId: randomUUID() },
      createdAt: '2026-11-15T10:00:00.123456Z',
      readAt: null,
    },
  ],
  meta: { nextCursor: null, unreadCount: 3 },
};

describe('Notifications HTTP contract', () => {
  let app: NestFastifyApplication;
  let calls: { args: unknown[] }[];

  beforeEach(async () => {
    calls = [];
    const notifications = {
      list: (...args: unknown[]) => {
        calls.push({ args });
        return Promise.resolve(page);
      },
      markRead: (userId: string, id: string) => {
        calls.push({ args: [userId, id] });
        return Promise.resolve();
      },
    };
    const guard = {
      canActivate: (context: ExecutionContext) => {
        const request = context.switchToHttp().getRequest<{
          headers: { authorization?: string };
          user?: { userId: string; sessionId: string };
        }>();
        if (request.headers.authorization !== 'Bearer test-token')
          throw new UnauthorizedException();
        request.user = { userId: 'user-1', sessionId: 'session-1' };
        return true;
      },
    };
    const module = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: notifications }],
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
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const auth = { authorization: 'Bearer test-token' };
  const base = '/api/v1/me/notifications';

  it('passes no filter when unread is omitted and returns meta.unreadCount', async () => {
    const response = await app.inject({
      method: 'GET',
      url: base,
      headers: auth,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls[0].args, [
      'user-1',
      undefined,
      undefined,
      undefined,
    ]);
    const body = response.json() as typeof page;
    assert.equal(body.meta.unreadCount, 3);
    assert.equal(body.meta.nextCursor, null);
    assert.equal(body.data[0].createdAt, '2026-11-15T10:00:00.123456Z');
    assert.equal(body.data[0].readAt, null);
  });

  it('forwards ?unread=true and ?unread=false as booleans', async () => {
    const unreadOnly = await app.inject({
      method: 'GET',
      url: base + '?unread=true',
      headers: auth,
    });
    assert.equal(unreadOnly.statusCode, 200);
    assert.equal(calls.at(-1)?.args[3], true);

    const all = await app.inject({
      method: 'GET',
      url: base + '?unread=false',
      headers: auth,
    });
    assert.equal(all.statusCode, 200);
    assert.equal(calls.at(-1)?.args[3], false);
  });

  it('forwards limit and cursor alongside the unread filter', async () => {
    const response = await app.inject({
      method: 'GET',
      url: base + '?limit=5&cursor=' + cursorId + '&unread=true',
      headers: auth,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls[0].args, ['user-1', 5, cursorId, true]);
  });

  it('rejects an unread value that is not a boolean', async () => {
    for (const value of ['yes', '1', 'TRUE']) {
      const response = await app.inject({
        method: 'GET',
        url: base + '?unread=' + value,
        headers: auth,
      });
      assert.equal(response.statusCode, 400, 'must reject unread=' + value);
    }
    assert.equal(calls.length, 0);
  });

  it('rejects unknown query parameters instead of ignoring them', async () => {
    const response = await app.inject({
      method: 'GET',
      url: base + '?read=true',
      headers: auth,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it('rejects a non-uuid cursor before reaching the service', async () => {
    const response = await app.inject({
      method: 'GET',
      url: base + '?cursor=not-a-uuid',
      headers: auth,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it('requires bearer authentication', async () => {
    const response = await app.inject({ method: 'GET', url: base });
    assert.equal(response.statusCode, 401);
    assert.equal(calls.length, 0);
  });

  it('marks one notification read for the current user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: base + '/' + notificationId + '/read',
      headers: auth,
    });
    assert.equal(response.statusCode, 204);
    assert.deepEqual(calls[0].args, ['user-1', notificationId]);
  });
});
