import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
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
import { OrdersController } from '../src/modules/orders/orders.controller';
import { OrdersService } from '../src/modules/orders/orders.service';

const orderId = randomUUID();
const refundId = randomUUID();

describe('Buyer cancellation HTTP contract', () => {
  let app: NestFastifyApplication;
  let calls: unknown[][];
  let cancel: (...args: unknown[]) => Promise<unknown>;

  beforeEach(async () => {
    calls = [];
    cancel = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({
        data: {
          orderId,
          orderNumber: 'AN-20261112-7K3M2Q',
          status: 'cancelled',
          version: 2,
          cancelledAt: '2026-11-15T10:00:00.123456Z',
          refund: {
            id: refundId,
            status: 'requested',
            amountMinor: '25000',
            currency: 'IDR',
            requestedAt: '2026-11-15T10:00:00.123456Z',
          },
        },
        meta: { replayed: false },
      });
    };
    const orders = { cancelByBuyer: (...args: unknown[]) => cancel(...args) };
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
      controllers: [OrdersController],
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
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const auth = { authorization: 'Bearer test-token' };
  const url = () => '/api/v1/orders/' + orderId + '/cancellation';

  it('passes the authenticated buyer, the order id and the reason to the service', async () => {
    const response = await app.inject({
      method: 'POST',
      url: url(),
      headers: auth,
      payload: { reason: 'Salah pilih jadwal' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls[0], ['user-1', orderId, 'Salah pilih jadwal']);
    const body = response.json() as {
      data: { status: string; refund: { status: string } };
      meta: { replayed: boolean };
    };
    assert.equal(body.data.status, 'cancelled');
    assert.equal(body.data.refund.status, 'requested');
    assert.equal(body.meta.replayed, false);
  });

  it('requires a reason and rejects unknown fields', async () => {
    for (const payload of [
      {},
      { reason: '' },
      { reason: 'x'.repeat(501) },
      // A client must never supply the outcome it wants.
      { reason: 'Alasan', status: 'cancelled' },
      { reason: 'Alasan', refundStatus: 'succeeded' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: url(),
        headers: auth,
        payload,
      });
      assert.equal(
        response.statusCode,
        400,
        'must reject ' + JSON.stringify(payload),
      );
    }
    assert.equal(calls.length, 0);
  });

  it('rejects a non-uuid order id before reaching the service', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/not-a-uuid/cancellation',
      headers: auth,
      payload: { reason: 'Alasan' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it('requires bearer authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: url(),
      payload: { reason: 'Alasan' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(calls.length, 0);
  });

  it('returns the precondition failure as a stable 409 code', async () => {
    for (const [code, expected] of [
      [
        'ORDER_CANCELLATION_STATUS_CONFLICT',
        'ORDER_CANCELLATION_STATUS_CONFLICT',
      ],
      [
        'ORDER_CANCELLATION_PICKUP_STARTED',
        'ORDER_CANCELLATION_PICKUP_STARTED',
      ],
      [
        'ORDER_CANCELLATION_ALREADY_CANCELLED',
        'ORDER_CANCELLATION_ALREADY_CANCELLED',
      ],
      ['REFUND_ALREADY_EXISTS', 'REFUND_ALREADY_EXISTS'],
    ] as const) {
      cancel = () => {
        throw new ConflictException({ code, message: 'precondition failed' });
      };
      const response = await app.inject({
        method: 'POST',
        url: url(),
        headers: auth,
        payload: { reason: 'Alasan' },
      });
      assert.equal(response.statusCode, 409);
      const body = response.json() as { error: { code: string } };
      assert.equal(body.error.code, expected);
    }
  });

  it("answers 404 for another buyer's order", async () => {
    cancel = () => {
      throw new NotFoundException('Order not found');
    };
    const response = await app.inject({
      method: 'POST',
      url: url(),
      headers: auth,
      payload: { reason: 'Alasan' },
    });
    assert.equal(response.statusCode, 404);
    const body = response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('returns the replay flag so a client can tell the second call apart', async () => {
    cancel = () =>
      Promise.resolve({
        data: {
          orderId,
          orderNumber: 'AN-20261112-7K3M2Q',
          status: 'cancelled',
          version: 2,
          cancelledAt: '2026-11-15T10:00:00.123456Z',
          refund: {
            id: refundId,
            status: 'requested',
            amountMinor: '25000',
            currency: 'IDR',
            requestedAt: '2026-11-15T10:00:00.123456Z',
          },
        },
        meta: { replayed: true },
      });
    const response = await app.inject({
      method: 'POST',
      url: url(),
      headers: auth,
      payload: { reason: 'Alasan' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(
      (response.json() as { meta: { replayed: boolean } }).meta.replayed,
      true,
    );
  });
});
