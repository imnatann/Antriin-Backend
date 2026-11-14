import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConflictException,
  ExecutionContext,
  ForbiddenException,
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
import { CampusAccessController } from '../src/modules/campuses/campus-access.controller';
import { CampusAccessService } from '../src/modules/campuses/campus-access.service';
import { CampusEmailDomainsController } from '../src/modules/campuses/campus-email-domains.controller';
import { CampusEmailDomainsService } from '../src/modules/campuses/campus-email-domains.service';

const CAMPUS_ID = '11111111-1111-4111-8111-111111111111';
const DOMAIN_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';

const domainView = {
  id: DOMAIN_ID,
  domain: 'student.ac.id',
  active: true,
  verifiedAt: null as string | null,
  createdAt: '2026-11-14T03:04:05.123456Z',
  updatedAt: '2026-11-14T03:04:05.123456Z',
};

class StubCampusAccessService {
  calls: string[] = [];
  failure?: unknown;

  async listMembers() {
    this.calls.push('listMembers');
    if (this.failure) throw this.failure;
    return [
      {
        membershipId: '44444444-4444-4444-8444-444444444444',
        userId: ACTOR_ID,
        displayName: 'Ada Admin',
        permissions: ['campus.access.manage'],
        status: 'active',
        createdAt: '2026-11-14T03:04:05.123456Z',
        updatedAt: '2026-11-14T03:04:05.123456Z',
      },
    ];
  }
}

class StubCampusEmailDomainsService {
  calls: string[] = [];
  failure?: unknown;
  lastInput?: unknown;

  async list() {
    this.calls.push('list');
    if (this.failure) throw this.failure;
    return [domainView];
  }

  async create(_actor: string, _campus: string, input: unknown) {
    this.calls.push('create');
    this.lastInput = input;
    if (this.failure) throw this.failure;
    return domainView;
  }

  async verify(_actor: string, _campus: string, _id: string, input: unknown) {
    this.calls.push('verify');
    this.lastInput = input;
    if (this.failure) throw this.failure;
    return { ...domainView, verifiedAt: '2026-11-14T04:00:00.000001Z' };
  }

  async update(_actor: string, _campus: string, _id: string, input: unknown) {
    this.calls.push('update');
    this.lastInput = input;
    if (this.failure) throw this.failure;
    return { ...domainView, active: false };
  }

  async remove(_actor: string, _campus: string, _id: string, input: unknown) {
    this.calls.push('remove');
    this.lastInput = input;
    if (this.failure) throw this.failure;
  }
}

