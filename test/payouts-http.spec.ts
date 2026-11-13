import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
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
import { BankAccountsService } from '../src/modules/payouts/bank-accounts.service';
import { CampusPayoutsController } from '../src/modules/payouts/campus-payouts.controller';
import { PayoutsController } from '../src/modules/payouts/payouts.controller';
import { PayoutsService } from '../src/modules/payouts/payouts.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const PAYOUT_ID = '44444444-4444-4444-8444-444444444444';
const TS = '2026-11-13T10:00:00.000000Z';

const accountView = {
  id: ACCOUNT_ID,
  tenantId: TENANT_ID,
  bankCode: 'BCA',
  accountNumberMasked: '****7890',
  accountHolderName: 'Owner Name',
  verificationStatus: 'pending' as const,
  verifiedAt: null,
  status: 'active' as const,
  isDefault: true,
  version: 1,
  createdAt: TS,
  updatedAt: TS,
};

const payoutView = {
  id: PAYOUT_ID,
  tenantId: TENANT_ID,
  bankAccountId: ACCOUNT_ID,
  bankCode: 'BCA',
  accountNumberMasked: '****7890',
  accountHolderName: 'Owner Name',
  amountMinor: '10000',
  currency: 'IDR',
  status: 'requested' as const,
  provider: 'sandbox',
  providerReference: null,
  failureCode: null,
  lastError: null,
  requestedByUserId: ACTOR_ID,
  requestedAt: TS,
  processingAt: null,
  succeededAt: null,
  failedAt: null,
  cancelledAt: null,
  version: 1,
  createdAt: TS,
  updatedAt: TS,
};

class StubBankAccountsService {
  calls: string[] = [];
  failure?: unknown;
  async listBankAccounts() {
    this.calls.push('list');
    if (this.failure) throw this.failure;
    return [accountView];
  }
  async createBankAccount() {
    this.calls.push('create');
    if (this.failure) throw this.failure;
    return accountView;
  }
  async replaceBankAccount() {
    this.calls.push('replace');
    if (this.failure) throw this.failure;
    return { ...accountView, id: PAYOUT_ID };
  }
  async disableBankAccount() {
    this.calls.push('disable');
    if (this.failure) throw this.failure;
    return { ...accountView, status: 'disabled' as const };
  }
  async requestVerification() {
    this.calls.push('verify');
    throw new ServiceUnavailableException({
      code: 'BANK_ACCOUNT_VERIFICATION_DISABLED',
      message: 'Bank account verification is not enabled',
    });
  }
}

class StubPayoutsService {
  requests: { idempotencyKey: string; amountMinor: string }[] = [];
  campusCalls: { campusId: string; status?: string }[] = [];
  failure?: unknown;
  replayed = false;
  async requestPayout(
    _actorUserId: string,
    _tenantId: string,
    input: { idempotencyKey: string; amountMinor: string },
  ) {
    this.requests.push(input);
    if (this.failure) throw this.failure;
    return { payout: payoutView, replayed: this.replayed };
  }
  async listCampusPayouts(
    _actorUserId: string,
    campusId: string,
    options: { status?: string } = {},
  ) {
    this.campusCalls.push({ campusId, status: options.status });
    if (this.failure) throw this.failure;
    return {
      items: [
        {
          payoutId: PAYOUT_ID,
          tenantId: TENANT_ID,
          tenantName: 'Kantin Uji',
          status: 'requested' as const,
          amountMinor: '10000',
          currency: 'IDR',
          bankCode: 'BCA',
          accountNumberMasked: '****7890',
          requestedAt: TS,
          processingAt: null,
          succeededAt: null,
          failedAt: null,
          cancelledAt: null,
        },
      ],
      nextCursor: null,
    };
  }
  async listTenantPayouts() {
    if (this.failure) throw this.failure;
    return { items: [payoutView], nextCursor: null };
  }
  async getTenantPayout() {
    if (this.failure) throw this.failure;
    return { payout: payoutView, events: [], allocations: [] };
  }
  async cancelPayout() {
    if (this.failure) throw this.failure;
    return { ...payoutView, status: 'cancelled' as const, cancelledAt: TS };
  }
}

