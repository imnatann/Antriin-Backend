import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import {
  RiskService,
  type IngestSignalInput,
  type RiskCategory,
} from './risk.service';

/**
 * Evidence-only risk detectors (REQUIREMENTS §3.10.4: the queue covers rating
 * anomalies, top-up/payment/refund chains and repeated tenant status changes).
 *
 * A detector reads a bounded, time-windowed slice of data that already exists,
 * recognises a pattern, and writes ONE immutable `risk_signals` row through
 * `RiskService.ingestSignal`. The only table this service writes is
 * `risk_signals`: no order, wallet, account, tenant, review or balance is
 * changed, and no score is ever turned into a sanction. The explanation states
 * what was observed and says explicitly that it is evidence for a human.
 *
 * Every detector is bounded twice: a fixed window (so no unbounded history is
 * scanned) and a candidate cap (so one pass never walks an entire table). The
 * dedupe key is `category:subjectType:subject:id(+`campus`):UTC day bucket`,
 * so re-running the job - or starting a second worker - cannot create a second
 * signal for the same finding on the same day.
 */

export const RISK_DETECTOR_VERSION = 'detectors.v1';

/** Window for the "recent activity" aggregate of every detector. */
export const DETECTOR_WINDOW_HOURS = 24;
/** Candidates considered per detector per pass (bounded scan). */
export const DETECTOR_CANDIDATE_LIMIT = 50;
/** Sample ids copied into the evidence payload (bounded payload). */
export const DETECTOR_EVIDENCE_SAMPLE_LIMIT = 10;

/** rating_anomaly: a concentration at or above this count in the window. */
export const RATING_BURST_MIN_REVIEWS = 10;
/** rating_anomaly: a jump needs at least this many window reviews to matter. */
export const RATING_CANDIDATE_MIN_REVIEWS = 5;
/** rating_anomaly: earlier history used as the comparison baseline. */
export const RATING_BASELINE_DAYS = 30;
/** rating_anomaly: a baseline needs at least this many reviews to be usable. */
export const RATING_BASELINE_MIN_REVIEWS = 10;
/** rating_anomaly: average shift, in rating points (1..5 scale). */
export const RATING_AVG_JUMP = 1;

/** payment_refund_chain: refunds in the window that are unusual on their own. */
export const PAYMENT_CHAIN_MIN_REFUNDS = 3;
/** payment_refund_chain: refunds that matter together with top-ups. */
export const PAYMENT_CHAIN_MIN_REFUNDS_WITH_TOPUPS = 2;
/** payment_refund_chain: top-ups in the window that complete a chain. */
export const PAYMENT_CHAIN_MIN_TOPUPS = 5;
/** payment_refund_chain: earlier history used for context. */
export const PAYMENT_BASELINE_DAYS = 30;

/** tenant_status_change: status changes in the window that are unusual. */
export const TENANT_STATUS_MIN_CHANGES = 3;
/** tenant_status_change: transitions copied into the evidence payload. */
export const TENANT_STATUS_DETAIL_LIMIT = 5;

export type DetectorOutcome = {
  category: RiskCategory;
  /** Candidate subjects examined in this pass. */
  scanned: number;
  /** Candidates that crossed a threshold. */
  detected: number;
  /** New signals inserted. */
  created: number;
  /** Findings whose dedupe key already existed. */
  deduplicated: number;
};

export type DetectorFailure = { category: RiskCategory; message: string };

export type RiskDetectorRunResult = {
  detectors: DetectorOutcome[];
  failures: DetectorFailure[];
  created: number;
  deduplicated: number;
};

/** PostgreSQL microsecond UTC string (repo convention D7). */
const MICRO_UTC_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

function microUtc(expression: string): string {
  return `to_char((${expression}) AT TIME ZONE 'UTC', ${MICRO_UTC_FORMAT})`;
}

/** The window start expression, parameterised by the window hours ($1). */
const WINDOW_START_EXPRESSION = `now() - ($1::int * interval '1 hour')`;

