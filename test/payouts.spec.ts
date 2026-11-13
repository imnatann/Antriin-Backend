import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import { AvailabilityService } from '../src/modules/availability/availability.service';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { TenantOperatingHoursService } from '../src/modules/tenants/tenant-operating-hours.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { RefundsService } from '../src/modules/refunds/refunds.service';
import { SandboxRefundAdapter } from '../src/modules/refunds/refund.adapter';
import { CasesService } from '../src/modules/cases/cases.service';
import { SettlementsService } from '../src/modules/settlements/settlements.service';
import {
  ORDER_PAYMENT_ESCROW_ACCOUNT,
  PAYOUT_CLEARING_SYSTEM_KEY,
  TENANT_PAYABLE_SYSTEM_KEY_PREFIX,
  TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX,
} from '../src/modules/settlements/settlements.constants';
import { BankAccountsService } from '../src/modules/payouts/bank-accounts.service';
import { PayoutsService } from '../src/modules/payouts/payouts.service';
import {
  SandboxPayoutAdapter,
  type PayoutProviderAdapter,
  type PayoutSubmissionInput,
  type PayoutSubmissionResult,
} from '../src/modules/payouts/payout.adapter';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const ENCRYPTION_KEY = randomBytes(32).toString('base64');

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    PAYOUTS_PROVIDER_MODE: 'sandbox',
    REFUNDS_PROVIDER_MODE: 'disabled',
    AUTH_ENCRYPTION_KEY: ENCRYPTION_KEY,
    ...overrides,
  };
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error('missing config ' + key);
      return values[key];
    },
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

type Stack = ReturnType<typeof buildStack>;

function buildStack(
  db: DatabaseService,
  overrides: Record<string, unknown> = {},
) {
  const config = makeConfig(overrides);
  const wallet = new WalletService(db);
  const access = new AccessService(db);
  const audit = new AuditService(db, access);
  const outbox = new OutboxService(db);
  const operatingHours = new TenantOperatingHoursService(db, access, audit);
  const availability = new AvailabilityService(
    db,
    access,
    operatingHours,
    audit,
  );
  const catalog = new CatalogService(db, access, availability, audit);
  const orders = new OrdersService(
    db,
    access,
    catalog,
    availability,
    wallet,
    audit,
    outbox,
    config,
  );
  const refunds = new RefundsService(
    db,
    wallet,
    audit,
    outbox,
    access,
    orders,
    config,
    new SandboxRefundAdapter(config),
  );
  const cases = new CasesService(db, access, audit, outbox, refunds);
  const settlements = new SettlementsService(
    db,
    access,
    audit,
    wallet,
    orders,
    cases,
  );
  const bankAccounts = new BankAccountsService(db, access, audit, config);
  const adapter = new SandboxPayoutAdapter(config);
  const payouts = new PayoutsService(
    db,
    access,
    audit,
    outbox,
    wallet,
    settlements,
    config,
    adapter,
  );
  return {
    config,
    wallet,
    access,
    audit,
    outbox,
    orders,
    refunds,
    cases,
    settlements,
    bankAccounts,
    adapter,
    payouts,
  };
}

function payoutsWith(
  stack: Stack,
  adapter: PayoutProviderAdapter,
  overrides: Record<string, unknown> = {},
): PayoutsService {
  const db = (stack.payouts as unknown as { database: DatabaseService })
    .database;
  return new PayoutsService(
    db,
    stack.access,
    stack.audit,
    stack.outbox,
    stack.wallet,
    stack.settlements,
    makeConfig(overrides),
    adapter,
  );
}

function stubAdapter(
  handler: (
    input: PayoutSubmissionInput,
  ) => PayoutSubmissionResult | Promise<PayoutSubmissionResult>,
  base: SandboxPayoutAdapter,
): PayoutProviderAdapter {
  return {
    provider: 'sandbox',
    buildProviderReference: (input) => base.buildProviderReference(input),
    submitPayout: async (input) => handler(input),
  };
}

