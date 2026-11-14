import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { uuidPattern } from '../notifications/outbox.service';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_EXPLANATION_LENGTH = 4000;

export const RISK_CATEGORIES = [
  'rating_anomaly',
  'payment_refund_chain',
  'tenant_status_change',
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_SUBJECT_TYPES = ['tenant', 'buyer', 'order'] as const;
export type RiskSubjectType = (typeof RISK_SUBJECT_TYPES)[number];

export const RISK_DECISIONS = [
  'no_violation',
  'explanation_requested',
] as const;
export type RiskDecision = (typeof RISK_DECISIONS)[number];

/** Queue filter: a signal is pending until a human decision row exists. */
export const RISK_REVIEW_STATES = ['pending', 'decided', 'all'] as const;
export type RiskReviewState = (typeof RISK_REVIEW_STATES)[number];

export type RiskDecisionView = {
  id: string;
  decision: RiskDecision;
  reason: string;
  decidedAt: string;
  actorUserId: string;
};

export type RiskSignalView = {
  id: string;
  campusId: string;
  tenantId: string | null;
  subjectType: RiskSubjectType;
  subjectId: string;
  category: RiskCategory;
  score: string;
  modelVersion: string;
  explanation: string;
  evidence: Record<string, unknown>;
  occurredAt: string;
  decision: RiskDecisionView | null;
};

/** Signal detail carries the full, newest-first decision trail. */
export type RiskSignalDetail = RiskSignalView & {
  decisions: RiskDecisionView[];
};

export type RiskSignalPage = {
  items: RiskSignalView[];
  nextCursor: string | null;
};

export type RiskDecisionInput = { decision: string; reason: string };

/** Producer contract for a future detector; never exposed as a route. */
export type IngestSignalInput = {
  campusId: string;
  tenantId?: string | null;
  subjectType: string;
  subjectId: string;
  category: string;
  score: number | string;
  modelVersion: string;
  explanation: string;
  evidence?: Record<string, unknown> | null;
  dedupeKey: string;
  /** Detection time supplied by the producer; defaults to now(). */
  occurredAt?: string;
};

export type IngestSignalResult = { created: boolean; signalId: string };

type SignalRow = {
  id: string;
  campus_id: string;
  tenant_id: string | null;
  subject_type: RiskSubjectType;
  subject_id: string;
  category: RiskCategory;
  score: string;
  model_version: string;
  explanation: string;
  evidence: Record<string, unknown>;
  occurred_at: string;
  decision_id: string | null;
  decision_value: RiskDecision | null;
  decision_reason: string | null;
  decision_decided_at: string | null;
  decision_actor_user_id: string | null;
};

type DecisionRow = {
  id: string;
  decision: RiskDecision;
  reason: string;
  decided_at: string;
  actor_user_id: string;
};

type Cursor = { occurredAt: string; id: string };

/**
 * Response timestamps must be the DB microsecond UTC strings themselves (D7):
 * re-serializing through Date/toISOString truncates to milliseconds.
 */
function microUtc(column: string, alias: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${alias}`;
}

// The newest decision travels with every queue row (one lateral join) so the
// list needs a single query instead of one query per signal.
const SIGNAL_COLUMNS = [
  's.id::text',
  's.campus_id::text',
  's.tenant_id::text',
  's.subject_type',
  's.subject_id::text',
  's.category',
  's.score::text as score',
  's.model_version',
  's.explanation',
  's.evidence',
  microUtc('s.occurred_at', 'occurred_at'),
  'dec.decision_id',
  'dec.decision_value',
  'dec.decision_reason',
  microUtc('dec.decision_decided_at', 'decision_decided_at'),
  'dec.decision_actor_user_id',
].join(', ');

const LATEST_DECISION_JOIN = `left join lateral (
  select d.id::text as decision_id,
         d.decision as decision_value,
         d.reason as decision_reason,
         d.actor_user_id::text as decision_actor_user_id,
         d.decided_at as decision_decided_at
    from risk_review_decisions d
   where d.signal_id = s.id
   order by d.decided_at desc, d.id desc
   limit 1
) dec on true`;

const DECISION_COLUMNS = [
  'id::text',
  'decision',
  'reason',
  microUtc('decided_at', 'decided_at'),
  'actor_user_id::text',
].join(', ');

/**
 * Risk/AI review queue (REQUIREMENTS §3.10.4-6).
 *
 * A signal is evidence, never a sanction. This service only reads signals and
 * appends human decisions: nothing here blocks an account, hides a review,
 * moves money or derives a punishment from the score. Both tables are
 * append-only, so the queue state is derived from the presence of a decision
 * and the whole decision history stays readable.
 */
@Injectable()
export class RiskService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /** Campus review queue, newest signal first, filtered by state/category. */
  async listRiskReviews(
    actorUserId: string,
    campusId: string,
    options: {
      state?: string;
      category?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<RiskSignalPage> {
    this.assertUuid(actorUserId, 'user');
    this.assertUuid(campusId, 'campus');
    const state = normalizeState(options.state);
    const category = normalizeCategory(options.category);
    const limit = normalizeLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.risk.read',
        tx,
      );
      const values: unknown[] = [campusId];
      const conditions = ['s.campus_id = $1'];
      if (category) {
        values.push(category);
        conditions.push('s.category = $' + String(values.length));
      }
      if (state === 'pending') conditions.push('dec.decision_id is null');
      if (state === 'decided') conditions.push('dec.decision_id is not null');
      if (cursor) {
        values.push(cursor.occurredAt, cursor.id);
        conditions.push(
          '(s.occurred_at, s.id) < ($' +
            String(values.length - 1) +
            '::timestamptz, $' +
            String(values.length) +
            '::uuid)',
        );
      }
      values.push(limit + 1);
      const result = await tx.query<SignalRow>(
        `select ${SIGNAL_COLUMNS}
           from risk_signals s
           ${LATEST_DECISION_JOIN}
          where ${conditions.join(' and ')}
          order by s.occurred_at desc, s.id desc
          limit $` + String(values.length),
        values,
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => this.toView(row)),
        nextCursor:
          hasMore && last
            ? encodeCursor({ occurredAt: last.occurred_at, id: last.id })
            : null,
      };
    });
  }

  /** One signal of this campus with its complete decision history. */
  async getRiskSignal(
    actorUserId: string,
    campusId: string,
    signalId: string,
  ): Promise<RiskSignalDetail> {
    this.assertUuid(actorUserId, 'user');
    this.assertUuid(campusId, 'campus');
    this.assertUuid(signalId, 'risk signal');
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.risk.read',
        tx,
      );
      const signal = await this.getScopedSignal(tx, campusId, signalId);
      const decisions = await tx.query<DecisionRow>(
        `select ${DECISION_COLUMNS}
           from risk_review_decisions
          where signal_id = $1 and campus_id = $2
          order by decided_at desc, id desc`,
        [signalId, campusId],
      );
      return {
        ...this.toView(signal),
        decisions: decisions.rows.map((row) => this.toDecisionView(row)),
      };
    });
  }

  /**
   * Appends a human decision on one signal. Re-deciding is allowed and keeps
   * every earlier decision; the signal row itself is locked FOR UPDATE so two
   * concurrent decisions serialize and the audit order matches the history.
   */
  async decideRiskSignal(
    actorUserId: string,
    campusId: string,
    signalId: string,
    input: RiskDecisionInput,
  ): Promise<RiskDecisionView> {
    this.assertUuid(actorUserId, 'user');
    this.assertUuid(campusId, 'campus');
    this.assertUuid(signalId, 'risk signal');
    const decision = normalizeDecision(input?.decision);
    const reason = normalizeReason(input?.reason);
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.ai_reviews.decide',
        tx,
      );
      // FOR UPDATE serializes decisions on the same signal; the row is only
      // read, never mutated: a signal stays exactly as the detector produced it.
      const locked = await tx.query<{
        id: string;
        category: RiskCategory;
      }>(
        'select id::text, category from risk_signals where id = $1 and campus_id = $2 for update',
        [signalId, campusId],
      );
      const signal = locked.rows[0];
      if (!signal) throw new NotFoundException('Risk signal was not found');
      const inserted = await tx.query<DecisionRow>(
        `insert into risk_review_decisions
           (signal_id, campus_id, actor_user_id, decision, reason, decided_at)
         values ($1, $2, $3, $4, $5, now())
         returning ` + DECISION_COLUMNS,
        [signalId, campusId, actorUserId, decision, reason],
      );
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'campus',
        scopeId: campusId,
        action: 'campus.risk_review_decided',
        targetType: 'risk_signal',
        targetId: signalId,
        reason,
        metadata: { decision, category: signal.category },
      });
      return this.toDecisionView(inserted.rows[0]);
    });
  }

  /**
   * Internal producer entry point for a future detector (no route). Insert is
   * deduplicated by dedupe_key, so re-running the same detection cannot create
   * a second signal and never touches an existing one.
   */
  async ingestSignal(input: IngestSignalInput): Promise<IngestSignalResult> {
    const campusId = input?.campusId;
    this.assertUuid(campusId, 'campus');
    const tenantId =
      input.tenantId === undefined || input.tenantId === null
        ? null
        : input.tenantId;
    if (tenantId !== null) this.assertUuid(tenantId, 'tenant');
    const subjectType = input?.subjectType;
    if (!isSubjectType(subjectType))
      throw new BadRequestException({
        code: 'RISK_SUBJECT_TYPE_INVALID',
        message: 'subjectType must be one of: ' + RISK_SUBJECT_TYPES.join(', '),
      });
    this.assertUuid(input?.subjectId, 'subject');
    const category = input?.category;
    if (!isCategory(category))
      throw new BadRequestException({
        code: 'RISK_CATEGORY_INVALID',
        message: 'category must be one of: ' + RISK_CATEGORIES.join(', '),
      });
    const score = normalizeScore(input?.score);
    const modelVersion =
      typeof input?.modelVersion === 'string' ? input.modelVersion.trim() : '';
    if (!modelVersion || modelVersion.length > 64)
      throw new BadRequestException({
        code: 'RISK_MODEL_VERSION_INVALID',
        message: 'modelVersion must be 1 to 64 characters',
      });
    const explanation =
      typeof input?.explanation === 'string' ? input.explanation.trim() : '';
    if (!explanation || explanation.length > MAX_EXPLANATION_LENGTH)
      throw new BadRequestException({
        code: 'RISK_EXPLANATION_INVALID',
        message:
          'explanation must be 1 to ' +
          String(MAX_EXPLANATION_LENGTH) +
          ' characters',
      });
    const evidence = normalizeEvidence(input?.evidence);
    const dedupeKey =
      typeof input?.dedupeKey === 'string' ? input.dedupeKey.trim() : '';
    if (!dedupeKey || dedupeKey.length > 200)
      throw new BadRequestException({
        code: 'RISK_DEDUPE_KEY_INVALID',
        message: 'dedupeKey must be 1 to 200 characters',
      });
    const occurredAt = normalizeOccurredAt(input?.occurredAt);

    return this.withTransaction(undefined, async (tx) => {
      if (tenantId !== null) {
        const tenant = await tx.query(
          'select 1 from tenants where id = $1 and campus_id = $2',
          [tenantId, campusId],
        );
        if (!tenant.rows[0])
          throw new BadRequestException({
            code: 'RISK_TENANT_NOT_IN_CAMPUS',
            message: 'The tenant does not belong to this campus',
          });
      }
      const inserted = await tx.query<{ id: string }>(
        `insert into risk_signals
           (campus_id, tenant_id, subject_type, subject_id, category, score,
            model_version, explanation, evidence, dedupe_key, occurred_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10,
                 coalesce($11::timestamptz, now()), now())
         on conflict (dedupe_key) do nothing
         returning id::text`,
        [
          campusId,
          tenantId,
          subjectType,
          input.subjectId,
          category,
          score,
          modelVersion,
          explanation,
          JSON.stringify(evidence),
          dedupeKey,
          occurredAt,
        ],
      );
      const created = inserted.rows[0];
      if (created) return { created: true, signalId: created.id };
      const existing = await tx.query<{ id: string }>(
        'select id::text from risk_signals where dedupe_key = $1',
        [dedupeKey],
      );
      const row = existing.rows[0];
      if (!row)
        throw new ConflictException({
          code: 'RISK_SIGNAL_DEDUPE_RACE',
          message: 'The signal could not be read after a dedupe conflict',
        });
      return { created: false, signalId: row.id };
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Reads one signal inside the campus scope; another campus is a 404. */
  private async getScopedSignal(
    tx: PoolClient,
    campusId: string,
    signalId: string,
  ): Promise<SignalRow> {
    const result = await tx.query<SignalRow>(
      `select ${SIGNAL_COLUMNS}
         from risk_signals s
         ${LATEST_DECISION_JOIN}
        where s.id = $1 and s.campus_id = $2`,
      [signalId, campusId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Risk signal was not found');
    return row;
  }

  private toView(row: SignalRow): RiskSignalView {
    return {
      id: row.id,
      campusId: row.campus_id,
      tenantId: row.tenant_id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      category: row.category,
      score: row.score,
      modelVersion: row.model_version,
      explanation: row.explanation,
      evidence: row.evidence ?? {},
      occurredAt: row.occurred_at,
      decision: row.decision_id
        ? {
            id: row.decision_id,
            decision: row.decision_value ?? 'no_violation',
            reason: row.decision_reason ?? '',
            decidedAt: row.decision_decided_at ?? '',
            actorUserId: row.decision_actor_user_id ?? '',
          }
        : null,
    };
  }

  private toDecisionView(row: DecisionRow): RiskDecisionView {
    return {
      id: row.id,
      decision: row.decision,
      reason: row.reason,
      decidedAt: row.decided_at,
      actorUserId: row.actor_user_id,
    };
  }

  private async withTransaction<T>(
    client: PoolClient | undefined,
    operation: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (client) return operation(client);
    const connection = await this.database.pool.connect();
    try {
      await connection.query('begin');
      const result = await operation(connection);
      await connection.query('commit');
      return result;
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  private assertUuid(value: string, name: string): void {
    if (!uuidPattern.test(value ?? ''))
      throw new BadRequestException('Invalid ' + name + ' id');
  }
}

function isCategory(value: unknown): value is RiskCategory {
  return (
    typeof value === 'string' &&
    (RISK_CATEGORIES as readonly string[]).includes(value)
  );
}

function isSubjectType(value: unknown): value is RiskSubjectType {
  return (
    typeof value === 'string' &&
    (RISK_SUBJECT_TYPES as readonly string[]).includes(value)
  );
}

function normalizeState(value: string | undefined): RiskReviewState {
  if (value === undefined) return 'pending';
  if (!(RISK_REVIEW_STATES as readonly string[]).includes(value))
    throw new BadRequestException({
      code: 'RISK_REVIEW_STATE_INVALID',
      message: 'state must be one of: ' + RISK_REVIEW_STATES.join(', '),
    });
  return value as RiskReviewState;
}

function normalizeCategory(
  value: string | undefined,
): RiskCategory | undefined {
  if (value === undefined) return undefined;
  if (!isCategory(value))
    throw new BadRequestException({
      code: 'RISK_CATEGORY_INVALID',
      message: 'category must be one of: ' + RISK_CATEGORIES.join(', '),
    });
  return value;
}

function normalizeDecision(value: unknown): RiskDecision {
  if (
    typeof value !== 'string' ||
    !(RISK_DECISIONS as readonly string[]).includes(value)
  )
    throw new BadRequestException({
      code: 'RISK_DECISION_INVALID',
      message: 'decision must be one of: ' + RISK_DECISIONS.join(', '),
    });
  return value as RiskDecision;
}

function normalizeReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason || reason.length > 500)
    throw new BadRequestException({
      code: 'RISK_DECISION_REASON_INVALID',
      message: 'A decision reason of 1 to 500 characters is required',
    });
  return reason;
}

/** numeric(5,4): the score is stored with four decimals, as a string view. */
function normalizeScore(value: unknown): string {
  const parsed =
    typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : typeof value === 'number'
        ? value
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
    throw new BadRequestException({
      code: 'RISK_SCORE_INVALID',
      message: 'score must be a number between 0 and 1',
    });
  return parsed.toFixed(4);
}

function normalizeEvidence(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException({
      code: 'RISK_EVIDENCE_INVALID',
      message: 'evidence must be a JSON object',
    });
  return value;
}

function normalizeOccurredAt(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new BadRequestException({
      code: 'RISK_OCCURRED_AT_INVALID',
      message: 'occurredAt must be an ISO 8601 timestamp',
    });
  return new Date(Date.parse(value)).toISOString();
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT)
    throw new BadRequestException(
      'limit must be an integer from 1 to ' + String(MAX_LIMIT),
    );
  return value;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as { occurredAt?: unknown; id?: unknown };
    if (
      typeof parsed.occurredAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(parsed.occurredAt) ||
      typeof parsed.id !== 'string' ||
      !uuidPattern.test(parsed.id)
    )
      throw new Error('invalid cursor shape');
    return { occurredAt: parsed.occurredAt, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid risk review list cursor');
  }
}