describe('Campus access HTTP contract', () => {
  let app: NestFastifyApplication;
  let accessStub: StubCampusAccessService;
  let domainsStub: StubCampusEmailDomainsService;

  const auth = { authorization: 'Bearer test-token' };
  const accessUrl = `/api/v1/campuses/${CAMPUS_ID}/access`;
  const domainsUrl = `/api/v1/campuses/${CAMPUS_ID}/email-domains`;
  const domainUrl = `${domainsUrl}/${DOMAIN_ID}`;

  beforeEach(async () => {
    accessStub = new StubCampusAccessService();
    domainsStub = new StubCampusEmailDomainsService();
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
      controllers: [CampusAccessController, CampusEmailDomainsController],
      providers: [
        { provide: CampusAccessService, useValue: accessStub },
        { provide: CampusEmailDomainsService, useValue: domainsStub },
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

  it('requires a bearer token on every campus access route', async () => {
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: accessUrl }),
      app.inject({ method: 'GET', url: domainsUrl }),
      app.inject({
        method: 'POST',
        url: domainsUrl,
        payload: { domain: 'student.ac.id', reason: 'Pendaftaran' },
      }),
      app.inject({
        method: 'POST',
        url: `${domainUrl}/verify`,
        payload: { reason: 'Verifikasi' },
      }),
      app.inject({
        method: 'PATCH',
        url: domainUrl,
        payload: { active: false, reason: 'Nonaktif' },
      }),
      app.inject({
        method: 'DELETE',
        url: domainUrl,
        payload: { reason: 'Hapus' },
      }),
    ]);
    for (const response of responses) assert.equal(response.statusCode, 401);
    assert.deepEqual(accessStub.calls, []);
    assert.deepEqual(domainsStub.calls, []);
  });

  it('lists campus members as a read-only projection', async () => {
    const response = await app.inject({
      method: 'GET',
      url: accessUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: { displayName: string; permissions: string[]; status: string }[];
    };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].displayName, 'Ada Admin');
    assert.deepEqual(body.data[0].permissions, ['campus.access.manage']);
    assert.equal(body.data[0].status, 'active');
    assert.deepEqual(accessStub.calls, ['listMembers']);
  });

  it('maps a campus access denial to 403', async () => {
    accessStub.failure = new ForbiddenException('Campus permission denied');
    const response = await app.inject({
      method: 'GET',
      url: accessUrl,
      headers: auth,
    });
    assert.equal(response.statusCode, 403);
  });

  it('creates a domain with 201 and returns the unverified row', async () => {
    const response = await app.inject({
      method: 'POST',
      url: domainsUrl,
      headers: auth,
      payload: { domain: 'Student.AC.ID', reason: 'Domain mahasiswa' },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as {
      data: { domain: string; active: boolean; verifiedAt: string | null };
    };
    assert.equal(body.data.domain, 'student.ac.id');
    assert.equal(body.data.active, true);
    assert.equal(body.data.verifiedAt, null);
    const input = domainsStub.lastInput as { domain: string; reason: string };
    assert.equal(input.domain, 'Student.AC.ID');
    assert.equal(input.reason, 'Domain mahasiswa');
  });

  it('rejects an invalid domain and unknown fields with 400', async () => {
    for (const payload of [
      { domain: 'nodots', reason: 'Tanpa titik' },
      { domain: 'a..b', reason: 'Label kosong' },
      { domain: 'student ac.id', reason: 'Spasi di tengah' },
      { domain: 'student.ac.id' },
      { domain: 'student.ac.id', reason: 'Pendaftaran', campusId: CAMPUS_ID },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: domainsUrl,
        headers: auth,
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.deepEqual(domainsStub.calls, []);
  });

  it('maps a duplicate domain to 409 EMAIL_DOMAIN_TAKEN', async () => {
    domainsStub.failure = new ConflictException({
      code: 'EMAIL_DOMAIN_TAKEN',
      message: 'This email domain is already registered',
    });
    const response = await app.inject({
      method: 'POST',
      url: domainsUrl,
      headers: auth,
      payload: { domain: 'student.ac.id', reason: 'Duplikat' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'EMAIL_DOMAIN_TAKEN',
    );
  });

  it('verifies and updates a domain with 200', async () => {
    const verified = await app.inject({
      method: 'POST',
      url: `${domainUrl}/verify`,
      headers: auth,
      payload: { reason: 'Verifikasi manual' },
    });
    assert.equal(verified.statusCode, 200);
    assert.equal(
      (verified.json() as { data: { verifiedAt: string | null } }).data
        .verifiedAt,
      '2026-11-14T04:00:00.000001Z',
    );

    const updated = await app.inject({
      method: 'PATCH',
      url: domainUrl,
      headers: auth,
      payload: { active: false, reason: 'Domain nonaktif' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(
      (updated.json() as { data: { active: boolean } }).data.active,
      false,
    );
    assert.deepEqual(domainsStub.calls, ['verify', 'update']);

    const invalidPatch = await app.inject({
      method: 'PATCH',
      url: domainUrl,
      headers: auth,
      payload: { active: 'false', reason: 'Tipe salah' },
    });
    assert.equal(invalidPatch.statusCode, 400);
  });

  it('deletes a domain with 204 and no body', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: domainUrl,
      headers: auth,
      payload: { reason: 'Domain tidak dipakai' },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.body, '');
    assert.deepEqual(domainsStub.calls, ['remove']);
    assert.equal(
      (domainsStub.lastInput as { reason: string }).reason,
      'Domain tidak dipakai',
    );

    const missingReason = await app.inject({
      method: 'DELETE',
      url: domainUrl,
      headers: auth,
      payload: {},
    });
    assert.equal(missingReason.statusCode, 400);
  });

  it('rejects a malformed path id before the service runs', async () => {
    for (const url of [
      '/api/v1/campuses/not-a-uuid/access',
      '/api/v1/campuses/not-a-uuid/email-domains',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: auth,
      });
      assert.equal(response.statusCode, 400, url);
    }
    const badDomainId = await app.inject({
      method: 'DELETE',
      url: `${domainsUrl}/not-a-uuid`,
      headers: auth,
      payload: { reason: 'Hapus' },
    });
    assert.equal(badDomainId.statusCode, 400);
    assert.deepEqual(accessStub.calls, []);
    assert.deepEqual(domainsStub.calls, []);
  });
});
