import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import type { RiskDetectorRunResult } from '../src/modules/risk/risk-detectors.service';
import {
  DELIVER_OTP_DELIVERIES_JOB,
  EXPIRE_TOPUP_INTENTS_JOB,
  MAINTENANCE_HEALTHCHECK_JOB,
  PURGE_ORDER_IDEMPOTENCY_JOB,
  RUN_REPORT_EXPORTS_JOB,
  RUN_RISK_DETECTORS_JOB,
  SWEEP_MEDIA_TOMBSTONES_JOB,
} from '../src/jobs/maintenance-jobs.constants';
import { MaintenanceProcessor } from '../src/jobs/maintenance.processor';
import { MaintenanceScheduler } from '../src/jobs/maintenance.scheduler';
import { DeliverOtpDeliveriesJob } from '../src/jobs/otp-delivery-dispatch.job';
import { SweepMediaTombstonesJob } from '../src/jobs/media-tombstone-sweep.job';
import { PurgeOrderIdempotencyJob } from '../src/jobs/order-idempotency-purge.job';
import { ReportExportJob } from '../src/jobs/report-export.job';
import { RiskDetectorJob } from '../src/jobs/risk-detector.job';
import { ExpireTopupIntentsJob } from '../src/jobs/topup-expiry.job';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

async function mkUser(pool: Pool, label: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    'insert into users (display_name) values ($1) returning id',
    [label + ' ' + randomUUID()],
  );
  return row.rows[0].id;
}

async function mkOrder(
  pool: Pool,
  campusId: string,
  tenantId: string,
  buyerId: string,
  slotIds: string[],
): Promise<string> {
  const slot = await pool.query<{ id: string }>(
    `insert into pickup_slots
       (tenant_id, starts_at, ends_at, capacity, reserved_count, status, version, created_at, updated_at)
     values ($1, now() + interval '2 hours', now() + interval '3 hours', 5, 0, 'open', 1, now(), now())
     returning id`,
    [tenantId],
  );
  slotIds.push(slot.rows[0].id);
  const order = await pool.query<{ id: string }>(
    `insert into orders
       (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot, tenant_timezone_snapshot,
        pickup_starts_at, pickup_ends_at, status, currency, subtotal_minor, total_minor,
        paid_at, confirmed_at, ready_at, completed_at, created_at, updated_at)
     values ($1, $2, $3, 'Tenant snapshot', 'Asia/Jakarta', now() - interval '1 hour', now(),
             'completed', 'IDR', '50000', '50000', now() - interval '2 hours',
             now() - interval '90 minutes', now() - interval '80 minutes',
             now() - interval '70 minutes', now() - interval '3 hours', now())
     returning id`,
    [buyerId, tenantId, slot.rows[0].id],
  );
  return order.rows[0].id;
}

/**
 * The sweepers act on the whole table, so the exact counters are asserted only
 * as lower bounds while the per-row assertions stay exact: this spec never
 * depends on the database being otherwise empty.
 */