const RATING_SQL = `
with windowed as (
  select r.tenant_id,
         r.campus_id,
         count(*)::int as recent_count,
         round(avg(r.rating), 2)::text as recent_avg,
         (array_agg(r.id::text order by r.created_at desc))[1:${DETECTOR_EVIDENCE_SAMPLE_LIMIT}] as sample_review_ids
    from reviews r
   where r.status = 'visible'
     and r.deleted_at is null
     and r.created_at >= ${WINDOW_START_EXPRESSION}
     and r.created_at < now()
   group by r.tenant_id, r.campus_id
  having count(*) >= $2
   order by count(*) desc, r.tenant_id
   limit $3
),
baseline as (
  select b.tenant_id,
         count(*)::int as prior_count,
         round(avg(b.rating), 2)::text as prior_avg
    from reviews b
    join windowed w on w.tenant_id = b.tenant_id
   where b.status = 'visible'
     and b.deleted_at is null
     and b.created_at >= ${WINDOW_START_EXPRESSION} - ($4::int * interval '1 day')
     and b.created_at < ${WINDOW_START_EXPRESSION}
   group by b.tenant_id
)
select w.tenant_id::text as tenant_id,
       w.campus_id::text as campus_id,
       w.recent_count,
       w.recent_avg,
       w.sample_review_ids,
       coalesce(b.prior_count, 0) as prior_count,
       b.prior_avg,
       ${microUtc(WINDOW_START_EXPRESSION)} as window_start,
       ${microUtc('now()')} as window_end
  from windowed w
  left join baseline b on b.tenant_id = w.tenant_id`;

const REFUND_CHAIN_SQL = `
with recent as (
  select rf.buyer_id,
         rf.campus_id,
         count(*)::int as refund_count,
         count(*) filter (where rf.status = 'succeeded')::int as succeeded_count,
         coalesce(sum(rf.amount_minor), 0)::text as refund_amount_minor,
         (array_agg(rf.id::text order by rf.created_at desc))[1:${DETECTOR_EVIDENCE_SAMPLE_LIMIT}] as sample_refund_ids
    from refunds rf
   where rf.created_at >= ${WINDOW_START_EXPRESSION}
     and rf.created_at < now()
   group by rf.buyer_id, rf.campus_id
  having count(*) >= $2
   order by count(*) desc, rf.buyer_id
   limit $3
)
select rf.buyer_id::text as buyer_id,
       rf.campus_id::text as campus_id,
       rf.refund_count,
       rf.succeeded_count,
       rf.refund_amount_minor,
       rf.sample_refund_ids,
       ${microUtc(WINDOW_START_EXPRESSION)} as window_start,
       ${microUtc('now()')} as window_end
  from recent rf`;

const TOPUP_COUNT_SQL = `
select user_id::text as user_id, count(*)::int as topup_count
  from topup_intents
 where user_id = any($1::uuid[])
   and created_at >= now() - ($2::int * interval '1 hour')
   and created_at < now()
 group by user_id`;

const REFUND_BASELINE_SQL = `
select buyer_id::text as buyer_id, count(*)::int as prior_refunds
  from refunds
 where buyer_id = any($1::uuid[])
   and created_at >= now() - ($2::int * interval '1 hour') - ($3::int * interval '1 day')
   and created_at < now() - ($2::int * interval '1 hour')
 group by buyer_id`;

const TENANT_STATUS_SQL = `
with changes as (
  select a.scope_id as tenant_id,
         count(*)::int as change_count,
         min(a.occurred_at) as first_change,
         max(a.occurred_at) as last_change
    from audit_events a
   where a.scope_type = 'tenant'
     and a.action = 'tenant.status_changed'
     and a.occurred_at >= ${WINDOW_START_EXPRESSION}
     and a.occurred_at < now()
   group by a.scope_id
  having count(*) >= $2::int
   order by count(*) desc, a.scope_id
   limit $3
)
select c.tenant_id::text as tenant_id,
       t.campus_id::text as campus_id,
       t.status as current_status,
       c.change_count,
       ${microUtc('c.first_change')} as first_change,
       ${microUtc('c.last_change')} as last_change,
       coalesce(d.recent_changes, '[]'::jsonb) as recent_changes,
       ${microUtc(WINDOW_START_EXPRESSION)} as window_start,
       ${microUtc('now()')} as window_end
  from changes c
  join tenants t on t.id = c.tenant_id
  left join lateral (
    select jsonb_agg(x.change order by x.occurred_at desc, x.id desc) as recent_changes
      from (
        select a.id,
               a.occurred_at,
               jsonb_build_object(
                 'from', a.metadata->>'from',
                 'to', a.metadata->>'to',
                 'actorUserId', a.actor_user_id::text,
                 'occurredAt', to_char(a.occurred_at AT TIME ZONE 'UTC', ${MICRO_UTC_FORMAT})
               ) as change
          from audit_events a
         where a.scope_type = 'tenant'
           and a.action = 'tenant.status_changed'
           and a.scope_id = c.tenant_id
           and a.occurred_at >= ${WINDOW_START_EXPRESSION}
           and a.occurred_at < now()
         order by a.occurred_at desc, a.id desc
         limit $4
      ) x
  ) d on true`;

