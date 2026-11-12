import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
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
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { WalletController } from '../src/modules/wallet/wallet.controller';
import { WalletService } from '../src/modules/wallet/wallet.service';

const currentUserId = '1b4a5172-ed86-4e22-9bdf-295c8eb1d591';

describe('Wallet HTTP contract', () => {
  let app: NestFastifyApplication;
  let calls: {
    balances: Array<[string, string | undefined]>;
    transactions: Array<[string, Record<string, unknown>]>;
  };
  let authenticatedUserId: string;

  beforeEach(async () => {
    calls = { balances: [], transactions: [] };
    authenticatedUserId = currentUserId;
    const wallet = {
      getBalance: async (userId: string, currency?: string) => {
        calls.balances.push([userId, currency]);
        if (userId !== currentUserId)
          throw new NotFoundException('User account was not found');
        return [
          {
            accountId: 'internal-id',
            currency: currency ?? 'IDR',
            balanceMinor: '0',
          },
        ];
      },
      listTransactions: async (
        userId: string,
        query: Record<string, unknown>,
      ) => {
        calls.transactions.push([userId, query]);
        return {
          items: [
            {
              id: '82f04510-4e84-4a0d-a216-8d2ed2a13afd',
              currency: 'IDR',
              direction: 'credit',
              amountMinor: '2500',
              createdAt: '2026-11-12T07:00:00.000Z',
            },
          ],
          nextCursor: 'opaque-cursor',
        };
      },
    };
    const guard = {
      canActivate: (context: ExecutionContext) => {
        const request = context.switchToHttp().getRequest<{
          headers: { authorization?: string };
          user?: { userId: string; sessionId: string };
        }>();
        if (request.headers.authorization !== 'Bearer test-token')
          throw new UnauthorizedException();
        request.user = {
          userId: authenticatedUserId,
          sessionId: 'test-session',
        };
        return true;
      },
    };
    const module = await Test.createTestingModule({
      controllers: [WalletController],
      providers: [{ provide: WalletService, useValue: wallet }],
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

  it('requires authentication and returns only the current user balances', async () => {
    const unauthorized = await app.inject({
      method: 'GET',
      url: '/v1/me/wallet?currency=IDR',
    });
    assert.equal(unauthorized.statusCode, 401);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me/wallet',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      data: [{ currency: 'IDR', balanceMinor: '0' }],
    });
    assert.deepEqual(calls.balances, [[currentUserId, 'IDR']]);

    const unsupported = await app.inject({
      method: 'GET',
      url: '/v1/me/wallet?currency=USD',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(unsupported.statusCode, 400);
    const clientScope = await app.inject({
      method: 'GET',
      url: `/v1/me/wallet?currency=IDR&userId=${randomUUID()}`,
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(clientScope.statusCode, 400);
    assert.equal(calls.balances.length, 1);

    authenticatedUserId = 'c1c5ca3a-2e6f-4dd6-b107-58902a962be7';
    const unknownUser = await app.inject({
      method: 'GET',
      url: '/v1/me/wallet',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(unknownUser.statusCode, 404);
    assert.equal(calls.balances[1][0], authenticatedUserId);
  });

  it('validates bounded cursor query and returns a cursor page', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me/wallet/transactions?currency=IDR&limit=10&cursor=Y3Vyc29y',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      calls.transactions.map(([userId, query]) => [userId, { ...query }]),
      [[currentUserId, { currency: 'IDR', limit: 10, cursor: 'Y3Vyc29y' }]],
    );
    assert.deepEqual(response.json().meta, { next_cursor: 'opaque-cursor' });
    assert.equal(Object.hasOwn(response.json().data[0], 'referenceId'), false);

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/me/wallet/transactions?limit=101',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls.transactions.length, 1);
  });

  it('does not expose a client route for arbitrary wallet mutations', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/me/wallet',
      headers: { authorization: 'Bearer test-token' },
      payload: { amountMinor: '100000', direction: 'credit' },
    });
    assert.equal(response.statusCode, 404);
  });
});
