import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import { BankAccountsService } from '../src/modules/payouts/bank-accounts.service';
import {
  SandboxPayoutAdapter,
  type PayoutProviderAdapter,
} from '../src/modules/payouts/payout.adapter';
import {
  PAYOUT_REQUEST_STALE_ALARM_SECONDS,
  PAYOUTS_QUEUE_JOB_NAME,
} from '../src/modules/payouts/payouts.constants';
import { PayoutsService } from '../src/modules/payouts/payouts.service';
import {
  PAYOUT_REQUESTS_QUEUE,
  PayoutRequestDispatcher,
  PayoutRequestProcessor,
} from '../src/modules/payouts/payout-request.processor';
import {
  ORDER_PAYMENT_ESCROW_ACCOUNT,
  TENANT_PAYABLE_SYSTEM_KEY_PREFIX,
} from '../src/modules/settlements/settlements.constants';
import type { SettlementsService } from '../src/modules/settlements/settlements.service';
import { WalletService } from '../src/modules/wallet/wallet.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testRedisPort = process.env.TEST_REDIS_PORT;
const ENCRYPTION_KEY = randomBytes(32).toString('base64');

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 15000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await check();
}

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    PAYOUTS_PROVIDER_MODE: 'sandbox',
    AUTH_ENCRYPTION_KEY: ENCRYPTION_KEY,
  };
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error('missing config ' + key);
      return values[key];
    },
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

interface Stack {
  wallet: WalletService;
  bankAccounts: BankAccountsService;
  payouts: PayoutsService;
}

/**
 * Minimal stack: the queue wiring only needs the payout service, its ledger
 * dependencies and the bank account service (to encrypt a real destination).
 * PayoutsService takes SettlementsService for its constructor contract but the
 * processor never calls it, so a stub keeps this suite focused.
 */
function buildStack(db: DatabaseService): Stack {
  const config = makeConfig();
  const wallet = new WalletService(db);
  const access = new AccessService(db);
  const audit = new AuditService(db, access);
  const outbox = new OutboxService(db);
  const bankAccounts = new BankAccountsService(db, access, audit, config);
  const adapter: PayoutProviderAdapter = new SandboxPayoutAdapter(config);
  const payouts = new PayoutsService(
    db,
    access,
    audit,
    outbox,
    wallet,
    {} as SettlementsService,
    config,
    adapter,
  );
  return { wallet, bankAccounts, payouts };
}

interface Fixture {
  tenantId: string;
  payoutId: string;
  ownerId: string;
}

/**
 * One requested payout with its provider-request outbox row and enough
 * released settlement money for the FIFO allocation to cover it, built through
 * the real services (hold, outbox, snapshot) plus raw rows for the order side.
 */