async function createEnv(pool: Pool) {
  const tag = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      'insert into campuses (name) values ($1) returning id',
      ['Campus ' + tag],
    )
  ).rows[0].id;
  const tenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusId, 'Tenant ' + tag, 'Location ' + tag],
    )
  ).rows[0].id;
  const mkUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [name + ' ' + tag],
      )
    ).rows[0].id;
  const ownerId = await mkUser('Owner');
  const kitchenId = await mkUser('Kitchen');
  const pickupId = await mkUser('Pickup');
  const buyerId = await mkUser('Buyer');
  await pool.query(
    `insert into tenant_memberships
       (tenant_id, user_id, role, permissions, status, owner_verified_at)
     values ($1, $2, 'owner', '{}'::text[], 'active', now())`,
    [tenantId, ownerId],
  );
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role, permissions, status)
     values ($1, $2, 'kitchen', $3::text[], 'active')`,
    [tenantId, kitchenId, ['tenant.orders.read']],
  );
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role, permissions, status)
     values ($1, $2, 'pickup', $3::text[], 'active')`,
    [tenantId, pickupId, ['tenant.orders.read', 'tenant.orders.handover']],
  );
  return { tag, campusId, tenantId, ownerId, kitchenId, pickupId, buyerId };
}

type Env = Awaited<ReturnType<typeof createEnv>>;

