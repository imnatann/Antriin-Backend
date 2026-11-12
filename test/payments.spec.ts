import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import {
  SandboxPaymentsAdapter,
  PermanentPaymentRequestError,
  type TopupProviderAdapter,
} from '../src/modules/payments/payments.adapter';
import {
  PaymentsService,
  SANDBOX_TOPUP_CLEARING_ACCOUNT,
  SANDBOX_TOPUP_TTL_SECONDS,
} from '../src/modules/payments/payments.service';
import type { SandboxWebhookEventDto } from '../src/modules/payments/dto/sandbox-webhook.dto';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const SECRET = 'a'.repeat(40);

function errCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response: unknown }).response === 'object' &&
    (error as { response: { code?: unknown } }).response?.code === code
  );
}

function pgCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    PAYMENTS_PROVIDER_MODE: 'sandbox',
    PAYMENTS_TOPUP_MIN_MINOR: 1000,
    PAYMENTS_TOPUP_MAX_MINOR: 2000000,
    PAYMENTS_SANDBOX_WEBHOOK_SECRET: SECRET,
    PAYMENTS_SANDBOX_TOPUP_TTL_SECONDS: SANDBOX_TOPUP_TTL_SECONDS,
    ...overrides,
  };
  return {
    getOrThrow: (k: string) => {
      if (!(k in values)) throw new Error('missing config ' + k);
      return values[k];
    },
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

function buildPayments(
  db: DatabaseService,
  overrides: Record<string, unknown> = {},
) {
  const wallet = new WalletService(db);
  const audit = new AuditService(db, new AccessService(db));
  const outbox = new OutboxService(db);
  const config = makeConfig(overrides);
  const adapter = new SandboxPaymentsAdapter(config);
  const payments = new PaymentsService(
    db,
    wallet,
    audit,
    outbox,
    config,
    adapter,
  );
  return { payments, wallet, audit, outbox, config, adapter };
}

describe(
  'Payments slice PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let db: DatabaseService;
    let ctx: ReturnType<typeof buildPayments>;

    async function newUser(): Promise<string> {
      const id = randomUUID();
      const r = await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        ['Payments test ' + id],
      );
      return r.rows[0].id;
    }

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 12 });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      ctx = buildPayments(db);
    });

    after(async () => {
      await pool?.end();
    });

    // ---------- intent creation ----------

    it('creates intent + provider outbox atomically and snapshots the buyer wallet', async () => {
      const userId = await newUser();
      const key = randomUUID();
      const res = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '50000',
        idempotencyKey: key,
      });
      assert.equal(res.view.status, 'pending');
      assert.equal(res.view.currency, 'IDR');
      assert.equal(res.view.amountMinor, '50000');
      assert.equal(res.replayed, false);
      assert.ok(res.view.expiresAt, 'expires_at must be set at creation');
      assert.equal(res.view.succeededAt, null);
      assert.ok(
        (res.view.qrisPayload ?? '').startsWith('ANTRIIN-QRIS-SANDBOX'),
        'sandbox QRIS payload derived',
      );
      // wallet snapshot equals the buyer's own wallet account
      const acct = await pool.query<{ id: string }>(
        "select id from wallet_accounts where account_type='wallet' and owner_user_id=$1 and currency='IDR'",
        [userId],
      );
      assert.equal(res.walletAccountId, acct.rows[0].id);
      const intentRow = await pool.query<{ id: string }>(
        'select id from topup_intents where id=$1',
        [res.view.id],
      );
      assert.equal(intentRow.rowCount, 1);
      const outboxRow = await pool.query<{ status: string; provider: string }>(
        'select status, provider from payment_request_outbox where topup_id=$1',
        [res.view.id],
      );
      assert.equal(outboxRow.rowCount, 1);
      assert.equal(outboxRow.rows[0].status, 'pending');
      assert.equal(outboxRow.rows[0].provider, 'sandbox');
      const auditRow = await pool.query(
        "select 1 from audit_events where target_type='topup_intent' and target_id=$1 and action='topup.created'",
        [res.view.id],
      );
      assert.equal(auditRow.rowCount, 1);
    });

    it('rolls back BOTH intent and outbox when a step inside the transaction fails', async () => {
      const userId = await newUser();
      const key = randomUUID();
      const wallet = new WalletService(db);
      const failingAudit = {
        append: async () => {
          throw new Error('injected failure');
        },
      } as unknown as AuditService;
      const outbox = new OutboxService(db);
      const config = makeConfig();
      const adapter = new SandboxPaymentsAdapter(config);
      const broken = new PaymentsService(
        db,
        wallet,
        failingAudit,
        outbox,
        config,
        adapter,
      );
      await assert.rejects(
        broken.createTopupIntent(userId, {
          amountMinor: '20000',
          idempotencyKey: key,
        }),
        /injected failure/,
      );
      const intents = await pool.query(
        'select id from topup_intents where user_id=$1 and idempotency_key=$2',
        [userId, key],
      );
      assert.equal(intents.rowCount, 0, 'intent must roll back');
      const outboxRows = await pool.query(
        'select o.id from payment_request_outbox o join topup_intents t on t.id=o.topup_id where t.user_id=$1',
        [userId],
      );
      assert.equal(outboxRows.rowCount, 0, 'outbox must roll back with intent');
    });

    it('replays the same idempotency key without creating a new intent', async () => {
      const userId = await newUser();
      const key = randomUUID();
      const first = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '30000',
        idempotencyKey: key,
      });
      const second = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '30000',
        idempotencyKey: key,
      });
      assert.equal(second.replayed, true);
      assert.equal(second.view.id, first.view.id);
      const count = await pool.query(
        'select count(*)::int as n from topup_intents where user_id=$1 and idempotency_key=$2',
        [userId, key],
      );
      assert.equal(count.rows[0].n, 1);
      const outboxCount = await pool.query(
        'select count(*)::int as n from payment_request_outbox where topup_id=$1',
        [first.view.id],
      );
      assert.equal(outboxCount.rows[0].n, 1);
    });

    it('rejects a reused idempotency key with a different amount', async () => {
      const userId = await newUser();
      const key = randomUUID();
      await ctx.payments.createTopupIntent(userId, {
        amountMinor: '30000',
        idempotencyKey: key,
      });
      await assert.rejects(
        ctx.payments.createTopupIntent(userId, {
          amountMinor: '31000',
          idempotencyKey: key,
        }),
        (e: unknown) => errCode(e, 'TOPUP_IDEMPOTENCY_KEY_REUSED'),
      );
    });

    it('rejects amounts outside bounds and non-integer IDR', async () => {
      const userId = await newUser();
      const below = () =>
        ctx.payments.createTopupIntent(userId, {
          amountMinor: '999',
          idempotencyKey: randomUUID(),
        });
      const above = () =>
        ctx.payments.createTopupIntent(userId, {
          amountMinor: '2000001',
          idempotencyKey: randomUUID(),
        });
      const frac = () =>
        ctx.payments.createTopupIntent(userId, {
          amountMinor: '50.5',
          idempotencyKey: randomUUID(),
        });
      const alpha = () =>
        ctx.payments.createTopupIntent(userId, {
          amountMinor: 'abc',
          idempotencyKey: randomUUID(),
        });
      await assert.rejects(below, (e: unknown) =>
        errCode(e, 'TOPUP_AMOUNT_OUT_OF_BOUNDS'),
      );
      await assert.rejects(above, (e: unknown) =>
        errCode(e, 'TOPUP_AMOUNT_OUT_OF_BOUNDS'),
      );
      await assert.rejects(frac, (e: unknown) =>
        errCode(e, 'TOPUP_AMOUNT_INVALID'),
      );
      await assert.rejects(alpha, (e: unknown) =>
        errCode(e, 'TOPUP_AMOUNT_INVALID'),
      );
      // bounds inclusive
      const min = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '1000',
        idempotencyKey: randomUUID(),
      });
      const max = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '2000000',
        idempotencyKey: randomUUID(),
      });
      assert.equal(min.view.amountMinor, '1000');
      assert.equal(max.view.amountMinor, '2000000');
    });

    it('disabled mode refuses creation with a clear contract and writes nothing', async () => {
      const disabled = buildPayments(db, {
        PAYMENTS_PROVIDER_MODE: 'disabled',
      });
      const userId = await newUser();
      const key = randomUUID();
      await assert.rejects(
        disabled.payments.createTopupIntent(userId, {
          amountMinor: '50000',
          idempotencyKey: key,
        }),
        (e: unknown) => errCode(e, 'PAYMENTS_PROVIDER_DISABLED'),
      );
      const rows = await pool.query(
        'select id from topup_intents where user_id=$1',
        [userId],
      );
      assert.equal(rows.rowCount, 0);
    });

    it('production never enables sandbox even if mode says sandbox', async () => {
      const prod = buildPayments(db, {
        NODE_ENV: 'production',
        PAYMENTS_PROVIDER_MODE: 'sandbox',
      });
      assert.equal(prod.payments.providerMode(), 'disabled');
      const userId = await newUser();
      await assert.rejects(
        prod.payments.createTopupIntent(userId, {
          amountMinor: '50000',
          idempotencyKey: randomUUID(),
        }),
        (e: unknown) => errCode(e, 'PAYMENTS_PROVIDER_DISABLED'),
      );
    });

    it('applies the configured sandbox TTL to expires_at (config-driven)', async () => {
      const custom = buildPayments(db, {
        PAYMENTS_SANDBOX_TOPUP_TTL_SECONDS: 120,
      });
      const userId = await newUser();
      const res = await custom.payments.createTopupIntent(userId, {
        amountMinor: '10000',
        idempotencyKey: randomUUID(),
      });
      const row = await pool.query<{ created_at: Date; expires_at: Date }>(
        'select created_at, expires_at from topup_intents where id=$1',
        [res.view.id],
      );
      const diffSeconds =
        (row.rows[0].expires_at.getTime() - row.rows[0].created_at.getTime()) /
        1000;
      assert.equal(
        diffSeconds,
        120,
        'expires_at must equal created_at + configured TTL',
      );
    });

    it('rejects a cross-user wallet snapshot at the database (composite FK)', async () => {
      const userA = await newUser();
      const userB = await newUser();
      const walletB = await ctx.wallet.getOrCreateWallet(userB, 'IDR');
      await assert.rejects(
        pool.query(
          `insert into topup_intents
             (user_id, wallet_account_id, provider, provider_reference, idempotency_key,
              request_hash, amount_minor, currency, status, status_version, created_at, updated_at, expires_at)
           values ($1,$2,'sandbox',$3,$4,$5,$6,'IDR','pending',1,now(),now(),now()+interval '1 hour')`,
          [
            userA,
            walletB.accountId,
            'sbx-' + randomUUID().replace(/-/g, '') + '0000000000',
            randomUUID(),
            'f'.repeat(64),
            '50000',
          ],
        ),
        (e: unknown) => pgCode(e, '23503'),
        'composite FK (user_id, wallet_account_id) must reject another user wallet',
      );
    });

    // ---------- request processor ----------

    it('processor leases, calls adapter outside lock, and completes the row idempotently', async () => {
      const userId = await newUser();
      const res = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '15000',
        idempotencyKey: randomUUID(),
      });
      const topupId = res.view.id;
      const first = await ctx.payments.processPaymentRequest(topupId);
      assert.equal(first.outcome, 'completed');
      const row = await pool.query<{
        status: string;
        lease_token: string | null;
        attempts: number;
      }>(
        'select status, lease_token, attempts from payment_request_outbox where topup_id=$1',
        [topupId],
      );
      assert.equal(row.rows[0].status, 'complete');
      assert.equal(row.rows[0].lease_token, null);
      assert.equal(row.rows[0].attempts, 1);
      const second = await ctx.payments.processPaymentRequest(topupId);
      assert.equal(second.outcome, 'skipped');
      const attemptsAfter = await pool.query<{ attempts: number }>(
        'select attempts from payment_request_outbox where topup_id=$1',
        [topupId],
      );
      assert.equal(
        attemptsAfter.rows[0].attempts,
        1,
        'completed row is not reprocessed',
      );
    });

    it('processor marks dead on a permanent provider error without duplicating effects', async () => {
      const userId = await newUser();
      const res = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '15000',
        idempotencyKey: randomUUID(),
      });
      const permAdapter: TopupProviderAdapter = {
        provider: 'sandbox',
        buildProviderReference: (i) => ctx.adapter.buildProviderReference(i),
        renderQrisPayload: (i) => ctx.adapter.renderQrisPayload(i),
        createPaymentRequest: async () => {
          throw new PermanentPaymentRequestError('PROVIDER_REJECTED', 'no');
        },
      };
      const config = makeConfig();
      const svc = new PaymentsService(
        db,
        ctx.wallet,
        ctx.audit,
        ctx.outbox,
        config,
        permAdapter,
      );
      const out = await svc.processPaymentRequest(res.view.id);
      assert.equal(out.outcome, 'dead');
      const row = await pool.query<{ status: string; last_error_code: string }>(
        'select status, last_error_code from payment_request_outbox where topup_id=$1',
        [res.view.id],
      );
      assert.equal(row.rows[0].status, 'dead');
      assert.equal(row.rows[0].last_error_code, 'PROVIDER_REJECTED');
      // intent untouched, no credit
      const bal = await ctx.wallet.getBalance(userId, 'IDR');
      assert.equal(bal[0].balanceMinor, '0');
    });

    it('processor defers with backoff on a transient error', async () => {
      const userId = await newUser();
      const res = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '15000',
        idempotencyKey: randomUUID(),
      });
      const flaky: TopupProviderAdapter = {
        provider: 'sandbox',
        buildProviderReference: (i) => ctx.adapter.buildProviderReference(i),
        renderQrisPayload: (i) => ctx.adapter.renderQrisPayload(i),
        createPaymentRequest: async () => {
          throw new Error('network blip');
        },
      };
      const svc = new PaymentsService(
        db,
        ctx.wallet,
        ctx.audit,
        ctx.outbox,
        makeConfig(),
        flaky,
      );
      const out = await svc.processPaymentRequest(res.view.id);
      assert.equal(out.outcome, 'deferred');
      const row = await pool.query<{
        status: string;
        last_error_code: string;
        available_at: Date;
        attempts: number;
      }>(
        'select status, last_error_code, available_at, attempts from payment_request_outbox where topup_id=$1',
        [res.view.id],
      );
      assert.equal(row.rows[0].status, 'pending');
      assert.equal(row.rows[0].last_error_code, 'PROVIDER_REQUEST_FAILED');
      assert.equal(row.rows[0].attempts, 1);
      assert.ok(
        row.rows[0].available_at.getTime() > Date.now(),
        'backoff pushes availability into the future',
      );
    });

    it('processor goes dead at the attempt cap', async () => {
      const userId = await newUser();
      const res = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '15000',
        idempotencyKey: randomUUID(),
      });
      // simulate 4 prior attempts already recorded and now due
      await pool.query(
        'update payment_request_outbox set attempts=4, available_at=now() where topup_id=$1',
        [res.view.id],
      );
      const flaky: TopupProviderAdapter = {
        provider: 'sandbox',
        buildProviderReference: (i) => ctx.adapter.buildProviderReference(i),
        renderQrisPayload: (i) => ctx.adapter.renderQrisPayload(i),
        createPaymentRequest: async () => {
          throw new Error('still down');
        },
      };
      const svc = new PaymentsService(
        db,
        ctx.wallet,
        ctx.audit,
        ctx.outbox,
        makeConfig(),
        flaky,
      );
      const out = await svc.processPaymentRequest(res.view.id);
      assert.equal(out.outcome, 'dead', 'attempts reaches cap of 5');
      const row = await pool.query<{ status: string }>(
        'select status from payment_request_outbox where topup_id=$1',
        [res.view.id],
      );
      assert.equal(row.rows[0].status, 'dead');
    });

    it('processor skips a row leased by another worker (lease fencing)', async () => {
      const userId = await newUser();
      const res = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '15000',
        idempotencyKey: randomUUID(),
      });
      await pool.query(
        "update payment_request_outbox set status='processing', lease_token=$2, lease_until=now()+interval '60 seconds', attempts=attempts+1 where topup_id=$1",
        [res.view.id, randomUUID()],
      );
      const out = await ctx.payments.processPaymentRequest(res.view.id);
      assert.equal(out.outcome, 'skipped');
      if (out.outcome === 'skipped') assert.equal(out.reason, 'leased');
    });
  },
);

