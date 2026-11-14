import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ConflictException,
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
import { OrdersController } from '../src/modules/orders/orders.controller';
import { OrdersService } from '../src/modules/orders/orders.service';
import { TenantOrdersController } from '../src/modules/orders/tenant-orders.controller';

const tenantId = randomUUID();
const slotId = randomUUID();
const itemId = randomUUID();
const choiceId = randomUUID();
const orderId = randomUUID();

const QUOTE_URL = '/api/v1/orders/quote';
const BUYER_EVENTS_URL = '/api/v1/orders/' + orderId + '/events';
const TENANT_EVENTS_URL =
  '/api/v1/tenants/' + tenantId + '/orders/' + orderId + '/events';

describe('Orders quote and events HTTP contract', () => {
  let app: NestFastifyApplication;
  let calls: { method: string; args: unknown[] }[];

  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };

  beforeEach(async () => {
    calls = [];
    const orders = {
      quoteForBuyer: record('quoteForBuyer', {
        data: {
          tenant: {
            id: tenantId,
            campusId: randomUUID(),
            name: 'Kantin Uji',
            timezone: 'Asia/Jakarta',
          },
          slot: {
            id: slotId,
            startsAt: '2026-11-15T03:00:00.000000Z',
            endsAt: '2026-11-15T04:00:00.000000Z',
            version: 1,
          },
          items: [
            {
              menuItemId: itemId,
              categoryId: randomUUID(),
              categoryName: 'Makanan',
              name: 'Nasi Ayam',
              description: 'Deskripsi',
              menuVersion: 1,
              quantity: 2,
              baseUnitPriceMinor: '15000',
              unitPriceMinor: '17000',
              lineTotalMinor: '34000',
              options: [],
            },
          ],
          subtotalMinor: '34000',
          totalMinor: '34000',
          currency: 'IDR',
          wallet: {
            currency: 'IDR',
            availableMinor: '100000',
            sufficient: true,
          },
        },
      }),
      listOrderEvents: record('listOrderEvents', {
        data: [
          {
            id: randomUUID(),
            version: 1,
            eventType: 'order.created',
            fromStatus: null,
            toStatus: 'paid_awaiting_tenant',
            actorUserId: 'user-1',
            actorService: null,
            reason: 'Order paid and awaiting tenant confirmation',
            metadata: { tenantId, totalMinor: '34000' },
            occurredAt: '2026-11-14T03:00:00.000000Z',
          },
        ],
      }),
      listTenantOrderEvents: record('listTenantOrderEvents', {
        data: [],
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
      controllers: [OrdersController, TenantOrdersController],
      providers: [{ provide: OrdersService, useValue: orders }],
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

  const validQuote = {
    tenantId,
    slotId,
    expectedSlotVersion: 1,
    items: [{ menuItemId: itemId, quantity: 2, optionIds: [choiceId] }],
  };

  it('requires a bearer token on the quote and both events routes', async () => {
    const routes: { method: 'GET' | 'POST'; url: string }[] = [
      { method: 'POST', url: QUOTE_URL },
      { method: 'GET', url: BUYER_EVENTS_URL },
      { method: 'GET', url: TENANT_EVENTS_URL },
    ];
    for (const route of routes) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        ...(route.method === 'POST' ? { payload: validQuote } : {}),
      });
      assert.equal(response.statusCode, 401, route.url);
    }
    assert.equal(calls.length, 0);
  });

  it('prices a cart without an Idempotency-Key and returns the quote envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: QUOTE_URL,
      headers: auth,
      payload: {
        ...validQuote,
        items: [
          {
            menuItemId: itemId,
            quantity: 2,
            optionIds: [choiceId],
            notes: 'tanpa sambal',
          },
        ],
        specialRequest: 'pedas sedang',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(calls.at(-1)?.method, 'quoteForBuyer');
    assert.equal(calls.at(-1)?.args[0], 'user-1');
    const sent = calls.at(-1)?.args[1] as {
      tenantId: string;
      slotId: string;
      expectedSlotVersion: number;
      specialRequest?: string;
      items: {
        menuItemId: string;
        quantity: number;
        optionIds: string[];
        notes?: string;
      }[];
    };
    assert.equal(sent.tenantId, tenantId);
    assert.equal(sent.slotId, slotId);
    assert.equal(sent.expectedSlotVersion, 1);
    assert.equal(sent.specialRequest, 'pedas sedang');
    assert.equal(sent.items[0].menuItemId, itemId);
    assert.equal(sent.items[0].quantity, 2);
    assert.deepEqual(sent.items[0].optionIds, [choiceId]);
    assert.equal(sent.items[0].notes, 'tanpa sambal');

    const body = response.json() as {
      data: {
        totalMinor: string;
        currency: string;
        items: { lineTotalMinor: string }[];
        wallet: { availableMinor: string; sufficient: boolean };
      };
    };
    assert.equal(body.data.totalMinor, '34000');
    assert.equal(body.data.currency, 'IDR');
    assert.equal(body.data.items[0].lineTotalMinor, '34000');
    assert.equal(body.data.wallet.sufficient, true);
    assert.equal(body.data.wallet.availableMinor, '100000');
  });

  it('accepts a quote without the optional slot version guard', async () => {
    const response = await app.inject({
      method: 'POST',
      url: QUOTE_URL,
      headers: auth,
      payload: {
        tenantId,
        slotId,
        items: [{ menuItemId: itemId, quantity: 1 }],
      },
    });
    assert.equal(response.statusCode, 200);
    const sent = calls.at(-1)?.args[1] as { expectedSlotVersion?: number };
    assert.equal(sent.expectedSlotVersion, undefined);
  });

  it('rejects client-supplied money, status and unknown fields', async () => {
    for (const extra of [
      { totalMinor: '1' },
      { subtotalMinor: '1' },
      { currency: 'IDR' },
      { status: 'completed' },
      { buyerId: randomUUID() },
      { wallet: { sufficient: true } },
      { quoteHash: 'abc' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: QUOTE_URL,
        headers: auth,
        payload: { ...validQuote, ...extra },
      });
      assert.equal(
        response.statusCode,
        400,
        'must reject ' + JSON.stringify(extra),
      );
    }
    for (const extra of [
      { priceMinor: '1' },
      { unitPriceMinor: '1' },
      { lineTotalMinor: '1' },
      { name: 'Palsu' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: QUOTE_URL,
        headers: auth,
        payload: {
          ...validQuote,
          items: [{ menuItemId: itemId, quantity: 1, ...extra }],
        },
      });
      assert.equal(
        response.statusCode,
        400,
        'must reject line field ' + JSON.stringify(extra),
      );
    }
    assert.equal(calls.length, 0, 'nothing reached the service');
  });

  it('validates cart bounds, ids and lengths before pricing', async () => {
    for (const payload of [
      { ...validQuote, items: [] },
      { ...validQuote, items: [{ menuItemId: itemId, quantity: 0 }] },
      { ...validQuote, items: [{ menuItemId: itemId, quantity: 201 }] },
      { ...validQuote, items: [{ menuItemId: itemId, quantity: 1.5 }] },
      { ...validQuote, items: [{ menuItemId: 'not-a-uuid', quantity: 1 }] },
      {
        ...validQuote,
        items: [{ menuItemId: itemId, quantity: 1, optionIds: ['nope'] }],
      },
      {
        ...validQuote,
        items: [{ menuItemId: itemId, quantity: 1, notes: 'x'.repeat(501) }],
      },
      { ...validQuote, expectedSlotVersion: 0 },
      { ...validQuote, expectedSlotVersion: '1' },
      { ...validQuote, tenantId: 'nope' },
      { ...validQuote, slotId: 'nope' },
      { ...validQuote, specialRequest: 'x'.repeat(501) },
      { tenantId, slotId },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: QUOTE_URL,
        headers: auth,
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(calls.length, 0);
  });

  it('returns the buyer timeline in the documented envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: BUYER_EVENTS_URL,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(calls.at(-1)?.method, 'listOrderEvents');
    assert.deepEqual(calls.at(-1)?.args, ['user-1', orderId]);
    const body = response.json() as {
      data: {
        id: string;
        version: number;
        eventType: string;
        fromStatus: string | null;
        toStatus: string | null;
        actorUserId: string | null;
        actorService: string | null;
        reason: string;
        metadata: Record<string, unknown>;
        occurredAt: string;
      }[];
    };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].eventType, 'order.created');
    assert.equal(body.data[0].fromStatus, null);
    assert.equal(body.data[0].toStatus, 'paid_awaiting_tenant');
    assert.equal(body.data[0].actorService, null);
    assert.deepEqual(body.data[0].metadata, {
      tenantId,
      totalMinor: '34000',
    });
    assert.equal(body.data[0].occurredAt, '2026-11-14T03:00:00.000000Z');
  });

  it('returns the tenant timeline and passes the tenant scope through', async () => {
    const response = await app.inject({
      method: 'GET',
      url: TENANT_EVENTS_URL,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(calls.at(-1)?.method, 'listTenantOrderEvents');
    assert.deepEqual(calls.at(-1)?.args, ['user-1', tenantId, orderId]);
    assert.deepEqual(response.json(), { data: [] });
  });

  it('rejects malformed path ids before reaching the service', async () => {
    for (const url of [
      '/api/v1/orders/not-a-uuid/events',
      '/api/v1/tenants/not-a-uuid/orders/' + orderId + '/events',
      '/api/v1/tenants/' + tenantId + '/orders/not-a-uuid/events',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: auth });
      assert.equal(response.statusCode, 400, url);
    }
    assert.equal(calls.length, 0);
  });

  it('surfaces a stale slot as 409 SLOT_CHANGED', async () => {
    const orders = app.get<{ quoteForBuyer: unknown }>(
      OrdersService,
    ) as unknown as {
      quoteForBuyer: () => Promise<never>;
    };
    orders.quoteForBuyer = () => {
      throw new ConflictException({
        code: 'SLOT_CHANGED',
        message: 'Pickup slot changed since the cart was built; re-quote',
      });
    };
    const response = await app.inject({
      method: 'POST',
      url: QUOTE_URL,
      headers: auth,
      payload: validQuote,
    });
    assert.equal(response.statusCode, 409);
    assert.equal((response.json() as { code?: string }).code, 'SLOT_CHANGED');
  });
});
