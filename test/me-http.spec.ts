import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BadRequestException,
  ConflictException,
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
const CAMPUS_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

const profile = {
  id: ACTOR_ID,
  displayName: 'Owner',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000000Z',
  updatedAt: '2026-01-01T00:00:00.000000Z',
  phone: { masked: '+62812****0001', verified: true },
  campusEmail: {
    verified: true,
    campusId: CAMPUS_ID,
    campusName: 'Campus A',
  },
  wallet: { currency: 'IDR', availableMinor: '0' },
  tenants: [
    {
      tenantId: TENANT_ID,
      tenantName: 'Alpha',
      tenantStatus: 'open',
      campusId: CAMPUS_ID,
      campusName: 'Campus A',
      role: 'owner',
      permissions: ['tenant.orders.read'],
    },
  ],
  campuses: [],
};

const preferences = {
  orderUpdates: true,
  reviewReplies: true,
  caseUpdates: true,
  pushEnabled: false,
  updatedAt: null,
};

const device = {
  id: DEVICE_ID,
  platform: 'ios',
  label: 'My phone',
  lastSeenAt: '2026-01-01T00:00:00.000000Z',
  createdAt: '2026-01-01T00:00:00.000000Z',
  updatedAt: '2026-01-01T00:00:00.000000Z',
};

class StubUsersService {
  calls: string[] = [];
  lastBody?: unknown;
  lastRevoke?: { userId: string; deviceId: string };
  failure?: unknown;

  private maybeFail() {
    if (this.failure) throw this.failure;
  }

  async getProfile() {
    this.calls.push('getProfile');
    this.maybeFail();
    return profile;
  }

  async updateProfile(_userId: string, input: unknown) {
    this.calls.push('updateProfile');
    this.lastBody = input;
    this.maybeFail();
    return profile;
  }

  async getNotificationPreferences() {
    this.calls.push('getNotificationPreferences');
    this.maybeFail();
    return preferences;
  }

  async updateNotificationPreferences(_userId: string, input: unknown) {
    this.calls.push('updateNotificationPreferences');
    this.lastBody = input;
    this.maybeFail();
    return preferences;
  }

  async listDevices() {
    this.calls.push('listDevices');
    this.maybeFail();
    return [device];
  }

  async registerDevice(_userId: string, input: unknown) {
    this.calls.push('registerDevice');
    this.lastBody = input;
    this.maybeFail();
    return device;
  }

  async revokeDevice(userId: string, deviceId: string) {
    this.calls.push('revokeDevice');
    this.lastRevoke = { userId, deviceId };
    this.maybeFail();
    return undefined;
  }
}

/** ValidationPipe hands the service a DTO instance; compare plain data only. */
function payloadOf(stub: StubUsersService): unknown {
  return JSON.parse(JSON.stringify(stub.lastBody));
}

