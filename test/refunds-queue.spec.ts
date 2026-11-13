import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
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
import { SandboxRefundAdapter } from '../src/modules/refunds/refund.adapter';
import {
  ORDER_PAYMENT_ESCROW_ACCOUNT,
  REFUNDS_QUEUE_JOB_NAME,
  RefundsService,
} from '../src/modules/refunds/refunds.service';
import {
  REFUND_REQUEST_STALE_ALARM_SECONDS,
  REFUND_REQUESTS_QUEUE,
  RefundRequestDispatcher,
  RefundRequestProcessor,
} from '../src/modules/refunds/refund-request.processor';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testRedisPort = process.env.TEST_REDIS_PORT;

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
    REFUNDS_PROVIDER_MODE: 'sandbox',
    PAYMENTS_PROVIDER_MODE: 'disabled',
  };
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error('missing config ' + key);
      return values[key];
    },
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

function buildRefundsService(db: DatabaseService): {
  refunds: RefundsService;
  wallet: WalletService;
} {
  const wallet = new WalletService(db);
  const access = new AccessService(db);
  const audit = new AuditService(db, access);
  const outbox = new OutboxService(db);
  const config = makeConfig();
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
  return { refunds, wallet };
}

/** Minimal valid refund + its provider-request outbox row (no HTTP/service). */
async function createRefundFixture(
  pool: Pool,
  wallet: WalletService,
): Promise<{ refundId: string; buyerId: string }> {
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
  const buyerId = await mkUser('QueueBuyer');
  const adminId = await mkUser('QueueAdmin');
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [
      campusId,
      adminId,
      ['campus.refunds.initiate', 'campus.transactions.read'],
    ],
  );
  const slotId = (
    await pool.query<{ id: string }>(
      `insert into pickup_slots
         (tenant_id, starts_at, ends_at, capacity, reserved_count, status, version, created_at, updated_at)
       values ($1, now() + interval '2 hours', now() + interval '3 hours', 5, 1, 'open', 1, now(), now())
       returning id`,
      [tenantId],
    )
  ).rows[0].id;
  const buyerWallet = await wallet.getOrCreateWallet(buyerId, 'IDR');
  const funder = await wallet.ensureSystemAccount(
    'queue-funding-' + randomUUID(),
    'IDR',
  );
  await wallet.postTransfer({
    idempotencyScope: 'test.refunds.queue.funding',
    idempotencyKey: randomUUID(),
    reference: { namespace: 'test-fixture', id: randomUUID() },
    currency: 'IDR',
    amountMinor: '100000',
    debitAccountId: funder.accountId,
    creditAccountId: buyerWallet.accountId,
    actor: { type: 'service', id: 'test-fixture' },
    reason: 'queue fixture funding',
  });
  const orderId = (
    await pool.query<{ id: string }>(
      `insert into orders
         (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot, tenant_timezone_snapshot,
          pickup_starts_at, pickup_ends_at, status, currency, subtotal_minor, total_minor,
          paid_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'Asia/Jakarta', now() + interval '2 hours', now() + interval '3 hours',
               'paid_awaiting_tenant', 'IDR', '50000', '50000', now(), now(), now())
       returning id`,
      [buyerId, tenantId, slotId, 'Tenant ' + tag],
    )
  ).rows[0].id;
  const escrow = await wallet.ensureSystemAccount(
    ORDER_PAYMENT_ESCROW_ACCOUNT,
    'IDR',
  );
  const posted = await wallet.postTransfer({
    idempotencyScope: 'test.refunds.queue.checkout',
    idempotencyKey: randomUUID(),
    reference: { namespace: 'test-order-payment', id: randomUUID() },
    currency: 'IDR',
    amountMinor: '50000',
    debitAccountId: buyerWallet.accountId,
    creditAccountId: escrow.accountId,
    actor: { type: 'service', id: 'test-fixture' },
    reason: 'queue fixture order payment',
  });
  const orderPaymentId = (
    await pool.query<{ id: string }>(
      `insert into order_payments
         (order_id, method, status, amount_minor, currency, ledger_transaction_id, succeeded_at, created_at, updated_at)
       values ($1, 'wallet', 'succeeded', '50000', 'IDR', $2, now(), now(), now())
       returning id`,
      [orderId, posted.transactionId],
    )
  ).rows[0].id;
  const refundId = (
    await pool.query<{ id: string }>(
      `insert into refunds
         (campus_id, tenant_id, order_id, order_payment_id, buyer_id, amount_minor,
          currency, status, provider, reason, requested_by_user_id, requested_at,
          attempt_count, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, '50000', 'IDR', 'requested', 'sandbox',
               'queue wiring fixture', $6, now(), 0, 1, now(), now())
       returning id::text`,
      [campusId, tenantId, orderId, orderPaymentId, buyerId, adminId],
    )
  ).rows[0].id;
  await pool.query(
    `insert into refund_request_outbox
       (refund_id, status, attempts, next_attempt_at, created_at, updated_at)
     values ($1, 'pending', 0, now(), now(), now())`,
    [refundId],
  );
  return { refundId, buyerId };
}

