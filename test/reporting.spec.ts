import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { ReportingService } from '../src/modules/reporting/reporting.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

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
  const mkUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [name + ' ' + tag],
      )
    ).rows[0].id;
  const ownerId = await mkUser('Owner');
  const kitchenId = await mkUser('Kitchen');
  const buyerId = await mkUser('Buyer');
  const adminId = await mkUser('CampusAdmin');
  const outsiderId = await mkUser('Outsider');
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1, $2, 'kitchen', $3::text[], 'active')",
    [tenantId, kitchenId, ['tenant.sales.read']],
  );
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) values ($1, $2, 'owner', $3::text[], 'active', now())",
    [tenantId, ownerId, ['tenant.sales.read']],
  );
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [campusId, adminId, ['campus.transactions.read']],
  );
  return {
    tag,
    campusId,
    tenantId,
    ownerId,
    kitchenId,
    buyerId,
    adminId,
    outsiderId,
  };
}

async function createOrder(
  pool: Pool,
  env: Env,
  status: string,
  totalMinor: string,
  createdAt?: Date,
) {
  const slotId = (
    await pool.query<{ id: string }>(
      `insert into pickup_slots
         (tenant_id, starts_at, ends_at, capacity, reserved_count, status, version, created_at, updated_at)
       values ($1, now() + interval '2 hours', now() + interval '3 hours', 5, 0, 'open', 1, now(), now())
       returning id`,
      [env.tenantId],
    )
  ).rows[0].id;
  // orders_status_timestamps_check (D12.4): status and timestamps must agree.
  const completed = status === 'completed';
  const now = new Date();
  const result = await pool.query<{ id: string }>(
    `insert into orders
       (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot, tenant_timezone_snapshot,
        pickup_starts_at, pickup_ends_at, status, currency, subtotal_minor, total_minor,
        paid_at, confirmed_at, ready_at, completed_at, cancelled_at, declined_at,
        created_at, updated_at)
     values ($1, $2, $3, $4, 'Asia/Jakarta', now(), now() + interval '1 hour', $5, 'IDR',
             $6, $6, $7, $8, $9, $10,
             $11, $12, $13, $13)
     returning id`,
    [
      env.buyerId,
      env.tenantId,
      slotId,
      'Tenant ' + env.tag,
      status,
      totalMinor,
      completed ? now : null,
      completed ? now : null,
      completed ? now : null,
      completed ? now : null,
      status === 'cancelled' ? now : null,
      status === 'declined' ? now : null,
      createdAt ?? now,
    ],
  );
  return result.rows[0].id;
}

describe(
  'Reporting slice PostgreSQL integration',
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

    it('summarizes tenant orders and refunds per status in the window', async () => {
      const env = await createEnv(pool);
      const from = new Date('2026-01-01T00:00:00.000Z');
      const to = new Date('2026-02-01T00:00:00.000Z');
      await createOrder(
        pool,
        env,
        'completed',
        '50000',
        new Date('2026-01-05T10:00:00Z'),
      );
      await createOrder(
        pool,
        env,
        'completed',
        '30000',
        new Date('2026-01-06T10:00:00Z'),
      );
      await createOrder(
        pool,
        env,
        'cancelled',
        '20000',
        new Date('2026-01-07T10:00:00Z'),
      );
      // Outside the window: must not be counted.
      await createOrder(
        pool,
        env,
        'completed',
        '99000',
        new Date('2026-03-01T10:00:00Z'),
      );

      const report = await reporting.getSalesReport(env.ownerId, env.tenantId, {
        from: from.toISOString(),
        to: to.toISOString(),
      });
      assert.equal(report.currency, 'IDR');
      assert.equal(report.tenantId, env.tenantId);
      const completed = report.orders.find((row) => row.status === 'completed');
      assert.equal(completed?.count, 2);
      assert.equal(completed?.totalMinor, '80000');
      const cancelled = report.orders.find((row) => row.status === 'cancelled');
      assert.equal(cancelled?.count, 1);
      assert.equal(cancelled?.totalMinor, '20000');
      assert.equal(
        report.orders.reduce((sum, row) => sum + row.count, 0),
        3,
      );
      assert.deepEqual(report.refunds, []);
    });

    it('refuses a tenant report without tenant.sales.read or with a bad window', async () => {
      const env = await createEnv(pool);
      const range = {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      };
      await assert.rejects(
        reporting.getSalesReport(env.outsiderId, env.tenantId, range),
        (error) => (error as { status?: number }).status === 403,
      );
      await assert.rejects(
        reporting.getSalesReport(env.adminId, env.tenantId, range),
        (error) => (error as { status?: number }).status === 403,
      );
      for (const bad of [
        { from: '', to: range.to },
        { from: 'not-a-date', to: range.to },
        { from: range.to, to: range.from },
        { from: '2025-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
      ]) {
        await assert.rejects(
          reporting.getSalesReport(env.ownerId, env.tenantId, bad),
          (error) => (error as { status?: number }).status === 400,
          JSON.stringify(bad),
        );
      }
    });

    it('builds the campus dashboard across tenants, orders, cases and payouts', async () => {
      const env = await createEnv(pool);
      const from = new Date('2026-01-01T00:00:00.000Z');
      const to = new Date('2026-02-01T00:00:00.000Z');
      await createOrder(
        pool,
        env,
        'completed',
        '50000',
        new Date('2026-01-05T10:00:00Z'),
      );
      await createOrder(
        pool,
        env,
        'paid_awaiting_tenant',
        '40000',
        new Date('2026-01-06T10:00:00Z'),
      );
      await pool.query(
        `insert into cases (campus_id, tenant_id, opened_by_user_id, category, status, subject, details, version, created_at, updated_at)
         values ($1, $2, $3, 'other', 'reported', 'Subjek', '', 1, $4, now())`,
        [
          env.campusId,
          env.tenantId,
          env.buyerId,
          new Date('2026-01-08T10:00:00Z'),
        ],
      );

      const dashboard = await reporting.getCampusDashboard(
        env.adminId,
        env.campusId,
        { from: from.toISOString(), to: to.toISOString() },
      );
      assert.equal(dashboard.campusId, env.campusId);
      assert.equal(dashboard.currency, 'IDR');
      assert.deepEqual(dashboard.tenants, [{ status: 'open', count: 1 }]);
      assert.equal(
        dashboard.orders.find((row) => row.status === 'completed')?.count,
        1,
      );
      assert.equal(
        dashboard.orders.find((row) => row.status === 'paid_awaiting_tenant')
          ?.totalMinor,
        '40000',
      );
      assert.deepEqual(dashboard.cases, [{ status: 'reported', count: 1 }]);
      assert.deepEqual(dashboard.payouts, []);
      assert.deepEqual(dashboard.refunds, []);
    });

    it('scopes the dashboard to one campus and its permission', async () => {
      const env = await createEnv(pool);
      const otherCampusId = (
        await pool.query<{ id: string }>(
          'insert into campuses (name) values ($1) returning id',
          ['Other ' + env.tag],
        )
      ).rows[0].id;
      const range = {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      };
      await assert.rejects(
        reporting.getCampusDashboard(env.ownerId, env.campusId, range),
        (error) => (error as { status?: number }).status === 403,
      );
      await assert.rejects(
        reporting.getCampusDashboard(env.adminId, otherCampusId, range),
        (error) => (error as { status?: number }).status === 403,
      );
      const own = await reporting.getCampusDashboard(
        env.adminId,
        env.campusId,
        range,
      );
      assert.equal(own.tenants[0].count, 1);
    });
  },
);
