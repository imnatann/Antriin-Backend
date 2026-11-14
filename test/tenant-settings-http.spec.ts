import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
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
import { TenantProvisioningService } from '../src/modules/tenants/tenant-provisioning.service';
import { TenantsController } from '../src/modules/tenants/tenants.controller';
import { TenantsService } from '../src/modules/tenants/tenants.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CAMPUS_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const MICRO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const EXPECTED = '2026-01-01T00:00:00.000000Z';

class StubTenantsService {
  calls: Array<{
    actorUserId: string;
    tenantId: string;
    input: Record<string, unknown>;
  }> = [];
  failure?: unknown;

  async updateSettings(
    actorUserId: string,
    tenantId: string,
    input: Record<string, unknown>,
  ) {
    this.calls.push({ actorUserId, tenantId, input });
    if (this.failure) throw this.failure;
    return {
      data: {
        id: TENANT_ID,
        campusId: CAMPUS_ID,
        name: 'Kantin Sehat',
        description: 'Masakan rumahan',
        contact: '0812-0000-1111',
        pickupInstructions: 'Loket A lantai 1',
        location: 'Gedung C Lantai 1',
        status: 'open',
        timezone: 'Asia/Jakarta',
        createdAt: '2026-01-01T00:00:00.000000Z',
        updatedAt: '2026-02-01T03:04:05.123456Z',
      },
    };
  }
}

describe('Tenant settings HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubTenantsService;

  const auth = { authorization: 'Bearer test-token' };
  const url = `/api/v1/tenants/${TENANT_ID}/settings`;
  const fullPayload = {
    name: 'Kantin Sehat',
    description: 'Masakan rumahan',
    contact: '0812-0000-1111',
    pickupInstructions: 'Loket A lantai 1',
    location: 'Gedung C Lantai 1',
    reason: 'Profil publik',
    expectedUpdatedAt: EXPECTED,
  };

  beforeEach(async () => {
    stub = new StubTenantsService();
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
      controllers: [TenantsController],
      providers: [
        { provide: TenantsService, useValue: stub },
        { provide: TenantProvisioningService, useValue: {} },
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

  it('requires a bearer token', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url,
      payload: fullPayload,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'unauthorized',
    );
    assert.deepEqual(stub.calls, []);
  });

  it('returns the updated profile inside the data envelope', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url,
      headers: auth,
      payload: fullPayload,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: {
        id: string;
        campusId: string;
        name: string;
        description: string;
        contact: string;
        pickupInstructions: string;
        location: string;
        status: string;
        timezone: string;
        createdAt: string;
        updatedAt: string;
      };
    };
    assert.equal(body.data.id, TENANT_ID);
    assert.equal(body.data.campusId, CAMPUS_ID);
    assert.equal(body.data.description, 'Masakan rumahan');
    assert.equal(body.data.contact, '0812-0000-1111');
    assert.equal(body.data.pickupInstructions, 'Loket A lantai 1');
    assert.equal(body.data.status, 'open');
    assert.match(body.data.createdAt, MICRO_ISO);
    assert.match(body.data.updatedAt, MICRO_ISO);

    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].actorUserId, ACTOR_ID);
    assert.equal(stub.calls[0].tenantId, TENANT_ID);
    assert.equal(stub.calls[0].input.reason, 'Profil publik');
    assert.equal(stub.calls[0].input.expectedUpdatedAt, EXPECTED);
    assert.equal(stub.calls[0].input.pickupInstructions, 'Loket A lantai 1');
  });

  it('accepts a single profile field and an empty description', async () => {
    const partial = await app.inject({
      method: 'PATCH',
      url,
      headers: auth,
      payload: {
        contact: '0813-0000-0000',
        reason: 'Ganti kontak',
        expectedUpdatedAt: EXPECTED,
      },
    });
    assert.equal(partial.statusCode, 200);

    const cleared = await app.inject({
      method: 'PATCH',
      url,
      headers: auth,
      payload: {
        description: '',
        reason: 'Hapus deskripsi',
        expectedUpdatedAt: EXPECTED,
      },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[1].input.description, '');
  });

  it('rejects unknown fields and malformed payloads before the service runs', async () => {
    const unknownField = await app.inject({
      method: 'PATCH',
      url,
      headers: auth,
      payload: { ...fullPayload, status: 'paused', campusId: CAMPUS_ID },
    });
    assert.equal(unknownField.statusCode, 400);
    assert.equal(
      (unknownField.json() as { error: { code: string } }).error.code,
      'VALIDATION_ERROR',
    );

    for (const payload of [
      { contact: '0812-0000-0000', expectedUpdatedAt: EXPECTED },
      { contact: '0812-0000-0000', reason: 'Tanpa versi' },
      { name: '', reason: 'Nama kosong', expectedUpdatedAt: EXPECTED },
      { name: 'Kantin', reason: '', expectedUpdatedAt: EXPECTED },
      {
        description: 'x'.repeat(2001),
        reason: 'Terlalu panjang',
        expectedUpdatedAt: EXPECTED,
      },
      { contact: '0812', reason: 'Versi salah', expectedUpdatedAt: 'kemarin' },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url,
        headers: auth,
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.deepEqual(stub.calls, []);
  });

  it('rejects a malformed tenant id before the service runs', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/not-a-uuid/settings',
      headers: auth,
      payload: fullPayload,
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(stub.calls, []);
  });

  it('maps an empty patch, a stale version and denied access to stable codes', async () => {
    stub.failure = new BadRequestException({
      code: 'TENANT_SETTINGS_EMPTY',
      message: 'At least one profile field is required',
    });
    const empty = await app.inject({
      method: 'PATCH',
      url,
      headers: auth,
      payload: { reason: 'Tanpa data', expectedUpdatedAt: EXPECTED },
    });
    assert.equal(empty.statusCode, 400);
    assert.equal(
      (empty.json() as { error: { code: string } }).error.code,
      'TENANT_SETTINGS_EMPTY',
    );

    stub.failure = new ConflictException({
      code: 'TENANT_VERSION_CONFLICT',
      message: 'Tenant changed since it was read; refresh expectedUpdatedAt',
    });
    const conflict = await app.inject({
      method: 'PATCH',
      url,
      headers: auth,
      payload: fullPayload,
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(
      (conflict.json() as { error: { code: string } }).error.code,
      'TENANT_VERSION_CONFLICT',
    );

    stub.failure = new ForbiddenException('Tenant permission denied');
    const forbidden = await app.inject({
      method: 'PATCH',
      url,
      headers: auth,
      payload: fullPayload,
    });
    assert.equal(forbidden.statusCode, 403);

    stub.failure = new NotFoundException('Tenant not found');
    const missing = await app.inject({
      method: 'PATCH',
      url,
      headers: auth,
      payload: fullPayload,
    });
    assert.equal(missing.statusCode, 404);
  });
});