// ---------- webhook provider-event handling (service level) ----------

type WebhookBody = {
  eventId: string;
  reference: string;
  status: 'pending' | 'succeeded' | 'failed' | 'expired';
  amountMinor: string;
  currency: string;
  occurredAt: string;
};

describe(
  'Payments webhook provider-event PostgreSQL integration',
  { skip: !process.env.TEST_DATABASE_URL },
  () => {
    let pool: Pool;
    let db: DatabaseService;
    let ctx: ReturnType<typeof buildPayments>;

    async function newUser(): Promise<string> {
      const id = randomUUID();
      const r = await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        ['Payments webhook test ' + id],
      );
      return r.rows[0].id;
    }

    function event(overrides: Partial<WebhookBody> & { reference: string }): {
      rawBody: Buffer;
      body: WebhookBody;
    } {
      const body: WebhookBody = {
        eventId: randomUUID(),
        status: 'succeeded',
        amountMinor: '50000',
        currency: 'IDR',
        occurredAt: new Date().toISOString(),
        ...overrides,
      };
      return { rawBody: Buffer.from(JSON.stringify(body), 'utf8'), body };
    }

    async function balanceOf(userId: string): Promise<string> {
      const b = await ctx.wallet.getBalance(userId, 'IDR');
      return b[0].balanceMinor;
    }

    before(async () => {
      pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 12,
      });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      ctx = buildPayments(db);
    });
    after(async () => {
      await pool?.end();
    });

    it('credits the wallet exactly once for a valid success event and writes audit + outbox', async () => {
      const userId = await newUser();
      const intent = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '50000',
        idempotencyKey: randomUUID(),
      });
      const topupId = intent.view.id;
      const { rawBody, body } = event({
        reference: intent.view.providerReference,
        amountMinor: '50000',
      });
      const result = await ctx.payments.handleProviderEvent(
        rawBody,
        body as unknown as SandboxWebhookEventDto,
      );
      assert.equal(result.kind, 'applied');
      assert.equal(await balanceOf(userId), '50000');
      const t = await pool.query<{
        status: string;
        succeeded_at: Date | null;
        status_version: number;
      }>(
        'select status, succeeded_at, status_version from topup_intents where id=$1',
        [topupId],
      );
      assert.equal(t.rows[0].status, 'succeeded');
      assert.ok(t.rows[0].succeeded_at, 'succeeded_at set on success');
      assert.equal(t.rows[0].status_version, 2);
      // balanced double-entry ledger for this intent reference
      const entries = await pool.query<{
        direction: string;
        amount_minor: string;
      }>(
        "select e.direction, e.amount_minor::text from ledger_entries e join ledger_transactions tx on tx.id=e.transaction_id where tx.reference_namespace='topup_intent' and tx.reference_id=$1",
        [topupId],
      );
      assert.equal(entries.rowCount, 2);
      const dirs = entries.rows.map((r) => r.direction).sort();
      assert.deepEqual(dirs, ['credit', 'debit']);
      assert.ok(entries.rows.every((r) => r.amount_minor === '50000'));
      // clearing system account funded the credit
      const clearing = await pool.query(
        "select id from wallet_accounts where account_type='system' and system_key=$1 and currency='IDR'",
        [SANDBOX_TOPUP_CLEARING_ACCOUNT],
      );
      assert.equal(clearing.rowCount, 1);
      const auditRow = await pool.query(
        "select 1 from audit_events where target_type='topup_intent' and target_id=$1 and action='topup.succeeded'",
        [topupId],
      );
      assert.equal(auditRow.rowCount, 1);
      const outboxRow = await pool.query(
        "select 1 from outbox_events where aggregate_type='topup_intent' and aggregate_id=$1 and event_type='topup.status_changed'",
        [topupId],
      );
      assert.equal(outboxRow.rowCount, 1);
      const evt = await pool.query<{ outcome: string; topup_id: string }>(
        "select outcome, topup_id::text from payment_provider_events where provider='sandbox' and event_id=$1",
        [body.eventId],
      );
      assert.equal(evt.rows[0].outcome, 'applied');
      assert.equal(evt.rows[0].topup_id, topupId);
    });

    it('deduplicates a repeated success event: credit happens once', async () => {
      const userId = await newUser();
      const intent = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '50000',
        idempotencyKey: randomUUID(),
      });
      const { rawBody, body } = event({
        reference: intent.view.providerReference,
        amountMinor: '50000',
      });
      const first = await ctx.payments.handleProviderEvent(
        rawBody,
        body as unknown as SandboxWebhookEventDto,
      );
      assert.equal(first.kind, 'applied');
      const second = await ctx.payments.handleProviderEvent(
        rawBody,
        body as unknown as SandboxWebhookEventDto,
      );
      assert.equal(second.kind, 'duplicate');
      assert.equal(await balanceOf(userId), '50000', 'no second credit');
      const evCount = await pool.query(
        "select count(*)::int as n from payment_provider_events where provider='sandbox' and event_id=$1",
        [body.eventId],
      );
      assert.equal(evCount.rows[0].n, 1);
      const creditCount = await pool.query(
        "select count(*)::int as n from ledger_entries e join ledger_transactions tx on tx.id=e.transaction_id where tx.reference_namespace='topup_intent' and tx.reference_id=$1 and e.direction='credit'",
        [intent.view.id],
      );
      assert.equal(creditCount.rows[0].n, 1);
    });

    it('rejects an amount mismatch without credit', async () => {
      const userId = await newUser();
      const intent = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '50000',
        idempotencyKey: randomUUID(),
      });
      const { rawBody, body } = event({
        reference: intent.view.providerReference,
        amountMinor: '40000',
      });
      const result = await ctx.payments.handleProviderEvent(
        rawBody,
        body as unknown as SandboxWebhookEventDto,
      );
      assert.equal(result.kind, 'mismatch');
      assert.equal(await balanceOf(userId), '0');
      const t = await pool.query<{ status: string }>(
        'select status from topup_intents where id=$1',
        [intent.view.id],
      );
      assert.equal(t.rows[0].status, 'pending');
      const evt = await pool.query<{ outcome: string }>(
        "select outcome from payment_provider_events where provider='sandbox' and event_id=$1",
        [body.eventId],
      );
      assert.equal(evt.rows[0].outcome, 'mismatch');
    });

    it('rejects a currency mismatch without credit', async () => {
      const userId = await newUser();
      const intent = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '50000',
        idempotencyKey: randomUUID(),
      });
      const { rawBody, body } = event({
        reference: intent.view.providerReference,
        amountMinor: '50000',
        currency: 'USD',
      });
      const result = await ctx.payments.handleProviderEvent(
        rawBody,
        body as unknown as SandboxWebhookEventDto,
      );
      assert.equal(result.kind, 'mismatch');
      assert.equal(await balanceOf(userId), '0');
    });

    it('rejects an unmatched reference without credit', async () => {
      const userId = await newUser();
      const { rawBody, body } = event({
        reference: 'sbx-' + '0'.repeat(48),
        amountMinor: '50000',
      });
      const result = await ctx.payments.handleProviderEvent(
        rawBody,
        body as unknown as SandboxWebhookEventDto,
      );
      assert.equal(result.kind, 'unmatched');
      assert.equal(await balanceOf(userId), '0');
      const evt = await pool.query<{
        outcome: string;
        topup_id: string | null;
      }>(
        "select outcome, topup_id from payment_provider_events where provider='sandbox' and event_id=$1",
        [body.eventId],
      );
      assert.equal(evt.rows[0].outcome, 'unmatched');
      assert.equal(evt.rows[0].topup_id, null);
    });

    it('credits a late success (old occurredAt) exactly once', async () => {
      const userId = await newUser();
      const intent = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '25000',
        idempotencyKey: randomUUID(),
      });
      const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
      const { rawBody, body } = event({
        reference: intent.view.providerReference,
        amountMinor: '25000',
        occurredAt: old,
      });
      const result = await ctx.payments.handleProviderEvent(
        rawBody,
        body as unknown as SandboxWebhookEventDto,
      );
      assert.equal(result.kind, 'applied');
      assert.equal(await balanceOf(userId), '25000');
      const evt = await pool.query<{ occurred_at: Date }>(
        "select occurred_at from payment_provider_events where provider='sandbox' and event_id=$1",
        [body.eventId],
      );
      assert.ok(
        evt.rows[0].occurred_at.getTime() < Date.now() - 9 * 24 * 3600 * 1000,
      );
    });

    it('moves a failed event to failed without credit and with null succeeded_at', async () => {
      const userId = await newUser();
      const intent = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '50000',
        idempotencyKey: randomUUID(),
      });
      const { rawBody, body } = event({
        reference: intent.view.providerReference,
        amountMinor: '50000',
        status: 'failed',
      });
      const result = await ctx.payments.handleProviderEvent(
        rawBody,
        body as unknown as SandboxWebhookEventDto,
      );
      assert.equal(result.kind, 'applied');
      assert.equal(await balanceOf(userId), '0');
      const t = await pool.query<{ status: string; succeeded_at: Date | null }>(
        'select status, succeeded_at from topup_intents where id=$1',
        [intent.view.id],
      );
      assert.equal(t.rows[0].status, 'failed');
      assert.equal(t.rows[0].succeeded_at, null);
    });

    it('ignores a pending status event without changing state', async () => {
      const userId = await newUser();
      const intent = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '50000',
        idempotencyKey: randomUUID(),
      });
      const { rawBody, body } = event({
        reference: intent.view.providerReference,
        amountMinor: '50000',
        status: 'pending',
      });
      const result = await ctx.payments.handleProviderEvent(
        rawBody,
        body as unknown as SandboxWebhookEventDto,
      );
      assert.equal(result.kind, 'ignored');
      assert.equal(await balanceOf(userId), '0');
      const t = await pool.query<{ status: string; status_version: number }>(
        'select status, status_version from topup_intents where id=$1',
        [intent.view.id],
      );
      assert.equal(t.rows[0].status, 'pending');
      assert.equal(t.rows[0].status_version, 1);
    });

    it('credits exactly once under two parallel success webhooks with different event ids', async () => {
      const userId = await newUser();
      const intent = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '60000',
        idempotencyKey: randomUUID(),
      });
      const a = event({
        reference: intent.view.providerReference,
        amountMinor: '60000',
      });
      const b = event({
        reference: intent.view.providerReference,
        amountMinor: '60000',
      });
      const results = await Promise.all([
        ctx.payments.handleProviderEvent(
          a.rawBody,
          a.body as unknown as SandboxWebhookEventDto,
        ),
        ctx.payments.handleProviderEvent(
          b.rawBody,
          b.body as unknown as SandboxWebhookEventDto,
        ),
      ]);
      const kinds = results.map((r) => r.kind).sort();
      assert.deepEqual(kinds, ['applied', 'duplicate']);
      assert.equal(
        await balanceOf(userId),
        '60000',
        'exactly one credit under concurrency',
      );
      const creditCount = await pool.query(
        "select count(*)::int as n from ledger_entries e join ledger_transactions tx on tx.id=e.transaction_id where tx.reference_namespace='topup_intent' and tx.reference_id=$1 and e.direction='credit'",
        [intent.view.id],
      );
      assert.equal(creditCount.rows[0].n, 1);
    });

    it('credits exactly once under two parallel identical webhooks (same event id)', async () => {
      const userId = await newUser();
      const intent = await ctx.payments.createTopupIntent(userId, {
        amountMinor: '70000',
        idempotencyKey: randomUUID(),
      });
      const e = event({
        reference: intent.view.providerReference,
        amountMinor: '70000',
      });
      const results = await Promise.all([
        ctx.payments.handleProviderEvent(
          e.rawBody,
          e.body as unknown as SandboxWebhookEventDto,
        ),
        ctx.payments.handleProviderEvent(
          e.rawBody,
          e.body as unknown as SandboxWebhookEventDto,
        ),
      ]);
      const applied = results.filter((r) => r.kind === 'applied').length;
      assert.equal(applied, 1);
      assert.equal(await balanceOf(userId), '70000');
      const evCount = await pool.query(
        "select count(*)::int as n from payment_provider_events where provider='sandbox' and event_id=$1",
        [e.body.eventId],
      );
      assert.equal(evCount.rows[0].n, 1);
    });
  },
);
