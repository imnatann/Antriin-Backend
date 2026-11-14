import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import {
  RiskService,
  type IngestSignalInput,
} from '../src/modules/risk/risk.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const MICRO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

type Env = Awaited<ReturnType<typeof createEnv>>;

async function createEnv(pool: Pool) {
  const tag = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      'insert into campuses (name) values ($1) returning id',
      ['Campus ' + tag],
    )
  ).rows[0].id;
  const otherCampusId = (
    await pool.query<{ id: string }>(
      'insert into campuses (name) values ($1) returning id',
      ['Other campus ' + tag],
    )
  ).rows[0].id;
  const tenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusId, 'Tenant ' + tag, 'Location ' + tag],
    )
  ).rows[0].id;
  const otherCampusTenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [otherCampusId, 'Other tenant ' + tag, 'Location ' + tag],
    )
  ).rows[0].id;
  const mkUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [name + ' ' + tag],
      )
    ).rows[0].id;
  const analystId = await mkUser('Analyst');
  const managerId = await mkUser('Manager');
  const outsiderId = await mkUser('Outsider');
  const otherCampusManagerId = await mkUser('OtherCampusManager');

  // Reading the queue is separate from deciding on it: the analyst holds only
  // campus.risk.read, the manager holds both permissions.
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [campusId, analystId, ['campus.risk.read']],
  );
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [campusId, managerId, ['campus.risk.read', 'campus.ai_reviews.decide']],
  );
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [
      otherCampusId,
      otherCampusManagerId,
      ['campus.risk.read', 'campus.ai_reviews.decide'],
    ],
  );
  return {
    tag,
    campusId,
    otherCampusId,
    tenantId,
    otherCampusTenantId,
    analystId,
    managerId,
    outsiderId,
    otherCampusManagerId,
  };
}

function signalInput(
  env: Env,
  overrides: Partial<IngestSignalInput> = {},
): IngestSignalInput {
  return {
    campusId: env.campusId,
    tenantId: env.tenantId,
    subjectType: 'tenant',
    subjectId: env.tenantId,
    category: 'rating_anomaly',
    score: 0.87,
    modelVersion: 'rating-detector-1.0.0',
    explanation:
      'Five five-star reviews arrived from accounts created the same day',
    evidence: { reviewCount: 5, windowMinutes: 30 },
    dedupeKey: 'rating:' + randomUUID(),
    ...overrides,
  };
}

