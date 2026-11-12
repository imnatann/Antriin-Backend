import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  ExecutionContext,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import type { DatabaseService } from '../src/database/database.service';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import { SandboxPaymentsAdapter } from '../src/modules/payments/payments.adapter';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { PaymentsController } from '../src/modules/payments/payments.controller';
import { PaymentsWebhookController } from '../src/modules/payments/payments-webhook.controller';
import { computeWebhookSignature } from '../src/modules/payments/webhook-signature';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const SECRET = 'a'.repeat(40);

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    PAYMENTS_PROVIDER_MODE: 'sandbox',
    PAYMENTS_TOPUP_MIN_MINOR: 1000,
    PAYMENTS_TOPUP_MAX_MINOR: 2000000,
    PAYMENTS_SANDBOX_WEBHOOK_SECRET: SECRET,
    PAYMENTS_SANDBOX_TOPUP_TTL_SECONDS: 3600,
    ...overrides,
  };
  return {
    getOrThrow: (k: string) => values[k],
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

type WebhookBody = {
  eventId: string;
  reference: string;
  status: string;
  amountMinor: string;
  currency: string;
  occurredAt: string;
};

describe(
  'Payments HTTP contract (webhook signature + buyer scope)',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let db: DatabaseService;
    let payments: PaymentsService;
    let wallet: WalletService;
    let config: ConfigService;
    let webhookApp: NestFastifyApplication;
    let buyerApp: NestFastifyApplication;
    let authenticatedUserId: string;

    const testGuard = {
      canActivate: (context: ExecutionContext): boolean => {
        const req = context.switchToHttp().getRequest<{
          headers: { authorization?: string };
          user?: { userId: string; sessionId: string };
        }>();
        if (req.headers.authorization !== 'Bearer test-token')
          throw new UnauthorizedException();
        req.user = { userId: authenticatedUserId, sessionId: 'test-session' };
        return true;
      },
    };

    async function newUser(): Promise<string> {
      const id = randomUUID();
      const r = await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        ['Payments http test ' + id],
      );
      return r.rows[0].id;
    }

    function signed(body: WebhookBody, timestamp?: string) {
      const rawStr = JSON.stringify(body);
      const rawBody = Buffer.from(rawStr, 'utf8');
      const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
      const sig = computeWebhookSignature(SECRET, ts, rawBody);
      return { rawStr, ts, sig };
    }

    function postWebhook(
      rawStr: string,
      ts: string,
      sig: string,
      provider = 'sandbox',
    ) {
      return webhookApp.inject({
        method: 'POST',
        url: '/v1/webhooks/payments/' + provider,
        headers: {
          'content-type': 'application/json',
          'x-antriin-signature': sig,
          'x-antriin-timestamp': ts,
        },
        payload: rawStr,
      });
    }

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 12 });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      wallet = new WalletService(db);
      const audit = new AuditService(db, new AccessService(db));
      const outbox = new OutboxService(db);
      config = makeConfig();
      const adapter = new SandboxPaymentsAdapter(config);
      payments = new PaymentsService(
        db,
        wallet,
        audit,
        outbox,
        config,
        adapter,
      );

      const whModule = await Test.createTestingModule({
        controllers: [PaymentsWebhookController],
        providers: [
          { provide: PaymentsService, useValue: payments },
          { provide: ConfigService, useValue: config },
        ],
      }).compile();
      webhookApp = whModule.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
        { rawBody: true },
      );
      webhookApp.setGlobalPrefix('v1');
      webhookApp.useGlobalFilters(new ApiExceptionFilter());
      webhookApp.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await webhookApp.init();
      await webhookApp.getHttpAdapter().getInstance().ready();

      const buyerModule = await Test.createTestingModule({
        controllers: [PaymentsController],
        providers: [{ provide: PaymentsService, useValue: payments }],
      })
        .overrideGuard(AuthGuard)
        .useValue(testGuard)
        .compile();
      buyerApp = buyerModule.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
      );
      buyerApp.setGlobalPrefix('v1');
      buyerApp.useGlobalFilters(new ApiExceptionFilter());
      buyerApp.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await buyerApp.init();
      await buyerApp.getHttpAdapter().getInstance().ready();
    });

    after(async () => {
      await webhookApp?.close();
      await buyerApp?.close();
      await pool?.end();
    });

    // ---------- webhook signature ----------

    it('accepts a correctly signed success webhook and credits the wallet', async () => {
      const userId = await newUser();
      const intent = await payments.createTopupIntent(userId, {
        amountMinor: '50000',
        idempotencyKey: randomUUID(),
      });
      const body: WebhookBody = {
        eventId: randomUUID(),
        reference: intent.view.providerReference,
        status: 'succeeded',
        amountMinor: '50000',
        currency: 'IDR',
        occurredAt: new Date().toISOString(),
      };
      const { rawStr, ts, sig } = signed(body);
      const res = await postWebhook(rawStr, ts, sig);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.outcome, 'applied');
      const bal = await wallet.getBalance(userId, 'IDR');
      assert.equal(bal[0].balanceMinor, '50000');
    });

    it('rejects a wrong signature with 401 and does not credit or record the event', async () => {
      const userId = await newUser();
      const intent = await payments.createTopupIntent(userId, {
        amountMinor: '50000',
        idempotencyKey: randomUUID(),
      });
      const eventId = randomUUID();
      const body: WebhookBody = {
        eventId,
        reference: intent.view.providerReference,
        status: 'succeeded',
        amountMinor: '50000',
        currency: 'IDR',
        occurredAt: new Date().toISOString(),
      };
      const { rawStr, ts } = signed(body);
      const res = await postWebhook(rawStr, ts, 'f'.repeat(64));
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'WEBHOOK_SIGNATURE_INVALID');
      const bal = await wallet.getBalance(userId, 'IDR');
      assert.equal(bal[0].balanceMinor, '0');
      const ev = await pool.query(
        'select count(*)::int as n from payment_provider_events where event_id=$1',
        [eventId],
      );
      assert.equal(ev.rows[0].n, 0);
    });

    it('rejects a stale timestamp beyond the 300s window', async () => {
      const userId = await newUser();
      const intent = await payments.createTopupIntent(userId, {
        amountMinor: '50000',
        idempotencyKey: randomUUID(),
      });
      const body: WebhookBody = {
        eventId: randomUUID(),
        reference: intent.view.providerReference,
        status: 'succeeded',
        amountMinor: '50000',
        currency: 'IDR',
        occurredAt: new Date().toISOString(),
      };
      const staleTs = String(Math.floor(Date.now() / 1000) - 400);
      const { rawStr, sig } = signed(body, staleTs);
      const res = await postWebhook(rawStr, staleTs, sig);
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'WEBHOOK_TIMESTAMP_SKEW');
      const bal = await wallet.getBalance(userId, 'IDR');
      assert.equal(bal[0].balanceMinor, '0');
    });

    it('rejects missing signature headers', async () => {
      const res = await webhookApp.inject({
        method: 'POST',
        url: '/v1/webhooks/payments/sandbox',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          eventId: randomUUID(),
          reference: 'sbx-x',
          status: 'succeeded',
          amountMinor: '50000',
          currency: 'IDR',
          occurredAt: new Date().toISOString(),
        }),
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'WEBHOOK_CREDENTIALS_MISSING');
    });

    it('rejects an unsupported provider path', async () => {
      const body: WebhookBody = {
        eventId: randomUUID(),
        reference: 'sbx-x',
        status: 'succeeded',
        amountMinor: '50000',
        currency: 'IDR',
        occurredAt: new Date().toISOString(),
      };
      const { rawStr, ts, sig } = signed(body);
      const res = await postWebhook(rawStr, ts, sig, 'midtrans');
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error.code, 'WEBHOOK_PROVIDER_UNSUPPORTED');
    });

    // ---------- buyer scope ----------

    it('requires authentication to create a top-up intent', async () => {
      const res = await buyerApp.inject({
        method: 'POST',
        url: '/v1/me/wallet/topups',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          amountMinor: '50000',
          idempotencyKey: randomUUID(),
        }),
      });
      assert.equal(res.statusCode, 401);
    });

    it('creates an intent for the authenticated buyer and rejects injected fields', async () => {
      authenticatedUserId = await newUser();
      const key = randomUUID();
      const ok = await buyerApp.inject({
        method: 'POST',
        url: '/v1/me/wallet/topups',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ amountMinor: '50000', idempotencyKey: key }),
      });
      assert.equal(ok.statusCode, 201);
      assert.equal(ok.json().data.status, 'pending');
      assert.equal(ok.json().data.amountMinor, '50000');
      assert.equal(ok.json().data.replayed, false);
      // a client cannot inject another user id / status (forbidNonWhitelisted)
      const injected = await buyerApp.inject({
        method: 'POST',
        url: '/v1/me/wallet/topups',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          amountMinor: '50000',
          idempotencyKey: randomUUID(),
          userId: randomUUID(),
          status: 'succeeded',
        }),
      });
      assert.equal(injected.statusCode, 400);
    });

    it('lists only the caller intents and hides other users via 404', async () => {
      const userA = await newUser();
      const userB = await newUser();
      const intentA = await payments.createTopupIntent(userA, {
        amountMinor: '20000',
        idempotencyKey: randomUUID(),
      });
      const intentB = await payments.createTopupIntent(userB, {
        amountMinor: '30000',
        idempotencyKey: randomUUID(),
      });
      authenticatedUserId = userA;
      const list = await buyerApp.inject({
        method: 'GET',
        url: '/v1/me/wallet/topups',
        headers: { authorization: 'Bearer test-token' },
      });
      assert.equal(list.statusCode, 200);
      const ids = list.json().data.map((x: { id: string }) => x.id);
      assert.ok(ids.includes(intentA.view.id));
      assert.ok(
        !ids.includes(intentB.view.id),
        'must not leak other user intents',
      );
      // detail of another user's intent is indistinguishable from missing
      const crossDetail = await buyerApp.inject({
        method: 'GET',
        url: '/v1/me/wallet/topups/' + intentB.view.id,
        headers: { authorization: 'Bearer test-token' },
      });
      assert.equal(crossDetail.statusCode, 404);
    });

    it('exposes no client route to credit a balance directly', async () => {
      authenticatedUserId = await newUser();
      const intent = await payments.createTopupIntent(authenticatedUserId, {
        amountMinor: '20000',
        idempotencyKey: randomUUID(),
      });
      const credit = await buyerApp.inject({
        method: 'POST',
        url: '/v1/me/wallet/topups/' + intent.view.id + '/credit',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ amountMinor: '999999' }),
      });
      assert.equal(credit.statusCode, 404);
      const bal = await wallet.getBalance(authenticatedUserId, 'IDR');
      assert.equal(bal[0].balanceMinor, '0');
    });
  },
);
