import 'reflect-metadata';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { XenditPaymentsAdapter } from '../src/modules/payments/xendit.adapter';
import { XenditWebhookController } from '../src/modules/payments/xendit-webhook.controller';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { PermanentPaymentRequestError } from '../src/modules/payments/payments.adapter';
import type { ProviderTopupEvent } from '../src/modules/payments/payments.service';

const SECRET = 'xnd_development_testkey0123456789';
const CALLBACK_TOKEN = 'callback-token-for-tests';

function configOf(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error('missing config ' + key);
      return value;
    },
  } as unknown as ConfigService;
}

/** Replace global fetch for the duration of one test. */
function stubFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
): { calls: { url: string; init: RequestInit }[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('XenditPaymentsAdapter', () => {
  const adapter = new XenditPaymentsAdapter(
    configOf({ XENDIT_SECRET_KEY: SECRET }),
  );
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('builds a stable reference that differs per intent', () => {
    const base = {
      userId: '11111111-1111-4111-8111-111111111111',
      requestHash: 'a'.repeat(64),
    };
    const one = adapter.buildProviderReference({
      ...base,
      idempotencyKey: 'key-1',
    });
    const again = adapter.buildProviderReference({
      ...base,
      idempotencyKey: 'key-1',
    });
    const other = adapter.buildProviderReference({
      ...base,
      idempotencyKey: 'key-2',
    });
    assert.equal(one, again, 'same input must yield the same reference');
    assert.notEqual(one, other);
    assert.match(one, /^antriin-[a-f0-9]{48}$/);
  });

  it('renders no local payload: Xendit issues the QR string', () => {
    assert.equal(adapter.renderQrisPayload(), null);
  });

  it('posts to /qr_codes with basic auth, api-version and the reference', async () => {
    const stub = stubFetch(async () =>
      jsonResponse({
        reference_id: 'antriin-abc',
        qr_string: '00020101021226...',
        status: 'ACTIVE',
      }),
    );
    restore = stub.restore;

    const result = await adapter.createPaymentRequest({
      id: '22222222-2222-4222-8222-222222222222',
      providerReference: 'antriin-abc',
      amountMinor: '50000',
      currency: 'IDR',
    });

    assert.equal(result.providerReference, 'antriin-abc');
    assert.equal(result.qrPayload, '00020101021226...');
    assert.equal(stub.calls.length, 1);
    const { url, init } = stub.calls[0];
    assert.match(url, /\/qr_codes$/);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['api-version'], '2022-07-31');
    assert.equal(
      headers.authorization,
      'Basic ' + Buffer.from(SECRET + ':', 'utf8').toString('base64'),
    );
    assert.equal(headers['idempotency-key'], 'antriin-abc');
    // Xendit expects a number, not a minor-unit string.
    assert.equal(
      JSON.parse(String(init.body)).amount,
      50000,
      'amount must be a JSON number in minor units',
    );
  });

  it('treats 5xx and 429 as transient so the retry budget is not burned', async () => {
    for (const status of [500, 503, 429]) {
      const stub = stubFetch(async () => jsonResponse({}, status));
      restore = stub.restore;
      await assert.rejects(
        () =>
          adapter.createPaymentRequest({
            id: 'x',
            providerReference: 'antriin-abc',
            amountMinor: '1000',
            currency: 'IDR',
          }),
        (error: unknown) => {
          assert.ok(
            !(error instanceof PermanentPaymentRequestError),
            status + ' must stay retryable',
          );
          return true;
        },
      );
      stub.restore();
      restore = null;
    }
  });

  it('treats a rejected request as permanent and keeps the error code', async () => {
    const stub = stubFetch(async () =>
      jsonResponse({ error_code: 'API_VALIDATION_ERROR' }, 400),
    );
    restore = stub.restore;
    await assert.rejects(
      () =>
        adapter.createPaymentRequest({
          id: 'x',
          providerReference: 'antriin-abc',
          amountMinor: '1000',
          currency: 'IDR',
        }),
      (error: unknown) => {
        assert.ok(error instanceof PermanentPaymentRequestError);
        assert.match((error as Error).message, /API_VALIDATION_ERROR/);
        return true;
      },
    );
  });

  it('refuses a response whose reference or QR string does not match', async () => {
    const mismatched = stubFetch(async () =>
      jsonResponse({ reference_id: 'someone-else', qr_string: 'qr' }),
    );
    restore = mismatched.restore;
    await assert.rejects(
      () =>
        adapter.createPaymentRequest({
          id: 'x',
          providerReference: 'antriin-abc',
          amountMinor: '1000',
          currency: 'IDR',
        }),
      PermanentPaymentRequestError,
    );
    mismatched.restore();
    restore = null;

    const missingQr = stubFetch(async () =>
      jsonResponse({ reference_id: 'antriin-abc' }),
    );
    restore = missingQr.restore;
    await assert.rejects(
      () =>
        adapter.createPaymentRequest({
          id: 'x',
          providerReference: 'antriin-abc',
          amountMinor: '1000',
          currency: 'IDR',
        }),
      (error: unknown) => {
        assert.ok(error instanceof PermanentPaymentRequestError);
        assert.match((error as Error).message, /qr_string/);
        return true;
      },
    );
  });

  it('fails permanently when the secret key is missing', async () => {
    const noKey = new XenditPaymentsAdapter(configOf({}));
    await assert.rejects(
      () =>
        noKey.createPaymentRequest({
          id: 'x',
          providerReference: 'antriin-abc',
          amountMinor: '1000',
          currency: 'IDR',
        }),
      (error: unknown) => {
        assert.ok(error instanceof PermanentPaymentRequestError);
        assert.match((error as Error).message, /XENDIT_SECRET_KEY/);
        return true;
      },
    );
  });
});

class StubPaymentsService {
  mode: 'disabled' | 'sandbox' | 'xendit' = 'xendit';
  providerMode(): 'disabled' | 'sandbox' | 'xendit' {
    return this.mode;
  }
  received: { rawBody: Buffer; event: ProviderTopupEvent; provider: string }[] =
    [];
  result: unknown = { kind: 'applied', status: 'succeeded' };

  async handleProviderEvent(
    rawBody: Buffer,
    event: ProviderTopupEvent,
    provider: string,
  ) {
    this.received.push({ rawBody, event, provider });
    return this.result;
  }
}

describe('Xendit webhook HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubPaymentsService;

  before(async () => {
    stub = new StubPaymentsService();
    const module = await Test.createTestingModule({
      controllers: [XenditWebhookController],
      providers: [
        { provide: PaymentsService, useValue: stub },
        { provide: ConfigService, useValue: { get: () => CALLBACK_TOKEN } },
      ],
    }).compile();
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

  after(async () => {
    await app.close();
  });

  const url = '/api/v1/webhooks/payments/xendit';

  function callbackBody(overrides: Record<string, unknown> = {}) {
    return {
      event: 'qr.payment',
      id: 'qrpy_123',
      qr_id: 'qr_abc',
      reference_id: 'antriin-abc',
      amount: 50000,
      currency: 'IDR',
      status: 'SUCCEEDED',
      created: '2026-11-16T03:00:00.000Z',
      ...overrides,
    };
  }

  it('rejects a missing or wrong callback token without touching the service', async () => {
    for (const headers of [{}, { 'x-callback-token': 'wrong-token-value' }]) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: callbackBody(),
      });
      assert.equal(response.statusCode, 401);
    }
    assert.equal(stub.received.length, 0);
  });

  it('accepts a genuine callback and normalises it for the service', async () => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-callback-token': CALLBACK_TOKEN },
      payload: callbackBody({
        // Fields the domain does not model must be tolerated, not rejected.
        basket: null,
        payment_detail: { receipt_id: null, source: null },
        channel_code: 'ID_LINKAJA',
      }),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(stub.received.length, 1);
    const { event, provider } = stub.received[0];
    assert.equal(provider, 'xendit');
    assert.equal(event.reference, 'antriin-abc');
    assert.equal(event.status, 'succeeded');
    assert.equal(event.amountMinor, '50000');
    assert.equal(event.currency, 'IDR');
    assert.equal(event.eventId, 'qrpy_123');
    assert.equal(event.occurredAt, '2026-11-16T03:00:00.000Z');
  });

  it('maps every Xendit status to the domain vocabulary', async () => {
    const cases: [string, string][] = [
      ['SUCCEEDED', 'succeeded'],
      ['EXPIRED', 'expired'],
      ['FAILED', 'failed'],
      ['ACTIVE', 'pending'],
      ['PENDING', 'pending'],
    ];
    for (const [raw, expected] of cases) {
      stub.received.length = 0;
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-callback-token': CALLBACK_TOKEN },
        payload: callbackBody({ status: raw, id: 'qrpy_' + raw }),
      });
      assert.equal(response.statusCode, 200, raw);
      assert.equal(stub.received[0].event.status, expected, raw);
    }
  });

  it('accepts the enveloped { event, data } shape too', async () => {
    stub.received.length = 0;
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-callback-token': CALLBACK_TOKEN },
      payload: {
        event: 'qr.payment',
        data: callbackBody({ id: 'qrpy_enveloped', status: 'SUCCEEDED' }),
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(stub.received[0].event.eventId, 'qrpy_enveloped');
    assert.equal(stub.received[0].event.reference, 'antriin-abc');
  });

  it('rejects a malformed or incomplete callback before any state change', async () => {
    const bodies = [
      { ...callbackBody(), reference_id: undefined },
      { ...callbackBody(), status: 'NOT_A_STATUS' },
      { ...callbackBody(), amount: 'not-a-number' },
      { ...callbackBody(), currency: 'RUPIAH' },
    ];
    for (const payload of bodies) {
      stub.received.length = 0;
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-callback-token': CALLBACK_TOKEN },
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(stub.received.length, 0);
    }
  });

  it('derives a stable event id when Xendit sends no payment id', async () => {
    stub.received.length = 0;
    const payload = { ...callbackBody(), id: undefined };
    await app.inject({
      method: 'POST',
      url,
      headers: { 'x-callback-token': CALLBACK_TOKEN },
      payload,
    });
    assert.equal(stub.received[0].event.eventId, 'qr_abc:succeeded');
  });

  it('refuses callbacks while payments are disabled', async () => {
    stub.mode = 'disabled';
    try {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-callback-token': CALLBACK_TOKEN },
        payload: callbackBody(),
      });
      assert.equal(response.statusCode, 503);
    } finally {
      stub.mode = 'xendit';
    }
  });
});
