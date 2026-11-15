import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
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
import { AccessController } from '../src/modules/access/access.controller';
import { AccessService } from '../src/modules/access/access.service';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { StaffInviteAcceptanceController } from '../src/modules/invites/staff-invite-acceptance.controller';
import { StaffInvitesController } from '../src/modules/invites/staff-invites.controller';
import { StaffInvitesService } from '../src/modules/invites/staff-invites.service';

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const INVITEE_ID = '44444444-4444-4444-8444-444444444444';
const INVITE_ID = '55555555-5555-4555-8555-555555555555';

const invite = {
  id: INVITE_ID,
  tenantId: TENANT_ID,
  invitedUserId: INVITEE_ID,
  invitedBy: ACTOR_ID,
  role: 'kitchen',
  permissions: ['tenant.orders.read'],
  status: 'pending' as const,
  expiresAt: '2026-01-08T00:00:00.000000Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-01-01T00:00:00.000000Z',
};

class StubInvitesService {
  calls: string[] = [];
  lastCreate?: unknown;
  lastList?: unknown;
  lastAccept?: unknown;
  failure?: unknown;

  private maybeFail() {
    if (this.failure) throw this.failure;
  }

  async createInvite(userId: string, tenantId: string, input: unknown) {
    this.calls.push('createInvite');
    this.lastCreate = { userId, tenantId, input };
    this.maybeFail();
    return { ...invite, token: 'raw-token-value-'.repeat(3) };
  }

  async listInvites(userId: string, tenantId: string, options: unknown) {
    this.calls.push('listInvites');
    this.lastList = { userId, tenantId, options };
    this.maybeFail();
    return { items: [invite], meta: { count: 1 } };
  }

  // Arguments are exercised through the controller; the stub only needs to answer.
  async revokeInvite() {
    this.calls.push('revokeInvite');
    this.maybeFail();
    return {
      ...invite,
      status: 'revoked' as const,
      revokedAt: '2026-01-02T00:00:00.000000Z',
    };
  }

  async acceptInvite(userId: string, token: string) {
    this.calls.push('acceptInvite');
    this.lastAccept = { userId, token };
    this.maybeFail();
    return {
      inviteId: INVITE_ID,
      tenantId: TENANT_ID,
      membershipId: '66666666-6666-4666-8666-666666666666',
      role: 'kitchen' as const,
      permissions: ['tenant.orders.read'],
      acceptedAt: '2026-01-02T00:00:00.000000Z',
    };
  }
}

