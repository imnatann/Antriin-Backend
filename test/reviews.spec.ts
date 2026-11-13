import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import { ReviewsService } from '../src/modules/reviews/reviews.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

type Services = {
  access: AccessService;
  audit: AuditService;
  outbox: OutboxService;
  reviews: ReviewsService;
};

function buildServices(db: DatabaseService): Services {
  const access = new AccessService(db);
  const audit = new AuditService(db, access);
  const outbox = new OutboxService(db);
  const reviews = new ReviewsService(db, access, audit, outbox);
  return { access, audit, outbox, reviews };
}

type Env = Awaited<ReturnType<typeof createEnv>>;

async function createEnv(pool: Pool) {
  const tag = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      'insert into campuses (name) values ($1) returning id',
      ['Campus ' + tag],
    )
  ).rows[0].id;
  const tenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusId, 'Tenant ' + tag, 'Location ' + tag],
    )
  ).rows[0].id;
  // A second tenant in the same campus proves the reply scope.
  const otherTenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusId, 'Other ' + tag, 'Location ' + tag],
    )
  ).rows[0].id;
  const mkUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [name + ' ' + tag],
      )
    ).rows[0].id;
  const buyerId = await mkUser('Buyer');
  const otherBuyerId = await mkUser('OtherBuyer');
  const unverifiedBuyerId = await mkUser('UnverifiedBuyer');
  const tenantStaffId = await mkUser('TenantStaff');
  const pickupStaffId = await mkUser('PickupStaff');
  const otherTenantOwnerId = await mkUser('OtherTenantOwner');
  const moderatorId = await mkUser('Moderator');
  const outsiderId = await mkUser('Outsider');

  const verify = async (userId: string) =>
    pool.query(
      `insert into campus_email_verifications
         (user_id, campus_id, identity_hash, verified_at, created_at, updated_at)
       values ($1, $2, $3, now(), now(), now())`,
      [userId, campusId, randomUUID().replace(/-/g, '') + '00000000'],
    );
  await verify(buyerId);
  await verify(otherBuyerId);

  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1, $2, 'kitchen', $3::text[], 'active')",
    [tenantId, tenantStaffId, ['tenant.orders.read', 'tenant.reviews.reply']],
  );
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1, $2, 'pickup', $3::text[], 'active')",
    [tenantId, pickupStaffId, ['tenant.orders.read']],
  );
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1, $2, 'kitchen', $3::text[], 'active')",
    [otherTenantId, otherTenantOwnerId, ['tenant.reviews.reply']],
  );
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [campusId, moderatorId, ['campus.reviews.moderate']],
  );
  return {
    tag,
    campusId,
    tenantId,
    otherTenantId,
    buyerId,
    otherBuyerId,
    unverifiedBuyerId,
    tenantStaffId,
    pickupStaffId,
    otherTenantOwnerId,
    moderatorId,
    outsiderId,
  };
}

async function createOrder(
  pool: Pool,
  env: Env,
  opts: {
    status?: 'paid_awaiting_tenant' | 'completed';
    buyerId?: string;
  } = {},
) {
  const status = opts.status ?? 'completed';
  const buyerId = opts.buyerId ?? env.buyerId;
  const slotId = (
    await pool.query<{ id: string }>(
      `insert into pickup_slots
         (tenant_id, starts_at, ends_at, capacity, reserved_count, status, version, created_at, updated_at)
       values ($1, now() + interval '2 hours', now() + interval '3 hours', 5, 0, 'open', 1, now(), now())
       returning id`,
      [env.tenantId],
    )
  ).rows[0].id;
  const completed = status === 'completed';
  const result = await pool.query<{ id: string }>(
    `insert into orders
       (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot, tenant_timezone_snapshot,
        pickup_starts_at, pickup_ends_at, status, currency, subtotal_minor, total_minor,
        paid_at, confirmed_at, ready_at, completed_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'Asia/Jakarta', now() - interval '1 hour', now(), $5, 'IDR',
             '50000', '50000', now() - interval '2 hours', $6, $7, $8,
             now() - interval '3 hours', now())
     returning id`,
    [
      buyerId,
      env.tenantId,
      slotId,
      'Tenant ' + env.tag,
      status,
      completed ? new Date() : null,
      completed ? new Date() : null,
      completed ? new Date() : null,
    ],
  );
  return result.rows[0].id;
}

function httpCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'response' in error
    ? ((error as { response: { code?: string } }).response?.code ?? undefined)
    : undefined;
}