describe(
  'Risk slice PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let db: DatabaseService;
    let risk: RiskService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      const access = new AccessService(db);
      risk = new RiskService(db, access, new AuditService(db, access));
    });
    after(async () => {
      await pool?.end();
    });

    it('ingests a signal once per dedupe key and never rewrites it', async () => {
      const env = await createEnv(pool);
      const input = signalInput(env);

      const first = await risk.ingestSignal(input);
      assert.equal(first.created, true);
      assert.match(first.signalId, /^[0-9a-f-]{36}$/i);

      const second = await risk.ingestSignal(input);
      assert.equal(second.created, false);
      assert.equal(second.signalId, first.signalId);

      const stored = await pool.query<{
        count: number;
        score: string;
        evidence: Record<string, unknown>;
        category: string;
      }>(
        `select count(*)::int as count,
                max(score::text) as score,
                max(evidence::text)::jsonb as evidence,
                max(category) as category
           from risk_signals where campus_id = $1`,
        [env.campusId],
      );
      assert.equal(stored.rows[0].count, 1);
      // numeric(5,4) is exposed as a decimal string, never a float.
      assert.equal(stored.rows[0].score, '0.8700');
      assert.equal(stored.rows[0].category, 'rating_anomaly');
      assert.deepEqual(stored.rows[0].evidence, {
        reviewCount: 5,
        windowMinutes: 30,
      });
    });

    it('keeps the pending queue to signals without a decision', async () => {
      const env = await createEnv(pool);
      const decided = await risk.ingestSignal(signalInput(env));
      const open = await risk.ingestSignal(
        signalInput(env, {
          category: 'payment_refund_chain',
          explanation: 'Three top-ups refunded within one hour',
        }),
      );
      await risk.decideRiskSignal(
        env.managerId,
        env.campusId,
        decided.signalId,
        {
          decision: 'no_violation',
          reason: 'The rating spike came from a shared campus event',
        },
      );

      // state defaults to pending.
      const pending = await risk.listRiskReviews(env.managerId, env.campusId);
      assert.deepEqual(
        pending.items.map((item) => item.id),
        [open.signalId],
      );
      assert.equal(pending.items[0].decision, null);

      const decidedPage = await risk.listRiskReviews(
        env.managerId,
        env.campusId,
        { state: 'decided' },
      );
      assert.deepEqual(
        decidedPage.items.map((item) => item.id),
        [decided.signalId],
      );
      assert.equal(decidedPage.items[0].decision?.decision, 'no_violation');
      assert.match(decidedPage.items[0].occurredAt, MICRO_UTC);

      const all = await risk.listRiskReviews(env.managerId, env.campusId, {
        state: 'all',
      });
      assert.equal(all.items.length, 2);
    });

    it('filters the queue by category and validates its options', async () => {
      const env = await createEnv(pool);
      const rating = await risk.ingestSignal(signalInput(env));
      const refund = await risk.ingestSignal(
        signalInput(env, {
          category: 'payment_refund_chain',
          explanation: 'Refund chain across two tenants',
        }),
      );

      const filtered = await risk.listRiskReviews(env.analystId, env.campusId, {
        category: 'payment_refund_chain',
      });
      assert.deepEqual(
        filtered.items.map((item) => item.id),
        [refund.signalId],
      );
      assert.equal(filtered.items[0].category, 'payment_refund_chain');
      assert.equal(typeof filtered.items[0].score, 'string');

      for (const options of [
        { state: 'archived' },
        { category: 'fraud' },
        { limit: 0 },
        { limit: 101 },
        { cursor: 'not-a-cursor' },
      ]) {
        await assert.rejects(
          risk.listRiskReviews(env.analystId, env.campusId, options),
          (error) => (error as { status?: number }).status === 400,
          JSON.stringify(options),
        );
      }
      // The rejected options never hid the valid row.
      const stillThere = await risk.listRiskReviews(
        env.analystId,
        env.campusId,
        {
          category: 'rating_anomaly',
        },
      );
      assert.deepEqual(
        stillThere.items.map((item) => item.id),
        [rating.signalId],
      );
    });

    it('pages the queue by (occurred_at, id) without duplicates', async () => {
      const env = await createEnv(pool);
      const ids: string[] = [];
      for (const hour of ['10', '11', '12']) {
        const ingested = await risk.ingestSignal(
          signalInput(env, {
            occurredAt: '2026-02-01T' + hour + ':00:00.000Z',
          }),
        );
        ids.push(ingested.signalId);
      }

      const first = await risk.listRiskReviews(env.managerId, env.campusId, {
        state: 'all',
        limit: 2,
      });
      assert.equal(first.items.length, 2);
      // Newest signal first: 12:00 then 11:00.
      assert.deepEqual(
        first.items.map((item) => item.id),
        [ids[2], ids[1]],
      );
      assert.ok(first.nextCursor);

      const second = await risk.listRiskReviews(env.managerId, env.campusId, {
        state: 'all',
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      assert.deepEqual(
        second.items.map((item) => item.id),
        [ids[0]],
      );
      assert.equal(second.nextCursor, null);
    });

    it('records a decision, its audit row, and keeps the signal untouched', async () => {
      const env = await createEnv(pool);
      const ingested = await risk.ingestSignal(signalInput(env));

      const decision = await risk.decideRiskSignal(
        env.managerId,
        env.campusId,
        ingested.signalId,
        {
          decision: 'explanation_requested',
          reason: 'Ask the tenant to explain the rating burst',
        },
      );
      assert.match(decision.id, /^[0-9a-f-]{36}$/i);
      assert.equal(decision.decision, 'explanation_requested');
      assert.equal(
        decision.reason,
        'Ask the tenant to explain the rating burst',
      );
      assert.equal(decision.actorUserId, env.managerId);
      assert.match(decision.decidedAt, MICRO_UTC);

      const audit = await pool.query<{
        actor_user_id: string;
        scope_type: string;
        scope_id: string;
        action: string;
        target_type: string;
        target_id: string;
        reason: string;
        metadata: { decision: string; category: string };
      }>(
        `select actor_user_id::text, scope_type, scope_id::text, action,
                target_type, target_id::text, reason, metadata
           from audit_events
          where target_type = 'risk_signal' and target_id = $1`,
        [ingested.signalId],
      );
      assert.equal(audit.rows.length, 1);
      const row = audit.rows[0];
      assert.equal(row.actor_user_id, env.managerId);
      assert.equal(row.scope_type, 'campus');
      assert.equal(row.scope_id, env.campusId);
      assert.equal(row.action, 'campus.risk_review_decided');
      assert.equal(row.reason, 'Ask the tenant to explain the rating burst');
      assert.deepEqual(row.metadata, {
        decision: 'explanation_requested',
        category: 'rating_anomaly',
      });

      // The signal row is append-only: nothing but a decision was written.
      const signal = await pool.query<{ score: string; explanation: string }>(
        'select score::text, explanation from risk_signals where id = $1',
        [ingested.signalId],
      );
      assert.equal(signal.rows[0].score, '0.8700');
      assert.equal(
        signal.rows[0].explanation,
        'Five five-star reviews arrived from accounts created the same day',
      );
    });

    it('keeps the full history when a signal is decided again', async () => {
      const env = await createEnv(pool);
      const ingested = await risk.ingestSignal(signalInput(env));

      const first = await risk.decideRiskSignal(
        env.managerId,
        env.campusId,
        ingested.signalId,
        { decision: 'explanation_requested', reason: 'Ask for an explanation' },
      );
      // Separate transactions: distinct decided_at ordering is meaningful.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await risk.decideRiskSignal(
        env.managerId,
        env.campusId,
        ingested.signalId,
        {
          decision: 'no_violation',
          reason: 'Explanation received and accepted',
        },
      );

      const detail = await risk.getRiskSignal(
        env.managerId,
        env.campusId,
        ingested.signalId,
      );
      assert.equal(detail.decisions.length, 2);
      assert.equal(detail.decisions[0].id, second.id);
      assert.equal(detail.decisions[0].decision, 'no_violation');
      assert.equal(detail.decisions[1].id, first.id);
      assert.equal(detail.decisions[1].decision, 'explanation_requested');
      // The current outcome is the newest decision.
      assert.equal(detail.decision?.id, second.id);

      const pending = await risk.listRiskReviews(env.managerId, env.campusId);
      assert.deepEqual(pending.items, []);
      const decided = await risk.listRiskReviews(env.managerId, env.campusId, {
        state: 'decided',
      });
      assert.deepEqual(
        decided.items.map((item) => item.id),
        [ingested.signalId],
      );
      const auditCount = await pool.query<{ n: number }>(
        `select count(*)::int as n from audit_events
           where target_type = 'risk_signal' and target_id = $1
             and action = 'campus.risk_review_decided'`,
        [ingested.signalId],
      );
      assert.equal(auditCount.rows[0].n, 2);
      const decisions = await pool.query<{ n: number }>(
        'select count(*)::int as n from risk_review_decisions where signal_id = $1',
        [ingested.signalId],
      );
      assert.equal(decisions.rows[0].n, 2);
    });

    it('scopes signals to their campus and denies a missing decision permission', async () => {
      const env = await createEnv(pool);
      const foreign = await risk.ingestSignal(
        signalInput(env, {
          campusId: env.otherCampusId,
          tenantId: env.otherCampusTenantId,
          subjectId: env.otherCampusTenantId,
        }),
      );

      // Reading with campus.risk.read works, deciding does not.
      const page = await risk.listRiskReviews(env.analystId, env.campusId);
      assert.deepEqual(page.items, []);
      const own = await risk.ingestSignal(signalInput(env));
      const detail = await risk.getRiskSignal(
        env.analystId,
        env.campusId,
        own.signalId,
      );
      assert.equal(detail.id, own.signalId);
      await assert.rejects(
        risk.decideRiskSignal(env.analystId, env.campusId, own.signalId, {
          decision: 'no_violation',
          reason: 'Looks fine to me',
        }),
        (error) => (error as { status?: number }).status === 403,
      );

      // A signal of another campus is invisible through this campus scope.
      await assert.rejects(
        risk.getRiskSignal(env.managerId, env.campusId, foreign.signalId),
        (error) => (error as { status?: number }).status === 404,
      );
      await assert.rejects(
        risk.decideRiskSignal(env.managerId, env.campusId, foreign.signalId, {
          decision: 'no_violation',
          reason: 'Not my campus',
        }),
        (error) => (error as { status?: number }).status === 404,
      );
      // The owner of the other campus can still see it.
      const foreignDetail = await risk.getRiskSignal(
        env.otherCampusManagerId,
        env.otherCampusId,
        foreign.signalId,
      );
      assert.equal(foreignDetail.campusId, env.otherCampusId);

      // Without any campus membership the queue is not readable at all.
      await assert.rejects(
        risk.listRiskReviews(env.outsiderId, env.campusId),
        (error) => (error as { status?: number }).status === 403,
      );
    });

    it('rejects a score outside 0..1 at the database constraint', async () => {
      const env = await createEnv(pool);
      await assert.rejects(
        pool.query(
          `insert into risk_signals
             (campus_id, tenant_id, subject_type, subject_id, category, score,
              model_version, explanation, dedupe_key)
           values ($1, $2, 'tenant', $2, 'rating_anomaly', 1.5000,
                   'detector-1.0.0', 'Out of range', $3)`,
          [env.campusId, env.tenantId, 'score:' + randomUUID()],
        ),
        (error) => (error as { code?: string }).code === '23514',
      );
      // The service refuses the same input before it reaches the constraint.
      await assert.rejects(
        risk.ingestSignal(signalInput(env, { score: 1.5 })),
        (error) => (error as { status?: number }).status === 400,
      );
      // The boundaries themselves are valid.
      const low = await risk.ingestSignal(signalInput(env, { score: 0 }));
      const high = await risk.ingestSignal(signalInput(env, { score: 1 }));
      const scores = await pool.query<{ score: string }>(
        'select score::text from risk_signals where id = any($1::uuid[]) order by score',
        [[low.signalId, high.signalId]],
      );
      assert.deepEqual(
        scores.rows.map((row) => row.score),
        ['0.0000', '1.0000'],
      );
    });

    it('refuses a signal for a tenant of another campus', async () => {
      const env = await createEnv(pool);
      await assert.rejects(
        risk.ingestSignal(
          signalInput(env, { tenantId: env.otherCampusTenantId }),
        ),
        (error) => (error as { status?: number }).status === 400,
      );
    });
  },
);
