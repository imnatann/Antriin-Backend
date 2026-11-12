import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
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
import { Pool } from 'pg';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { CampusesController } from '../src/modules/campuses/campuses.controller';
import { CampusesService } from '../src/modules/campuses/campuses.service';
import { TenantOperatingHoursController } from '../src/modules/tenants/tenant-operating-hours.controller';
import { TenantOperatingHoursService } from '../src/modules/tenants/tenant-operating-hours.service';
import { TenantProvisioningService } from '../src/modules/tenants/tenant-provisioning.service';
import { TenantsController } from '../src/modules/tenants/tenants.controller';
import { TenantsService } from '../src/modules/tenants/tenants.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MICRO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

describe(
  'Tenants/Campuses HTTP contract on PostgreSQL',
  { skip: !databaseUrl },
  () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const database = { pool } as DatabaseService;
    const access = new AccessService(database);
    const audit = new AuditService(database, access);

    // Unique per-run token so repeated runs against the same database never
    // collide on name-based search assertions.
    const run = randomUUID().slice(0, 8);
    const campus = randomUUID();
    const admin = randomUUID();
    const owner = randomUUID();
    const outsider = randomUUID();
    const ownerSubject = randomUUID();
    const fixtureTenant = randomUUID();
    const tokens: Record<string, string> = {
      'token-admin': admin,
      'token-owner': owner,
      'token-outsider': outsider,
    };
    let app: NestFastifyApplication;
    let createdTenantId: string;
    let createdUpdatedAt: string;

    const guard = {
      canActivate: (context: ExecutionContext) => {
        const request = context.switchToHttp().getRequest<{
          headers: { authorization?: string };
          user?: { userId: string; sessionId: string };
        }>();
        const header = request.headers.authorization;
        const token =
          typeof header === 'string' ? header.replace('Bearer ', '') : '';
        const userId = tokens[token];
        if (!userId) {
          throw new UnauthorizedException({
            code: 'unauthorized',
            message: 'A valid bearer token is required',
          });
        }
        request.user = { userId, sessionId: 'http-test-session' };
        return true;
      },
    };

    before(async () => {
      await pool.query(
        `INSERT INTO campuses (id, name, timezone, status) VALUES ($1, $2, 'Asia/Jakarta', 'active')`,
        [campus, `Kampus HTTP Contract ${run}`],
      );
      await pool.query(
        `INSERT INTO users (id, display_name, status) VALUES
         ($1, 'HTTP admin', 'active'),
         ($2, 'HTTP owner', 'active'),
         ($3, 'HTTP outsider', 'active'),
         ($4, 'HTTP owner subject', 'active')`,
        [admin, owner, outsider, ownerSubject],
      );
      await pool.query(
        `INSERT INTO tenants (id, campus_id, name, location, status) VALUES ($1, $2, 'Kantin HTTP', 'Gedung HTTP', 'open')`,
        [fixtureTenant, campus],
      );
      await pool.query(
        `INSERT INTO campus_memberships (campus_id, user_id, permissions) VALUES ($1, $2, ARRAY['campus.tenants.manage','campus.access.manage']::text[])`,
        [campus, admin],
      );
      await pool.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, owner_verified_at) VALUES ($1, $2, 'owner', '{}'::text[], now())`,
        [fixtureTenant, owner],
      );

      const module = await Test.createTestingModule({
        controllers: [
          TenantsController,
          TenantOperatingHoursController,
          CampusesController,
        ],
        providers: [
          {
            provide: TenantsService,
            useValue: new TenantsService(database, access, audit),
          },
          {
            provide: TenantOperatingHoursService,
            useValue: new TenantOperatingHoursService(database, access, audit),
          },
          {
            provide: TenantProvisioningService,
            useValue: new TenantProvisioningService(database, access, audit),
          },
          { provide: CampusesService, useValue: new CampusesService(database) },
        ],
      })
        .overrideGuard(AuthGuard)
        .useValue(guard)
        .compile();
      app = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
      );
      app.setGlobalPrefix('v1');
      app.useGlobalFilters(new ApiExceptionFilter());
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

    after(async () => {
      await app?.close();
      await pool.end();
    });

    it('serves public campus discovery and validates query DTOs', async () => {
      const list = await app.inject({
        method: 'GET',
        url: `/v1/campuses?search=${encodeURIComponent(`HTTP CONTRACT ${run}`)}`,
      });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(
        list.json().data.map((row: { id: string }) => row.id),
        [campus],
      );

      const detail = await app.inject({
        method: 'GET',
        url: `/v1/campuses/${campus}`,
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().data.timezone, 'Asia/Jakarta');

      const campusTenants = await app.inject({
        method: 'GET',
        url: `/v1/campuses/${campus}/tenants`,
      });
      assert.equal(campusTenants.statusCode, 200);
      assert.deepEqual(
        campusTenants.json().data.map((row: { id: string }) => row.id),
        [fixtureTenant],
        'defaults to open tenants',
      );

      const badStatus = await app.inject({
        method: 'GET',
        url: `/v1/campuses/${campus}/tenants?status=archived`,
      });
      assert.equal(badStatus.statusCode, 400);
      assert.equal(badStatus.json().error.code, 'VALIDATION_ERROR');

      const badUuid = await app.inject({
        method: 'GET',
        url: '/v1/campuses/not-a-uuid',
      });
      assert.equal(badUuid.statusCode, 400);
    });

    it('requires auth, rejects unknown fields, and creates tenants with microsecond updatedAt', async () => {
      const unauthorized = await app.inject({
        method: 'POST',
        url: `/v1/campuses/${campus}/tenants`,
        payload: { name: 'Tanpa token', location: 'X', reason: 'Y' },
      });
      assert.equal(unauthorized.statusCode, 401);
      // The real AuthGuard declares the domain code 'unauthorized' and the
      // ApiExceptionFilter preserves declared codes verbatim (see api-errors.spec).
      assert.equal(unauthorized.json().error.code, 'unauthorized');

      const forbidden = await app.inject({
        method: 'POST',
        url: `/v1/campuses/${campus}/tenants`,
        headers: { authorization: 'Bearer token-outsider' },
        payload: { name: 'Bukan admin', location: 'X', reason: 'Y' },
      });
      assert.equal(forbidden.statusCode, 403);
      assert.equal(forbidden.json().error.code, 'FORBIDDEN');

      const unknownField = await app.inject({
        method: 'POST',
        url: `/v1/campuses/${campus}/tenants`,
        headers: { authorization: 'Bearer token-admin' },
        payload: {
          name: 'Ada field asing',
          location: 'X',
          reason: 'Y',
          status: 'open',
          isAdmin: true,
        },
      });
      assert.equal(unknownField.statusCode, 400);
      assert.equal(unknownField.json().error.code, 'VALIDATION_ERROR');

      const created = await app.inject({
        method: 'POST',
        url: `/v1/campuses/${campus}/tenants`,
        headers: { authorization: 'Bearer token-admin' },
        payload: {
          name: 'Kantin HTTP Baru',
          location: 'Gedung Baru',
          reason: 'Onboarding',
        },
      });
      assert.equal(created.statusCode, 201);
      createdTenantId = created.json().data.id;
      createdUpdatedAt = created.json().data.updatedAt;
      assert.equal(created.json().data.status, 'closed');
      assert.match(createdUpdatedAt, MICRO_ISO);
    });

    it('round-trips expectedUpdatedAt verbatim for updates (convention D7)', async () => {
      const updated = await app.inject({
        method: 'PATCH',
        url: `/v1/campuses/${campus}/tenants/${createdTenantId}`,
        headers: { authorization: 'Bearer token-admin' },
        payload: {
          name: 'Kantin HTTP Baru Direvisi',
          location: 'Gedung Baru Lantai 3',
          reason: 'Pindah lantai',
          expectedUpdatedAt: createdUpdatedAt,
        },
      });
      assert.equal(updated.statusCode, 200);
      assert.match(updated.json().data.updatedAt, MICRO_ISO);

      const stale = await app.inject({
        method: 'PATCH',
        url: `/v1/campuses/${campus}/tenants/${createdTenantId}`,
        headers: { authorization: 'Bearer token-admin' },
        payload: {
          name: 'Basi',
          location: 'X',
          reason: 'Token basi',
          expectedUpdatedAt: createdUpdatedAt,
        },
      });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error.code, 'CONFLICT');
    });

    it('guards staff status transitions and operating-hours writes', async () => {
      const statusToken = await pool.query<{ iso: string }>(
        `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS iso FROM tenants WHERE id = $1`,
        [fixtureTenant],
      );
      const outsiderPause = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${fixtureTenant}/status`,
        headers: { authorization: 'Bearer token-outsider' },
        payload: {
          status: 'paused',
          reason: 'Bukan staf',
          expectedUpdatedAt: statusToken.rows[0].iso,
        },
      });
      assert.equal(outsiderPause.statusCode, 403);

      const paused = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${fixtureTenant}/status`,
        headers: { authorization: 'Bearer token-owner' },
        payload: {
          status: 'paused',
          reason: 'Libur mendadak',
          expectedUpdatedAt: statusToken.rows[0].iso,
        },
      });
      assert.equal(paused.statusCode, 200);
      assert.equal(paused.json().data.status, 'paused');

      const badSchedule = await app.inject({
        method: 'PUT',
        url: `/v1/tenants/${fixtureTenant}/operating-hours`,
        headers: { authorization: 'Bearer token-owner' },
        payload: {
          days: [
            { weekday: 1, isOpen: true, opensAt: '08:00', closesAt: '17:00' },
          ],
          reason: 'Kurang hari',
        },
      });
      assert.equal(badSchedule.statusCode, 400);

      const fullWeek = [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
        weekday === 0
          ? { weekday, isOpen: false }
          : { weekday, isOpen: true, opensAt: '08:00', closesAt: '17:00' },
      );
      const schedule = await app.inject({
        method: 'PUT',
        url: `/v1/tenants/${fixtureTenant}/operating-hours`,
        headers: { authorization: 'Bearer token-owner' },
        payload: { days: fullWeek, reason: 'Jadwal reguler' },
      });
      assert.equal(schedule.statusCode, 200);
      assert.equal(schedule.json().data.weekly.length, 7);

      const listed = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${fixtureTenant}/operating-hours`,
      });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json().data.timezone, 'Asia/Jakarta');
      assert.ok(Array.isArray(listed.json().data.overrides));
    });

    it('provisions the first owner once (409 afterwards) and archives with a body reason', async () => {
      const provisioned = await app.inject({
        method: 'POST',
        url: `/v1/campuses/${campus}/tenants/${createdTenantId}/owner`,
        headers: { authorization: 'Bearer token-admin' },
        payload: {
          subjectUserId: ownerSubject,
          reason: 'Owner pertama via HTTP',
        },
      });
      assert.equal(provisioned.statusCode, 201);
      assert.equal(provisioned.json().data.role, 'owner');

      const duplicate = await app.inject({
        method: 'POST',
        url: `/v1/campuses/${campus}/tenants/${createdTenantId}/owner`,
        headers: { authorization: 'Bearer token-admin' },
        payload: { subjectUserId: randomUUID(), reason: 'Owner kedua' },
      });
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.json().error.code, 'CONFLICT');

      const current = await pool.query<{ iso: string }>(
        `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS iso FROM tenants WHERE id = $1`,
        [createdTenantId],
      );
      const archived = await app.inject({
        method: 'DELETE',
        url: `/v1/campuses/${campus}/tenants/${createdTenantId}`,
        headers: { authorization: 'Bearer token-admin' },
        payload: {
          reason: 'Batal onboarding',
          expectedUpdatedAt: current.rows[0].iso,
        },
      });
      assert.equal(archived.statusCode, 200);
      assert.equal(archived.json().data.status, 'archived');

      const gone = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${createdTenantId}`,
      });
      assert.equal(gone.statusCode, 404);
      assert.equal(gone.json().error.code, 'NOT_FOUND');
    });
  },
);
