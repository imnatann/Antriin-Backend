import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { AvailabilityController } from '../src/modules/availability/availability.controller';
import { AvailabilityService } from '../src/modules/availability/availability.service';

const tenantId = randomUUID();
const slotId = randomUUID();

type SvcMock = {
  listAvailability: (...args: unknown[]) => Promise<unknown>;
  listManagedSlots: (...args: unknown[]) => Promise<unknown>;
  createSlot: (...args: unknown[]) => Promise<unknown>;
  updateSlot: (...args: unknown[]) => Promise<unknown>;
};

describe('Availability HTTP contract', () => {
  let app: NestFastifyApplication;
  let svc: SvcMock;
  let calls: { method: string; args: unknown[] }[];

  beforeEach(async () => {
    calls = [];
    const record =
      (method: string, result: unknown) =>
      (...args: unknown[]) => {
        calls.push({ method, args });
        return Promise.resolve(result);
      };
    svc = {
      listAvailability: record('listAvailability', {
        data: { tenantId, slots: [] },
      }),
      listManagedSlots: record('listManagedSlots', {
        data: { tenantId, slots: [] },
      }),
      createSlot: record('createSlot', {
        data: { id: slotId, tenantId, version: 1 },
      }),
      updateSlot: record('updateSlot', {
        data: { id: slotId, tenantId, version: 2 },
      }),
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
      controllers: [AvailabilityController],
      providers: [{ provide: AvailabilityService, useValue: svc }],
    })
      .overrideGuard(AuthGuard)
      .useValue(guard)
      .compile();
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

  const auth = { authorization: 'Bearer test-token' };

  it('requires authentication on every management route and serves buyers publicly', async () => {
    const routes: [string, string, object?][] = [
      [
        'GET',
        `/v1/tenants/${tenantId}/availability/slots?from=2026-11-13&to=2026-11-14`,
      ],
      [
        'POST',
        `/v1/tenants/${tenantId}/availability/slots`,
        {
          startsAt: '2026-11-13T03:00:00Z',
          endsAt: '2026-11-13T04:00:00Z',
          capacity: 2,
        },
      ],
      [
        'PATCH',
        `/v1/tenants/${tenantId}/availability/slots/${slotId}`,
        { status: 'closed', expectedVersion: 1, reason: 'Bahan habis' },
      ],
    ];
    for (const [method, url, payload] of routes) {
      const response = await app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
      });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
    }

    const publicList = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/availability?date=2026-11-13`,
    });
    assert.equal(publicList.statusCode, 200);
    assert.equal(calls.at(-1)?.method, 'listAvailability');
  });

  it('validates the buyer range query at the edge', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/availability?date=2026-11-13`,
    });
    assert.equal(ok.statusCode, 200);
    const call = calls.at(-1);
    assert.equal(call?.args[0], tenantId);
    assert.deepEqual(
      { ...(call?.args[1] as object) },
      { date: '2026-11-13', from: undefined, to: undefined },
    );

    const badDate = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/availability?date=13-11-2026`,
    });
    assert.equal(badDate.statusCode, 400);

    const badFrom = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/availability?from=2026-13-45&to=2026-11-14`,
    });
    assert.equal(badFrom.statusCode, 400);

    const unknownParam = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/availability?date=2026-11-13&campusId=x`,
    });
    assert.equal(unknownParam.statusCode, 400);

    const badTenant = await app.inject({
      method: 'GET',
      url: '/v1/tenants/not-a-uuid/availability?date=2026-11-13',
    });
    assert.equal(badTenant.statusCode, 400);

    const missingRange = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/availability/slots`,
      headers: auth,
    });
    assert.equal(missingRange.statusCode, 400, 'from/to are required');
  });

  it('validates slot write DTOs (window, capacity, reason) at the edge', async () => {
    const url = `/v1/tenants/${tenantId}/availability/slots`;
    const validBody = {
      startsAt: '2026-11-13T03:00:00Z',
      endsAt: '2026-11-13T04:00:00Z',
      capacity: 2,
    };
    const badBodies: object[] = [
      { ...validBody, startsAt: '2026-11-13 03:00' }, // non-ISO
      { ...validBody, capacity: 0 },
      { ...validBody, capacity: 2147483648 }, // above int4 / service bound
      { ...validBody, capacity: 'abc' },
      { ...validBody, reason: 'r'.repeat(301) },
      { ...validBody, tenantId: randomUUID() }, // unknown field
      { startsAt: validBody.startsAt, endsAt: validBody.endsAt }, // no capacity
    ];
    for (const payload of badBodies) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: auth,
        payload,
      });
      assert.equal(
        response.statusCode,
        400,
        `POST body ${JSON.stringify(payload).slice(0, 90)}`,
      );
    }

    const patchUrl = `${url}/${slotId}`;
    const badPatches: object[] = [
      { capacity: 3 }, // missing expectedVersion
      { status: 'paused', expectedVersion: 1 }, // invalid enum
      { capacity: -1, expectedVersion: 1 },
      { capacity: 2147483648, expectedVersion: 1 },
      {
        status: 'closed',
        expectedVersion: 1,
        reason: 'r'.repeat(301),
      },
      { expectedVersion: 1, surprise: true }, // unknown field
    ];
    for (const payload of badPatches) {
      const response = await app.inject({
        method: 'PATCH',
        url: patchUrl,
        headers: auth,
        payload,
      });
      assert.equal(
        response.statusCode,
        400,
        `PATCH body ${JSON.stringify(payload).slice(0, 90)}`,
      );
    }
    const badSlotId = await app.inject({
      method: 'PATCH',
      url: `${url}/not-a-uuid`,
      headers: auth,
      payload: { status: 'closed', expectedVersion: 1, reason: 'x' },
    });
    assert.equal(badSlotId.statusCode, 400);
  });

  it('passes the session principal and coerced DTO into the service', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/availability/slots`,
      headers: auth,
      payload: {
        startsAt: '2026-11-13T03:00:00Z',
        endsAt: '2026-11-13T04:00:00Z',
        capacity: '3',
      },
    });
    assert.equal(created.statusCode, 201);
    const createCall = calls.at(-1);
    assert.equal(createCall?.method, 'createSlot');
    assert.equal(createCall?.args[0], 'user-1');
    assert.equal(createCall?.args[1], tenantId);
    assert.deepEqual(
      { ...(createCall?.args[2] as object) },
      {
        startsAt: '2026-11-13T03:00:00Z',
        endsAt: '2026-11-13T04:00:00Z',
        capacity: 3,
        reason: undefined,
      },
      'string capacity coerced to int by transform',
    );

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/availability/slots/${slotId}`,
      headers: auth,
      payload: { capacity: '4', expectedVersion: '2' },
    });
    assert.equal(patched.statusCode, 200);
    const patchCall = calls.at(-1);
    assert.equal(patchCall?.method, 'updateSlot');
    assert.equal(patchCall?.args[0], 'user-1');
    assert.equal(patchCall?.args[2], slotId);
    const patchDto = patchCall?.args[3] as {
      capacity: number;
      expectedVersion: number;
    };
    assert.equal(patchDto.capacity, 4);
    assert.equal(patchDto.expectedVersion, 2);

    const managed = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/availability/slots?from=2026-11-13&to=2026-11-20`,
      headers: auth,
    });
    assert.equal(managed.statusCode, 200);
    const managedCall = calls.at(-1);
    assert.equal(managedCall?.method, 'listManagedSlots');
    assert.equal(managedCall?.args[0], 'user-1');
    assert.deepEqual(
      { ...(managedCall?.args[2] as object) },
      { from: '2026-11-13', to: '2026-11-20' },
    );
  });

  it('maps permission, scope, validation and conflict failures to HTTP codes', async () => {
    // 403 — staff without tenant.capacity.manage (service-side authorization).
    svc.listManagedSlots = () =>
      Promise.reject(new ForbiddenException('Tenant permission denied'));
    const forbidden = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/availability/slots?from=2026-11-13&to=2026-11-14`,
      headers: auth,
    });
    assert.equal(forbidden.statusCode, 403);

    svc.createSlot = () =>
      Promise.reject(new ForbiddenException('Tenant access denied'));
    const forbiddenCreate = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/availability/slots`,
      headers: auth,
      payload: {
        startsAt: '2026-11-13T03:00:00Z',
        endsAt: '2026-11-13T04:00:00Z',
        capacity: 2,
      },
    });
    assert.equal(forbiddenCreate.statusCode, 403);

    // 404 — other tenant's slot / unknown tenant.
    svc.updateSlot = () =>
      Promise.reject(new NotFoundException('Pickup slot not found'));
    const notFound = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/availability/slots/${slotId}`,
      headers: auth,
      payload: { status: 'closed', expectedVersion: 1, reason: 'Ditutup' },
    });
    assert.equal(notFound.statusCode, 404);

    svc.listAvailability = () =>
      Promise.reject(new NotFoundException('Tenant not found'));
    const tenantNotFound = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/availability?date=2026-11-13`,
    });
    assert.equal(tenantNotFound.statusCode, 404);

    // 400 — service-level window and reason validation.
    svc.createSlot = () =>
      Promise.reject(new BadRequestException('endsAt must be after startsAt'));
    const badWindow = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/availability/slots`,
      headers: auth,
      payload: {
        startsAt: '2026-11-13T04:00:00Z',
        endsAt: '2026-11-13T03:00:00Z',
        capacity: 2,
      },
    });
    assert.equal(badWindow.statusCode, 400);

    svc.updateSlot = () =>
      Promise.reject(
        new BadRequestException(
          'A reason of 1 to 300 characters is required to close a slot or reduce capacity',
        ),
      );
    const missingReason = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/availability/slots/${slotId}`,
      headers: auth,
      payload: { status: 'closed', expectedVersion: 1 },
    });
    assert.equal(missingReason.statusCode, 400);

    // 409 — version conflict, capacity floor, duplicate window.
    const conflicts: [string, () => void][] = [
      [
        'version',
        () => {
          svc.updateSlot = () =>
            Promise.reject(
              new ConflictException('Pickup slot changed; refresh and retry'),
            );
        },
      ],
      [
        'capacityFloor',
        () => {
          svc.updateSlot = () =>
            Promise.reject(
              new ConflictException(
                'Capacity cannot drop below reserved orders',
              ),
            );
        },
      ],
      [
        'duplicateWindow',
        () => {
          svc.createSlot = () =>
            Promise.reject(
              new ConflictException(
                'A pickup slot with the same window already exists',
              ),
            );
        },
      ],
    ];
    for (const [name, install] of conflicts) {
      install();
      if (name === 'duplicateWindow') {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/availability/slots`,
          headers: auth,
          payload: {
            startsAt: '2026-11-13T03:00:00Z',
            endsAt: '2026-11-13T04:00:00Z',
            capacity: 2,
          },
        });
        assert.equal(response.statusCode, 409, name);
      } else {
        const response = await app.inject({
          method: 'PATCH',
          url: `/v1/tenants/${tenantId}/availability/slots/${slotId}`,
          headers: auth,
          payload: { capacity: 1, expectedVersion: 1, reason: 'Kurangi' },
        });
        assert.equal(response.statusCode, 409, name);
      }
    }
  });
});