async function createPayoutFixture(pool: Pool, stack: Stack): Promise<Fixture> {
  const tag = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      'insert into campuses (name) values ($1) returning id',
      ['Queue campus ' + tag],
    )
  ).rows[0].id;
  const tenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusId, 'Queue tenant ' + tag, 'Queue location ' + tag],
    )
  ).rows[0].id;
  const mkUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [name + ' ' + tag],
      )
    ).rows[0].id;
  const ownerId = await mkUser('QueueOwner');
  const buyerId = await mkUser('QueueBuyer');
  await pool.query(
    `insert into tenant_memberships
       (tenant_id, user_id, role, permissions, status, owner_verified_at)
     values ($1, $2, 'owner', '{}'::text[], 'active', now())`,
    [tenantId, ownerId],
  );

  const amountMinor = '10000';
  const releasedMinor = '50000';
  const funder = await stack.wallet.ensureSystemAccount(
    'queue-funding-' + randomUUID(),
    'IDR',
  );
  const escrow = await stack.wallet.ensureSystemAccount(
    ORDER_PAYMENT_ESCROW_ACCOUNT,
    'IDR',
  );
  const paymentTx = await stack.wallet.postTransfer({
    idempotencyScope: 'test.payouts.queue.payment',
    idempotencyKey: randomUUID(),
    reference: { namespace: 'test-order-payment', id: randomUUID() },
    currency: 'IDR',
    amountMinor: releasedMinor,
    debitAccountId: funder.accountId,
    creditAccountId: escrow.accountId,
    actor: { type: 'service', id: 'test-fixture' },
    reason: 'queue fixture order payment',
  });
  const slotId = (
    await pool.query<{ id: string }>(
      `insert into pickup_slots
         (tenant_id, starts_at, ends_at, capacity, reserved_count, status,
          version, created_at, updated_at)
       values ($1, now() + interval '2 hours', now() + interval '3 hours', 5, 0,
               'open', 1, now(), now())
       returning id`,
      [tenantId],
    )
  ).rows[0].id;
  const orderId = (
    await pool.query<{ id: string }>(
      `insert into orders
         (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot,
          tenant_timezone_snapshot, pickup_starts_at, pickup_ends_at, status,
          currency, subtotal_minor, total_minor, paid_at, confirmed_at, ready_at,
          completed_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'Asia/Jakarta', now() - interval '1 hour', now(),
               'completed', 'IDR', $5::numeric, $5::numeric,
               now() - interval '3 hours', now() - interval '3 hours',
               now() - interval '2 hours', now() - interval '1 hour',
               now() - interval '4 hours', now())
       returning id`,
      [buyerId, tenantId, slotId, 'Tenant ' + tag, releasedMinor],
    )
  ).rows[0].id;
  const orderPaymentId = (
    await pool.query<{ id: string }>(
      `insert into order_payments
         (order_id, method, status, amount_minor, currency,
          ledger_transaction_id, succeeded_at, created_at, updated_at)
       values ($1, 'wallet', 'succeeded', $2::numeric, 'IDR', $3, now(), now(), now())
       returning id`,
      [orderId, releasedMinor, paymentTx.transactionId],
    )
  ).rows[0].id;
  const releaseTx = await stack.wallet.postTransfer({
    idempotencyScope: 'test.payouts.queue.release',
    idempotencyKey: randomUUID(),
    reference: { namespace: 'settlement_release', id: orderId },
    currency: 'IDR',
    amountMinor: releasedMinor,
    debitAccountId: escrow.accountId,
    creditAccountId: (
      await stack.wallet.ensureSystemAccount(
        TENANT_PAYABLE_SYSTEM_KEY_PREFIX + tenantId,
        'IDR',
      )
    ).accountId,
    actor: { type: 'service', id: 'test-fixture' },
    reason: 'queue fixture settlement release',
  });
  await pool.query(
    `insert into settlements
       (tenant_id, order_id, order_payment_id, amount_minor, currency, status,
        paid_out_minor, release_ledger_transaction_id, released_at, created_at,
        updated_at)
     values ($1, $2, $3, $4::numeric, 'IDR', 'available', 0, $5, now(), now(),
             now())`,
    [tenantId, orderId, orderPaymentId, releasedMinor, releaseTx.transactionId],
  );

  const account = await stack.bankAccounts.createBankAccount(
    ownerId,
    tenantId,
    {
      bankCode: 'BCA',
      accountNumber:
        '10' + randomBytes(4).toString('hex').replace(/[a-f]/g, '7'),
      accountHolderName: 'Queue Owner',
    },
  );
  const client = await pool.connect();
  try {
    await client.query('begin');
    await stack.bankAccounts.markVerified(client, tenantId, account.id, {
      verifiedByUserId: ownerId,
      method: 'manual_campus',
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const requested = await stack.payouts.requestPayout(ownerId, tenantId, {
    bankAccountId: account.id,
    amountMinor,
    idempotencyKey: 'queue-fixture-' + tag,
  });
  return { tenantId, payoutId: requested.payout.id, ownerId };
}

describe('Payout request queue wiring', () => {
  it('fails fast with UnrecoverableError for malformed job payloads', async () => {
    const handled: string[] = [];
    const processor = new PayoutRequestProcessor({
      processPayoutRequest: async (payoutId: string) => {
        handled.push(payoutId);
      },
    } as unknown as PayoutsService);
    const validId = randomUUID();

    const invalid = [
      { name: PAYOUTS_QUEUE_JOB_NAME, data: { payoutId: 'not-a-uuid' } },
      { name: 'other-job', data: { payoutId: validId } },
      { name: PAYOUTS_QUEUE_JOB_NAME, data: null },
      { name: PAYOUTS_QUEUE_JOB_NAME, data: {} },
      { name: PAYOUTS_QUEUE_JOB_NAME, data: { payoutId: 42 } },
    ];
    for (const job of invalid) {
      await assert.rejects(
        processor.process(job as unknown as Job),
        UnrecoverableError,
        JSON.stringify(job),
      );
    }
    assert.deepEqual(
      handled,
      [],
      'a malformed job must never reach the payout domain',
    );

    await processor.process({
      name: PAYOUTS_QUEUE_JOB_NAME,
      data: { payoutId: validId },
    } as unknown as Job);
    assert.deepEqual(handled, [validId]);
    assert.equal(PAYOUT_REQUESTS_QUEUE, 'payout-requests');
    assert.equal(PAYOUTS_QUEUE_JOB_NAME, 'request');
    assert.equal(PAYOUT_REQUEST_STALE_ALARM_SECONDS, 120);
  });

  it(
    're-enqueues a due row after a terminal job failure, alarms on stale rows and rotates the jobId nonce',
    { skip: !testDatabaseUrl || !testRedisPort },
    async () => {
      const pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      const connection = {
        host: '127.0.0.1',
        port: Number(testRedisPort),
        maxRetriesPerRequest: null,
      };
      const queueName = 'payout-requests-liveness-' + randomUUID();
      const queue = new Queue(queueName, { connection });
      let failing: Worker | undefined;
      let healthy: Worker | undefined;
      try {
        const db = { pool } as unknown as DatabaseService;
        const stack = buildStack(db);
        const stale = await createPayoutFixture(pool, stack);
        const fresh = await createPayoutFixture(pool, stack);

        const jobIdFor = (row: {
          payoutId: string;
          attempts: number;
          nonce: string;
        }) =>
          'payout-request-' +
          row.payoutId +
          '-' +
          row.attempts +
          '-' +
          row.nonce;

        // Part 1: the jobId nonce follows the row state, so a lease/defer
        // cycle never dedupes onto the previous job (payments review P2-01).
        const freshDue = (await stack.payouts.listDuePayoutRequests(100)).find(
          (row) => row.payoutId === fresh.payoutId,
        );
        assert.ok(freshDue, 'the fresh outbox row must be due');
        await pool.query(
          "update payout_request_outbox set updated_at = now() + interval '1 second' where payout_id = $1",
          [fresh.payoutId],
        );
        const rotated = (await stack.payouts.listDuePayoutRequests(100)).find(
          (row) => row.payoutId === fresh.payoutId,
        );
        assert.ok(rotated);
        assert.notEqual(
          rotated.nonce,
          freshDue.nonce,
          'the nonce must change when the row changes',
        );
        assert.notEqual(jobIdFor(rotated), jobIdFor(freshDue));

        // Part 2: a due row that has been waiting past the alarm threshold.
        await pool.query(
          "update payout_request_outbox set next_attempt_at = now() - interval '1 hour', updated_at = now() - interval '200 seconds' where payout_id = $1",
          [stale.payoutId],
        );
        const staleDue = (await stack.payouts.listDuePayoutRequests(100)).find(
          (row) => row.payoutId === stale.payoutId,
        );
        assert.ok(staleDue);
        assert.ok(
          staleDue.staleForSeconds >= PAYOUT_REQUEST_STALE_ALARM_SECONDS,
          'the fixture must be past the stale alarm threshold',
        );
        const staleJobId = jobIdFor(staleDue);

        const dispatcher = new PayoutRequestDispatcher(stack.payouts, queue);
        const warnings: string[] = [];
        const internals = dispatcher as unknown as {
          logger: { warn: (message: string) => void };
        };
        internals.logger.warn = (message: string) => {
          warnings.push(message);
        };

        failing = new Worker(
          queueName,
          async (job) => {
            // Only this test's payout may fail; foreign rows are ignored.
            if (job.data?.payoutId !== stale.payoutId) return;
            // Simulates processPayoutRequest throwing before any row change
            // (infrastructure outage): the job fails terminally while the
            // PostgreSQL row stays due with an identical nonce.
            throw new Error('simulated infrastructure outage');
          },
          { connection },
        );
        await failing.waitUntilReady();
        await dispatcher.flush();
        assert.ok(
          warnings.some(
            (warning) =>
              warning.includes(stale.payoutId) &&
              warning.includes('without completing'),
          ),
          'a row due past the threshold must raise the stale alarm',
        );
        const failedSeen = await waitFor(async () => {
          const job = await queue.getJob(staleJobId);
          return job ? (await job.getState()) === 'failed' : false;
        });
        assert.ok(
          failedSeen,
          'the first job for this row must fail terminally',
        );
        await failing.close();
        failing = undefined;

        const stillDue = (await stack.payouts.listDuePayoutRequests(100)).find(
          (row) => row.payoutId === stale.payoutId,
        );
        assert.ok(
          stillDue && stillDue.nonce === staleDue.nonce,
          'the row is unchanged and still due after the terminal failure',
        );
        // The payout was never submitted: it is still requested, nothing held
        // twice and no terminal ledger leg written.
        const untouched = await pool.query<{
          status: string;
          settle_ledger_transaction_id: string | null;
          release_ledger_transaction_id: string | null;
        }>(
          'select status, settle_ledger_transaction_id::text, release_ledger_transaction_id::text from payouts where id = $1',
          [stale.payoutId],
        );
        assert.equal(untouched.rows[0].status, 'requested');
        assert.equal(untouched.rows[0].settle_ledger_transaction_id, null);
        assert.equal(untouched.rows[0].release_ledger_transaction_id, null);

        healthy = new Worker(
          queueName,
          async (job) => {
            if (job.data?.payoutId !== stale.payoutId) return;
            await stack.payouts.processPayoutRequest(String(job.data.payoutId));
          },
          { connection },
        );
        await healthy.waitUntilReady();
        // Second flush: the add dedupes onto the retained failed job, so the
        // dispatcher must remove it and re-add for the row to make progress.
        await dispatcher.flush();
        const completed = await waitFor(async () => {
          const row = await pool.query<{ status: string }>(
            'select status from payout_request_outbox where payout_id = $1',
            [stale.payoutId],
          );
          return row.rows[0]?.status === 'done';
        });
        assert.ok(
          completed,
          'the dispatcher must re-enqueue after a terminal failure',
        );
        const payoutRow = await pool.query<{
          status: string;
          settle_ledger_transaction_id: string | null;
          release_ledger_transaction_id: string | null;
        }>(
          'select status, settle_ledger_transaction_id::text, release_ledger_transaction_id::text from payouts where id = $1',
          [stale.payoutId],
        );
        assert.equal(payoutRow.rows[0].status, 'succeeded');
        assert.ok(payoutRow.rows[0].settle_ledger_transaction_id);
        assert.equal(payoutRow.rows[0].release_ledger_transaction_id, null);
        const attempts = await pool.query<{ n: string }>(
          'select count(*)::text as n from payout_attempts where payout_id = $1',
          [stale.payoutId],
        );
        assert.equal(
          attempts.rows[0].n,
          '1',
          'the payout is submitted exactly once',
        );
        const finalJob = await queue.getJob(staleJobId);
        assert.ok(finalJob, 'a job with the same id was re-added');
        assert.equal(await finalJob.getState(), 'completed');
      } finally {
        await failing?.close().catch(() => undefined);
        await healthy?.close().catch(() => undefined);
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close().catch(() => undefined);
        await pool.end();
      }
    },
  );
});