type RatingRow = {
  tenant_id: string;
  campus_id: string;
  recent_count: number;
  recent_avg: string;
  sample_review_ids: string[] | null;
  prior_count: number;
  prior_avg: string | null;
  window_start: string;
  window_end: string;
};

type RefundChainRow = {
  buyer_id: string;
  campus_id: string;
  refund_count: number;
  succeeded_count: number;
  refund_amount_minor: string;
  sample_refund_ids: string[] | null;
  window_start: string;
  window_end: string;
};

type TopupCountRow = { user_id: string; topup_count: number };
type RefundBaselineRow = { buyer_id: string; prior_refunds: number };

type TenantStatusRow = {
  tenant_id: string;
  campus_id: string;
  current_status: string;
  change_count: number;
  first_change: string;
  last_change: string;
  recent_changes: Array<{
    from: string | null;
    to: string | null;
    actorUserId: string | null;
    occurredAt: string;
  }>;
  window_start: string;
  window_end: string;
};

@Injectable()
export class RiskDetectorService {
  private readonly logger = new Logger(RiskDetectorService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly risk: RiskService,
  ) {}

  /**
   * Runs all detectors. One failing detector does not stop the others: each is
   * isolated and its error is reported, so a single broken query cannot starve
   * the queue. The caller (the scheduled job) decides whether to retry.
   */
  async runAll(): Promise<RiskDetectorRunResult> {
    const detectors: Array<{
      category: RiskCategory;
      run: () => Promise<DetectorOutcome>;
    }> = [
      { category: 'rating_anomaly', run: () => this.detectRatingAnomalies() },
      {
        category: 'payment_refund_chain',
        run: () => this.detectPaymentRefundChains(),
      },
      {
        category: 'tenant_status_change',
        run: () => this.detectTenantStatusChanges(),
      },
    ];
    const outcomes: DetectorOutcome[] = [];
    const failures: DetectorFailure[] = [];
    for (const detector of detectors) {
      try {
        outcomes.push(await detector.run());
      } catch (error) {
        const message = messageOf(error);
        failures.push({ category: detector.category, message });
        this.logger.warn(
          'Risk detector ' + detector.category + ' failed: ' + message,
        );
      }
    }
    return {
      detectors: outcomes,
      failures,
      created: outcomes.reduce((total, item) => total + item.created, 0),
      deduplicated: outcomes.reduce(
        (total, item) => total + item.deduplicated,
        0,
      ),
    };
  }