function sqlState(code: string) {
  return (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code;
}

describe(
  'Reviews slice PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let db: DatabaseService;
    let svc: Services;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 12 });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      svc = buildServices(db);
    });
    after(async () => {
      await pool?.end();
    });

    it('lets a verified buyer review a completed order and notifies the tenant', async () => {
      const env = await createEnv(pool);
      const orderId = await createOrder(pool, env);
      const view = await svc.reviews.createReview(env.buyerId, orderId, {
        rating: 5,
        body: '  Enak dan cepat  ',
      });
      assert.equal(view.status, 'visible');
      assert.equal(view.rating, 5);
      assert.equal(view.body, 'Enak dan cepat');
      assert.equal(view.orderId, orderId);
      assert.equal(view.tenantId, env.tenantId);
      assert.equal(view.campusId, env.campusId);
      assert.equal(view.buyerId, env.buyerId);
      assert.equal(view.reply, null);
      assert.equal(view.openReportCount, 0);
      assert.match(view.createdAt, /^\d{4}-\d\d-\d\dT.*\.\d{6}Z$/);

      // Only the tenant staff who may reply is notified; the pickup role is not.
      const event = await pool.query<{
        event_type: string;
        recipient_ids: string[];
      }>(
        'select event_type, recipient_ids from outbox_events where event_key = $1',
        ['review:' + view.id + ':created'],
      );
      assert.equal(event.rowCount, 1);
      assert.equal(event.rows[0].event_type, 'review.created');
      assert.deepEqual(event.rows[0].recipient_ids, [env.tenantStaffId]);
    });

    it('rejects a review unless the order is completed, owned, and campus-verified', async () => {
      const env = await createEnv(pool);

      const unpaid = await createOrder(pool, env, {
        status: 'paid_awaiting_tenant',
      });
      await assert.rejects(
        svc.reviews.createReview(env.buyerId, unpaid, {
          rating: 4,
          body: 'ok',
        }),
        (error) =>
          httpCode(error) === 'REVIEW_ORDER_NOT_COMPLETED' &&
          (error as { status?: number }).status === 409,
      );

      const foreign = await createOrder(pool, env, {
        buyerId: env.otherBuyerId,
      });
      await assert.rejects(
        svc.reviews.createReview(env.buyerId, foreign, {
          rating: 4,
          body: 'ok',
        }),
        (error) => (error as { status?: number }).status === 404,
      );

      const own = await createOrder(pool, env, {
        buyerId: env.unverifiedBuyerId,
      });
      await assert.rejects(
        svc.reviews.createReview(env.unverifiedBuyerId, own, {
          rating: 4,
          body: 'ok',
        }),
        (error) =>
          httpCode(error) === 'CAMPUS_VERIFICATION_REQUIRED' &&
          (error as { status?: number }).status === 403,
      );

      const reviewable = await createOrder(pool, env);
      await svc.reviews.createReview(env.buyerId, reviewable, {
        rating: 4,
        body: 'ok',
      });
      await assert.rejects(
        svc.reviews.createReview(env.buyerId, reviewable, {
          rating: 3,
          body: 'again',
        }),
        (error) =>
          httpCode(error) === 'REVIEW_ALREADY_EXISTS' &&
          (error as { status?: number }).status === 409,
      );

      await assert.rejects(
        svc.reviews.createReview(env.buyerId, reviewable, {
          rating: 6,
          body: 'ok',
        }),
        (error) => httpCode(error) === 'REVIEW_RATING_INVALID',
      );
      await assert.rejects(
        svc.reviews.createReview(env.buyerId, reviewable, {
          rating: 3,
          body: '   ',
        }),
        (error) => httpCode(error) === 'REVIEW_BODY_INVALID',
      );
    });

    it('lets the buyer edit and soft-delete a review without re-opening the order', async () => {
      const env = await createEnv(pool);
      const orderId = await createOrder(pool, env);
      const created = await svc.reviews.createReview(env.buyerId, orderId, {
        rating: 2,
        body: 'Lumayan',
      });

      const edited = await svc.reviews.updateReview(env.buyerId, created.id, {
        rating: 4,
        body: 'Setelah komplain jadi lebih baik',
      });
      assert.equal(edited.rating, 4);
      assert.equal(edited.body, 'Setelah komplain jadi lebih baik');

      await assert.rejects(
        svc.reviews.updateReview(env.otherBuyerId, created.id, {
          rating: 1,
          body: 'not mine',
        }),
        (error) => (error as { status?: number }).status === 404,
      );

      const deleted = await svc.reviews.deleteReview(env.buyerId, created.id);
      assert.equal(deleted.status, 'visible');
      const deletedAt = await pool.query<{ deleted_at: string | null }>(
        'select deleted_at from reviews where id = $1',
        [created.id],
      );
      assert.notEqual(deletedAt.rows[0].deleted_at, null);

      // The order stays un-reviewable after the soft delete.
      await assert.rejects(
        svc.reviews.createReview(env.buyerId, orderId, {
          rating: 5,
          body: 'second try',
        }),
        (error) => httpCode(error) === 'REVIEW_ALREADY_EXISTS',
      );

      // Idempotent: deleting twice keeps the first timestamp.
      await svc.reviews.deleteReview(env.buyerId, created.id);
      const again = await pool.query<{ deleted_at: string | null }>(
        'select deleted_at from reviews where id = $1',
        [created.id],
      );
      assert.equal(
        String(again.rows[0].deleted_at),
        String(deletedAt.rows[0].deleted_at),
      );

      const publicPage = await svc.reviews.listPublicReviews(env.tenantId);
      assert.equal(publicPage.items.length, 0);
      const mine = await svc.reviews.listBuyerReviews(env.buyerId);
      assert.equal(mine.items.length, 0);
    });

    it('lists only visible tenant reviews publicly, without buyer identity', async () => {
      const env = await createEnv(pool);
      const first = await createOrder(pool, env);
      const second = await createOrder(pool, env, {
        buyerId: env.otherBuyerId,
      });
      await svc.reviews.createReview(env.buyerId, first, {
        rating: 5,
        body: 'Mantap',
      });
      const reported = await svc.reviews.createReview(
        env.otherBuyerId,
        second,
        { rating: 1, body: 'Kurang' },
      );
      await svc.reviews.reportReview(env.outsiderId, reported.id, {
        reason: 'spam',
      });

      const page = await svc.reviews.listPublicReviews(env.tenantId);
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0].body, 'Mantap');
      const raw = JSON.stringify(page.items[0]);
      assert.equal(raw.includes(env.buyerId), false);

      const tenantPage = await svc.reviews.listTenantReviews(
        env.tenantStaffId,
        env.tenantId,
      );
      assert.equal(tenantPage.items.length, 2);
      const filtered = await svc.reviews.listTenantReviews(
        env.tenantStaffId,
        env.tenantId,
        { status: 'reported' },
      );
      assert.equal(filtered.items.length, 1);
      assert.equal(filtered.items[0].id, reported.id);

      await assert.rejects(
        svc.reviews.listTenantReviews(env.pickupStaffId, env.tenantId),
        (error) => (error as { status?: number }).status === 403,
      );
      await assert.rejects(
        svc.reviews.listTenantReviews(env.tenantStaffId, env.otherTenantId),
        (error) => (error as { status?: number }).status === 403,
      );
    });

    it('pages tenant reviews with an opaque cursor', async () => {
      const env = await createEnv(pool);
      for (let index = 0; index < 3; index += 1) {
        const orderId = await createOrder(pool, env);
        await svc.reviews.createReview(env.buyerId, orderId, {
          rating: 4,
          body: 'review ' + String(index),
        });
      }
      const first = await svc.reviews.listTenantReviews(
        env.tenantStaffId,
        env.tenantId,
        { limit: 2 },
      );
      assert.equal(first.items.length, 2);
      assert.notEqual(first.nextCursor, null);
      const second = await svc.reviews.listTenantReviews(
        env.tenantStaffId,
        env.tenantId,
        { limit: 2, cursor: first.nextCursor ?? undefined },
      );
      assert.equal(second.items.length, 1);
      assert.equal(second.nextCursor, null);
      const ids = new Set(first.items.map((item) => item.id));
      assert.equal(ids.has(second.items[0].id), false);
      await assert.rejects(
        svc.reviews.listTenantReviews(env.tenantStaffId, env.tenantId, {
          cursor: 'not-a-cursor',
        }),
        (error) => (error as { status?: number }).status === 400,
      );
    });

    it('stores one tenant reply and refuses cross-tenant replies', async () => {
      const env = await createEnv(pool);
      const orderId = await createOrder(pool, env);
      const review = await svc.reviews.createReview(env.buyerId, orderId, {
        rating: 3,
        body: 'Boleh lebih hangat',
      });

      const replied = await svc.reviews.replyToReview(
        env.tenantStaffId,
        env.tenantId,
        review.id,
        { body: 'Terima kasih, kami perbaiki' },
      );
      assert.equal(replied.reply?.body, 'Terima kasih, kami perbaiki');
      assert.equal(replied.reply?.authorUserId, env.tenantStaffId);

      const updated = await svc.reviews.replyToReview(
        env.tenantStaffId,
        env.tenantId,
        review.id,
        { body: 'Sudah kami perbaiki' },
      );
      assert.equal(updated.reply?.body, 'Sudah kami perbaiki');
      const replies = await pool.query<{ n: number }>(
        'select count(*)::int as n from review_replies where review_id = $1',
        [review.id],
      );
      assert.equal(replies.rows[0].n, 1);

      await assert.rejects(
        svc.reviews.replyToReview(
          env.otherTenantOwnerId,
          env.otherTenantId,
          review.id,
          { body: 'not ours' },
        ),
        (error) => (error as { status?: number }).status === 404,
      );
      await assert.rejects(
        svc.reviews.replyToReview(env.pickupStaffId, env.tenantId, review.id, {
          body: 'no permission',
        }),
        (error) => (error as { status?: number }).status === 403,
      );
      // The public page exposes the reply.
      const publicPage = await svc.reviews.listPublicReviews(env.tenantId);
      assert.equal(publicPage.items[0].reply?.body, 'Sudah kami perbaiki');
    });

    it('records one report per user, flags the review and notifies moderators', async () => {
      const env = await createEnv(pool);
      const orderId = await createOrder(pool, env);
      const review = await svc.reviews.createReview(env.buyerId, orderId, {
        rating: 1,
        body: 'Bukan pesanan saya',
      });

      const reported = await svc.reviews.reportReview(
        env.outsiderId,
        review.id,
        {
          reason: '  berisi data pribadi  ',
        },
      );
      assert.equal(reported.status, 'reported');
      assert.equal(reported.openReportCount, 1);

      await assert.rejects(
        svc.reviews.reportReview(env.outsiderId, review.id, {
          reason: 'again',
        }),
        (error) =>
          httpCode(error) === 'REVIEW_ALREADY_REPORTED' &&
          (error as { status?: number }).status === 409,
      );
      await assert.rejects(
        svc.reviews.reportReview(env.buyerId, review.id, { reason: '   ' }),
        (error) => httpCode(error) === 'REVIEW_REPORT_REASON_INVALID',
      );

      const event = await pool.query<{ recipient_ids: string[] }>(
        "select recipient_ids from outbox_events where event_type = 'review.reported' and aggregate_id = $1",
        [review.id],
      );
      assert.equal(event.rowCount, 1);
      assert.deepEqual(event.rows[0].recipient_ids, [env.moderatorId]);
    });

    it('hides and restores a review through campus moderation with an audit trail', async () => {
      const env = await createEnv(pool);
      const orderId = await createOrder(pool, env);
      const review = await svc.reviews.createReview(env.buyerId, orderId, {
        rating: 1,
        body: 'Isi ulasan',
      });
      await svc.reviews.reportReview(env.outsiderId, review.id, {
        reason: 'pii',
      });

      await assert.rejects(
        svc.reviews.listModerationQueue(env.outsiderId, env.campusId),
        (error) => (error as { status?: number }).status === 403,
      );
      const queue = await svc.reviews.listModerationQueue(
        env.moderatorId,
        env.campusId,
      );
      assert.equal(queue.items.length, 1);
      assert.equal(queue.items[0].id, review.id);
      assert.equal(queue.items[0].openReportCount, 1);

      const hidden = await svc.reviews.decideModeration(
        env.moderatorId,
        env.campusId,
        review.id,
        { action: 'hide', reason: 'Memuat data pribadi' },
      );
      assert.equal(hidden.status, 'hidden');
      assert.equal(hidden.openReportCount, 0);

      const hiddenRow = await pool.query<{
        hidden_at: string | null;
        hidden_by_user_id: string | null;
      }>(
        'select hidden_at, hidden_by_user_id::text from reviews where id = $1',
        [review.id],
      );
      assert.notEqual(hiddenRow.rows[0].hidden_at, null);
      assert.equal(hiddenRow.rows[0].hidden_by_user_id, env.moderatorId);

      const action = await pool.query<{ action: string; reason: string }>(
        'select action, reason from review_moderation_actions where review_id = $1',
        [review.id],
      );
      assert.equal(action.rowCount, 1);
      assert.equal(action.rows[0].action, 'hide');
      assert.equal(action.rows[0].reason, 'Memuat data pribadi');

      const audit = await pool.query<{ actor_user_id: string; reason: string }>(
        "select actor_user_id::text, reason from audit_events where action = 'campus.reviews.moderated' and target_id = $1",
        [review.id],
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].actor_user_id, env.moderatorId);

      // Hidden reviews disappear from the public page and cannot be edited.
      const publicPage = await svc.reviews.listPublicReviews(env.tenantId);
      assert.equal(publicPage.items.length, 0);
      await assert.rejects(
        svc.reviews.updateReview(env.buyerId, review.id, {
          rating: 5,
          body: 'sneaky edit',
        }),
        (error) => httpCode(error) === 'REVIEW_HIDDEN',
      );

      const restored = await svc.reviews.decideModeration(
        env.moderatorId,
        env.campusId,
        review.id,
        { action: 'keep', reason: 'Bukan pelanggaran' },
      );
      assert.equal(restored.status, 'visible');
      const restoredRow = await pool.query<{
        hidden_at: string | null;
        hidden_by_user_id: string | null;
      }>(
        'select hidden_at, hidden_by_user_id::text from reviews where id = $1',
        [review.id],
      );
      assert.equal(restoredRow.rows[0].hidden_at, null);
      assert.equal(restoredRow.rows[0].hidden_by_user_id, null);
      const actions = await pool.query<{ n: number }>(
        'select count(*)::int as n from review_moderation_actions where review_id = $1',
        [review.id],
      );
      assert.equal(actions.rows[0].n, 2);

      // The moderated event reaches the buyer exactly once per decision.
      const events = await pool.query<{ recipient_ids: string[] }>(
        "select recipient_ids from outbox_events where event_type = 'review.moderated' and aggregate_id = $1 order by event_key",
        [review.id],
      );
      assert.equal(events.rowCount, 2);
      for (const row of events.rows)
        assert.deepEqual(row.recipient_ids, [env.buyerId]);

      await assert.rejects(
        svc.reviews.decideModeration(env.outsiderId, env.campusId, review.id, {
          action: 'hide',
          reason: 'nope',
        }),
        (error) => (error as { status?: number }).status === 403,
      );
      await assert.rejects(
        svc.reviews.decideModeration(env.moderatorId, env.campusId, review.id, {
          action: 'delete',
          reason: 'nope',
        }),
        (error) => httpCode(error) === 'REVIEW_MODERATION_ACTION_INVALID',
      );
      await assert.rejects(
        svc.reviews.decideModeration(env.moderatorId, env.campusId, review.id, {
          action: 'hide',
          reason: '',
        }),
        (error) => httpCode(error) === 'REVIEW_MODERATION_REASON_INVALID',
      );
    });

    it('keeps the review invariants at the database boundary', async () => {
      const env = await createEnv(pool);
      const orderId = await createOrder(pool, env);
      const review = await svc.reviews.createReview(env.buyerId, orderId, {
        rating: 5,
        body: 'ok',
      });

      // One review per order, enforced by the UNIQUE index.
      await assert.rejects(
        pool.query(
          `insert into reviews (campus_id, tenant_id, order_id, buyer_id, rating, body)
           values ($1, $2, $3, $4, 5, 'dup')`,
          [env.campusId, env.tenantId, orderId, env.buyerId],
        ),
        sqlState('23505'),
      );
      // Rating outside 1..5.
      const otherOrder = await createOrder(pool, env);
      await assert.rejects(
        pool.query(
          `insert into reviews (campus_id, tenant_id, order_id, buyer_id, rating, body)
           values ($1, $2, $3, $4, 6, 'out of range')`,
          [env.campusId, env.tenantId, otherOrder, env.buyerId],
        ),
        sqlState('23514'),
      );
      // A hidden status without the hiding columns violates the CHECK.
      await assert.rejects(
        pool.query("update reviews set status = 'hidden' where id = $1", [
          review.id,
        ]),
        sqlState('23514'),
      );
      // A review must belong to an order of the same tenant.
      const foreignOrder = await createOrder(pool, env);
      await assert.rejects(
        pool.query(
          `insert into reviews (campus_id, tenant_id, order_id, buyer_id, rating, body)
           values ($1, $2, $3, $4, 4, 'cross tenant')`,
          [env.campusId, env.otherTenantId, foreignOrder, env.buyerId],
        ),
        sqlState('23503'),
      );
      // A reply can only point at a review of the same tenant.
      await assert.rejects(
        pool.query(
          `insert into review_replies (review_id, tenant_id, author_user_id, body)
           values ($1, $2, $3, 'wrong tenant')`,
          [review.id, env.otherTenantId, env.otherTenantOwnerId],
        ),
        sqlState('23503'),
      );
    });
  },
);
