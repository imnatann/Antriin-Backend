import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { ReportingService } from '../src/modules/reporting/reporting.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const RANGE = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
};

/** D7: timestamps travel as microsecond UTC strings, never through Date. */
const MICRO_UTC_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

type Env = Awaited<ReturnType<typeof createEnv>>;

async function createEnv(pool: Pool) {
  const tag = randomUUID();
  const insertCampus = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'insert into campuses (name) values ($1) returning id',
        [name],
      )
    ).rows[0].id;
  const campusId = await insertCampus('Campus ' + tag);
  const otherCampusId = await insertCampus('Other campus ' + tag);
  const insertTenant = async (campus: string, name: string) =>
    (
      await pool.query<{ id: string }>(
        "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
        [campus, name, 'Location ' + tag],
      )
    ).rows[0].id;
  const tenantId = await insertTenant(campusId, 'Tenant ' + tag);
  const secondTenantId = await insertTenant(campusId, 'Second tenant ' + tag);
  const otherTenantId = await insertTenant(
    otherCampusId,
    'Other tenant ' + tag,
  );
  const mkUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [name + ' ' + tag],
      )
    ).rows[0].id;
  const buyerId = await mkUser('Buyer');
  const adminId = await mkUser('CampusAdmin');
  const otherAdminId = await mkUser('OtherCampusAdmin');
  const ownerId = await mkUser('TenantOwner');
  const outsiderId = await mkUser('Outsider');
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [campusId, adminId, ['campus.transactions.read']],
  );
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [otherCampusId, otherAdminId, ['campus.transactions.read']],
  );
  // A tenant owner has no campus permission: campus oversight is not implied.
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) values ($1, $2, 'owner', $3::text[], 'active', now())",
    [tenantId, ownerId, ['tenant.sales.read']],
  );
  return {
    tag,
    campusId,
    otherCampusId,
    tenantId,
    secondTenantId,
    otherTenantId,
    buyerId,
    adminId,
    otherAdminId,
    ownerId,
    outsiderId,
  };
}

/** Slots are unique per (tenant, starts_at, ends_at), so each one is nudged. */
let slotOffsetMinutes = 0;
function nextSlotWindow(createdAt: Date) {
  slotOffsetMinutes += 1;
  const startsAt = new Date(
    createdAt.getTime() + 2 * 60 * 60 * 1000 + slotOffsetMinutes * 60 * 1000,
  );
  return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000) };
}

let orderSequence = 0;

type OrderOptions = {
  status?: string;
  totalMinor?: string;
  createdAt: Date;
};

async function createOrder(
  pool: Pool,
  env: Env,
  tenantId: string,
  options: OrderOptions,
): Promise<string> {
  const status = options.status ?? 'completed';
  const totalMinor = options.totalMinor ?? '10000';
  const { startsAt, endsAt } = nextSlotWindow(options.createdAt);
  const slotId = (
    await pool.query<{ id: string }>(
      `insert into pickup_slots
         (tenant_id, starts_at, ends_at, capacity, reserved_count, status, version, created_at, updated_at)
       values ($1, $2, $3, 5, 0, 'open', 1, now(), now())
       returning id`,
      [tenantId, startsAt, endsAt],
    )
  ).rows[0].id;
  orderSequence += 1;
  const suffix = (
    env.tag.replace(/-/g, '') + String(orderSequence)
  ).toUpperCase();
  const orderNumber = 'AN-20260101-' + suffix.slice(-6).padStart(6, '0');
  // orders_status_timestamps_check (D12.4): status and timestamps must agree,
  // and the transition chain must be monotonic.
  const completed = status === 'completed';
  const now = new Date();
  const result = await pool.query<{ id: string }>(
    `insert into orders
       (buyer_id, tenant_id, pickup_slot_id, order_number, tenant_name_snapshot,
        tenant_timezone_snapshot, pickup_starts_at, pickup_ends_at, status,
        currency, subtotal_minor, total_minor, paid_at, confirmed_at, ready_at,
        completed_at, cancelled_at, declined_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'Asia/Jakarta', $6, $7, $8, 'IDR',
             $9, $9, $10, $11, $12, $13, $14, $15, $16, $16)
     returning id`,
    [
      env.buyerId,
      tenantId,
      slotId,
      orderNumber,
      'Tenant ' + env.tag,
      startsAt,
      endsAt,
      status,
      totalMinor,
      completed ? now : null,
      completed ? now : null,
      completed ? now : null,
      completed ? now : null,
      status === 'cancelled' ? now : null,
      status === 'declined' ? now : null,
      options.createdAt,
    ],
  );
  return result.rows[0].id;
}