  /**
   * rating_anomaly - a tenant whose recent visible reviews are concentrated
   * (>= RATING_BURST_MIN_REVIEWS in the window) or whose average shifted by at
   * least RATING_AVG_JUMP against its earlier baseline.
   *
   * Only visible, non-deleted reviews count: hiding or deleting reviews must
   * not be able to manufacture a signal.
   */
  async detectRatingAnomalies(): Promise<DetectorOutcome> {
    const result = await this.database.pool.query<RatingRow>(RATING_SQL, [
      DETECTOR_WINDOW_HOURS,
      RATING_CANDIDATE_MIN_REVIEWS,
      DETECTOR_CANDIDATE_LIMIT,
      RATING_BASELINE_DAYS,
    ]);
    let detected = 0;
    let created = 0;
    let deduplicated = 0;
    for (const row of result.rows) {
      const recentAvg = Number(row.recent_avg);
      const priorAvg = row.prior_avg === null ? null : Number(row.prior_avg);
      const burst = row.recent_count >= RATING_BURST_MIN_REVIEWS;
      const delta =
        priorAvg === null || Number.isNaN(recentAvg) ? 0 : recentAvg - priorAvg;
      const jump =
        priorAvg !== null &&
        row.prior_count >= RATING_BASELINE_MIN_REVIEWS &&
        Math.abs(delta) >= RATING_AVG_JUMP;
      if (!burst && !jump) continue;
      detected += 1;
      const bucket = utcDayBucket(row.window_end);
      const observation = {
        windowHours: DETECTOR_WINDOW_HOURS,
        windowStart: row.window_start,
        windowEnd: row.window_end,
        visibleReviewsInWindow: row.recent_count,
        averageRatingInWindow: row.recent_avg,
        baselineDays: RATING_BASELINE_DAYS,
        visibleReviewsInBaseline: row.prior_count,
        averageRatingInBaseline: row.prior_avg,
        averageRatingDelta: delta.toFixed(2),
        burst,
        jump,
        sampleReviewIds: row.sample_review_ids ?? [],
      };
      const explanation = [
        `Observed ${String(row.recent_count)} visible review(s) for this tenant in the ${String(DETECTOR_WINDOW_HOURS)}h window ending ${row.window_end}.`,
        row.prior_count > 0
          ? `The earlier ${String(RATING_BASELINE_DAYS)} days hold ${String(row.prior_count)} visible review(s) with an average of ${String(row.prior_avg)} versus ${row.recent_avg} in the window.`
          : `The tenant has no visible reviews in the earlier ${String(RATING_BASELINE_DAYS)} day baseline.`,
        burst
          ? `The window count is at or above the concentration threshold of ${String(RATING_BURST_MIN_REVIEWS)} reviews.`
          : `The window average differs from the baseline by ${delta.toFixed(2)} rating points (threshold ${String(RATING_AVG_JUMP)}).`,
        'This is evidence for human review only: a concentration or shift does not prove manipulation, and no review, order, account or balance was changed.',
      ].join(' ');
      const ingested = await this.ingest({
        campusId: row.campus_id,
        tenantId: row.tenant_id,
        subjectType: 'tenant',
        subjectId: row.tenant_id,
        category: 'rating_anomaly',
        score: ratingScore(row.recent_count, delta, jump),
        explanation,
        evidence: {
          detector: 'rating_anomaly',
          detectorVersion: RISK_DETECTOR_VERSION,
          scope: 'reviews.status = visible and reviews.deleted_at is null',
          observation,
          note: 'Evidence only; a campus reviewer decides what it means.',
        },
        dedupeKey: `rating_anomaly:tenant:${row.tenant_id}:${bucket}`,
      });
      if (ingested === 'created') created += 1;
      else deduplicated += 1;
    }
    return {
      category: 'rating_anomaly',
      scanned: result.rows.length,
      detected,
      created,
      deduplicated,
    };
  }

