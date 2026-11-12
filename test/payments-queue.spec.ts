import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Queue, Worker } from 'bullmq';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import { SandboxPaymentsAdapter } from '../src/modules/payments/payments.adapter';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { PaymentRequestDispatcher } from '../src/modules/payments/payment-request.processor';

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

/**
 * Review P2-01 regression: a due payment_request_outbox row whose BullMQ job
 * failed TERMINALLY (e.g. the database was down for the whole retry window,
 * so the row itself never changed and the jobId nonce stayed identical) must
 * still be re-enqueued by the next dispatcher flush. The dispatcher detects
 * that its add was deduplicated onto a failed job, removes that job and adds
 * again, so the row can never stall silently.
 */
describe(
  'Payment request dispatch liveness (P2-01)',
  { skip: !testDatabaseUrl || !testRedisPort },
  () => {
    it('re-enqueues a due row whose previous job failed terminally, then completes it', async () => {
      const pool = new Pool({ connectionString: testDatabaseUrl, max: 6 });
      const db = { pool } as unknown as DatabaseService;
      const wallet = new WalletService(db);
      const audit = new AuditService(db, new AccessService(db));
      const outbox = new OutboxService(db);
      const values: Record<string, unknown> = {
        NODE_ENV: 'test',
        PAYMENTS_PROVIDER_MODE: 'sandbox',
        PAYMENTS_TOPUP_MIN_MINOR: 1000,
        PAYMENTS_TOPUP_MAX_MINOR: 2000000,
        PAYMENTS_SANDBOX_WEBHOOK_SECRET: 'a'.repeat(40),
        PAYMENTS_SANDBOX_TOPUP_TTL_SECONDS: 3600,
      };
      const config = {
        getOrThrow: (k: string) => {
          if (!(k in values)) throw new Error('missing config ' + k);
          return values[k];
        },
        get: (k: string) => values[k],
      } as unknown as ConfigService;
      const adapter = new SandboxPaymentsAdapter(config);
      const payments = new PaymentsService(
        db,
        wallet,
        audit,
        outbox,
        config,
        adapter,
      );

      const userRow = await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        ['Queue liveness ' + randomUUID()],
      );
      const userId = userRow.rows[0].id;
      const intent = await payments.createTopupIntent(userId, {
        amountMinor: '15000',
        idempotencyKey: randomUUID(),
      });
      const topupId = intent.view.id;
      // Backdate so the row sorts first among any leftover due rows.
      await pool.query(
        "update payment_request_outbox set available_at=now()-interval '1 hour' where topup_id=$1",
        [topupId],
      );
      const due = await payments.listDuePaymentRequests(100);
      const row = due.find((r) => r.topupId === topupId);
      assert.ok(row, 'the fresh row must be due');
      const jobId =
        'payment-request-' + topupId + '-' + row.attempts + '-' + row.nonce;

      const connection = {
        host: '127.0.0.1',
        port: Number(testRedisPort),
        maxRetriesPerRequest: null,
      };
      const queueName = 'payment-requests-liveness-' + randomUUID();
      const queue = new Queue(queueName, { connection });
      const dispatcher = new PaymentRequestDispatcher(payments, queue);
      const failing = new Worker(
        queueName,
        async () => {
          // Simulates processPaymentRequest throwing before any row change
          // (infrastructure outage): the job fails terminally, the PG row
          // stays due with an identical nonce.
          throw new Error('simulated infrastructure outage');
        },
        { connection },
      );
      let healthy: Worker | undefined;
      try {
        await failing.waitUntilReady();
        await dispatcher.flush();
        const failedSeen = await waitFor(async () => {
          const job = await queue.getJob(jobId);
          return job ? (await job.getState()) === 'failed' : false;
        });
        assert.ok(
          failedSeen,
          'the first job for this row must fail terminally',
        );
        await failing.close();

        const stillDue = await payments.listDuePaymentRequests(100);
        assert.ok(
          stillDue.some((r) => r.topupId === topupId && r.nonce === row.nonce),
          'the row is unchanged and still due after the terminal failure',
        );

        healthy = new Worker(
          queueName,
          async (job) => {
            await payments.processPaymentRequest(String(job.data.topupId));
          },
          { connection },
        );
        await healthy.waitUntilReady();
        // Second flush: the add dedupes onto the retained failed job; the
        // dispatcher must remove it and re-add so the row is processed.
        await dispatcher.flush();
        const completed = await waitFor(async () => {
          const r = await pool.query<{ status: string }>(
            'select status from payment_request_outbox where topup_id=$1',
            [topupId],
          );
          return r.rows[0]?.status === 'complete';
        });
        assert.ok(
          completed,
          'dispatcher must re-enqueue after a terminal failure and the row must complete',
        );
        const finalJob = await queue.getJob(jobId);
        assert.ok(finalJob, 'a job with the same id was re-added');
        assert.equal(await finalJob.getState(), 'completed');
      } finally {
        await failing.close().catch(() => undefined);
        await healthy?.close().catch(() => undefined);
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close().catch(() => undefined);
        await pool.end();
      }
    });
  },
);
