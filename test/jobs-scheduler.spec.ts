import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import {
  EXPIRE_TOPUP_INTENTS_EVERY_MS,
  EXPIRE_TOPUP_INTENTS_JOB,
  PURGE_ORDER_IDEMPOTENCY_CRON,
  PURGE_ORDER_IDEMPOTENCY_JOB,
  RUN_REPORT_EXPORTS_EVERY_MS,
  RUN_REPORT_EXPORTS_JOB,
  RUN_RISK_DETECTORS_EVERY_MS,
  RUN_RISK_DETECTORS_JOB,
  SWEEP_MEDIA_TOMBSTONES_CRON,
  SWEEP_MEDIA_TOMBSTONES_JOB,
} from '../src/jobs/maintenance-jobs.constants';
import {
  MAINTENANCE_SCHEDULES,
  MaintenanceScheduler,
} from '../src/jobs/maintenance.scheduler';

const redisPort = Number(
  process.env.TEST_REDIS_PORT ?? process.env.REDIS_PORT ?? 0,
);
const redisHost = process.env.REDIS_HOST ?? '127.0.0.1';

/**
 * The scheduler is exercised against a real Redis (BullMQ job schedulers live
 * there); the queue name is unique per run so nothing else is touched.
 */
describe('Maintenance scheduler against Redis', { skip: !redisPort }, () => {
  it('registers every repeatable job once and upserts instead of duplicating', async () => {
    const connection = {
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null as null,
    };
    const queue = new Queue('maintenance-scheduler-test-' + randomUUID(), {
      connection,
    });
    try {
      const scheduler = new MaintenanceScheduler(queue);
      await scheduler.register();

      const first = await queue.getJobSchedulers(0, 100, true);
      // BullMQ reports the scheduler identifier as `key`.
      assert.deepEqual(
        first.map((item) => item.key).sort(),
        MAINTENANCE_SCHEDULES.map((item) => item.id).sort(),
      );

      const byId = new Map(first.map((item) => [item.key, item]));
      const expiry = byId.get(EXPIRE_TOPUP_INTENTS_JOB);
      assert.equal(expiry?.name, EXPIRE_TOPUP_INTENTS_JOB);
      assert.equal(Number(expiry?.every), EXPIRE_TOPUP_INTENTS_EVERY_MS);
      assert.equal(Number(expiry?.every), 60_000);

      const detectors = byId.get(RUN_RISK_DETECTORS_JOB);
      assert.equal(Number(detectors?.every), RUN_RISK_DETECTORS_EVERY_MS);
      assert.equal(Number(detectors?.every), 15 * 60_000);

      const purge = byId.get(PURGE_ORDER_IDEMPOTENCY_JOB);
      assert.equal(purge?.pattern, PURGE_ORDER_IDEMPOTENCY_CRON);
      assert.equal(purge?.tz, 'UTC');

      const sweep = byId.get(SWEEP_MEDIA_TOMBSTONES_JOB);
      assert.equal(sweep?.pattern, SWEEP_MEDIA_TOMBSTONES_CRON);
      assert.equal(sweep?.tz, 'UTC');

      const reports = byId.get(RUN_REPORT_EXPORTS_JOB);
      assert.equal(Number(reports?.every), RUN_REPORT_EXPORTS_EVERY_MS);

      // BullMQ materialises the next job as soon as the scheduler is upserted:
      // an interval scheduler into 'wait' (due now) and a cron scheduler into
      // 'delayed' (due at the next cron minute). Either way a worker that starts
      // after this call already finds work.
      const materialised = new Set(
        (await queue.getJobs(['waiting', 'delayed'])).map((job) => job.name),
      );
      for (const schedule of MAINTENANCE_SCHEDULES)
        assert.ok(
          materialised.has(schedule.jobName),
          'missing materialised job for ' + schedule.jobName,
        );

      // Bootstrap (and therefore every worker restart) upserts the same ids.
      await scheduler.onApplicationBootstrap();
      const second = await queue.getJobSchedulers(0, 100, true);
      assert.equal(second.length, MAINTENANCE_SCHEDULES.length);
      // Derived from the registry, so adding a scheduled job does not silently
      // invalidate this assertion: the count is whatever the worker registers.
      assert.equal(
        await queue.getJobSchedulersCount(),
        MAINTENANCE_SCHEDULES.length,
      );
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
  });

  it('hands a registered job to a worker so a fresh start processes immediately', async () => {
    const connection = {
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null as null,
    };
    const queue = new Queue('maintenance-scheduler-worker-' + randomUUID(), {
      connection,
    });
    const processed: string[] = [];
    let worker: Worker | undefined;
    try {
      worker = new Worker(
        queue.name,
        async (job) => {
          processed.push(job.name);
          return { status: 'ok' };
        },
        { connection },
      );
      await worker.waitUntilReady();
      await new MaintenanceScheduler(queue).register();

      const deadline = Date.now() + 15000;
      while (
        !processed.includes(EXPIRE_TOPUP_INTENTS_JOB) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(
        processed.includes(EXPIRE_TOPUP_INTENTS_JOB),
        'the every-60s job must reach a worker right after registration',
      );
    } finally {
      await worker?.close().catch(() => undefined);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
  });
});
