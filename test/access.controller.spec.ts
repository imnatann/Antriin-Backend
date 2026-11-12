import 'reflect-metadata';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { AccessController } from '../src/modules/access/access.controller';
import { AccessService } from '../src/modules/access/access.service';
import { AuthGuard } from '../src/modules/auth/auth.guard';

describe('Tenant staff access HTTP contract', () => {
  let app: NestFastifyApplication;
  let access: {
    listTenantStaff: ReturnType<typeof mock.fn>;
    grantTenantMembership: ReturnType<typeof mock.fn>;
    revokeTenantMembership: ReturnType<typeof mock.fn>;
  };

  beforeEach(async () => {
    access = {
      listTenantStaff: mock.fn(async () => [
        {
          userId: '72c23f61-4d05-4dd5-8b1c-c6d37e4228e8',
          role: 'pickup',
          permissions: ['tenant.orders.handover'],
          status: 'active',
        },
      ]),
      grantTenantMembership: mock.fn(async () => ({
        membershipId: 'f0463c86-9095-4d8a-8a35-c782cf2483b2',
      })),
      revokeTenantMembership: mock.fn(async () => undefined),
    };
    const authGuard = {
      canActivate: (context: {
        switchToHttp(): {
          getRequest(): { headers: Record<string, string>; user?: unknown };
        };
      }) => {
        const request = context.switchToHttp().getRequest();
        const userId = request.headers['x-test-user'];
        if (!userId) throw new UnauthorizedException();
        request.user = { userId, sessionId: 'test-session' };
        return true;
      },
    };
    const builder = Test.createTestingModule({
      controllers: [AccessController],
      providers: [{ provide: AccessService, useValue: access }],
    })
      .overrideGuard(AuthGuard)
      .useValue(authGuard);
    const module = await builder.compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('v1');
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

  it('requires authenticated principal and returns staff data without PII', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/tenants/6e7de3fd-dca1-4769-93dd-b22008b3aee9/staff',
    });
    assert.equal(denied.statusCode, 401);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/6e7de3fd-dca1-4769-93dd-b22008b3aee9/staff',
      headers: { 'x-test-user': 'owner-user-id' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      data: [
        {
          userId: '72c23f61-4d05-4dd5-8b1c-c6d37e4228e8',
          role: 'pickup',
          permissions: ['tenant.orders.handover'],
          status: 'active',
        },
      ],
    });
    assert.deepEqual(access.listTenantStaff.mock.calls[0].arguments, [
      'owner-user-id',
      '6e7de3fd-dca1-4769-93dd-b22008b3aee9',
    ]);
  });

  it('grants only validated staff fields using the authenticated actor', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tenants/6e7de3fd-dca1-4769-93dd-b22008b3aee9/staff',
      headers: { 'x-test-user': 'owner-user-id' },
      payload: {
        subjectUserId: '72c23f61-4d05-4dd5-8b1c-c6d37e4228e8',
        role: 'pickup',
        permissions: ['tenant.orders.handover'],
        reason: 'Pickup shift',
        actorUserId: 'forged-client-user',
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(access.grantTenantMembership.mock.callCount(), 0);

    const valid = await app.inject({
      method: 'POST',
      url: '/v1/tenants/6e7de3fd-dca1-4769-93dd-b22008b3aee9/staff',
      headers: { 'x-test-user': 'owner-user-id' },
      payload: {
        subjectUserId: '72c23f61-4d05-4dd5-8b1c-c6d37e4228e8',
        role: 'pickup',
        permissions: ['tenant.orders.handover'],
        reason: 'Pickup shift',
      },
    });
    assert.equal(valid.statusCode, 201);
    assert.deepEqual(access.grantTenantMembership.mock.calls[0].arguments, [
      {
        actorUserId: 'owner-user-id',
        tenantId: '6e7de3fd-dca1-4769-93dd-b22008b3aee9',
        subjectUserId: '72c23f61-4d05-4dd5-8b1c-c6d37e4228e8',
        role: 'pickup',
        permissions: ['tenant.orders.handover'],
        reason: 'Pickup shift',
      },
    ]);
  });

  it('validates scoped revocation parameters and forwards the reason', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/tenants/6e7de3fd-dca1-4769-93dd-b22008b3aee9/staff/72c23f61-4d05-4dd5-8b1c-c6d37e4228e8',
      headers: { 'x-test-user': 'owner-user-id' },
      payload: { reason: 'Staff contract ended' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(access.revokeTenantMembership.mock.calls[0].arguments, [
      {
        actorUserId: 'owner-user-id',
        tenantId: '6e7de3fd-dca1-4769-93dd-b22008b3aee9',
        subjectUserId: '72c23f61-4d05-4dd5-8b1c-c6d37e4228e8',
        reason: 'Staff contract ended',
      },
    ]);
  });
});