describe(
  'Scheduled maintenance jobs against PostgreSQL',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let db: DatabaseService;
    let audit: AuditService;
    let mediaRoot: string;
    const topupIntentIds: string[] = [];
    const userIds: string[] = [];
    const mediaIds: string[] = [];
    const orderIds: string[] = [];
    const tenantIds: string[] = [];
    const campusIds: string[] = [];
    const slotIds: string[] = [];
    let idempotencyIds: string[] = [];

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 6 });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      audit = new AuditService(db, new AccessService(db));
      mediaRoot = await mkdtemp(join(tmpdir(), 'antriin-jobs-media-'));
    });

    after(async () => {
      // audit_events are immutable by a DB trigger: the expiry audit rows stay
      // on purpose (that is what an append-only audit trail means).
      if (topupIntentIds.length)
        await pool.query(
          'delete from topup_intents where id = any($1::uuid[])',
          [topupIntentIds],
        );
      // wallet_accounts are retained by a DB trigger (they are ledger
      // owners), so the top-up wallet and its owner user stay behind.
      if (mediaIds.length)
        await pool.query(
          'delete from media_assets where id = any($1::uuid[])',
          [mediaIds],
        );
      if (idempotencyIds.length)
        await pool.query(
          'delete from order_request_idempotency where id = any($1::uuid[])',
          [idempotencyIds],
        );
      if (orderIds.length)
        await pool.query('delete from orders where id = any($1::uuid[])', [
          orderIds,
        ]);
      if (slotIds.length)
        await pool.query(
          'delete from pickup_slots where id = any($1::uuid[])',
          [slotIds],
        );
      if (tenantIds.length)
        await pool.query('delete from tenants where id = any($1::uuid[])', [
          tenantIds,
        ]);
      if (campusIds.length)
        await pool.query('delete from campuses where id = any($1::uuid[])', [
          campusIds,
        ]);
      if (userIds.length)
        await pool.query(
          `delete from users u
            where u.id = any($1::uuid[])
              and not exists (
                select 1 from wallet_accounts w where w.owner_user_id = u.id
              )`,
          [userIds],
        );
      await rm(mediaRoot, { recursive: true, force: true });
      await pool.end();
    });

    describe('expire-topup-intents', () => {
      it('expires only due pending intents, audits each transition and is idempotent', async () => {
        const userId = await mkUser(pool, 'Topup owner');
        userIds.push(userId);
        const wallet = await pool.query<{ id: string }>(
          `insert into wallet_accounts (account_type, owner_user_id, currency)
           values ('wallet', $1, 'IDR') returning id`,
          [userId],
        );
        const walletId = wallet.rows[0].id;

        const insertIntent = async (input: {
          status: string;
          createdMinutesAgo: number;
          /** Offset from now, in minutes; null leaves expires_at unset. */
          expiresInMinutes: number | null;
          succeededMinutesAgo?: number | null;
        }) => {
          const expiresAt =
            input.expiresInMinutes === null
              ? null
              : new Date(Date.now() + input.expiresInMinutes * 60_000);
          const succeededAt =
            input.succeededMinutesAgo === undefined ||
            input.succeededMinutesAgo === null
              ? null
              : new Date(Date.now() - input.succeededMinutesAgo * 60_000);
          const row = await pool.query<{ id: string }>(
            `insert into topup_intents
               (user_id, wallet_account_id, provider, provider_reference, idempotency_key,
                request_hash, amount_minor, currency, status, status_version, expires_at,
                succeeded_at, created_at, updated_at)
             values ($1, $2, 'sandbox', $3, $4, $5, '15000', 'IDR', $6, 1, $7, $8,
                     now() - ($9::int * interval '1 minute'), now())
             returning id`,
            [
              userId,
              walletId,
              randomUUID(),
              randomUUID(),
              'a'.repeat(64),
              input.status,
              expiresAt,
              succeededAt,
              input.createdMinutesAgo,
            ],
          );
          topupIntentIds.push(row.rows[0].id);
          return row.rows[0].id;
        };

        const dueOne = await insertIntent({
          status: 'pending',
          createdMinutesAgo: 120,
          expiresInMinutes: -60,
        });
        const dueTwo = await insertIntent({
          status: 'pending',
          createdMinutesAgo: 180,
          expiresInMinutes: -2,
        });
        const future = await insertIntent({
          status: 'pending',
          createdMinutesAgo: 0,
          expiresInMinutes: 60,
        });
        // The CHECK requires expires_at > created_at, so "no expiry" is modeled
        // as NULL rather than a past value.
        const noExpiry = await insertIntent({
          status: 'pending',
          createdMinutesAgo: 0,
          expiresInMinutes: null,
        });
        const settled = await insertIntent({
          status: 'succeeded',
          createdMinutesAgo: 120,
          expiresInMinutes: -60,
          succeededMinutesAgo: 30,
        });

        const job = new ExpireTopupIntentsJob(db, audit);
        const first = await job.run();
        assert.equal(first.job, EXPIRE_TOPUP_INTENTS_JOB);
        assert.ok(first.expired >= 2);
        assert.equal(first.capped, false);

        const rows = await pool.query<{
          id: string;
          status: string;
          status_version: number;
        }>(
          'select id::text, status, status_version from topup_intents where id = any($1::uuid[])',
          [topupIntentIds],
        );
        const byId = new Map(rows.rows.map((row) => [row.id, row]));
        assert.equal(byId.get(dueOne)?.status, 'expired');
        assert.equal(byId.get(dueOne)?.status_version, 2);
        assert.equal(byId.get(dueTwo)?.status, 'expired');
        assert.equal(byId.get(future)?.status, 'pending');
        assert.equal(byId.get(noExpiry)?.status, 'pending');
        assert.equal(byId.get(settled)?.status, 'succeeded');

        // No row of this owner that was due may survive the pass.
        const stillDue = await pool.query<{ count: string }>(
          `select count(*)::text from topup_intents
            where user_id = $1
              and status = 'pending' and expires_at is not null and expires_at <= now()`,
          [userId],
        );
        assert.equal(stillDue.rows[0].count, '0');

        const auditRows = await pool.query<{ target_id: string }>(
          'select target_id::text from audit_events where action = $1 and target_id = any($2::uuid[])',
          ['topup.expired', topupIntentIds],
        );
        assert.deepEqual(
          auditRows.rows.map((row) => row.target_id).sort(),
          [dueOne, dueTwo].sort(),
        );

        // A second pass must not expire anything again, and must not add audit.
        const second = await job.run();
        assert.equal(second.expired, 0);
        const afterAudit = await pool.query(
          'select 1 from audit_events where action = $1 and target_id = any($2::uuid[])',
          ['topup.expired', topupIntentIds],
        );
        assert.equal(afterAudit.rowCount, 2);
      });
    });

    describe('purge-order-idempotency', () => {
      it('deletes only expired replay records and never the order itself', async () => {
        const campus = await pool.query<{ id: string }>(
          'insert into campuses (name) values ($1) returning id',
          ['Idempotency campus ' + randomUUID()],
        );
        campusIds.push(campus.rows[0].id);
        const tenant = await pool.query<{ id: string }>(
          `insert into tenants (campus_id, name, location, status)
           values ($1, $2, $3, 'open') returning id`,
          [campus.rows[0].id, 'Tenant ' + randomUUID(), 'Location'],
        );
        tenantIds.push(tenant.rows[0].id);
        const buyer = await mkUser(pool, 'Idempotency buyer');
        userIds.push(buyer);
        const orderId = await mkOrder(
          pool,
          campus.rows[0].id,
          tenant.rows[0].id,
          buyer,
          slotIds,
        );
        orderIds.push(orderId);

        const insertReplay = async (minutesFromNow: number | null) => {
          const row = await pool.query<{ id: string }>(
            `insert into order_request_idempotency
               (actor_user_id, route_name, key_hash, request_hash, order_id,
                response_body, expires_at)
             values ($1, 'POST /v1/orders', $2, $3, $4, '{}'::jsonb, $5)
             returning id`,
            [
              buyer,
              randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
              randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
              orderId,
              minutesFromNow === null
                ? null
                : new Date(Date.now() + minutesFromNow * 60_000),
            ],
          );
          idempotencyIds.push(row.rows[0].id);
          return row.rows[0].id;
        };
        await insertReplay(-1440);
        await insertReplay(-1);
        const future = await insertReplay(1440);
        const optedOut = await insertReplay(null);

        const job = new PurgeOrderIdempotencyJob(db);
        const first = await job.run();
        assert.equal(first.job, PURGE_ORDER_IDEMPOTENCY_JOB);
        assert.ok(first.purged >= 2);
        assert.equal(first.capped, false);

        const left = await pool.query<{ id: string }>(
          'select id::text from order_request_idempotency where id = any($1::uuid[])',
          [idempotencyIds],
        );
        assert.deepEqual(
          left.rows.map((row) => row.id).sort(),
          [future, optedOut].sort(),
        );
        assert.equal(
          (await pool.query('select 1 from orders where id = $1', [orderId]))
            .rowCount,
          1,
          'the order must survive idempotency retention',
        );

        const second = await job.run();
        assert.equal(second.purged, 0);
        // Only the survivors remain for cleanup at the end of the run.
        idempotencyIds = [future, optedOut];
      });
    });

    describe('sweep-media-tombstones', () => {
      it('removes old tombstones and their files, keeps recent rows and refuses unsafe keys', async () => {
        const owner = await mkUser(pool, 'Media owner');
        userIds.push(owner);

        const insertRow = async (input: {
          storageKey: string;
          thumbnailKey?: string | null;
          deletedDaysAgo: number | null;
        }) => {
          const row = await pool.query<{ id: string }>(
            `insert into media_assets
               (owner_user_id, purpose, storage_key, content_type, byte_size,
                checksum_sha256, original_filename, width, height, thumbnail_key,
                deleted_at, created_at, updated_at)
             values ($1, 'avatar', $2, 'image/png', 33, $3, '', 2, 2, $4, $5, now(), now())
             returning id`,
            [
              owner,
              input.storageKey,
              'b'.repeat(64),
              input.thumbnailKey ?? null,
              input.deletedDaysAgo === null
                ? null
                : new Date(Date.now() - input.deletedDaysAgo * 86400_000),
            ],
          );
          mediaIds.push(row.rows[0].id);
          return row.rows[0].id;
        };
        const writeStoredFile = async (key: string) => {
          const path = join(mediaRoot, key);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, Buffer.alloc(33));
          return path;
        };

        const oldKey = `2026/01/${randomUUID()}.png`;
        const oldThumbKey = `2026/01/${randomUUID()}.png`;
        const oldFile = await writeStoredFile(oldKey);
        const oldThumb = await writeStoredFile(oldThumbKey);
        const oldId = await insertRow({
          storageKey: oldKey,
          thumbnailKey: oldThumbKey,
          deletedDaysAgo: 40,
        });

        const recentKey = `2026/02/${randomUUID()}.png`;
        const recentFile = await writeStoredFile(recentKey);
        const recentId = await insertRow({
          storageKey: recentKey,
          deletedDaysAgo: 5,
        });

        const liveKey = `2026/03/${randomUUID()}.png`;
        const liveFile = await writeStoredFile(liveKey);
        const liveId = await insertRow({
          storageKey: liveKey,
          deletedDaysAgo: null,
        });

        const unsafeId = await insertRow({
          storageKey: '../../etc/passwd',
          deletedDaysAgo: 40,
        });

        const config = {
          getOrThrow: (key: string) => {
            if (key === 'MEDIA_ROOT') return mediaRoot;
            throw new Error('unexpected config key ' + key);
          },
        } as unknown as ConfigService;
        const job = new SweepMediaTombstonesJob(db, config);
        const first = await job.run();
        assert.equal(first.job, SWEEP_MEDIA_TOMBSTONES_JOB);
        assert.ok(first.purged >= 1);
        assert.ok(first.filesDeleted >= 2);
        // Other tombstones may exist in the database; ours is refused.
        assert.ok(first.skippedUnsafePaths >= 1);
        assert.equal(first.failed, 0);

        await assert.rejects(stat(oldFile), { code: 'ENOENT' });
        await assert.rejects(stat(oldThumb), { code: 'ENOENT' });
        assert.ok((await stat(recentFile)).isFile());
        assert.ok((await stat(liveFile)).isFile());

        const rows = await pool.query<{ id: string }>(
          'select id::text from media_assets where id = any($1::uuid[])',
          [mediaIds],
        );
        assert.deepEqual(
          rows.rows.map((row) => row.id).sort(),
          [recentId, liveId, unsafeId].sort(),
        );
        assert.ok(!rows.rows.some((row) => row.id === oldId));

        // Second pass: the purged row and files are gone and the unsafe key is
        // still refused, so a rerun converges instead of deleting more.
        const second = await job.run();
        assert.equal(second.purged, 0);
        assert.ok(second.skippedUnsafePaths >= 1);
        assert.equal(
          (
            await pool.query(
              'select 1 from media_assets where id = any($1::uuid[])',
              [[recentId, liveId, unsafeId]],
            )
          ).rowCount,
          3,
        );
      });
    });

    describe('maintenance processor dispatch', () => {
      function buildProcessor(overrides: {
        topup?: unknown;
        purge?: unknown;
        media?: unknown;
        risk?: unknown;
        reports?: unknown;
        otp?: unknown;
      }) {
        return new MaintenanceProcessor(
          (overrides.topup ?? {
            run: async () => ({ job: EXPIRE_TOPUP_INTENTS_JOB, expired: 7 }),
          }) as ExpireTopupIntentsJob,
          (overrides.purge ?? {
            run: async () => ({ job: PURGE_ORDER_IDEMPOTENCY_JOB, purged: 3 }),
          }) as PurgeOrderIdempotencyJob,
          (overrides.media ?? {
            run: async () => ({ job: SWEEP_MEDIA_TOMBSTONES_JOB, purged: 0 }),
          }) as SweepMediaTombstonesJob,
          (overrides.risk ?? {
            run: async () => ({ job: RUN_RISK_DETECTORS_JOB, failures: [] }),
          }) as unknown as RiskDetectorJob,
          (overrides.reports ?? {
            run: async () => ({
              job: RUN_REPORT_EXPORTS_JOB,
              generated: 0,
              failed: 0,
            }),
          }) as unknown as ReportExportJob,
          (overrides.otp ?? {
            run: async () => ({
              job: DELIVER_OTP_DELIVERIES_JOB,
              sent: 0,
              deferred: 0,
            }),
          }) as unknown as DeliverOtpDeliveriesJob,
        );
      }
      const asJob = (name: string) =>
        ({ name, id: 'job-1', attemptsMade: 0 }) as unknown as Job;

      it('answers the healthcheck probe without touching the database', async () => {
        const processor = buildProcessor({});
        assert.deepEqual(
          await processor.process(asJob(MAINTENANCE_HEALTHCHECK_JOB)),
          { status: 'ok' },
        );
      });

      it('routes each named job to its implementation', async () => {
        const processor = buildProcessor({});
        const expiry = await processor.process(asJob(EXPIRE_TOPUP_INTENTS_JOB));
        assert.equal((expiry as { expired: number }).expired, 7);
        const purge = await processor.process(
          asJob(PURGE_ORDER_IDEMPOTENCY_JOB),
        );
        assert.equal((purge as { purged: number }).purged, 3);
        const sweep = await processor.process(
          asJob(SWEEP_MEDIA_TOMBSTONES_JOB),
        );
        assert.equal((sweep as { purged: number }).purged, 0);
        const otp = await processor.process(asJob(DELIVER_OTP_DELIVERIES_JOB));
        assert.deepEqual({ sent: (otp as { sent: number }).sent }, { sent: 0 });
      });

      it('treats only an unknown job name as unrecoverable', async () => {
        const processor = buildProcessor({});
        await assert.rejects(
          processor.process(asJob('not-a-maintenance-job')),
          (error: unknown) =>
            error instanceof UnrecoverableError &&
            /Unsupported maintenance job/.test(error.message),
        );
      });

      it('retries a pass where a detector failed but keeps a clean pass quiet', async () => {
        const failed: RiskDetectorRunResult = {
          detectors: [],
          failures: [{ category: 'rating_anomaly', message: 'query failed' }],
          created: 0,
          deduplicated: 0,
        };
        const failing = buildProcessor({
          risk: {
            run: async () => ({ job: RUN_RISK_DETECTORS_JOB, ...failed }),
          },
        });
        await assert.rejects(
          failing.process(asJob(RUN_RISK_DETECTORS_JOB)),
          (error: unknown) =>
            error instanceof Error &&
            !(error instanceof UnrecoverableError) &&
            /1 failing detector/.test(error.message),
        );

        const passing = buildProcessor({
          risk: {
            run: async () => ({
              job: RUN_RISK_DETECTORS_JOB,
              detectors: [],
              failures: [],
              created: 2,
              deduplicated: 1,
            }),
          },
        });
        const summary = await passing.process(asJob(RUN_RISK_DETECTORS_JOB));
        assert.equal((summary as { created: number }).created, 2);
      });

      it('does not crash the worker when the schedule cannot be registered', async () => {
        const brokenQueue = {
          upsertJobScheduler: async () => {
            throw new Error('redis unavailable');
          },
        } as unknown as Queue;
        const scheduler = new MaintenanceScheduler(brokenQueue);
        await scheduler.onApplicationBootstrap();
      });
    });
  },
);
