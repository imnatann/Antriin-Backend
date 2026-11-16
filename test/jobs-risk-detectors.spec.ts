import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { RiskDetectorService } from '../src/modules/risk/risk-detectors.service';
import { RiskService } from '../src/modules/risk/risk.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const MICRO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

describe(
  'Risk detectors against PostgreSQL',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let detectors: RiskDetectorService;
    const campusIds: string[] = [];
    const tenantIds: string[] = [];
    const userIds: string[] = [];
    const orderIds: string[] = [];
    const slotIds: string[] = [];
    const reviewIds: string[] = [];
    const refundIds: string[] = [];
    const topupIds: string[] = [];

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 6 });
      await pool.query('select 1');
      const db = { pool } as unknown as DatabaseService;
      const risk = new RiskService(
        db,
        new AccessService(db),
        new AuditService(db, new AccessService(db)),
      );
      detectors = new RiskDetectorService(db, risk);
    });

    after(async () => {
      // Signals are the only rows the detectors write; remove the evidence they
      // observed here so the DB is left as it was found.
      if (campusIds.length) {
        await pool.query(
          'delete from risk_review_decisions where campus_id = any($1::uuid[])',
          [campusIds],
        );
        await pool.query(
          'delete from risk_signals where campus_id = any($1::uuid[])',
          [campusIds],
        );
      }
      // audit_events are immutable by a DB trigger; the seeded transitions
      // stay, which is exactly what an append-only audit trail means.
      if (reviewIds.length)
        await pool.query('delete from reviews where id = any($1::uuid[])', [
          reviewIds,
        ]);
      if (refundIds.length)
        await pool.query('delete from refunds where id = any($1::uuid[])', [
          refundIds,
        ]);
      if (topupIds.length)
        await pool.query(
          'delete from topup_intents where id = any($1::uuid[])',
          [topupIds],
        );
      // wallet_accounts are retained by a DB trigger (they are ledger owners),
      // so the detector seed wallet and its owner user stay behind.
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
      await pool.end();
    });

    async function mkCampus(): Promise<string> {
      const row = await pool.query<{ id: string }>(
        'insert into campuses (name) values ($1) returning id',
        ['Detector campus ' + randomUUID()],
      );
      campusIds.push(row.rows[0].id);
      return row.rows[0].id;
    }

    async function mkTenant(campusId: string): Promise<string> {
      const row = await pool.query<{ id: string }>(
        `insert into tenants (campus_id, name, location, status)
         values ($1, $2, $3, 'open') returning id`,
        [campusId, 'Tenant ' + randomUUID(), 'Location'],
      );
      tenantIds.push(row.rows[0].id);
      return row.rows[0].id;
    }

    async function mkUser(label: string): Promise<string> {
      const row = await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [label + ' ' + randomUUID()],
      );
      userIds.push(row.rows[0].id);
      return row.rows[0].id;
    }

    async function mkOrder(tenantId: string, buyerId: string): Promise<string> {
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
         values ($1, $2, $3, 'Tenant snapshot', 'Asia/Jakarta', now() - interval '2 hours',
                 now() - interval '1 hour', 'completed', 'IDR', '50000', '50000',
                 now() - interval '3 hours', now() - interval '3 hours',
                 now() - interval '3 hours', now() - interval '2 hours',
                 now() - interval '4 hours', now())
         returning id`,
        [buyerId, tenantId, slot.rows[0].id],
      );
      orderIds.push(order.rows[0].id);
      return order.rows[0].id;
    }

    async function mkReview(input: {
      campusId: string;
      tenantId: string;
      buyerId: string;
      rating: number;
      daysAgo: number;
      status?: 'visible' | 'hidden';
      deleted?: boolean;
      actorId: string;
    }): Promise<string> {
      const orderId = await mkOrder(input.tenantId, input.buyerId);
      const hidden =
        input.status === 'hidden'
          ? { hiddenAt: new Date(), hiddenBy: input.actorId }
          : null;
      const row = await pool.query<{ id: string }>(
        `insert into reviews
           (campus_id, tenant_id, order_id, buyer_id, rating, body, status,
            hidden_at, hidden_by_user_id, deleted_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'detector seed', $6, $7, $8, $9,
                 now() - ($10::int * interval '1 day'), now())
         returning id`,
        [
          input.campusId,
          input.tenantId,
          orderId,
          input.buyerId,
          input.rating,
          input.status ?? 'visible',
          hidden?.hiddenAt ?? null,
          hidden?.hiddenBy ?? null,
          input.deleted ? new Date() : null,
          input.daysAgo,
        ],
      );
      reviewIds.push(row.rows[0].id);
      return row.rows[0].id;
    }

    async function mkRefund(input: {
      campusId: string;
      tenantId: string;
      buyerId: string;
      requestedBy: string;
      minutesAgo: number;
    }): Promise<string> {
      const orderId = await mkOrder(input.tenantId, input.buyerId);
      const row = await pool.query<{ id: string }>(
        `insert into refunds
           (campus_id, tenant_id, order_id, buyer_id, amount_minor, currency, status,
            provider, reason, requested_by_user_id, requested_at, created_at, updated_at)
         values ($1, $2, $3, $4, '50000', 'IDR', 'requested', 'sandbox', 'detector seed',
                 $5, now() - ($6::int * interval '1 minute'),
                 now() - ($6::int * interval '1 minute'), now())
         returning id`,
        [
          input.campusId,
          input.tenantId,
          orderId,
          input.buyerId,
          input.requestedBy,
          input.minutesAgo,
        ],
      );
      refundIds.push(row.rows[0].id);
      return row.rows[0].id;
    }

    async function mkWallet(userId: string): Promise<string> {
      // One wallet per owner and currency (wallet_accounts_owner_currency_uq).
      const wallet = await pool.query<{ id: string }>(
        `insert into wallet_accounts (account_type, owner_user_id, currency)
         values ('wallet', $1, 'IDR') returning id`,
        [userId],
      );
      return wallet.rows[0].id;
    }

    async function mkTopup(
      walletId: string,
      userId: string,
      index: number,
    ): Promise<string> {
      const row = await pool.query<{ id: string }>(
        `insert into topup_intents
           (user_id, wallet_account_id, provider, provider_reference, idempotency_key,
            request_hash, amount_minor, currency, status, status_version, expires_at,
            created_at, updated_at)
         values ($1, $2, 'sandbox', $3, $4, $5, '15000', 'IDR', 'pending', 1,
                 now() + interval '1 hour', now() - interval '10 minutes', now())
         returning id`,
        [
          userId,
          walletId,
          randomUUID() + '-' + String(index),
          randomUUID(),
          'c'.repeat(64),
        ],
      );
      topupIds.push(row.rows[0].id);
      return row.rows[0].id;
    }

    async function signalsFor(subjectId: string) {
      return pool.query<{
        id: string;
        dedupe_key: string;
        occurred_at_iso: string;
      }>(
        `select id::text, dedupe_key,
                to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at_iso
           from risk_signals
          where subject_id = $1
          order by occurred_at, id`,
        [subjectId],
      );
    }

    it('raises one rating_anomaly signal for a concentrated review burst and once per day bucket', async () => {
      const campusId = await mkCampus();
      const tenantId = await mkTenant(campusId);
      const buyerId = await mkUser('Burst buyer');
      for (let index = 0; index < 10; index += 1)
        await mkReview({
          campusId,
          tenantId,
          buyerId,
          rating: 5,
          daysAgo: 0,
          actorId: buyerId,
        });
      // created_at for "daysAgo 0" is now, i.e. inside the 24h window.

      const dayBefore = utcDay();
      await detectors.runAll();
      const first = await signalsFor(tenantId);
      const rerun = await detectors.runAll();
      const after = await signalsFor(tenantId);
      assert.equal(rerun.failures.length, 0);
      const dayAfter = utcDay();

      assert.equal(first.rows.length, 1);
      assert.ok(
        first.rows[0].dedupe_key.startsWith(
          'rating_anomaly:tenant:' + tenantId + ':',
        ),
      );
      assert.match(first.rows[0].dedupe_key, /:\d{4}-\d\d-\d\d$/);
      assert.match(first.rows[0].occurred_at_iso, MICRO_UTC);
      // A rerun in the same UTC day re-uses the signal; across midnight the
      // detector correctly records the next day's window as a new signal.
      assert.equal(after.rows.length, dayBefore === dayAfter ? 1 : 2);

      const detail = await pool.query<{
        campus_id: string;
        tenant_id: string;
        subject_type: string;
        category: string;
        score: string;
        model_version: string;
        explanation: string;
        evidence: Record<string, unknown>;
      }>(
        `select campus_id::text, tenant_id::text, subject_type, category, score::text,
                model_version, explanation, evidence
           from risk_signals where id = $1`,
        [first.rows[0].id],
      );
      const signal = detail.rows[0];
      assert.equal(signal.campus_id, campusId);
      assert.equal(signal.tenant_id, tenantId);
      assert.equal(signal.subject_type, 'tenant');
      assert.equal(signal.category, 'rating_anomaly');
      assert.equal(signal.model_version, 'detectors.v1');
      assert.ok(Number(signal.score) > 0 && Number(signal.score) <= 1);
      assert.match(signal.explanation, /Observed 10 visible review/);
      assert.match(signal.explanation, /does not prove manipulation/);
      const observation = signal.evidence.observation as Record<
        string,
        unknown
      >;
      assert.equal(observation.visibleReviewsInWindow, 10);
      assert.equal(observation.burst, true);
      assert.match(String(observation.windowEnd), MICRO_UTC);
      assert.equal((observation.sampleReviewIds as string[]).length, 10);
    });

    it('raises rating_anomaly when the recent average jumps against the earlier baseline', async () => {
      const campusId = await mkCampus();
      const tenantId = await mkTenant(campusId);
      const buyerId = await mkUser('Jump buyer');
      for (let index = 0; index < 12; index += 1)
        await mkReview({
          campusId,
          tenantId,
          buyerId,
          rating: 1,
          daysAgo: 15,
          actorId: buyerId,
        });
      for (let index = 0; index < 6; index += 1)
        await mkReview({
          campusId,
          tenantId,
          buyerId,
          rating: 5,
          daysAgo: 0,
          actorId: buyerId,
        });

      await detectors.runAll();
      const signals = await signalsFor(tenantId);
      assert.equal(signals.rows.length, 1);
      const row = await pool.query<{
        explanation: string;
        evidence: { observation: Record<string, unknown> };
      }>('select explanation, evidence from risk_signals where id = $1', [
        signals.rows[0].id,
      ]);
      const observation = row.rows[0].evidence.observation;
      assert.equal(observation.burst, false);
      assert.equal(observation.jump, true);
      assert.equal(observation.visibleReviewsInWindow, 6);
      assert.equal(observation.visibleReviewsInBaseline, 12);
      assert.match(row.rows[0].explanation, /average/);
    });

    it('ignores hidden, deleted and below-threshold reviews', async () => {
      const campusId = await mkCampus();
      const hiddenTenant = await mkTenant(campusId);
      const quietTenant = await mkTenant(campusId);
      const buyerId = await mkUser('Ignored buyer');
      for (let index = 0; index < 12; index += 1)
        await mkReview({
          campusId,
          tenantId: hiddenTenant,
          buyerId,
          rating: 5,
          daysAgo: 0,
          status: 'hidden',
          actorId: buyerId,
        });
      for (let index = 0; index < 12; index += 1)
        await mkReview({
          campusId,
          tenantId: hiddenTenant,
          buyerId,
          rating: 5,
          daysAgo: 0,
          deleted: true,
          actorId: buyerId,
        });
      // 9 recent reviews with no baseline: a candidate, but below both
      // thresholds (burst >= 10, jump needs a >= 10 baseline).
      for (let index = 0; index < 9; index += 1)
        await mkReview({
          campusId,
          tenantId: quietTenant,
          buyerId,
          rating: 5,
          daysAgo: 0,
          actorId: buyerId,
        });

      await detectors.runAll();
      assert.equal((await signalsFor(hiddenTenant)).rows.length, 0);
      assert.equal((await signalsFor(quietTenant)).rows.length, 0);
    });

    it('raises a buyer payment_refund_chain signal for refunds alone and for refunds plus top-ups', async () => {
      const campusId = await mkCampus();
      const tenantId = await mkTenant(campusId);
      const adminId = await mkUser('Campus admin');
      const refundsBuyer = await mkUser('Refund buyer');
      for (let index = 0; index < 3; index += 1)
        await mkRefund({
          campusId,
          tenantId,
          buyerId: refundsBuyer,
          requestedBy: adminId,
          minutesAgo: 30 + index,
        });

      const chainBuyer = await mkUser('Chain buyer');
      for (let index = 0; index < 2; index += 1)
        await mkRefund({
          campusId,
          tenantId,
          buyerId: chainBuyer,
          requestedBy: adminId,
          minutesAgo: 20 + index,
        });
      const chainWalletId = await mkWallet(chainBuyer);
      for (let index = 0; index < 6; index += 1)
        await mkTopup(chainWalletId, chainBuyer, index);

      const quietBuyer = await mkUser('Quiet buyer');
      await mkRefund({
        campusId,
        tenantId,
        buyerId: quietBuyer,
        requestedBy: adminId,
        minutesAgo: 10,
      });

      await detectors.runAll();
      const refundSignals = await signalsFor(refundsBuyer);
      assert.equal(refundSignals.rows.length, 1);
      const refundRow = await pool.query<{
        category: string;
        subject_type: string;
        tenant_id: string | null;
        explanation: string;
        evidence: Record<string, unknown>;
      }>(
        `select category, subject_type, tenant_id::text, explanation, evidence
           from risk_signals where id = $1`,
        [refundSignals.rows[0].id],
      );
      assert.equal(refundRow.rows[0].category, 'payment_refund_chain');
      assert.equal(refundRow.rows[0].subject_type, 'buyer');
      assert.equal(refundRow.rows[0].tenant_id, null);
      assert.match(refundRow.rows[0].explanation, /3 refund request/);
      const refundObservation = refundRow.rows[0].evidence
        .observation as Record<string, unknown>;
      assert.equal(refundObservation.refundsInWindow, 3);
      assert.equal(refundObservation.topupIntentsInWindow, 0);

      const chainSignals = await signalsFor(chainBuyer);
      assert.equal(chainSignals.rows.length, 1);
      const chainObservation = (
        await pool.query<{
          evidence: { observation: Record<string, unknown> };
        }>('select evidence from risk_signals where id = $1', [
          chainSignals.rows[0].id,
        ])
      ).rows[0].evidence.observation;
      assert.equal(chainObservation.refundsInWindow, 2);
      assert.equal(chainObservation.topupIntentsInWindow, 6);

      assert.equal((await signalsFor(quietBuyer)).rows.length, 0);
    });

    it('raises a tenant_status_change signal from repeated audit transitions only', async () => {
      const campusId = await mkCampus();
      const tenantId = await mkTenant(campusId);
      const quietTenantId = await mkTenant(campusId);
      // A service actor keeps the immutable audit rows from pinning a user row
      // the cleanup below deletes (audit_events.actor_user_id is RESTRICT).
      const insertChange = async (
        scopeId: string,
        hoursAgo: number,
        to: string,
      ) => {
        await pool.query(
          `insert into audit_events
             (actor_service, scope_type, scope_id, action, target_type, target_id,
              reason, metadata, occurred_at)
           values ('detector-test', 'tenant', $1, 'tenant.status_changed', 'tenant', $1,
                   'detector seed', $2::jsonb, now() - ($3::int * interval '1 hour'))`,
          [
            scopeId,
            JSON.stringify({ from: 'open', to, via: 'campus_admin' }),
            hoursAgo,
          ],
        );
      };
      await insertChange(tenantId, 1, 'paused');
      await insertChange(tenantId, 2, 'open');
      await insertChange(tenantId, 3, 'closed');
      await insertChange(quietTenantId, 1, 'paused');
      await insertChange(quietTenantId, 4, 'open');

      await detectors.runAll();
      const signals = await signalsFor(tenantId);
      assert.equal(signals.rows.length, 1);
      const row = await pool.query<{
        category: string;
        explanation: string;
        evidence: { observation: Record<string, unknown> };
      }>(
        'select category, explanation, evidence from risk_signals where id = $1',
        [signals.rows[0].id],
      );
      assert.equal(row.rows[0].category, 'tenant_status_change');
      assert.equal(row.rows[0].evidence.observation.statusChangesInWindow, 3);
      assert.equal(
        (row.rows[0].evidence.observation.recentChanges as unknown[]).length,
        3,
      );
      assert.match(row.rows[0].explanation, /do not prove misuse/);

      // The detector never changes the tenant or the trail.
      const tenant = await pool.query<{ status: string }>(
        'select status from tenants where id = $1',
        [tenantId],
      );
      assert.equal(tenant.rows[0].status, 'open');
      assert.equal((await signalsFor(quietTenantId)).rows.length, 0);
    });

    it('writes nothing outside risk_signals', async () => {
      // Node runs spec files in parallel against the same database, so a global
      // row set changes for reasons that have nothing to do with the detectors:
      // another spec finishing deletes its own users mid-run. Comparing global
      // ID sets therefore fails spuriously. The proof is scoped instead:
      // snapshot the rows THIS test creates plus its campus/tenant, and assert
      // they survive the detector run unchanged, while the only table whose
      // count may grow is risk_signals.
      const campusId = await mkCampus();
      const tenantId = await mkTenant(campusId);

      // Every count below is scoped to THIS test's campus and tenant. A global
      // count cannot prove anything here: other specs run in parallel against
      // the same database and legitimately create and delete their own rows
      // (the media tombstone sweeper in particular), so a global decrease is
      // not evidence that the detectors deleted something.
      const scopedCounts = async () => {
        const query = async (sql: string, params: unknown[]) => {
          const result = await pool.query<{ count: string }>(sql, params);
          return Number(result.rows[0].count);
        };
        return {
          tenants: await query(
            'select count(*)::text as count from tenants where campus_id = $1',
            [campusId],
          ),
          orders: await query(
            'select count(*)::text as count from orders where tenant_id = $1',
            [tenantId],
          ),
          refunds: await query(
            'select count(*)::text as count from refunds where campus_id = $1',
            [campusId],
          ),
          reviews: await query(
            'select count(*)::text as count from reviews where tenant_id = $1',
            [tenantId],
          ),
          audit: await query(
            'select count(*)::text as count from audit_events where scope_id in ($1::uuid, $2::uuid)',
            [campusId, tenantId],
          ),
          topups: await query(
            'select count(*)::text as count from topup_intents where user_id = $1',
            [tenantId],
          ),
        };
      };

      const before = await scopedCounts();
      const signalsBefore = await pool.query<{ count: string }>(
        'select count(*)::text as count from risk_signals',
      );

      await detectors.runAll();

      // Nothing the detectors touched around this fixture changed: a signal
      // describes a subject, it never mutates it.
      assert.deepEqual(await scopedCounts(), before);

      const campus = await pool.query<{ status: string }>(
        'select status from campuses where id = $1',
        [campusId],
      );
      assert.equal(campus.rows[0].status, 'active');

      // risk_signals is the one table allowed to grow.
      const signalsAfter = await pool.query<{ count: string }>(
        'select count(*)::text as count from risk_signals',
      );
      assert.ok(
        Number(signalsAfter.rows[0].count) >=
          Number(signalsBefore.rows[0].count),
        'risk_signals may only grow',
      );

      // The tenant the detectors looked at is untouched: a signal never has a
      // side effect on the subject it describes.
      const tenant = await pool.query<{ status: string }>(
        'select status from tenants where id = $1',
        [tenantId],
      );
      assert.equal(tenant.rows[0].status, 'open');
    });
  },
);