  /**
   * payment_refund_chain - a buyer with an unusual refund/top-up pattern in a
   * short window: enough refunds to stand on their own, or fewer refunds
   * combined with a burst of top-ups.
   *
   * Refunds, top-up intents and wallet balances are only READ. Counting refund
   * intents (including failed ones) never implies money moved; the evidence
   * records the statuses it saw.
   */
  async detectPaymentRefundChains(): Promise<DetectorOutcome> {
    const result = await this.database.pool.query<RefundChainRow>(
      REFUND_CHAIN_SQL,
      [
        DETECTOR_WINDOW_HOURS,
        PAYMENT_CHAIN_MIN_REFUNDS_WITH_TOPUPS,
        DETECTOR_CANDIDATE_LIMIT,
      ],
    );
    if (result.rows.length === 0)
      return {
        category: 'payment_refund_chain',
        scanned: 0,
        detected: 0,
        created: 0,
        deduplicated: 0,
      };

    const buyerIds = [...new Set(result.rows.map((row) => row.buyer_id))];
    const [topups, baseline] = await Promise.all([
      this.database.pool.query<TopupCountRow>(TOPUP_COUNT_SQL, [
        buyerIds,
        DETECTOR_WINDOW_HOURS,
      ]),
      this.database.pool.query<RefundBaselineRow>(REFUND_BASELINE_SQL, [
        buyerIds,
        DETECTOR_WINDOW_HOURS,
        PAYMENT_BASELINE_DAYS,
      ]),
    ]);
    const topupsByBuyer = new Map(
      topups.rows.map((row) => [row.user_id, row.topup_count]),
    );
    const baselineByBuyer = new Map(
      baseline.rows.map((row) => [row.buyer_id, row.prior_refunds]),
    );

    let detected = 0;
    let created = 0;
    let deduplicated = 0;
    for (const row of result.rows) {
      const topupCount = topupsByBuyer.get(row.buyer_id) ?? 0;
      const priorRefunds = baselineByBuyer.get(row.buyer_id) ?? 0;
      const refundsAlone = row.refund_count >= PAYMENT_CHAIN_MIN_REFUNDS;
      const withTopups =
        row.refund_count >= PAYMENT_CHAIN_MIN_REFUNDS_WITH_TOPUPS &&
        topupCount >= PAYMENT_CHAIN_MIN_TOPUPS;
      if (!refundsAlone && !withTopups) continue;
      detected += 1;
      const bucket = utcDayBucket(row.window_end);
      const observation = {
        windowHours: DETECTOR_WINDOW_HOURS,
        windowStart: row.window_start,
        windowEnd: row.window_end,
        refundsInWindow: row.refund_count,
        succeededRefundsInWindow: row.succeeded_count,
        refundAmountMinor: row.refund_amount_minor,
        currency: 'IDR',
        topupIntentsInWindow: topupCount,
        refundsInBaseline: priorRefunds,
        baselineDays: PAYMENT_BASELINE_DAYS,
        sampleRefundIds: row.sample_refund_ids ?? [],
      };
      const explanation = [
        `Observed ${String(row.refund_count)} refund request(s) for this buyer in the ${String(DETECTOR_WINDOW_HOURS)}h window ending ${row.window_end}, of which ${String(row.succeeded_count)} succeeded, alongside ${String(topupCount)} top-up intent(s).`,
        `The buyer had ${String(priorRefunds)} refund request(s) in the preceding ${String(PAYMENT_BASELINE_DAYS)} days.`,
        refundsAlone
          ? `The window refund count is at or above the threshold of ${String(PAYMENT_CHAIN_MIN_REFUNDS)}.`
          : `The refund/top-up combination crosses ${String(PAYMENT_CHAIN_MIN_REFUNDS_WITH_TOPUPS)} refund(s) with ${String(PAYMENT_CHAIN_MIN_TOPUPS)} top-up intent(s).`,
        'This is evidence for human review only: a refund/top-up pattern does not prove misuse by itself, and no refund, top-up, wallet or order state was changed.',
      ].join(' ');
      const ingested = await this.ingest({
        campusId: row.campus_id,
        tenantId: null,
        subjectType: 'buyer',
        subjectId: row.buyer_id,
        category: 'payment_refund_chain',
        score: paymentChainScore(row.refund_count, topupCount),
        explanation,
        evidence: {
          detector: 'payment_refund_chain',
          detectorVersion: RISK_DETECTOR_VERSION,
          scope: 'refund requests and top-up intents created in the window',
          observation,
          note: 'Evidence only; a campus reviewer decides what it means.',
        },
        dedupeKey: `payment_refund_chain:buyer:${row.campus_id}:${row.buyer_id}:${bucket}`,
      });
      if (ingested === 'created') created += 1;
      else deduplicated += 1;
    }
    return {
      category: 'payment_refund_chain',
      scanned: result.rows.length,
      detected,
      created,
      deduplicated,
    };
  }

