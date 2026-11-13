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
const orderId = randomUUID();
const slotId = randomUUID();
const itemId = randomUUID();
const proposalId = randomUUID();

describe('Orders HTTP contract', () => {
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
    const orders = {
      checkout: record('checkout', {
        data: { id: orderId },
        meta: { replayed: false },
      }),
      listBuyerOrders: record('listBuyerOrders', {
        data: [],
        meta: { next_cursor: null },
      }),
      getBuyerOrder: record('getBuyerOrder', { data: { id: orderId } }),
      decideScheduleProposal: record('decideScheduleProposal', {
        data: { id: proposalId },
        meta: { replayed: false },
      }),
      listTenantOrders: record('listTenantOrders', {
        data: [],
        meta: { next_cursor: null },
      }),
      getTenantOrder: record('getTenantOrder', { data: { id: orderId } }),
      tenantTransition: record('tenantTransition', { data: { id: orderId } }),
      createScheduleProposal: record('createScheduleProposal', {
        data: { id: proposalId },
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

  const validCart = {
    tenantId,
    slotId,
    expectedSlotVersion: 1,
    items: [{ menuItemId: itemId, quantity: 2, optionIds: [] }],
  };

  it('requires an Idempotency-Key header for checkout', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: auth,
      payload: validCart,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it('rejects client-supplied price, total, status and unknown fields', async () => {
    for (const extra of [
      { totalMinor: '1' },
      { subtotalMinor: '1' },
      { currency: 'IDR' },
      { status: 'completed' },
      { buyerId: randomUUID() },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: { ...auth, 'idempotency-key': 'checkout-key-123456' },
        payload: { ...validCart, ...extra },
      });
      assert.equal(
        response.statusCode,
        400,
        'must reject ' + JSON.stringify(extra),
      );
    }
    // The same applies inside a cart line.
    const lineExtra = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...auth, 'idempotency-key': 'checkout-key-123456' },
      payload: {
        ...validCart,
        items: [{ menuItemId: itemId, quantity: 1, priceMinor: '1' }],
      },
    });
    assert.equal(lineExtra.statusCode, 400);
    assert.equal(calls.length, 0, 'nothing reached the service');
  });

  it('validates quantities, cart bounds and the idempotency key shape', async () => {
    for (const payload of [
      { ...validCart, items: [] },
      { ...validCart, items: [{ menuItemId: itemId, quantity: 0 }] },
      { ...validCart, items: [{ menuItemId: itemId, quantity: 201 }] },
      { ...validCart, items: [{ menuItemId: 'not-a-uuid', quantity: 1 }] },
      { ...validCart, expectedSlotVersion: 0 },
      { ...validCart, tenantId: 'nope' },
      { ...validCart, specialRequest: 'x'.repeat(501) },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: { ...auth, 'idempotency-key': 'checkout-key-123456' },
        payload,
      });
      assert.equal(response.statusCode, 400);
    }
    const shortKey = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...auth, 'idempotency-key': 'short' },
      payload: validCart,
    });
    assert.equal(shortKey.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it('passes the header and body to the service and returns 201', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...auth, 'idempotency-key': 'checkout-key-123456' },
      payload: validCart,
    });
    assert.equal(response.statusCode, 201);
    assert.equal(calls.at(-1)?.method, 'checkout');
    assert.equal(calls.at(-1)?.args[0], 'user-1');
    assert.equal(calls.at(-1)?.args[1], 'checkout-key-123456');
    const sent = (calls.at(-1)?.args[2] as { items: Record<string, unknown>[] })
      .items[0];
    assert.equal(sent.menuItemId, itemId);
    assert.equal(sent.quantity, 2);
    assert.deepEqual(sent.optionIds, []);
    assert.deepEqual(response.json(), {
      data: { id: orderId },
      meta: { replayed: false },
    });
  });

  it('requires a bearer token on every orders route', async () => {
    const routes: { method: 'GET' | 'POST'; url: string }[] = [
      { method: 'GET', url: '/v1/orders' },
      { method: 'GET', url: '/v1/orders/' + orderId },
      { method: 'GET', url: '/v1/tenants/' + tenantId + '/orders' },
      {
        method: 'POST',
        url: '/v1/tenants/' + tenantId + '/orders/' + orderId + '/confirm',
      },
    ];
    for (const route of routes) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        ...(route.method === 'POST' ? { payload: {} } : {}),
      });
      assert.equal(response.statusCode, 401, route.url);
    }
  });

  it('requires a reason to decline and validates the decision value', async () => {
    const noReason = await app.inject({
      method: 'POST',
      url: '/v1/tenants/' + tenantId + '/orders/' + orderId + '/decline',
      headers: auth,
      payload: {},
    });
    assert.equal(noReason.statusCode, 400);

    const blankReason = await app.inject({
      method: 'POST',
      url: '/v1/tenants/' + tenantId + '/orders/' + orderId + '/decline',
      headers: auth,
      payload: { reason: '' },
    });
    assert.equal(blankReason.statusCode, 400);

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/tenants/' + tenantId + '/orders/' + orderId + '/decline',
      headers: auth,
      payload: { reason: 'Bahan habis' },
    });
    assert.equal(ok.statusCode, 200);
    // args: (actorUserId, tenantId, orderId, action, input)
    assert.equal(calls.at(-1)?.args[3], 'decline');
    assert.equal(
      (calls.at(-1)?.args[4] as { reason?: string }).reason,
      'Bahan habis',
    );

    const badDecision = await app.inject({
      method: 'POST',
      url:
        '/v1/orders/' +
        orderId +
        '/schedule-proposals/' +
        proposalId +
        '/decision',
      headers: auth,
      payload: { decision: 'approve' },
    });
    assert.equal(badDecision.statusCode, 400);
  });

  it('validates list query parameters and cursor shape', async () => {
    const badLimit = await app.inject({
      method: 'GET',
      url: '/v1/orders?limit=1000',
      headers: auth,
    });
    assert.equal(badLimit.statusCode, 400);

    const badStatus = await app.inject({
      method: 'GET',
      url: '/v1/orders?status=awaiting_payment',
      headers: auth,
    });
    assert.equal(badStatus.statusCode, 400);

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/orders?status=paid_awaiting_tenant&limit=10',
      headers: auth,
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(calls.at(-1)?.args[0], 'user-1');

    const tenantList = await app.inject({
      method: 'GET',
      url: '/v1/tenants/' + tenantId + '/orders?limit=5',
      headers: auth,
    });
    assert.equal(tenantList.statusCode, 200);
    assert.equal(calls.at(-1)?.method, 'listTenantOrders');
    assert.equal(calls.at(-1)?.args[1], tenantId);
  });

  it('surfaces service conflicts as 409 with a stable error code', async () => {
    const orders = app.get<{ checkout: unknown }>(OrdersService) as {
      checkout: () => Promise<never>;
    };
    orders.checkout = () => {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was already used with different input',
      });
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...auth, 'idempotency-key': 'checkout-key-123456' },
      payload: validCart,
    });
    assert.equal(response.statusCode, 409);
    // This harness does not install ApiExceptionFilter, so the exception body is
    // returned directly; the stable code is what the client relies on.
    const body = response.json() as { code?: string };
    assert.equal(body.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects a non-uuid order id before reaching the service', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/orders/not-a-uuid',
      headers: auth,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });
});