function payloadOf(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** Stands in for the pre-existing /tenants/:id/staff surface. */
class StubAccessService {
  calls: string[] = [];

  async listTenantStaff() {
    this.calls.push('listTenantStaff');
    return [];
  }

  async revokeTenantMembership(input: unknown) {
    this.calls.push('revokeTenantMembership');
    return input;
  }

  async grantTenantMembership() {
    this.calls.push('grantTenantMembership');
    return { membershipId: '88888888-8888-4888-8888-888888888888' };
  }
}

describe('Staff invite HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubInvitesService;
  let accessStub: StubAccessService;

  const auth = { authorization: 'Bearer test-token' };
  const tenantBase = '/api/v1/tenants/' + TENANT_ID + '/staff/invites';
  const acceptBase = '/api/v1/tenant-invites/';

  beforeEach(async () => {
    stub = new StubInvitesService();
    accessStub = new StubAccessService();
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
      controllers: [
        StaffInvitesController,
        StaffInviteAcceptanceController,
        AccessController,
      ],
      providers: [
        { provide: StaffInvitesService, useValue: stub },
        { provide: AccessService, useValue: accessStub },
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

  it('requires a bearer token on every invitation route', async () => {
    const requests = [
      {
        method: 'POST' as const,
        url: tenantBase,
        payload: {
          userId: INVITEE_ID,
          role: 'kitchen',
          permissions: ['tenant.orders.read'],
        },
      },
      { method: 'GET' as const, url: tenantBase },
      { method: 'DELETE' as const, url: tenantBase + '/' + INVITE_ID },
      {
        method: 'POST' as const,
        url: acceptBase + 'token-value-1234567890123456789012345/accept',
      },
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      assert.equal(
        response.statusCode,
        401,
        request.method + ' ' + request.url,
      );
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        'unauthorized',
      );
    }
    assert.deepEqual(stub.calls, []);
  });

  it('returns the invitation with the one-time token in a data envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: tenantBase,
      headers: auth,
      payload: {
        userId: INVITEE_ID,
        role: 'kitchen',
        permissions: ['tenant.orders.read'],
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as {
      data: { id: string; token: string; status: string; tenantId: string };
    };
    assert.equal(body.data.id, INVITE_ID);
    assert.equal(body.data.tenantId, TENANT_ID);
    assert.equal(body.data.status, 'pending');
    assert.match(body.data.token, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(stub.calls, ['createInvite']);
    // The actor comes from the session, never from the body.
    assert.deepEqual(payloadOf(stub.lastCreate), {
      userId: ACTOR_ID,
      tenantId: TENANT_ID,
      input: {
        userId: INVITEE_ID,
        role: 'kitchen',
        permissions: ['tenant.orders.read'],
      },
    });
  });

  it('rejects invitation bodies the transport cannot accept', async () => {
    const invalidBodies: { name: string; payload: Record<string, unknown> }[] =
      [
        {
          name: 'unknown role',
          payload: { userId: INVITEE_ID, role: 'owner', permissions: [] },
        },
        {
          name: 'unknown permission',
          payload: {
            userId: INVITEE_ID,
            role: 'kitchen',
            permissions: ['tenant.root'],
          },
        },
        {
          name: 'duplicate permissions',
          payload: {
            userId: INVITEE_ID,
            role: 'kitchen',
            permissions: ['tenant.orders.read', 'tenant.orders.read'],
          },
        },
        {
          name: 'permissions not an array',
          payload: {
            userId: INVITEE_ID,
            role: 'kitchen',
            permissions: 'tenant.orders.read',
          },
        },
        {
          name: 'missing user id',
          payload: { role: 'kitchen', permissions: [] },
        },
        {
          name: 'user id is not a uuid',
          payload: { userId: 'not-a-uuid', role: 'kitchen', permissions: [] },
        },
        {
          name: 'unknown field',
          payload: {
            userId: INVITEE_ID,
            role: 'kitchen',
            permissions: [],
            reason: 'smuggled',
          },
        },
      ];
    for (const { name, payload } of invalidBodies) {
      const response = await app.inject({
        method: 'POST',
        url: tenantBase,
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

  it('forwards a rejected invitation with its domain code', async () => {
    stub.failure = new ForbiddenException({
      code: 'INVITE_PERMISSION_EXCEEDS_ACTOR',
      message: 'The inviter does not hold: tenant.orders.prepare',
    });
    const response = await app.inject({
      method: 'POST',
      url: tenantBase,
      headers: auth,
      payload: {
        userId: INVITEE_ID,
        role: 'kitchen',
        permissions: ['tenant.orders.prepare'],
      },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'INVITE_PERMISSION_EXCEEDS_ACTOR',
    );
  });

  it('lists invitations and validates the query filter', async () => {
    const response = await app.inject({
      method: 'GET',
      url: tenantBase,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: { id: string }[];
      meta: { count: number };
    };
    assert.equal(body.meta.count, 1);
    assert.equal(body.data[0].id, INVITE_ID);
    assert.ok(!('token' in body.data[0]));

    const explicit = await app.inject({
      method: 'GET',
      url: tenantBase + '?state=accepted&limit=10',
      headers: auth,
    });
    assert.equal(explicit.statusCode, 200);
    assert.deepEqual(payloadOf(stub.lastList), {
      userId: ACTOR_ID,
      tenantId: TENANT_ID,
      options: { state: 'accepted', limit: 10 },
    });

    for (const query of [
      '?state=nonsense',
      '?limit=0',
      '?limit=201',
      '?limit=abc',
    ]) {
      const invalid = await app.inject({
        method: 'GET',
        url: tenantBase + query,
        headers: auth,
      });
      assert.equal(invalid.statusCode, 400, query);
    }
  });

  it('revokes an invitation and surfaces the refusal codes', async () => {
    const ok = await app.inject({
      method: 'DELETE',
      url: tenantBase + '/' + INVITE_ID,
      headers: auth,
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(
      (ok.json() as { data: { status: string } }).data.status,
      'revoked',
    );

    const invalidId = await app.inject({
      method: 'DELETE',
      url: tenantBase + '/not-a-uuid',
      headers: auth,
    });
    assert.equal(invalidId.statusCode, 400);

    stub.failure = new ConflictException({
      code: 'INVITE_ALREADY_ACCEPTED',
      message: 'An accepted invitation cannot be revoked',
    });
    const conflict = await app.inject({
      method: 'DELETE',
      url: tenantBase + '/' + INVITE_ID,
      headers: auth,
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(
      (conflict.json() as { error: { code: string } }).error.code,
      'INVITE_ALREADY_ACCEPTED',
    );

    stub.failure = new NotFoundException({
      code: 'INVITE_NOT_FOUND',
      message: 'Invitation was not found for this tenant',
    });
    const missing = await app.inject({
      method: 'DELETE',
      url: tenantBase + '/' + INVITE_ID,
      headers: auth,
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(
      (missing.json() as { error: { code: string } }).error.code,
      'INVITE_NOT_FOUND',
    );
  });

  it('coexists with the pre-existing /tenants/:id/staff routes', async () => {
    // The staff surface already owns GET/POST /staff and PUT/DELETE /staff/:userId.
    // Registering the invitation controller must not shadow any of them.
    const staffList = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/' + TENANT_ID + '/staff',
      headers: auth,
    });
    assert.equal(staffList.statusCode, 200);
    assert.deepEqual(staffList.json(), { data: [] });

    const invites = await app.inject({
      method: 'GET',
      url: tenantBase,
      headers: auth,
    });
    assert.equal(invites.statusCode, 200);
    assert.equal(
      (invites.json() as { data: { id: string }[] }).data[0].id,
      INVITE_ID,
    );

    // The staff DELETE carries a reason body, so the request must include one.
    const revokeStaff = await app.inject({
      method: 'DELETE',
      url: '/api/v1/tenants/' + TENANT_ID + '/staff/' + INVITEE_ID,
      headers: auth,
      payload: { reason: 'rotation' },
    });
    assert.equal(revokeStaff.statusCode, 200);
    assert.deepEqual(accessStub.calls, [
      'listTenantStaff',
      'revokeTenantMembership',
    ]);
    // ... and the invitation delete still reaches the invitation service.
    const revokeInvite = await app.inject({
      method: 'DELETE',
      url: tenantBase + '/' + INVITE_ID,
      headers: auth,
    });
    assert.equal(revokeInvite.statusCode, 200);
    assert.ok(stub.calls.includes('revokeInvite'));
  });

  it('redeems a token for the authenticated user and reports each refusal', async () => {
    const token = 'a'.repeat(43);
    const ok = await app.inject({
      method: 'POST',
      url: acceptBase + token + '/accept',
      headers: auth,
    });
    // Accepting creates the membership row, so the answer is 201 Created.
    assert.equal(ok.statusCode, 201);
    const body = ok.json() as {
      data: { membershipId: string; role: string; permissions: string[] };
    };
    assert.equal(body.data.role, 'kitchen');
    assert.deepEqual(body.data.permissions, ['tenant.orders.read']);
    // The invitee is the session user, not anything the client could send.
    assert.deepEqual(payloadOf(stub.lastAccept), {
      userId: ACTOR_ID,
      token,
    });

    const refusals = [
      {
        error: new ForbiddenException({
          code: 'INVITE_USER_MISMATCH',
          message: 'This invitation belongs to a different account',
        }),
        status: 403,
        code: 'INVITE_USER_MISMATCH',
      },
      {
        error: new ConflictException({
          code: 'INVITE_EXPIRED',
          message: 'This invitation has expired',
        }),
        status: 409,
        code: 'INVITE_EXPIRED',
      },
      {
        error: new ConflictException({
          code: 'INVITE_REVOKED',
          message: 'This invitation was revoked',
        }),
        status: 409,
        code: 'INVITE_REVOKED',
      },
      {
        error: new NotFoundException({
          code: 'INVITE_NOT_FOUND',
          message: 'Invitation was not found',
        }),
        status: 404,
        code: 'INVITE_NOT_FOUND',
      },
    ];
    for (const refusal of refusals) {
      stub.failure = refusal.error;
      const response = await app.inject({
        method: 'POST',
        url: acceptBase + token + '/accept',
        headers: auth,
      });
      assert.equal(response.statusCode, refusal.status, refusal.code);
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        refusal.code,
      );
    }
  });
});