  /**
   * tenant_status_change - a tenant whose status was changed repeatedly in a
   * short window. The source is the append-only audit trail written by the
   * tenant status endpoints (`tenant.status_changed`), which is the only place
   * a status transition is recorded with its actor and reason.
   *
   * Reading the audit trail cannot change a tenant: nothing here writes a
   * tenant row, and the signal does not pause or suspend anything.
   */
  async detectTenantStatusChanges(): Promise<DetectorOutcome> {
    const result = await this.database.pool.query<TenantStatusRow>(
      TENANT_STATUS_SQL,
      [
        DETECTOR_WINDOW_HOURS,
        TENANT_STATUS_MIN_CHANGES,
        DETECTOR_CANDIDATE_LIMIT,
        TENANT_STATUS_DETAIL_LIMIT,
      ],
    );
    let detected = 0;
    let created = 0;
    let deduplicated = 0;
    for (const row of result.rows) {
      detected += 1;
      const bucket = utcDayBucket(row.window_end);
      const latest = row.recent_changes[0];
      const observation = {
        windowHours: DETECTOR_WINDOW_HOURS,
        windowStart: row.window_start,
        windowEnd: row.window_end,
        statusChangesInWindow: row.change_count,
        currentStatus: row.current_status,
        firstChangeAt: row.first_change,
        lastChangeAt: row.last_change,
        recentChanges: row.recent_changes,
      };
      const explanation = [
        `Observed ${String(row.change_count)} tenant status change(s) for this tenant in the ${String(DETECTOR_WINDOW_HOURS)}h window ending ${row.window_end} (threshold ${String(TENANT_STATUS_MIN_CHANGES)}); the tenant is currently '${row.current_status}'.`,
        latest
          ? `Latest recorded transition: '${latest.from ?? 'unknown'}' -> '${latest.to ?? 'unknown'}' at ${latest.occurredAt}.`
          : 'The audit trail holds no detail rows for this window.',
        'This is evidence for human review only: repeated status changes do not prove misuse, and no tenant, order, account or balance was changed.',
      ].join(' ');
      const ingested = await this.ingest({
        campusId: row.campus_id,
        tenantId: row.tenant_id,
        subjectType: 'tenant',
        subjectId: row.tenant_id,
        category: 'tenant_status_change',
        score: tenantStatusScore(row.change_count),
        explanation,
        evidence: {
          detector: 'tenant_status_change',
          detectorVersion: RISK_DETECTOR_VERSION,
          scope:
            'audit_events action = tenant.status_changed within the window',
          observation,
          note: 'Evidence only; a campus reviewer decides what it means.',
        },
        dedupeKey: `tenant_status_change:tenant:${row.tenant_id}:${bucket}`,
      });
      if (ingested === 'created') created += 1;
      else deduplicated += 1;
    }
    return {
      category: 'tenant_status_change',
      scanned: result.rows.length,
      detected,
      created,
      deduplicated,
    };
  }

  private async ingest(
    input: Omit<IngestSignalInput, 'modelVersion'>,
  ): Promise<'created' | 'deduplicated'> {
    const result = await this.risk.ingestSignal({
      ...input,
      modelVersion: RISK_DETECTOR_VERSION,
    });
    return result.created ? 'created' : 'deduplicated';
  }
}

/** UTC day bucket for the dedupe key, taken from the DB window end. */
function utcDayBucket(windowEnd: string): string {
  const bucket = windowEnd.slice(0, 10);
  if (!/^\d{4}-\d\d-\d\d$/.test(bucket))
    throw new Error('Unexpected detector window timestamp: ' + windowEnd);
  return bucket;
}

function clampScore(value: number): string {
  return Math.min(1, Math.max(0, value)).toFixed(4);
}

function ratingScore(count: number, delta: number, jump: boolean): string {
  const burst = Math.min(1, count / (2 * RATING_BURST_MIN_REVIEWS));
  const shift = jump ? Math.min(1, Math.abs(delta) / 2) : 0;
  return clampScore(Math.max(burst, shift));
}

function paymentChainScore(refunds: number, topups: number): string {
  const refundScore = Math.min(1, refunds / (2 * PAYMENT_CHAIN_MIN_REFUNDS));
  const topupScore =
    topups >= PAYMENT_CHAIN_MIN_TOPUPS ? Math.min(1, topups / 10) : 0;
  return clampScore(Math.max(refundScore, topupScore));
}

function tenantStatusScore(changes: number): string {
  return clampScore(changes / (2 * TENANT_STATUS_MIN_CHANGES));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
