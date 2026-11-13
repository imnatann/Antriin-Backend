import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService, uuidPattern } from '../notifications/outbox.service';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const REVIEW_STATUSES = [
  'visible',
  'reported',
  'under_review',
  'hidden',
  'resolved',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const MODERATION_ACTIONS = ['keep', 'hide'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export type ReviewReplyView = {
  id: string;
  body: string;
  authorUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type ReviewView = {
  id: string;
  campusId: string;
  tenantId: string;
  orderId: string;
  buyerId: string;
  rating: number;
  body: string;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  reply: ReviewReplyView | null;
  openReportCount: number;
};

export type ReviewPage = {
  items: ReviewView[];
  nextCursor: string | null;
};

/**
 * Public projection: a review's buyer and order stay private (REQUIREMENTS
 * §3.9 point 4), so the unauthenticated listing carries neither.
 */
export type PublicReviewView = {
  id: string;
  tenantId: string;
  rating: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  reply: ReviewReplyView | null;
};

export type PublicReviewPage = {
  items: PublicReviewView[];
  nextCursor: string | null;
};

export type ReviewInput = { rating: number; body: string };

export type ReportInput = { reason: string };

export type ReplyInput = { body: string };

export type ModerationDecisionInput = {
  action: string;
  reason: string;
};

type ReviewRow = {
  id: string;
  campus_id: string;
  tenant_id: string;
  order_id: string;
  buyer_id: string;
  rating: number;
  body: string;
  status: ReviewStatus;
  created_at: string;
  updated_at: string;
  reply_id: string | null;
  reply_body: string | null;
  reply_author_user_id: string | null;
  reply_created_at: string | null;
  reply_updated_at: string | null;
  open_report_count: number | string;
};

type Cursor = { createdAt: string; id: string };

/**
 * Response timestamps must be the DB microsecond UTC strings themselves (D7):
 * re-serializing through Date/toISOString truncates to milliseconds.
 */
function microUtc(column: string, alias: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${alias}`;
}

// The reply and the open-report count travel with every review row so a list
// page costs one query instead of one query per review.
const REVIEW_COLUMNS = [
  'r.id::text',
  'r.campus_id::text',
  'r.tenant_id::text',
  'r.order_id::text',
  'r.buyer_id::text',
  'r.rating',
  'r.body',
  'r.status',
  microUtc('r.created_at', 'created_at'),
  microUtc('r.updated_at', 'updated_at'),
  'p.id::text as reply_id',
  'p.body as reply_body',
  'p.author_user_id::text as reply_author_user_id',
  microUtc('p.created_at', 'reply_created_at'),
  microUtc('p.updated_at', 'reply_updated_at'),
  '(select count(*) from review_reports rr where rr.review_id = r.id and rr.status = $1) as open_report_count',
].join(', ');

/**
 * Buyer reviews (REQUIREMENTS §3.9). A review needs a completed order, its
 * buyer, and a campus email verified for the order's campus; one review per
 * order, soft-deleted reviews included. A tenant may read and reply, never
 * edit or delete. Hiding a review is a campus moderation decision with a
 * reason and an append-only trail — a low rating alone is never a violation.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Buyer reviews their own completed order exactly once. */
  async createReview(
    buyerId: string,
    orderId: string,
    input: ReviewInput,
  ): Promise<ReviewView> {
    this.assertUuid(buyerId, 'user');
    this.assertUuid(orderId, 'order');
    const { rating, body } = this.normalizeInput(input);
    return this.withTransaction(undefined, async (tx) => {
      // FOR SHARE: a concurrent handover/refund decision cannot change the
      // order status between this read and the insert.
      const order = await tx.query<{
        buyer_id: string;
        tenant_id: string;
        campus_id: string;
        status: string;
      }>(
        `select o.buyer_id::text, o.tenant_id::text, t.campus_id::text, o.status
           from orders o
           join tenants t on t.id = o.tenant_id
          where o.id = $1
          for share of o`,
        [orderId],
      );
      const row = order.rows[0];
      if (!row || row.buyer_id !== buyerId)
        throw new NotFoundException('Order was not found');
      if (row.status !== 'completed')
        throw new ConflictException({
          code: 'REVIEW_ORDER_NOT_COMPLETED',
          message: 'Only a completed order can be reviewed',
        });
      const verified = await tx.query(
        `select 1 from campus_email_verifications
           where user_id = $1 and campus_id = $2 limit 1`,
        [buyerId, row.campus_id],
      );
      if (!verified.rows[0])
        throw new ForbiddenException({
          code: 'CAMPUS_VERIFICATION_REQUIRED',
          message: 'A verified campus email is required to review an order',
        });
      const inserted = await tx.query<{ id: string }>(
        `insert into reviews
           (campus_id, tenant_id, order_id, buyer_id, rating, body, status,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'visible', now(), now())
         on conflict (order_id) do nothing
         returning id::text`,
        [row.campus_id, row.tenant_id, orderId, buyerId, rating, body],
      );
      if (!inserted.rows[0])
        throw new ConflictException({
          code: 'REVIEW_ALREADY_EXISTS',
          message: 'This order already has a review',
        });
      const reviewId = inserted.rows[0].id;
      // Recipients are computed server-side: the tenant staff who may reply.
      await this.notifyTenantStaff(tx, row.tenant_id, reviewId, 'created');
      return this.getReview(tx, reviewId, 'review was not found');
    });
  }

  /** Public listing: visible reviews of a tenant, newest first. */
  async listPublicReviews(
    tenantId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<PublicReviewPage> {
    this.assertUuid(tenantId, 'tenant');
    const page = await this.listScoped(
      'r.tenant_id = $2 and r.status = $3 and r.deleted_at is null',
      [tenantId, 'visible'],
      options,
    );
    return {
      items: page.items.map((item) => ({
        id: item.id,
        tenantId: item.tenantId,
        rating: item.rating,
        body: item.body,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        reply: item.reply,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** Tenant view of its own reviews, every status except buyer-deleted. */
  async listTenantReviews(
    actorUserId: string,
    tenantId: string,
    options: { cursor?: string; limit?: number; status?: string } = {},
  ): Promise<ReviewPage> {
    this.assertUuid(actorUserId, 'user');
    this.assertUuid(tenantId, 'tenant');
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.reviews.reply',
        tx,
      );
      const filters: unknown[] = [tenantId];
      let where = 'r.tenant_id = $2 and r.deleted_at is null';
      if (options.status !== undefined) {
        if (!isReviewStatus(options.status))
          throw new BadRequestException({
            code: 'REVIEW_STATUS_INVALID',
            message: 'status must be one of: ' + REVIEW_STATUSES.join(', '),
          });
        filters.push(options.status);
        where += ' and r.status = $' + String(filters.length + 1);
      }
      return this.listScoped(where, filters, options, tx);
    });
  }

  /** Buyer's own reviews, including ones campus moderation hid. */
  async listBuyerReviews(
    buyerId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ReviewPage> {
    this.assertUuid(buyerId, 'user');
    return this.listScoped(
      'r.buyer_id = $2 and r.deleted_at is null',
      [buyerId],
      options,
    );
  }

  /** Buyer edits their own review. A hidden review stays hidden. */
  async updateReview(
    buyerId: string,
    reviewId: string,
    input: ReviewInput,
  ): Promise<ReviewView> {
    this.assertUuid(buyerId, 'user');
    this.assertUuid(reviewId, 'review');
    const { rating, body } = this.normalizeInput(input);
    return this.withTransaction(undefined, async (tx) => {
      const current = await this.lockOwnReview(tx, buyerId, reviewId);
      if (current.status === 'hidden')
        throw new ConflictException({
          code: 'REVIEW_HIDDEN',
          message: 'A hidden review cannot be edited',
        });
      await tx.query(
        `update reviews set rating = $2, body = $3, updated_at = now()
           where id = $1`,
        [reviewId, rating, body],
      );
      return this.getReview(tx, reviewId, 'Review was not found');
    });
  }

  /** Buyer soft-deletes their own review; the order stays un-reviewable. */
  async deleteReview(buyerId: string, reviewId: string): Promise<ReviewView> {
    this.assertUuid(buyerId, 'user');
    this.assertUuid(reviewId, 'review');
    return this.withTransaction(undefined, async (tx) => {
      // Idempotent: a repeat keeps the first deleted_at, and only the owner
      // can reach the row at all.
      const updated = await tx.query(
        `update reviews
            set deleted_at = coalesce(deleted_at, now()), updated_at = now()
          where id = $1 and buyer_id = $2
          returning id::text`,
        [reviewId, buyerId],
      );
      if (!updated.rows[0]) throw new NotFoundException('Review was not found');
      return this.getReview(tx, reviewId, 'Review was not found');
    });
  }

  /** Any authenticated user reports a review to campus moderation. */
  async reportReview(
    reporterUserId: string,
    reviewId: string,
    input: ReportInput,
  ): Promise<ReviewView> {
    this.assertUuid(reporterUserId, 'user');
    this.assertUuid(reviewId, 'review');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 500)
      throw new BadRequestException({
        code: 'REVIEW_REPORT_REASON_INVALID',
        message: 'A report reason of 1 to 500 characters is required',
      });
    return this.withTransaction(undefined, async (tx) => {
      const review = await tx.query<{
        campus_id: string;
        status: ReviewStatus;
        deleted_at: string | null;
      }>(
        `select campus_id::text, status, deleted_at
           from reviews where id = $1 for update`,
        [reviewId],
      );
      const row = review.rows[0];
      if (!row || row.deleted_at)
        throw new NotFoundException('Review was not found');
      const inserted = await tx.query(
        `insert into review_reports
           (review_id, campus_id, reporter_user_id, reason, status, created_at, updated_at)
         values ($1, $2, $3, $4, 'open', now(), now())
         on conflict (review_id, reporter_user_id) do nothing returning id::text`,
        [reviewId, row.campus_id, reporterUserId, reason],
      );
      if (!inserted.rows[0])
        throw new ConflictException({
          code: 'REVIEW_ALREADY_REPORTED',
          message: 'This review was already reported by this user',
        });
      if (row.status === 'visible')
        await tx.query(
          `update reviews set status = 'reported', updated_at = now()
             where id = $1`,
          [reviewId],
        );
      const moderators = await tx.query<{ user_id: string }>(
        `select user_id::text from campus_memberships
           where campus_id = $1 and status = 'active'
             and permissions && array['campus.reviews.moderate']::text[]`,
        [row.campus_id],
      );
      await this.outbox.append(tx, {
        eventKey: 'review:' + reviewId + ':reported:' + reporterUserId,
        eventType: 'review.reported',
        aggregateType: 'review',
        aggregateId: reviewId,
        recipientIds: moderators.rows.map((r) => r.user_id),
      });
      return this.getReview(tx, reviewId, 'Review was not found');
    });
  }

  /** Tenant replies once to its own review (upsert). */
  async replyToReview(
    actorUserId: string,
    tenantId: string,
    reviewId: string,
    input: ReplyInput,
  ): Promise<ReviewView> {
    this.assertUuid(actorUserId, 'user');
    this.assertUuid(tenantId, 'tenant');
    this.assertUuid(reviewId, 'review');
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (!body || body.length > 2000)
      throw new BadRequestException({
        code: 'REVIEW_REPLY_INVALID',
        message: 'A reply of 1 to 2000 characters is required',
      });
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.reviews.reply',
        tx,
      );
      const scoped = await tx.query(
        'select 1 from reviews where id = $1 and tenant_id = $2',
        [reviewId, tenantId],
      );
      if (!scoped.rows[0]) throw new NotFoundException('Review was not found');
      await tx.query(
        `insert into review_replies
           (review_id, tenant_id, author_user_id, body, created_at, updated_at)
         values ($1, $2, $3, $4, now(), now())
         on conflict (review_id) do update
           set body = excluded.body, author_user_id = excluded.author_user_id,
               updated_at = now()`,
        [reviewId, tenantId, actorUserId, body],
      );
      return this.getReview(tx, reviewId, 'Review was not found');
    });
  }

  /** Campus moderation queue: reviews reported or already under review. */
  async listModerationQueue(
    actorUserId: string,
    campusId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ReviewPage> {
    this.assertUuid(actorUserId, 'user');
    this.assertUuid(campusId, 'campus');
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.reviews.moderate',
        tx,
      );
      return this.listScoped(
        "r.campus_id = $2 and r.deleted_at is null and r.status in ('reported','under_review')",
        [campusId],
        options,
        tx,
      );
    });
  }

  /**
   * Campus decision: keep the review visible or hide it. Appends the decision
   * trail, resolves the open reports, audits and notifies the buyer.
   */
  async decideModeration(
    actorUserId: string,
    campusId: string,
    reviewId: string,
    input: ModerationDecisionInput,
  ): Promise<ReviewView> {
    this.assertUuid(actorUserId, 'user');
    this.assertUuid(campusId, 'campus');
    this.assertUuid(reviewId, 'review');
    if (!MODERATION_ACTIONS.includes(input.action as ModerationAction))
      throw new BadRequestException({
        code: 'REVIEW_MODERATION_ACTION_INVALID',
        message: 'action must be one of: ' + MODERATION_ACTIONS.join(', '),
      });
    const action = input.action as ModerationAction;
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 500)
      throw new BadRequestException({
        code: 'REVIEW_MODERATION_REASON_INVALID',
        message: 'A decision reason of 1 to 500 characters is required',
      });
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.reviews.moderate',
        tx,
      );
      const locked = await tx.query<{
        id: string;
        buyer_id: string;
        status: ReviewStatus;
        deleted_at: string | null;
      }>(
        `select id::text, buyer_id::text, status, deleted_at
           from reviews where id = $1 and campus_id = $2 for update`,
        [reviewId, campusId],
      );
      const current = locked.rows[0];
      if (!current || current.deleted_at)
        throw new NotFoundException('Review was not found');
      if (action === 'hide')
        await tx.query(
          `update reviews
              set status = 'hidden', hidden_at = now(),
                  hidden_by_user_id = $2, updated_at = now()
            where id = $1`,
          [reviewId, actorUserId],
        );
      else
        await tx.query(
          `update reviews
              set status = 'visible', hidden_at = null,
                  hidden_by_user_id = null, updated_at = now()
            where id = $1`,
          [reviewId],
        );
      await tx.query(
        `insert into review_moderation_actions
           (review_id, campus_id, actor_user_id, action, reason, created_at)
         values ($1, $2, $3, $4, $5, now())`,
        [reviewId, campusId, actorUserId, action, reason],
      );
      await tx.query(
        `update review_reports
            set status = 'resolved', resolved_at = now(), updated_at = now()
          where review_id = $1 and status = 'open'`,
        [reviewId],
      );
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'campus',
        scopeId: campusId,
        action: 'campus.reviews.moderated',
        targetType: 'review',
        targetId: reviewId,
        reason,
        metadata: { action, previousStatus: current.status },
      });
      await this.outbox.append(tx, {
        eventKey: 'review:' + reviewId + ':moderated:' + action,
        eventType: 'review.moderated',
        aggregateType: 'review',
        aggregateId: reviewId,
        recipientIds: [current.buyer_id],
      });
      return this.getReview(tx, reviewId, 'Review was not found');
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Notifies the tenant staff allowed to reply; recipients stay server-side. */
  private async notifyTenantStaff(
    tx: PoolClient,
    tenantId: string,
    reviewId: string,
    suffix: string,
  ): Promise<void> {
    const staff = await tx.query<{ user_id: string }>(
      `select user_id::text from tenant_memberships
         where tenant_id = $1 and status = 'active'
           and permissions && array['tenant.reviews.reply']::text[]`,
      [tenantId],
    );
    await this.outbox.append(tx, {
      eventKey: 'review:' + reviewId + ':' + suffix,
      eventType: 'review.created',
      aggregateType: 'review',
      aggregateId: reviewId,
      recipientIds: staff.rows.map((r) => r.user_id),
    });
  }

  /** Locks the review for update and proves the caller is its buyer. */
  private async lockOwnReview(
    tx: PoolClient,
    buyerId: string,
    reviewId: string,
  ): Promise<{ status: ReviewStatus; deleted_at: string | null }> {
    const result = await tx.query<{
      status: ReviewStatus;
      deleted_at: string | null;
    }>(
      `select status, deleted_at from reviews
         where id = $1 and buyer_id = $2 for update`,
      [reviewId, buyerId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Review was not found');
    if (row.deleted_at) throw new NotFoundException('Review was not found');
    return row;
  }

  private async getReview(
    tx: PoolClient,
    reviewId: string,
    notFoundMessage: string,
  ): Promise<ReviewView> {
    const result = await tx.query<ReviewRow>(
      `select ${REVIEW_COLUMNS}
         from reviews r
         left join review_replies p on p.review_id = r.id
        where r.id = $2`,
      ['open', reviewId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException(notFoundMessage);
    return this.toView(row);
  }

  /**
   * Shared cursor page. `filters` are the bound values of `where`, whose
   * placeholders start at $2 because $1 is the open-report status.
   */
  private async listScoped(
    where: string,
    filters: unknown[],
    options: { cursor?: string; limit?: number },
    client?: PoolClient,
  ): Promise<ReviewPage> {
    const limit = normalizeLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    const values: unknown[] = ['open', ...filters];
    let predicate = where;
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      predicate +=
        ' and (r.created_at, r.id) < ($' +
        String(values.length - 1) +
        '::timestamptz, $' +
        String(values.length) +
        '::uuid)';
    }
    values.push(limit + 1);
    const query =
      `select ${REVIEW_COLUMNS}
         from reviews r
         left join review_replies p on p.review_id = r.id
        where ${predicate}
        order by r.created_at desc, r.id desc
        limit $` + String(values.length);
    const result = client
      ? await client.query<ReviewRow>(query, values)
      : await this.database.pool.query<ReviewRow>(query, values);
    const rows = result.rows;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.toView(row)),
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.created_at, id: last.id })
          : null,
    };
  }

  private toView(row: ReviewRow): ReviewView {
    return {
      id: row.id,
      campusId: row.campus_id,
      tenantId: row.tenant_id,
      orderId: row.order_id,
      buyerId: row.buyer_id,
      rating: Number(row.rating),
      body: row.body,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reply: row.reply_id
        ? {
            id: row.reply_id,
            body: row.reply_body ?? '',
            authorUserId: row.reply_author_user_id ?? '',
            createdAt: row.reply_created_at ?? '',
            updatedAt: row.reply_updated_at ?? '',
          }
        : null,
      openReportCount: Number(row.open_report_count),
    };
  }

  private normalizeInput(input: ReviewInput): ReviewInput {
    const rating = input?.rating;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5)
      throw new BadRequestException({
        code: 'REVIEW_RATING_INVALID',
        message: 'rating must be an integer from 1 to 5',
      });
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (!body || body.length > 2000)
      throw new BadRequestException({
        code: 'REVIEW_BODY_INVALID',
        message: 'body must be 1 to 2000 characters',
      });
    return { rating, body };
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

function isReviewStatus(value: string): value is ReviewStatus {
  return (REVIEW_STATUSES as readonly string[]).includes(value);
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
    ) as { createdAt?: unknown; id?: unknown };
    if (
      typeof parsed.createdAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(parsed.createdAt) ||
      typeof parsed.id !== 'string' ||
      !uuidPattern.test(parsed.id)
    )
      throw new Error('invalid cursor shape');
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid review list cursor');
  }
}