describe('Refund request queue wiring', () => {
  it('fails fast with UnrecoverableError for malformed job payloads', async () => {
    const handled: string[] = [];
    const processor = new RefundRequestProcessor({
      processRefundRequest: async (refundId: string) => {
        handled.push(refundId);
      },
    } as unknown as RefundsService);
    const validId = randomUUID();

    const invalid = [
      { name: REFUNDS_QUEUE_JOB_NAME, data: { refundId: 'not-a-uuid' } },
      { name: 'other-job', data: { refundId: validId } },
      { name: REFUNDS_QUEUE_JOB_NAME, data: null },
      { name: REFUNDS_QUEUE_JOB_NAME, data: {} },
      { name: REFUNDS_QUEUE_JOB_NAME, data: { refundId: 42 } },
    ];
    for (const job of invalid) {
      await assert.rejects(
        processor.process(job as unknown as Job),
        UnrecoverableError,
        JSON.stringify(job),
      );
    }
    assert.deepEqual(handled, [], 'a malformed job never reaches the domain');

    await processor.process({
      name: REFUNDS_QUEUE_JOB_NAME,
      data: { refundId: validId },
    } as unknown as Job);
    assert.deepEqual(handled, [validId]);
    assert.equal(REFUND_REQUESTS_QUEUE, 'refund-requests');
    assert.equal(REFUND_REQUEST_STALE_ALARM_SECONDS, 120);
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
      const queueName = 'refund-requests-liveness-' + randomUUID();
      const queue = new Queue(queueName, { connection });
      let failing: Worker | undefined;
      let healthy: Worker | undefined;
      try {
        const db = { pool } as unknown as DatabaseService;
        const { refunds } = buildRefundsService(db);
        const stale = await createRefundFixture(pool, new WalletService(db));
        const fresh = await createRefundFixture(pool, new WalletService(db));

        // P2-01 regression, part 1: the jobId nonce follows the row's state, so
        // a lease/defer cycle never dedupes onto the previous job.
        await pool.query(
          "update refund_request_outbox set updated_at = now() + interval '1 millisecond' where refund_id = $1",
          [fresh.refundId],
        );
        const freshDue = (await refunds.listDueRefundRequests(100)).find(
          (row) => row.refundId === fresh.refundId,
        );
        assert.ok(freshDue, 'the fresh row must be due');
        const jobIdFor = (row: {
          refundId: string;
          attempts: number;
          nonce: string;
        }) =>
          'refund-request-' +
          row.refundId +
          '-' +
          row.attempts +
          '-' +
          row.nonce;
        await pool.query(
          "update refund_request_outbox set updated_at = now() + interval '1 second' where refund_id = $1",
          [fresh.refundId],
        );
        const rotated = (await refunds.listDueRefundRequests(100)).find(
          (row) => row.refundId === fresh.refundId,
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
          "update refund_request_outbox set next_attempt_at = now() - interval '1 hour', updated_at = now() - interval '200 seconds' where refund_id = $1",
          [stale.refundId],
        );
        const staleDue = (await refunds.listDueRefundRequests(100)).find(
          (row) => row.refundId === stale.refundId,
        );
        assert.ok(staleDue);
        assert.ok(
          staleDue.staleForSeconds >= REFUND_REQUEST_STALE_ALARM_SECONDS,
          'the fixture must be past the stale alarm threshold',
        );
        const staleJobId = jobIdFor(staleDue);

        const dispatcher = new RefundRequestDispatcher(refunds, queue);
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
            // Only this test's refund may fail; foreign rows from parallel
            // suites are ignored.
            if (job.data?.refundId !== stale.refundId) return;
            // Simulates processRefundRequest throwing before any row change
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
              warning.includes(stale.refundId) &&
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

        const stillDue = (await refunds.listDueRefundRequests(100)).find(
          (row) => row.refundId === stale.refundId,
        );
        assert.ok(
          stillDue && stillDue.nonce === staleDue.nonce,
          'the row is unchanged and still due after the terminal failure',
        );

        healthy = new Worker(
          queueName,
          async (job) => {
            if (job.data?.refundId !== stale.refundId) return;
            await refunds.processRefundRequest(String(job.data.refundId));
          },
          { connection },
        );
        await healthy.waitUntilReady();
        // Second flush: the add dedupes onto the retained failed job, so the
        // dispatcher must remove it and re-add for the row to make progress.
        await dispatcher.flush();
        const completed = await waitFor(async () => {
          const row = await pool.query<{ status: string }>(
            'select status from refund_request_outbox where refund_id = $1',
            [stale.refundId],
          );
          return row.rows[0]?.status === 'done';
        });
        assert.ok(
          completed,
          'the dispatcher must re-enqueue after a terminal failure',
        );
        const refundRow = await pool.query<{ status: string }>(
          'select status from refunds where id = $1',
          [stale.refundId],
        );
        assert.equal(refundRow.rows[0].status, 'succeeded');
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