describe('Payouts HTTP contract', () => {
  let app: NestFastifyApplication;
  let accounts: StubBankAccountsService;
  let payouts: StubPayoutsService;

  const auth = { authorization: 'Bearer test-token' };
  const base = `/api/v1/tenants/${TENANT_ID}`;
  const accountsUrl = base + '/bank-accounts';
  const payoutsUrl = base + '/payouts';

  beforeEach(async () => {
    accounts = new StubBankAccountsService();
    payouts = new StubPayoutsService();
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
      controllers: [PayoutsController],
      providers: [
        { provide: PayoutsService, useValue: payouts },
        { provide: BankAccountsService, useValue: accounts },
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

  it('requires a bearer token on every bank account and payout route', async () => {
    const routes: [string, string, object?][] = [
      ['GET', accountsUrl],
      [
        'POST',
        accountsUrl,
        {
          bankCode: 'BCA',
          accountNumber: '1234567890',
          accountHolderName: 'Owner Name',
        },
      ],
      ['DELETE', accountsUrl + '/' + ACCOUNT_ID],
      ['POST', accountsUrl + '/' + ACCOUNT_ID + '/verify'],
      ['GET', payoutsUrl],
      ['GET', payoutsUrl + '/' + PAYOUT_ID],
      ['POST', payoutsUrl + '/' + PAYOUT_ID + '/cancel', {}],
    ];
    for (const [method, url, payload] of routes) {
      const response = await app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
      });
      assert.equal(response.statusCode, 401, method + ' ' + url);
    }
    assert.equal(accounts.calls.length, 0);
    assert.equal(payouts.requests.length, 0);
  });

  it('creates an account and returns only the masked number', async () => {
    const response = await app.inject({
      method: 'POST',
      url: accountsUrl,
      headers: auth,
      payload: {
        bankCode: 'BCA',
        accountNumber: '1234567890',
        accountHolderName: 'Owner Name',
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as {
      data: { accountNumberMasked: string; verificationStatus: string };
    };
    assert.equal(body.data.accountNumberMasked, '****7890');
    assert.equal(body.data.verificationStatus, 'pending');
    assert.ok(!JSON.stringify(body).includes('1234567890'));
  });

  it('keeps the verification endpoint at 503 BANK_ACCOUNT_VERIFICATION_DISABLED', async () => {
    const response = await app.inject({
      method: 'POST',
      url: accountsUrl + '/' + ACCOUNT_ID + '/verify',
      headers: auth,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'BANK_ACCOUNT_VERIFICATION_DISABLED',
    );
  });

  it('requires a well-formed Idempotency-Key on payout requests', async () => {
    const payload = { bankAccountId: ACCOUNT_ID, amountMinor: '10000' };
    const missing = await app.inject({
      method: 'POST',
      url: payoutsUrl,
      headers: auth,
      payload,
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(
      (missing.json() as { error: { code: string } }).error.code,
      'PAYOUT_IDEMPOTENCY_KEY_INVALID',
    );
    const malformed = await app.inject({
      method: 'POST',
      url: payoutsUrl,
      headers: { ...auth, 'idempotency-key': 'short' },
      payload,
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(payouts.requests.length, 0);
  });

  it('rejects malformed amounts, ids and unknown fields before the service runs', async () => {
    const headers = { ...auth, 'idempotency-key': 'payout-key-0001' };
    for (const payload of [
      { bankAccountId: ACCOUNT_ID, amountMinor: '0' },
      { bankAccountId: ACCOUNT_ID, amountMinor: '-5' },
      { bankAccountId: ACCOUNT_ID, amountMinor: '1.5' },
      { bankAccountId: ACCOUNT_ID, amountMinor: 10000 },
      { bankAccountId: 'not-a-uuid', amountMinor: '10000' },
      {
        bankAccountId: ACCOUNT_ID,
        amountMinor: '10000',
        tenantId: TENANT_ID,
      },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: payoutsUrl,
        headers,
        payload: payload as object,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(payouts.requests.length, 0);
  });

  it('forwards the owner request with the idempotency key and returns the payout', async () => {
    const response = await app.inject({
      method: 'POST',
      url: payoutsUrl,
      headers: { ...auth, 'idempotency-key': 'payout-key-0002' },
      payload: { bankAccountId: ACCOUNT_ID, amountMinor: '10000' },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(payouts.requests.length, 1);
    assert.equal(payouts.requests[0].idempotencyKey, 'payout-key-0002');
    assert.equal(payouts.requests[0].amountMinor, '10000');
    const body = response.json() as {
      data: { status: string; accountNumberMasked: string };
    };
    assert.equal(body.data.status, 'requested');
    assert.equal(body.data.accountNumberMasked, '****7890');
    // F7: a first request is not a replay, and the flag is part of the envelope.
    assert.deepEqual(
      (response.json() as { meta: { replayed: boolean } }).meta,
      { replayed: false },
    );
  });

  it('marks an Idempotency-Key replay in the response envelope (F7)', async () => {
    payouts.replayed = true;
    const response = await app.inject({
      method: 'POST',
      url: payoutsUrl,
      headers: { ...auth, 'idempotency-key': 'payout-key-0004' },
      payload: { bankAccountId: ACCOUNT_ID, amountMinor: '10000' },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as {
      data: { id: string };
      meta: { replayed: boolean };
    };
    assert.equal(body.meta.replayed, true);
    assert.equal(body.data.id, PAYOUT_ID);
    assert.equal(payouts.requests.length, 1);
  });

  it('maps domain conflicts and disabled providers to stable HTTP codes', async () => {
    const headers = { ...auth, 'idempotency-key': 'payout-key-0003' };
    const payload = { bankAccountId: ACCOUNT_ID, amountMinor: '10000' };
    const cases: [unknown, number, string?][] = [
      [
        new ConflictException({
          code: 'PAYOUT_ACTIVE_EXISTS',
          message: 'Another payout is active',
        }),
        409,
        'PAYOUT_ACTIVE_EXISTS',
      ],
      [
        new ConflictException({
          code: 'PAYOUT_AMOUNT_EXCEEDS_AVAILABLE',
          message: 'Too much',
        }),
        409,
        'PAYOUT_AMOUNT_EXCEEDS_AVAILABLE',
      ],
      [
        new ConflictException({
          code: 'PAYOUT_BANK_ACCOUNT_UNVERIFIED',
          message: 'Unverified',
        }),
        409,
        'PAYOUT_BANK_ACCOUNT_UNVERIFIED',
      ],
      [
        new ServiceUnavailableException({
          code: 'PAYOUT_PROVIDER_DISABLED',
          message: 'Disabled',
        }),
        503,
        'PAYOUT_PROVIDER_DISABLED',
      ],
      [new NotFoundException('Bank account was not found'), 404, undefined],
      [new ForbiddenException('Tenant finance access denied'), 403, undefined],
    ];
    for (const [error, status, code] of cases) {
      payouts.failure = error;
      const response = await app.inject({
        method: 'POST',
        url: payoutsUrl,
        headers,
        payload,
      });
      assert.equal(response.statusCode, status);
      if (code)
        assert.equal(
          (response.json() as { error: { code: string } }).error.code,
          code,
        );
    }
  });

  it('lists and reads payouts and cancels a requested one', async () => {
    const list = await app.inject({
      method: 'GET',
      url: payoutsUrl + '?status=requested&limit=5',
      headers: auth,
    });
    assert.equal(list.statusCode, 200);
    const body = list.json() as {
      data: { id: string }[];
      meta: { next_cursor: string | null };
    };
    assert.equal(body.data[0].id, PAYOUT_ID);
    assert.equal(body.meta.next_cursor, null);

    const invalidStatus = await app.inject({
      method: 'GET',
      url: payoutsUrl + '?status=unknown',
      headers: auth,
    });
    assert.equal(invalidStatus.statusCode, 400);

    const detail = await app.inject({
      method: 'GET',
      url: payoutsUrl + '/' + PAYOUT_ID,
      headers: auth,
    });
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(
      Object.keys((detail.json() as { data: object }).data).sort(),
      ['allocations', 'events', 'payout'],
    );

    const cancelled = await app.inject({
      method: 'POST',
      url: payoutsUrl + '/' + PAYOUT_ID + '/cancel',
      headers: auth,
      payload: { reason: 'Changed the destination account' },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(
      (cancelled.json() as { data: { status: string } }).data.status,
      'cancelled',
    );
  });

  it('rejects staff actors with 403 from the domain service', async () => {
    accounts.failure = new ForbiddenException('Tenant finance access denied');
    const list = await app.inject({
      method: 'GET',
      url: accountsUrl,
      headers: auth,
    });
    assert.equal(list.statusCode, 403);
    const create = await app.inject({
      method: 'POST',
      url: accountsUrl,
      headers: auth,
      payload: {
        bankCode: 'BCA',
        accountNumber: '1234567890',
        accountHolderName: 'Owner Name',
      },
    });
    assert.equal(create.statusCode, 403);
  });
});

describe('Campus payout monitoring HTTP contract (F9)', () => {
  const CAMPUS_ID = '55555555-5555-4555-8555-555555555555';
  const url = '/api/v1/campuses/' + CAMPUS_ID + '/payouts';
  let app: NestFastifyApplication;
  let payouts: StubPayoutsService;

  beforeEach(async () => {
    payouts = new StubPayoutsService();
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
      controllers: [CampusPayoutsController],
      providers: [{ provide: PayoutsService, useValue: payouts }],
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

  it('requires a bearer token', async () => {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 401);
    assert.equal(payouts.campusCalls.length, 0);
  });

  it('returns the masked campus payout list with a cursor envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: url + '?status=requested&limit=5',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: {
        payoutId: string;
        accountNumberMasked: string;
        tenantName: string;
      }[];
      meta: { next_cursor: string | null };
    };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].accountNumberMasked, '****7890');
    assert.equal(body.data[0].tenantName, 'Kantin Uji');
    assert.equal(body.meta.next_cursor, null);
    assert.deepEqual(payouts.campusCalls, [
      { campusId: CAMPUS_ID, status: 'requested' },
    ]);
    // No full account number, ciphertext or hash may ever leave this route.
    const serialized = JSON.stringify(body);
    for (const forbidden of ['ciphertext', 'accountNumberHash', '1234567890']) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  });

  it('maps permission failures and invalid filters to stable codes', async () => {
    payouts.failure = new ForbiddenException('Campus permission denied');
    const denied = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(denied.statusCode, 403);

    payouts.failure = undefined;
    const badStatus = await app.inject({
      method: 'GET',
      url: url + '?status=unknown',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(badStatus.statusCode, 400);

    const badCampus = await app.inject({
      method: 'GET',
      url: '/api/v1/campuses/not-a-uuid/payouts',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(badCampus.statusCode, 400);
    assert.equal(
      payouts.campusCalls.length,
      1,
      'invalid input never reaches the service',
    );
  });

  it('exposes no mutating campus payout route', async () => {
    const forbidden: ['POST' | 'DELETE', string][] = [
      ['POST', '/api/v1/campuses/' + CAMPUS_ID + '/payouts'],
      [
        'POST',
        '/api/v1/campuses/' + CAMPUS_ID + '/payouts/' + PAYOUT_ID + '/cancel',
      ],
      ['DELETE', '/api/v1/campuses/' + CAMPUS_ID + '/payouts/' + PAYOUT_ID],
    ];
    for (const [method, target] of forbidden) {
      const response = await app.inject({
        method,
        url: target,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      });
      assert.ok(
        response.statusCode === 404 || response.statusCode === 405,
        method +
          ' ' +
          target +
          ' must not exist (got ' +
          String(response.statusCode) +
          ')',
      );
    }
  });
});