function at(iso: string): Date {
  return new Date(iso);
}

async function expectHttpStatus(
  promise: Promise<unknown>,
  status: number,
  code?: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const httpError = error as {
      status?: number;
      getResponse?: () => unknown;
    };
    assert.equal(httpError.status, status);
    if (code) {
      const body = httpError.getResponse?.() as { code?: string } | undefined;
      assert.equal(body?.code, code);
    }
    return true;
  });
}

describe(
  'Campus transaction monitoring PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let db: DatabaseService;
    let reporting: ReportingService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      reporting = new ReportingService(db, new AccessService(db));
    });
    after(async () => {
      await pool?.end();
    });

    it('lists only the orders of the requested campus, newest first', async () => {
      const env = await createEnv(pool);
      const first = await createOrder(pool, env, env.tenantId, {
        status: 'completed',
        totalMinor: '50000',
        createdAt: at('2026-01-05T10:00:00Z'),
      });
      const second = await createOrder(pool, env, env.secondTenantId, {
        status: 'paid_awaiting_tenant',
        totalMinor: '40000',
        createdAt: at('2026-01-06T10:00:00Z'),
      });
      const foreign = await createOrder(pool, env, env.otherTenantId, {
        status: 'completed',
        totalMinor: '99000',
        createdAt: at('2026-01-07T10:00:00Z'),
      });

      const page = await reporting.listCampusTransactions(
        env.adminId,
        env.campusId,
        RANGE,
      );

      assert.equal(page.nextCursor, null);
      assert.deepEqual(
        page.items.map((row) => row.orderId),
        [second, first],
      );
      assert.equal(
        page.items.some((row) => row.orderId === foreign),
        false,
        'another campus order leaked into the page',
      );
      const newest = page.items[0];
      assert.equal(newest.tenantId, env.secondTenantId);
      assert.equal(newest.tenantName, 'Second tenant ' + env.tag);
      assert.equal(newest.status, 'paid_awaiting_tenant');
      assert.equal(newest.currency, 'IDR');
      assert.equal(newest.totalMinor, '40000');
      assert.equal(typeof newest.totalMinor, 'string');
      assert.equal(newest.buyerDisplayName, 'Buyer ' + env.tag);
      assert.match(newest.createdAt, MICRO_UTC_PATTERN);
      assert.match(newest.updatedAt, MICRO_UTC_PATTERN);
      assert.match(newest.pickupStartsAt, MICRO_UTC_PATTERN);
      assert.match(newest.orderNumber ?? '', /^AN-\d{8}-[0-9A-Z]{6}$/);
    });

    it('filters by order status and by tenant', async () => {
      const env = await createEnv(pool);
      const completed = await createOrder(pool, env, env.tenantId, {
        status: 'completed',
        createdAt: at('2026-01-05T10:00:00Z'),
      });
      await createOrder(pool, env, env.tenantId, {
        status: 'cancelled',
        createdAt: at('2026-01-06T10:00:00Z'),
      });
      const waiting = await createOrder(pool, env, env.secondTenantId, {
        status: 'paid_awaiting_tenant',
        createdAt: at('2026-01-07T10:00:00Z'),
      });

      const onlyCompleted = await reporting.listCampusTransactions(
        env.adminId,
        env.campusId,
        { ...RANGE, status: 'completed' },
      );
      assert.deepEqual(
        onlyCompleted.items.map((row) => row.orderId),
        [completed],
      );

      const onlySecondTenant = await reporting.listCampusTransactions(
        env.adminId,
        env.campusId,
        { ...RANGE, tenantId: env.secondTenantId },
      );
      assert.deepEqual(
        onlySecondTenant.items.map((row) => row.orderId),
        [waiting],
      );

      // A tenant of another campus may never widen the campus scope.
      await expectHttpStatus(
        reporting.listCampusTransactions(env.adminId, env.campusId, {
          ...RANGE,
          tenantId: env.otherTenantId,
        }),
        403,
        'REPORT_TENANT_OUT_OF_SCOPE',
      );
      await expectHttpStatus(
        reporting.listCampusTransactions(env.adminId, env.campusId, {
          ...RANGE,
          status: 'shipped',
        }),
        400,
        'REPORT_STATUS_INVALID',
      );
    });

    it('pages with an opaque cursor without duplicates or gaps', async () => {
      const env = await createEnv(pool);
      const created: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        created.push(
          await createOrder(pool, env, env.tenantId, {
            status: 'completed',
            createdAt: at('2026-01-1' + String(index) + 'T10:00:00Z'),
          }),
        );
      }
      const expected = [...created].reverse();

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
        const page = await reporting.listCampusTransactions(
          env.adminId,
          env.campusId,
          { ...RANGE, limit: 2, cursor },
        );
        seen.push(...page.items.map((row) => row.orderId));
        if (pageNumber < 2) {
          assert.equal(typeof page.nextCursor, 'string');
          cursor = page.nextCursor ?? undefined;
        } else {
          assert.equal(page.nextCursor, null);
        }
      }
      assert.deepEqual(seen, expected);
      assert.equal(new Set(seen).size, 5);
    });

    it('excludes orders outside the half-open window', async () => {
      const env = await createEnv(pool);
      await createOrder(pool, env, env.tenantId, {
        status: 'completed',
        createdAt: at('2025-12-31T23:59:59Z'),
      });
      const inside = await createOrder(pool, env, env.tenantId, {
        status: 'completed',
        createdAt: at('2026-01-15T10:00:00Z'),
      });
      // Exactly the upper bound is excluded: [from, to).
      await createOrder(pool, env, env.tenantId, {
        status: 'completed',
        createdAt: at('2026-02-01T00:00:00Z'),
      });

      const page = await reporting.listCampusTransactions(
        env.adminId,
        env.campusId,
        RANGE,
      );
      assert.deepEqual(
        page.items.map((row) => row.orderId),
        [inside],
      );
    });

    it('denies callers without campus access, including other campus admins', async () => {
      const env = await createEnv(pool);
      await createOrder(pool, env, env.tenantId, {
        status: 'completed',
        createdAt: at('2026-01-05T10:00:00Z'),
      });

      // Tenant owner: no campus permission.
      await expectHttpStatus(
        reporting.listCampusTransactions(env.ownerId, env.campusId, RANGE),
        403,
      );
      // Unrelated user: no membership at all.
      await expectHttpStatus(
        reporting.listCampusTransactions(env.outsiderId, env.campusId, RANGE),
        403,
      );
      // Admin of another campus on this campus.
      await expectHttpStatus(
        reporting.listCampusTransactions(env.otherAdminId, env.campusId, RANGE),
        403,
      );
      // Admin of this campus on the other campus.
      await expectHttpStatus(
        reporting.listCampusTransactions(env.adminId, env.otherCampusId, RANGE),
        403,
      );
    });

    it('rejects invalid windows, cursors and limits', async () => {
      const env = await createEnv(pool);
      const badWindows = [
        { from: '', to: RANGE.to },
        { from: 'not-a-date', to: RANGE.to },
        { from: RANGE.to, to: RANGE.from },
        { from: '2025-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
      ];
      for (const range of badWindows) {
        await expectHttpStatus(
          reporting.listCampusTransactions(env.adminId, env.campusId, range),
          400,
        );
      }

      const encoded = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const badCursors = [
        'not-a-cursor',
        encoded({ id: env.tenantId }),
        encoded({ createdAt: '2026-01-01T00:00:00.000Z', id: env.tenantId }),
        encoded({ createdAt: '2026-01-01T00:00:00.000000Z', id: 'nope' }),
      ];
      for (const cursor of badCursors) {
        await expectHttpStatus(
          reporting.listCampusTransactions(env.adminId, env.campusId, {
            ...RANGE,
            cursor,
          }),
          400,
          'REPORT_CURSOR_INVALID',
        );
      }

      for (const limit of [0, 101, 2.5]) {
        await expectHttpStatus(
          reporting.listCampusTransactions(env.adminId, env.campusId, {
            ...RANGE,
            limit,
          }),
          400,
          'REPORT_LIMIT_INVALID',
        );
      }
    });
  },
);
