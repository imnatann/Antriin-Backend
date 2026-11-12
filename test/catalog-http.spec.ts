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
import { CatalogAdminController } from '../src/modules/catalog/catalog-admin.controller';
import { CatalogController } from '../src/modules/catalog/catalog.controller';
import { CatalogService } from '../src/modules/catalog/catalog.service';

const tenantId = randomUUID();
const itemId = randomUUID();
const groupId = randomUUID();
const choiceId = randomUUID();
const categoryId = randomUUID();

describe('Catalog HTTP contract', () => {
  let app: NestFastifyApplication;
  let calls: { method: string; args: unknown[] }[];

  beforeEach(async () => {
    calls = [];
    const record =
      (method: string, result: unknown) =>
      (...args: unknown[]) => {
        calls.push({ method, args });
        return Promise.resolve(result);
      };
    const catalog = {
      listMenu: record('listMenu', {
        data: { categories: [] },
        meta: { truncated: false },
      }),
      getMenuItem: record('getMenuItem', { data: { item: { id: itemId } } }),
      listAdminMenu: record('listAdminMenu', { data: { tenantId } }),
      createCategory: record('createCategory', { data: { id: categoryId } }),
      updateCategory: record('updateCategory', { data: { id: categoryId } }),
      archiveCategory: record('archiveCategory', { data: { id: categoryId } }),
      createMenuItem: record('createMenuItem', { data: { id: itemId } }),
      updateMenuItem: record('updateMenuItem', { data: { id: itemId } }),
      archiveMenuItem: record('archiveMenuItem', { data: { id: itemId } }),
      createOptionGroup: record('createOptionGroup', { data: { id: groupId } }),
      updateOptionGroup: record('updateOptionGroup', { data: { id: groupId } }),
      archiveOptionGroup: record('archiveOptionGroup', {
        data: { id: groupId },
      }),
      createOptionChoice: record('createOptionChoice', {
        data: { id: choiceId },
      }),
      updateOptionChoice: record('updateOptionChoice', {
        data: { id: choiceId },
      }),
      archiveOptionChoice: record('archiveOptionChoice', {
        data: { id: choiceId },
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
      controllers: [CatalogController, CatalogAdminController],
      providers: [{ provide: CatalogService, useValue: catalog }],
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

  it('serves buyer discovery without authentication and validates query input', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/menu?status=sold_out&search=nasi`,
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(calls.at(-1)?.args[0], tenantId);
    assert.deepEqual(
      { ...(calls.at(-1)?.args[1] as object) },
      {
        status: 'sold_out',
        search: 'nasi',
        categoryId: undefined,
      },
    );

    const badStatus = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/menu?status=archived`,
    });
    assert.equal(badStatus.statusCode, 400);

    const badTenant = await app.inject({
      method: 'GET',
      url: '/v1/tenants/not-a-uuid/menu',
    });
    assert.equal(badTenant.statusCode, 400);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/menu/items/${itemId}`,
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(calls.at(-1)?.method, 'getMenuItem');
  });

  it('requires authentication for every admin route', async () => {
    const routes: [string, string, object?][] = [
      ['GET', `/v1/tenants/${tenantId}/menu/manage`],
      ['POST', `/v1/tenants/${tenantId}/menu/categories`, { name: 'X' }],
      [
        'POST',
        `/v1/tenants/${tenantId}/menu/items`,
        { categoryId, name: 'X', priceMinor: '1' },
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
  });

  it('rejects unknown and malformed fields on admin writes', async () => {
    const unknownField = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/menu/categories`,
      headers: auth,
      payload: { name: 'Minuman', tenantId: randomUUID() },
    });
    assert.equal(unknownField.statusCode, 400);

    const missingName = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/menu/categories`,
      headers: auth,
      payload: { sortOrder: 1 },
    });
    assert.equal(missingName.statusCode, 400);

    for (const priceMinor of ['-5', '10.5', 15000, '1e3']) {
      const badPrice = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/menu/items`,
        headers: auth,
        payload: { categoryId, name: 'Nasi', priceMinor },
      });
      assert.equal(badPrice.statusCode, 400, String(priceMinor));
    }

    const missingVersion = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/menu/items/${itemId}`,
      headers: auth,
      payload: { priceMinor: '16000' },
    });
    assert.equal(missingVersion.statusCode, 400);

    const longReason = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/menu/items/${itemId}`,
      headers: auth,
      payload: {
        priceMinor: '16000',
        expectedVersion: 2,
        reason: 'r'.repeat(301),
      },
    });
    assert.equal(longReason.statusCode, 400);

    const badDelta = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/menu/option-groups/${groupId}/choices`,
      headers: auth,
      payload: { name: 'Ekstra', priceDeltaMinor: '-1' },
    });
    assert.equal(badDelta.statusCode, 400);

    const badBounds = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/menu/items/${itemId}/option-groups`,
      headers: auth,
      payload: { name: 'Sambal', minSelections: -1, maxSelections: 0 },
    });
    assert.equal(badBounds.statusCode, 400);
  });

  it('passes the session principal and typed DTO into every admin route', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/menu/items`,
      headers: auth,
      payload: {
        categoryId,
        name: 'Nasi Ayam',
        description: 'd',
        priceMinor: '15000',
        imageRef: 'media://a.png',
      },
    });
    assert.equal(created.statusCode, 201);
    const createCall = calls.at(-1);
    assert.equal(createCall?.method, 'createMenuItem');
    assert.equal(createCall?.args[0], 'user-1');
    assert.equal(createCall?.args[1], tenantId);
    assert.deepEqual(
      { ...(createCall?.args[2] as object) },
      {
        categoryId,
        name: 'Nasi Ayam',
        description: 'd',
        priceMinor: '15000',
        status: undefined,
        imageRef: 'media://a.png',
      },
    );

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/menu/items/${itemId}`,
      headers: auth,
      payload: { priceMinor: '16000', expectedVersion: 2 },
    });
    assert.equal(patched.statusCode, 200);
    const patchCall = calls.at(-1);
    assert.equal(patchCall?.method, 'updateMenuItem');
    const patchDto = patchCall?.args[3] as {
      priceMinor: string;
      expectedVersion: number;
    };
    assert.equal(patchDto.priceMinor, '16000');
    assert.equal(
      patchDto.expectedVersion,
      2,
      'string coerced to int by transform',
    );

    // DELETE is a soft delete and requires an audit reason query param.
    const missingReason = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/menu/choices/${choiceId}`,
      headers: auth,
    });
    assert.equal(missingReason.statusCode, 400);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/menu/choices/${choiceId}?reason=Discontinued`,
      headers: auth,
    });
    assert.equal(deleted.statusCode, 200);
    const deleteCall = calls.at(-1);
    assert.equal(deleteCall?.method, 'archiveOptionChoice');
    assert.equal(deleteCall?.args[0], 'user-1');
    assert.equal(deleteCall?.args[3], 'Discontinued');

    const manage = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/menu/manage`,
      headers: auth,
    });
    assert.equal(manage.statusCode, 200);
    assert.equal(calls.at(-1)?.method, 'listAdminMenu');
  });
});
