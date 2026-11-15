import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BadRequestException,
  ExecutionContext,
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
import { UsersController } from '../src/modules/users/users.controller';
import { UsersService } from '../src/modules/users/users.service';

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '77777777-7777-4777-8777-777777777777';

const closure = {
  status: 'closed' as const,
  displayName: 'Closed account 33333333',
  closedAt: '2026-01-02T00:00:00.000000Z',
  requestId: REQUEST_ID,
  revokedSessions: 1,
  retained: {
    policy: 'REQUIREMENTS §7.6',
    closedBy: 'self_service',
    pseudonymised: ['users.display_name'],
    revoked: { sessions: 1, devices: 0 },
    retained: [
      { entity: 'orders', count: 2, reason: 'Financial records survive' },
    ],
  },
};

const accountExport = {
  exportedAt: '2026-01-02T00:00:00.000000Z',
  profile: {
    id: ACTOR_ID,
    displayName: 'Owner',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000000Z',
    updatedAt: '2026-01-01T00:00:00.000000Z',
    phone: { masked: '+62812****0001', verified: true },
    campusEmail: { verified: false, campusId: null, campusName: null },
  },
  orders: {
    total: 2,
    byStatus: [{ status: 'completed', count: 2 }],
    totalsByCurrency: [{ currency: 'IDR', totalMinor: '50000' }],
  },
  wallet: [{ currency: 'IDR', availableMinor: '20000' }],
  transactions: {
    count: 0,
    truncated: false,
    items: [],
  },
  reviews: { count: 0, items: [] },
  notifications: { count: 3, unread: 1 },
};

class StubUsersService {
  calls: string[] = [];
  lastClosure?: unknown;
  failure?: unknown;

  private maybeFail() {
    if (this.failure) throw this.failure;
  }

  async closeAccount(userId: string, input: unknown) {
    this.calls.push('closeAccount');
    this.lastClosure = { userId, input };
    this.maybeFail();
    return closure;
  }

  async exportAccount(userId: string) {
    this.calls.push('exportAccount:' + userId);
    this.maybeFail();
    return accountExport;
  }
}

describe('Account closure and export HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubUsersService;

  const auth = { authorization: 'Bearer test-token' };
  const base = '/api/v1/me';

  beforeEach(async () => {
    stub = new StubUsersService();
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
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: stub }],
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

  it('requires a bearer token on both routes', async () => {
    for (const request of [
      { method: 'POST' as const, url: base + '/deletion' },
      { method: 'GET' as const, url: base + '/export' },
    ]) {
      const response = await app.inject(request);
      assert.equal(
        response.statusCode,
        401,
        request.method + ' ' + request.url,
      );
    }
    assert.deepEqual(stub.calls, []);
  });

  it('closes the account for the session user and returns the retained summary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: base + '/deletion',
      headers: auth,
      payload: { reason: 'moving on' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: typeof closure };
    assert.equal(body.data.status, 'closed');
    assert.equal(body.data.requestId, REQUEST_ID);
    assert.equal(body.data.revokedSessions, 1);
    assert.deepEqual(body.data.retained.retained, [
      { entity: 'orders', count: 2, reason: 'Financial records survive' },
    ]);
    // The actor is the session user; no body field can name another account.
    assert.deepEqual(JSON.parse(JSON.stringify(stub.lastClosure)), {
      userId: ACTOR_ID,
      input: { reason: 'moving on' },
    });
  });

  it('accepts an empty body because the request itself is the confirmation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: base + '/deletion',
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(stub.lastClosure)), {
      userId: ACTOR_ID,
      input: {},
    });
  });

  it('rejects a body the closure request must not carry', async () => {
    const invalid = [
      { name: 'reason too long', payload: { reason: 'x'.repeat(501) } },
      { name: 'reason not a string', payload: { reason: 42 } },
      { name: 'unknown field', payload: { confirm: true } },
      // The client cannot choose whose account is closed.
      { name: 'user id in body', payload: { userId: REQUEST_ID } },
    ];
    for (const { name, payload } of invalid) {
      const response = await app.inject({
        method: 'POST',
        url: base + '/deletion',
        headers: auth,
        payload,
      });
      assert.equal(response.statusCode, 400, name);
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        'VALIDATION_ERROR',
        name,
      );
    }
    assert.deepEqual(stub.calls, []);
  });

  it('surfaces a service failure with its domain code', async () => {
    stub.failure = new NotFoundException('User account was not found');
    const notFound = await app.inject({
      method: 'POST',
      url: base + '/deletion',
      headers: auth,
    });
    assert.equal(notFound.statusCode, 404);

    stub.failure = new BadRequestException({
      code: 'ACCOUNT_CLOSURE_REASON_INVALID',
      message: 'reason must be 1 to 500 characters when provided',
    });
    const invalid = await app.inject({
      method: 'POST',
      url: base + '/deletion',
      headers: auth,
      payload: { reason: 'ok' },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(
      (invalid.json() as { error: { code: string } }).error.code,
      'ACCOUNT_CLOSURE_REASON_INVALID',
    );
  });

  it('exports the caller own data in a data envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: base + '/export',
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: typeof accountExport };
    assert.equal(body.data.profile.id, ACTOR_ID);
    assert.equal(body.data.profile.phone.masked, '+62812****0001');
    assert.deepEqual(body.data.wallet, [
      { currency: 'IDR', availableMinor: '20000' },
    ]);
    assert.deepEqual(stub.calls, ['exportAccount:' + ACTOR_ID]);
    // The export is read-only: no closure was attempted.
    assert.ok(!stub.calls.some((call) => call === 'closeAccount'));
  });
});