describe('Me HTTP contract', () => {
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

  it('requires a bearer token on every profile route', async () => {
    const requests = [
      { method: 'GET' as const, url: base },
      { method: 'PATCH' as const, url: base, payload: { displayName: 'X' } },
      { method: 'GET' as const, url: base + '/notification-preferences' },
      {
        method: 'PATCH' as const,
        url: base + '/notification-preferences',
        payload: { orderUpdates: false },
      },
      { method: 'GET' as const, url: base + '/devices' },
      {
        method: 'POST' as const,
        url: base + '/devices',
        payload: { platform: 'ios', token: 'device-token-1234' },
      },
      { method: 'DELETE' as const, url: base + '/devices/' + DEVICE_ID },
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      assert.equal(
        response.statusCode,
        401,
        request.method + ' ' + request.url,
      );
    }
    assert.deepEqual(stub.calls, []);
  });

  it('returns the profile in a data envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: base,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: typeof profile };
    assert.equal(body.data.id, ACTOR_ID);
    assert.equal(body.data.phone.masked, '+62812****0001');
    assert.equal(body.data.wallet?.availableMinor, '0');
    assert.equal(body.data.tenants[0].role, 'owner');
    assert.deepEqual(stub.calls, ['getProfile']);
  });

  it('renames the profile and rejects an empty or oversized display name', async () => {
    const ok = await app.inject({
      method: 'PATCH',
      url: base,
      headers: auth,
      payload: { displayName: 'New Name' },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(
      (ok.json() as { data: { displayName: string } }).data.displayName,
      'Owner',
    );
    assert.deepEqual(payloadOf(stub), { displayName: 'New Name' });

    for (const payload of [
      { displayName: '' },
      { displayName: 'x'.repeat(201) },
      { displayName: 42 },
    ]) {
      const invalid = await app.inject({
        method: 'PATCH',
        url: base,
        headers: auth,
        payload,
      });
      assert.equal(invalid.statusCode, 400, JSON.stringify(payload));
    }
    const unknownField = await app.inject({
      method: 'PATCH',
      url: base,
      headers: auth,
      payload: { displayName: 'New Name', role: 'owner' },
    });
    assert.equal(unknownField.statusCode, 400);
    assert.deepEqual(stub.calls, ['updateProfile']);
  });

  it('serves and partially updates the notification preferences', async () => {
    const read = await app.inject({
      method: 'GET',
      url: base + '/notification-preferences',
      headers: auth,
    });
    assert.equal(read.statusCode, 200);
    const readBody = read.json() as { data: typeof preferences };
    assert.equal(readBody.data.updatedAt, null);
    assert.equal(readBody.data.pushEnabled, false);

    const patched = await app.inject({
      method: 'PATCH',
      url: base + '/notification-preferences',
      headers: auth,
      payload: { orderUpdates: false },
    });
    assert.equal(patched.statusCode, 200);
    assert.deepEqual(payloadOf(stub), { orderUpdates: false });

    const notBoolean = await app.inject({
      method: 'PATCH',
      url: base + '/notification-preferences',
      headers: auth,
      payload: { orderUpdates: 'no' },
    });
    assert.equal(notBoolean.statusCode, 400);
    const unknownField = await app.inject({
      method: 'PATCH',
      url: base + '/notification-preferences',
      headers: auth,
      payload: { smsEnabled: true },
    });
    assert.equal(unknownField.statusCode, 400);
    assert.deepEqual(stub.calls, [
      'getNotificationPreferences',
      'updateNotificationPreferences',
    ]);
  });

  it('maps an empty preference update to a stable error code', async () => {
    stub.failure = new BadRequestException({
      code: 'PREFERENCE_UPDATE_EMPTY',
      message: 'At least one notification preference must be provided',
    });
    const response = await app.inject({
      method: 'PATCH',
      url: base + '/notification-preferences',
      headers: auth,
      payload: {},
    });
    assert.equal(response.statusCode, 400);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'PREFERENCE_UPDATE_EMPTY',
    );
  });

  it('lists and registers devices without exposing the token', async () => {
    const list = await app.inject({
      method: 'GET',
      url: base + '/devices',
      headers: auth,
    });
    assert.equal(list.statusCode, 200);
    const listBody = list.json() as { data: (typeof device)[] };
    assert.equal(listBody.data.length, 1);
    assert.equal('token' in listBody.data[0], false);

    const created = await app.inject({
      method: 'POST',
      url: base + '/devices',
      headers: auth,
      payload: {
        platform: 'ios',
        token: 'device-token-1234',
        label: 'My phone',
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(
      (created.json() as { data: { id: string } }).data.id,
      DEVICE_ID,
    );
    assert.deepEqual(payloadOf(stub), {
      platform: 'ios',
      token: 'device-token-1234',
      label: 'My phone',
    });

    for (const payload of [
      { platform: 'windows', token: 'device-token-1234' },
      { platform: 'ios', token: 'short' },
      { platform: 'ios', token: 'device-token-1234', extra: true },
    ]) {
      const invalid = await app.inject({
        method: 'POST',
        url: base + '/devices',
        headers: auth,
        payload,
      });
      assert.equal(invalid.statusCode, 400, JSON.stringify(payload));
    }
    assert.deepEqual(stub.calls, ['listDevices', 'registerDevice']);
  });

  it('returns 409 when the device token belongs to another account', async () => {
    stub.failure = new ConflictException({
      code: 'DEVICE_TOKEN_CONFLICT',
      message: 'This device token is registered to another account',
    });
    const response = await app.inject({
      method: 'POST',
      url: base + '/devices',
      headers: auth,
      payload: { platform: 'android', token: 'device-token-1234' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'DEVICE_TOKEN_CONFLICT',
    );
  });

  it('revokes a device with 204 and rejects a foreign or unknown one', async () => {
    const revoked = await app.inject({
      method: 'DELETE',
      url: base + '/devices/' + DEVICE_ID,
      headers: auth,
    });
    assert.equal(revoked.statusCode, 204);
    assert.equal(revoked.body, '');
    assert.deepEqual(stub.calls, ['revokeDevice']);
    // The actor and the device come from the session and the path, never a body.
    assert.deepEqual(stub.lastRevoke, {
      userId: ACTOR_ID,
      deviceId: DEVICE_ID,
    });

    stub.failure = new NotFoundException('Device was not found');
    const missing = await app.inject({
      method: 'DELETE',
      url: base + '/devices/' + DEVICE_ID,
      headers: auth,
    });
    assert.equal(missing.statusCode, 404);

    stub.failure = undefined;
    stub.calls = [];
    const malformed = await app.inject({
      method: 'DELETE',
      url: base + '/devices/not-a-uuid',
      headers: auth,
    });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(stub.calls, []);
  });
});