async function fundPayable(
  pool: Pool,
  stack: Stack,
  env: Env,
  amounts: string[],
): Promise<string[]> {
  const settlementIds: string[] = [];
  for (const amountMinor of amounts) {
    const slotId = (
      await pool.query<{ id: string }>(
        `insert into pickup_slots
           (tenant_id, starts_at, ends_at, capacity, reserved_count, status,
            version, created_at, updated_at)
         values ($1, now() + interval '2 hours', now() + interval '3 hours', 5,
                 0, 'open', 1, now(), now())
         returning id`,
        [env.tenantId],
      )
    ).rows[0].id;
    const orderId = (
      await pool.query<{ id: string }>(
        `insert into orders
           (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot,
            tenant_timezone_snapshot, pickup_starts_at, pickup_ends_at, status,
            currency, subtotal_minor, total_minor, paid_at, confirmed_at,
            ready_at, completed_at, created_at, updated_at)
         values ($1, $2, $3, $4, 'Asia/Jakarta', now() - interval '1 hour', now(),
                 'completed', 'IDR', $5::numeric, $5::numeric,
                 now() - interval '2 hours', now() - interval '2 hours',
                 now() - interval '1 hour', now(), now() - interval '3 hours',
                 now())
         returning id`,
        [env.buyerId, env.tenantId, slotId, 'Tenant ' + env.tag, amountMinor],
      )
    ).rows[0].id;
    const buyerWallet = await stack.wallet.getOrCreateWallet(
      env.buyerId,
      'IDR',
    );
    const funder = await stack.wallet.ensureSystemAccount(
      'test-funding-' + randomUUID(),
      'IDR',
    );
    await stack.wallet.postTransfer({
      idempotencyScope: 'test.payouts.funding',
      idempotencyKey: randomUUID(),
      reference: { namespace: 'test-fixture', id: randomUUID() },
      currency: 'IDR',
      amountMinor: '1000000',
      debitAccountId: funder.accountId,
      creditAccountId: buyerWallet.accountId,
      actor: { type: 'service', id: 'test-fixture' },
      reason: 'payout fixture funding',
    });
    const escrow = await stack.wallet.ensureSystemAccount(
      ORDER_PAYMENT_ESCROW_ACCOUNT,
      'IDR',
    );
    const posted = await stack.wallet.postTransfer({
      idempotencyScope: 'test.payouts.checkout',
      idempotencyKey: randomUUID(),
      reference: { namespace: 'test-order-payment', id: randomUUID() },
      currency: 'IDR',
      amountMinor,
      debitAccountId: buyerWallet.accountId,
      creditAccountId: escrow.accountId,
      actor: { type: 'service', id: 'test-fixture' },
      reason: 'payout fixture order payment',
    });
    await pool.query(
      `insert into order_payments
         (order_id, method, status, amount_minor, currency,
          ledger_transaction_id, succeeded_at, created_at, updated_at)
       values ($1, 'wallet', 'succeeded', $2, 'IDR', $3, now(), now(), now())`,
      [orderId, amountMinor, posted.transactionId],
    );
    const client = await pool.connect();
    try {
      await client.query('begin');
      const outcome = await stack.settlements.releaseForOrder(
        client,
        env.tenantId,
        orderId,
        { type: 'service', id: 'settlements' },
      );
      await client.query('commit');
      if (!outcome.released) throw new Error('fixture release failed');
      settlementIds.push(outcome.settlementId);
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return settlementIds;
}

async function createVerifiedAccount(
  pool: Pool,
  stack: Stack,
  env: Env,
  opts: { verify?: boolean } = {},
): Promise<string> {
  // Unique per call so two accounts of one tenant do not collide on the
  // active-number dedupe index.
  const digits = randomBytes(5).toString('hex').replace(/[a-f]/g, '7');
  const view = await stack.bankAccounts.createBankAccount(
    env.ownerId,
    env.tenantId,
    {
      bankCode: 'BCA',
      accountNumber: '10' + digits.slice(0, 8),
      accountHolderName: 'Tenant Owner',
    },
  );
  if (opts.verify === false) return view.id;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await stack.bankAccounts.markVerified(client, env.tenantId, view.id, {
      verifiedByUserId: env.ownerId,
      method: 'manual_campus',
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return view.id;
}

async function balanceOf(pool: Pool, systemKey: string): Promise<string> {
  const result = await pool.query<{ balance_minor: string }>(
    `select balance_minor::text from wallet_accounts
      where account_type = 'system' and system_key = $1 and currency = 'IDR'`,
    [systemKey],
  );
  return result.rows[0]?.balance_minor ?? '0';
}

function httpCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'response' in error
    ? (error as { response: { code?: string } }).response?.code
    : undefined;
}

describe(
  'Payouts slice PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let db: DatabaseService;
    let stack: Stack;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 16 });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      stack = buildStack(db);
    });
    after(async () => {
      await pool?.end();
    });

    it('requests a payout: holds exactly the amount and records the trail', async () => {
      const env = await createEnv(pool);
      await fundPayable(pool, stack, env, ['50000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const payableKey = TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId;
      const holdKey = TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + env.tenantId;

      const result = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '30000',
          idempotencyKey: 'payout-request-1',
        },
      );
      assert.equal(result.replayed, false);
      assert.equal(result.payout.status, 'requested');
      assert.equal(result.payout.amountMinor, '30000');
      assert.equal(result.payout.currency, 'IDR');
      assert.match(result.payout.accountNumberMasked, /^\*{4}[0-9]{4}$/);
      assert.ok(
        !result.payout.accountNumberMasked.includes('1234567890'),
        'the full number never appears in a response',
      );
      assert.equal(await balanceOf(pool, payableKey), '20000');
      assert.equal(await balanceOf(pool, holdKey), '30000');

      const outbox = await pool.query<{ status: string; attempts: number }>(
        'select status, attempts from payout_request_outbox where payout_id = $1',
        [result.payout.id],
      );
      assert.equal(outbox.rows[0].status, 'pending');
      assert.equal(outbox.rows[0].attempts, 0);
      const events = await pool.query<{ version: number; to_status: string }>(
        'select version, to_status from payout_events where payout_id = $1',
        [result.payout.id],
      );
      assert.equal(events.rowCount, 1);
      assert.equal(events.rows[0].to_status, 'requested');
      const audit = await pool.query(
        `select 1 from audit_events
          where action = 'tenant.payout.requested' and target_id = $1`,
        [result.payout.id],
      );
      assert.equal(audit.rowCount, 1);
      // The destination snapshot is stored on the payout row.
      const snapshot = await pool.query<{
        bank_code: string;
        account_holder_name: string;
      }>('select bank_code, account_holder_name from payouts where id = $1', [
        result.payout.id,
      ]);
      assert.equal(snapshot.rows[0].bank_code, 'BCA');
      assert.equal(snapshot.rows[0].account_holder_name, 'Tenant Owner');
    });

    it('rejects invalid amounts, unknown/foreign accounts and unverified accounts', async () => {
      const env = await createEnv(pool);
      const other = await createEnv(pool);
      await fundPayable(pool, stack, env, ['50000']);
      const verified = await createVerifiedAccount(pool, stack, env);
      const pending = await createVerifiedAccount(pool, stack, env, {
        verify: false,
      });
      const foreign = await createVerifiedAccount(pool, stack, other);

      await assert.rejects(
        stack.payouts.requestPayout(env.ownerId, env.tenantId, {
          bankAccountId: verified,
          amountMinor: '0',
          idempotencyKey: 'invalid-amount-1',
        }),
        (error: unknown) => httpCode(error) === 'PAYOUT_AMOUNT_INVALID',
      );
      await assert.rejects(
        stack.payouts.requestPayout(env.ownerId, env.tenantId, {
          bankAccountId: verified,
          amountMinor: '50001',
          idempotencyKey: 'too-large-1',
        }),
        (error: unknown) =>
          httpCode(error) === 'PAYOUT_AMOUNT_EXCEEDS_AVAILABLE',
      );
      await assert.rejects(
        stack.payouts.requestPayout(env.ownerId, env.tenantId, {
          bankAccountId: pending,
          amountMinor: '10000',
          idempotencyKey: 'pending-account-1',
        }),
        (error: unknown) =>
          httpCode(error) === 'PAYOUT_BANK_ACCOUNT_UNVERIFIED',
      );
      await assert.rejects(
        stack.payouts.requestPayout(env.ownerId, env.tenantId, {
          bankAccountId: foreign,
          amountMinor: '10000',
          idempotencyKey: 'foreign-account-1',
        }),
        /Bank account was not found/,
      );
      await assert.rejects(
        stack.payouts.requestPayout(env.kitchenId, env.tenantId, {
          bankAccountId: verified,
          amountMinor: '10000',
          idempotencyKey: 'staff-account-1',
        }),
        /Tenant finance access denied/,
      );
      await assert.rejects(
        stack.payouts.requestPayout(env.pickupId, env.tenantId, {
          bankAccountId: verified,
          amountMinor: '10000',
          idempotencyKey: 'pickup-account-1',
        }),
        /Tenant finance access denied/,
      );
      assert.equal(
        (
          await pool.query('select 1 from payouts where tenant_id = $1', [
            env.tenantId,
          ])
        ).rowCount,
        0,
      );
    });

    it('refuses everything while the provider mode is disabled (production)', async () => {
      const env = await createEnv(pool);
      await fundPayable(pool, stack, env, ['50000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const disabled = payoutsWith(stack, stack.adapter, {
        PAYOUTS_PROVIDER_MODE: 'disabled',
      });
      await assert.rejects(
        disabled.requestPayout(env.ownerId, env.tenantId, {
          bankAccountId: accountId,
          amountMinor: '10000',
          idempotencyKey: 'disabled-1',
        }),
        (error: unknown) => httpCode(error) === 'PAYOUT_PROVIDER_DISABLED',
      );
      const production = payoutsWith(stack, stack.adapter, {
        NODE_ENV: 'production',
        PAYOUTS_PROVIDER_MODE: 'sandbox',
      });
      assert.equal(production.providerMode(), 'disabled');
      assert.equal(
        (
          await pool.query('select 1 from payouts where tenant_id = $1', [
            env.tenantId,
          ])
        ).rowCount,
        0,
      );
    });

    it('keeps one active payout per tenant and replays the same idempotency key', async () => {
      const env = await createEnv(pool);
      await fundPayable(pool, stack, env, ['50000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const first = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '10000',
          idempotencyKey: 'active-payout-1',
        },
      );
      await assert.rejects(
        stack.payouts.requestPayout(env.ownerId, env.tenantId, {
          bankAccountId: accountId,
          amountMinor: '10000',
          idempotencyKey: 'active-payout-2',
        }),
        (error: unknown) => httpCode(error) === 'PAYOUT_ACTIVE_EXISTS',
      );
      const replay = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '10000',
          idempotencyKey: 'active-payout-1',
        },
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.payout.id, first.payout.id);
      await assert.rejects(
        stack.payouts.requestPayout(env.ownerId, env.tenantId, {
          bankAccountId: accountId,
          amountMinor: '20000',
          idempotencyKey: 'active-payout-1',
        }),
        (error: unknown) => httpCode(error) === 'PAYOUT_IDEMPOTENCY_REUSED',
      );
      assert.equal(
        await balanceOf(
          pool,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + env.tenantId,
        ),
        '10000',
        'the replay must not hold the money twice',
      );
    });

    it('serializes parallel payouts: only funded requests succeed and balances never go negative', async () => {
      const env = await createEnv(pool);
      // Payable holds exactly 3 x 10000; each round fires 6 parallel requests
      // for 10000, so at most one may win (one active payout per tenant) and at
      // most three may ever be funded.
      await fundPayable(pool, stack, env, ['10000', '10000', '10000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      let successes = 0;
      for (let round = 0; round < 5; round += 1) {
        const attempts = await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            stack.payouts
              .requestPayout(env.ownerId, env.tenantId, {
                bankAccountId: accountId,
                amountMinor: '10000',
                idempotencyKey:
                  'parallel-payout-' + String(round) + '-' + String(index),
              })
              .then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              ),
          ),
        );
        const winners = attempts.filter((attempt) => attempt.ok);
        assert.ok(winners.length <= 1, 'one active payout per tenant');
        for (const attempt of attempts) {
          if (!attempt.ok) {
            const code = httpCode(attempt.error);
            assert.ok(
              code === 'PAYOUT_ACTIVE_EXISTS' ||
                code === 'PAYOUT_AMOUNT_EXCEEDS_AVAILABLE',
              'unexpected rejection code ' + String(code),
            );
          }
        }
        const payable = await balanceOf(
          pool,
          TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId,
        );
        const held = await balanceOf(
          pool,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + env.tenantId,
        );
        assert.ok(BigInt(payable) >= 0n, 'payable is never negative');
        assert.ok(BigInt(held) >= 0n, 'hold is never negative');
        if (winners.length === 0) break;
        successes += 1;
        const processed = await stack.payouts.processPayoutRequest(
          winners[0].value.payout.id,
        );
        assert.equal(processed.outcome, 'succeeded');
      }
      assert.equal(successes, 3, 'exactly three payouts were funded');
      assert.equal(
        await balanceOf(pool, TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId),
        '0',
      );
      assert.equal(
        await balanceOf(
          pool,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + env.tenantId,
        ),
        '0',
      );
      const paidOut = await pool.query<{ total: string }>(
        `select coalesce(sum(amount_minor), 0)::text as total from payouts
          where tenant_id = $1 and status = 'succeeded'`,
        [env.tenantId],
      );
      assert.equal(paidOut.rows[0].total, '30000');
    });

    it('settles a payout exactly once, allocates FIFO and updates paid_out_minor', async () => {
      const env = await createEnv(pool);
      const settlementIds = await fundPayable(pool, stack, env, [
        '30000',
        '20000',
      ]);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const clearingBefore = BigInt(
        await balanceOf(pool, PAYOUT_CLEARING_SYSTEM_KEY),
      );
      const requested = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '40000',
          idempotencyKey: 'settle-payout-1',
        },
      );

      const processed = await stack.payouts.processPayoutRequest(
        requested.payout.id,
      );
      assert.equal(processed.outcome, 'succeeded');
      const detail = await stack.payouts.getTenantPayout(
        env.ownerId,
        env.tenantId,
        requested.payout.id,
      );
      assert.equal(detail.payout.status, 'succeeded');
      assert.ok(detail.payout.succeededAt);
      assert.equal(
        detail.allocations.length,
        2,
        'FIFO covers both settlements',
      );
      assert.deepEqual(
        detail.allocations.map((allocation) => allocation.amountMinor),
        ['30000', '10000'],
        'oldest release first, the last settlement is partially allocated',
      );
      const settlements = await pool.query<{
        id: string;
        status: string;
        paid_out_minor: string;
      }>(
        'select id::text, status, paid_out_minor::text from settlements where tenant_id = $1 order by released_at, id',
        [env.tenantId],
      );
      assert.equal(settlements.rows[0].id, settlementIds[0]);
      assert.equal(settlements.rows[0].status, 'paid_out');
      assert.equal(settlements.rows[0].paid_out_minor, '30000');
      assert.equal(settlements.rows[1].status, 'available');
      assert.equal(settlements.rows[1].paid_out_minor, '10000');

      assert.equal(
        await balanceOf(
          pool,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + env.tenantId,
        ),
        '0',
        'the hold was emptied exactly once',
      );
      assert.equal(
        BigInt(await balanceOf(pool, PAYOUT_CLEARING_SYSTEM_KEY)) -
          clearingBefore,
        40000n,
        'the payout cleared to the provider counter-account',
      );
      assert.equal(
        await balanceOf(pool, TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId),
        '10000',
        'unallocated payable stays with the tenant',
      );

      // Replaying the processing step changes nothing.
      const replay = await stack.payouts.processPayoutRequest(
        requested.payout.id,
      );
      assert.equal(replay.outcome, 'skipped');
      const settleLegs = await pool.query(
        `select 1 from ledger_transactions
          where idempotency_scope = 'payouts.settle' and idempotency_key = $1`,
        [requested.payout.id],
      );
      assert.equal(settleLegs.rowCount, 1, 'settle posted exactly once');
      const providerEvents = await pool.query(
        'select 1 from payout_provider_events where payout_id = $1',
        [requested.payout.id],
      );
      assert.equal(providerEvents.rowCount, 1);

      // Reconciliation identities (2) and (3) of design section 4.4.
      const allocated = await pool.query<{ total: string }>(
        `select coalesce(sum(amount_minor), 0)::text as total
           from payout_allocations where payout_id = $1`,
        [requested.payout.id],
      );
      assert.equal(allocated.rows[0].total, detail.payout.amountMinor);
      const perSettlement = await pool.query<{
        settlement_id: string;
        total: string;
      }>(
        `select settlement_id::text, sum(amount_minor)::text as total
           from payout_allocations where payout_id = $1 group by settlement_id`,
        [requested.payout.id],
      );
      for (const row of perSettlement.rows) {
        const stored = await pool.query<{ paid_out_minor: string }>(
          'select paid_out_minor::text from settlements where id = $1',
          [row.settlement_id],
        );
        assert.equal(stored.rows[0].paid_out_minor, row.total);
      }
    });

    it('releases the hold exactly once when the provider fails', async () => {
      const env = await createEnv(pool);
      await fundPayable(pool, stack, env, ['50000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const requested = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '20000',
          idempotencyKey: 'failed-payout-1',
        },
      );
      const failing = stubAdapter(
        (input) => ({
          status: 'failed',
          providerReference: input.providerReference,
          occurredAt: new Date(),
          errorCode: 'ACCOUNT_CLOSED',
        }),
        stack.adapter,
      );
      const service = payoutsWith(stack, failing);
      const processed = await service.processPayoutRequest(requested.payout.id);
      assert.equal(processed.outcome, 'failed');

      const payout = await pool.query<{
        status: string;
        release_ledger_transaction_id: string | null;
        settle_ledger_transaction_id: string | null;
        failure_code: string | null;
      }>(
        `select status, release_ledger_transaction_id::text,
                settle_ledger_transaction_id::text, failure_code
           from payouts where id = $1`,
        [requested.payout.id],
      );
      assert.equal(payout.rows[0].status, 'failed');
      assert.ok(payout.rows[0].release_ledger_transaction_id);
      assert.equal(payout.rows[0].settle_ledger_transaction_id, null);
      assert.equal(payout.rows[0].failure_code, 'ACCOUNT_CLOSED');
      assert.equal(
        await balanceOf(
          pool,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + env.tenantId,
        ),
        '0',
      );
      assert.equal(
        await balanceOf(pool, TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId),
        '50000',
        'the held amount returned to the tenant payable',
      );
      const releaseLegs = await pool.query(
        `select 1 from ledger_transactions
          where idempotency_scope = 'payouts.release' and idempotency_key = $1`,
        [requested.payout.id],
      );
      assert.equal(releaseLegs.rowCount, 1);

      const replay = await service.processPayoutRequest(requested.payout.id);
      assert.equal(replay.outcome, 'skipped');
      assert.equal(
        await balanceOf(pool, TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId),
        '50000',
        'a replay must not release the hold twice',
      );
    });

    it('keeps funds held and stops retrying on an ambiguous provider outcome', async () => {
      const env = await createEnv(pool);
      await fundPayable(pool, stack, env, ['50000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const requested = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '25000',
          idempotencyKey: 'ambiguous-payout-1',
        },
      );
      const pending = stubAdapter(
        (input) => ({
          status: 'pending',
          providerReference: input.providerReference,
          occurredAt: new Date(),
        }),
        stack.adapter,
      );
      const service = payoutsWith(stack, pending);
      let last = await service.processPayoutRequest(requested.payout.id);
      for (
        let attempt = 0;
        attempt < 6 && last.outcome === 'deferred';
        attempt++
      ) {
        // Force the next attempt to be due immediately.
        await pool.query(
          `update payout_request_outbox set next_attempt_at = now()
            where payout_id = $1`,
          [requested.payout.id],
        );
        last = await service.processPayoutRequest(requested.payout.id);
      }
      assert.equal(last.outcome, 'needs_assistance');
      assert.equal(
        await balanceOf(
          pool,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + env.tenantId,
        ),
        '25000',
        'an ambiguous outcome must never release the hold',
      );
      const payout = await pool.query<{ status: string; last_error: string }>(
        'select status, last_error from payouts where id = $1',
        [requested.payout.id],
      );
      assert.equal(payout.rows[0].status, 'processing');
      assert.ok(payout.rows[0].last_error);
      const outbox = await pool.query<{ status: string }>(
        'select status from payout_request_outbox where payout_id = $1',
        [requested.payout.id],
      );
      assert.equal(outbox.rows[0].status, 'dead');
      const attempts = await pool.query<{ status: string }>(
        'select status from payout_attempts where payout_id = $1 order by attempt_no',
        [requested.payout.id],
      );
      assert.ok((attempts.rowCount ?? 0) >= 2);
      assert.ok(attempts.rows.every((row) => row.status === 'unknown'));
    });

    it('cancels a requested payout and releases the hold exactly once', async () => {
      const env = await createEnv(pool);
      await fundPayable(pool, stack, env, ['50000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const requested = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '15000',
          idempotencyKey: 'cancelled-payout-1',
        },
      );
      const cancelled = await stack.payouts.cancelPayout(
        env.ownerId,
        env.tenantId,
        requested.payout.id,
        'Changed the destination account',
      );
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(
        await balanceOf(pool, TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId),
        '50000',
      );
      assert.equal(
        await balanceOf(
          pool,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + env.tenantId,
        ),
        '0',
      );
      const replay = await stack.payouts.cancelPayout(
        env.ownerId,
        env.tenantId,
        requested.payout.id,
      );
      assert.equal(replay.status, 'cancelled');
      const legs = await pool.query(
        `select 1 from ledger_transactions
          where idempotency_scope = 'payouts.release' and idempotency_key = $1`,
        [requested.payout.id],
      );
      assert.equal(legs.rowCount, 1);
      // A processed payout cannot be cancelled any more (D18 Q9).
      const second = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '10000',
          idempotencyKey: 'cancelled-payout-2',
        },
      );
      await stack.payouts.processPayoutRequest(second.payout.id);
      await assert.rejects(
        stack.payouts.cancelPayout(env.ownerId, env.tenantId, second.payout.id),
        (error: unknown) => httpCode(error) === 'PAYOUT_STATE_CONFLICT',
      );
    });

    it('calls the provider adapter outside any database transaction or lock', async () => {
      const env = await createEnv(pool);
      await fundPayable(pool, stack, env, ['50000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const requested = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '10000',
          idempotencyKey: 'no-lock-payout-1',
        },
      );
      let lockFree = false;
      const probe = stubAdapter(async (input) => {
        // A separate connection can take the payout row lock only when the
        // processor holds no transaction/lock while talking to the provider.
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query(
            'select id from payouts where id = $1 for update nowait',
            [requested.payout.id],
          );
          lockFree = true;
          await client.query('rollback');
        } catch (error) {
          await client.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        return {
          status: 'succeeded',
          providerReference: input.providerReference,
          occurredAt: new Date(),
        };
      }, stack.adapter);
      const service = payoutsWith(stack, probe);
      const processed = await service.processPayoutRequest(requested.payout.id);
      assert.equal(processed.outcome, 'succeeded');
      assert.equal(lockFree, true);
    });

    it('rolls the settle back when released settlements cannot cover the payout', async () => {
      const env = await createEnv(pool);
      const settlementIds = await fundPayable(pool, stack, env, ['50000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const requested = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '30000',
          idempotencyKey: 'mismatch-payout-1',
        },
      );
      // Simulate an accounting inconsistency: the settlement is no longer
      // available while the money is already held.
      await pool.query(
        `update settlements
            set status = 'voided', voided_at = now(), paid_out_minor = 0,
                updated_at = now()
          where id = $1`,
        [settlementIds[0]],
      );
      const processed = await stack.payouts.processPayoutRequest(
        requested.payout.id,
      );
      assert.notEqual(processed.outcome, 'succeeded');
      const payout = await pool.query<{ status: string }>(
        'select status from payouts where id = $1',
        [requested.payout.id],
      );
      assert.notEqual(payout.rows[0].status, 'succeeded');
      assert.equal(
        await balanceOf(
          pool,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + env.tenantId,
        ),
        '30000',
        'the hold is not moved by a failed settle',
      );
      const settleLegs = await pool.query(
        `select 1 from ledger_transactions
          where idempotency_scope = 'payouts.settle' and idempotency_key = $1`,
        [requested.payout.id],
      );
      assert.equal(settleLegs.rowCount, 0);
    });

    it('deduplicates a replayed provider event instead of settling twice', async () => {
      const env = await createEnv(pool);
      await fundPayable(pool, stack, env, ['50000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const requested = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '20000',
          idempotencyKey: 'dedupe-payout-1',
        },
      );
      const providerReference = stack.adapter.buildProviderReference({
        payoutId: requested.payout.id,
        amountMinor: '20000',
      });
      // Simulate the provider result already having been recorded (a replay of
      // the same (provider, event_id) pair).
      await pool.query(
        `insert into payout_provider_events
           (payout_id, provider, event_id, event_type, amount_minor, currency,
            provider_reference, occurred_at, received_at, processed_at)
         values ($1, 'sandbox', $2, 'payout.succeeded', $3, 'IDR', $4, now(),
                 now(), now())`,
        [
          requested.payout.id,
          providerReference + ':payout.succeeded',
          '20000',
          providerReference,
        ],
      );
      const processed = await stack.payouts.processPayoutRequest(
        requested.payout.id,
      );
      assert.equal(processed.outcome, 'duplicate');
      const payout = await pool.query<{ status: string }>(
        'select status from payouts where id = $1',
        [requested.payout.id],
      );
      assert.equal(payout.rows[0].status, 'processing');
      assert.equal(
        await balanceOf(
          pool,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + env.tenantId,
        ),
        '20000',
        'the hold is not moved by a duplicate provider event',
      );
      const settleLegs = await pool.query(
        `select 1 from ledger_transactions
          where idempotency_scope = 'payouts.settle' and idempotency_key = $1`,
        [requested.payout.id],
      );
      assert.equal(settleLegs.rowCount, 0);
    });

    it('keeps the destination snapshot when the account is replaced later', async () => {
      const env = await createEnv(pool);
      await fundPayable(pool, stack, env, ['50000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const before = await stack.bankAccounts.loadView(
        { query: pool.query.bind(pool) },
        env.tenantId,
        accountId,
      );
      const requested = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '10000',
          idempotencyKey: 'snapshot-payout-1',
        },
      );
      const replacement = await stack.bankAccounts.replaceBankAccount(
        env.ownerId,
        env.tenantId,
        accountId,
        {
          bankCode: 'BNI',
          accountNumber: '777' + String(Date.now()).slice(-7),
          accountHolderName: 'Owner Name',
        },
      );
      assert.notEqual(replacement.id, accountId);
      const detail = await stack.payouts.getTenantPayout(
        env.ownerId,
        env.tenantId,
        requested.payout.id,
      );
      assert.equal(detail.payout.bankAccountId, accountId);
      assert.equal(detail.payout.bankCode, before.bankCode);
      assert.equal(
        detail.payout.accountNumberMasked,
        before.accountNumberMasked,
        'a later account change must not retarget an existing payout',
      );
    });

    it('satisfies the payout reconciliation identities (design section 4.4)', async () => {
      const env = await createEnv(pool);
      await fundPayable(pool, stack, env, ['20000', '10000']);
      const accountId = await createVerifiedAccount(pool, stack, env);
      const first = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '15000',
          idempotencyKey: 'reconcile-payout-1',
        },
      );
      await stack.payouts.processPayoutRequest(first.payout.id);
      const second = await stack.payouts.requestPayout(
        env.ownerId,
        env.tenantId,
        {
          bankAccountId: accountId,
          amountMinor: '5000',
          idempotencyKey: 'reconcile-payout-2',
        },
      );
      await stack.payouts.cancelPayout(
        env.ownerId,
        env.tenantId,
        second.payout.id,
      );

      const payable = BigInt(
        await balanceOf(pool, TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId),
      );
      const held = BigInt(
        await balanceOf(
          pool,
          TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX + env.tenantId,
        ),
      );
      const paidOut = await pool.query<{ total: string }>(
        `select coalesce(sum(amount_minor), 0)::text as total from payouts
          where tenant_id = $1 and status = 'succeeded'`,
        [env.tenantId],
      );
      const released = await pool.query<{ total: string }>(
        `select coalesce(sum(amount_minor), 0)::text as total from settlements
          where tenant_id = $1 and status in ('available', 'paid_out')`,
        [env.tenantId],
      );
      // Identity (1): payable + hold + paid out = released.
      assert.equal(
        payable + held + BigInt(paidOut.rows[0].total),
        BigInt(released.rows[0].total),
      );
      // Identity (3): allocations per settlement equal paid_out_minor.
      const perSettlement = await pool.query<{ settlement_id: string }>(
        `select distinct settlement_id::text from payout_allocations
          where tenant_id = $1`,
        [env.tenantId],
      );
      for (const row of perSettlement.rows) {
        const allocated = await pool.query<{ total: string }>(
          `select coalesce(sum(amount_minor), 0)::text as total
             from payout_allocations where settlement_id = $1`,
          [row.settlement_id],
        );
        const stored = await pool.query<{ paid_out_minor: string }>(
          'select paid_out_minor::text from settlements where id = $1',
          [row.settlement_id],
        );
        assert.equal(stored.rows[0].paid_out_minor, allocated.rows[0].total);
      }
    });
  },
);
