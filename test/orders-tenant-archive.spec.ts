import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AvailabilityService } from '../src/modules/availability/availability.service';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { TenantOperatingHoursService } from '../src/modules/tenants/tenant-operating-hours.service';
import { TenantsService } from '../src/modules/tenants/tenants.service';
import { WalletService } from '../src/modules/wallet/wallet.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const ITEM_PRICE_MINOR = 30000;
const TS = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface Fixture {
  campusId: string;
  tenantId: string;
  buyerId: string;
  ownerId: string;
  adminId: string;
  itemId: string;
  slotId: string;
  slotVersion: number;
}

let orders: OrdersService;
let tenants: TenantsService;
let wallet: WalletService;

describe(
  'P2-05 write skew: checkout vs tenant archive (PostgreSQL)',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 20 });
      await pool.query('select 1');
      const database = { pool } as unknown as DatabaseService;
      const access = new AccessService(database);
      const audit = new AuditService(database, access);
      const operatingHours = new TenantOperatingHoursService(
        database,
        access,
        audit,
      );
      const availability = new AvailabilityService(
        database,
        access,
        operatingHours,
        audit,
      );
      const catalog = new CatalogService(database, access, availability, audit);
      wallet = new WalletService(database);
      const outbox = new OutboxService(database);
      const config: Record<string, number> = {
        ORDER_PROPOSAL_TTL_SECONDS: 600,
        ORDER_PREPARATION_LEAD_SECONDS: 7200,
      };
      const configService = {
        get: (key: string) => config[key],
      } as unknown as ConfigService;
      orders = new OrdersService(
        database,
        access,
        catalog,
        availability,
        wallet,
        audit,
        outbox,
        configService,
      );
      tenants = new TenantsService(database, access, audit);
    });

    after(async () => {
      await pool?.end();
    });

    it('never creates an order on an already archived tenant (archive wins)', async () => {
      // Archive FIRST through the real TenantsService (possible because this
      // fixture has no pickup slots yet), then give the archived tenant a slot
      // so the checkout gets past slot lookup and must be stopped by the
      // tenant guard itself.
      const fx = await createFixture(pool, { withSlot: false });
      const tenant = await tenantState(pool, fx.tenantId);
      await tenants.archive(fx.adminId, fx.campusId, fx.tenantId, {
        reason: 'Tenant berhenti beroperasi',
        expectedUpdatedAt: tenant.updatedAt,
      });
      assert.equal((await tenantState(pool, fx.tenantId)).status, 'archived');
      const slot = await insertSlot(pool, fx.tenantId);

      await assert.rejects(
        orders.checkout(fx.buyerId, 'checkout-archived-tenant', {
          tenantId: fx.tenantId,
          slotId: slot.id,
          expectedSlotVersion: slot.version,
          items: [{ menuItemId: fx.itemId, quantity: 1 }],
        }),
        (error: unknown) =>
          error instanceof NotFoundException ||
          error instanceof ConflictException,
      );

      const count = await pool.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM orders WHERE tenant_id = $1',
        [fx.tenantId],
      );
      assert.equal(count.rows[0].total, '0', 'no order on an archived tenant');
      assert.equal((await slotRow(pool, slot.id)).reserved_count, 0);
      assert.equal(await walletBalance(pool, fx.buyerId), '10000000');
    });

    it('serializes a parallel checkout and archive: exactly one wins, never both', async () => {
      const fx = await createFixture(pool);
      const tenant = await tenantState(pool, fx.tenantId);

      // Both transactions start at the same time. Depending on who grabs the
      // tenants row first: either the archive waits for the checkout (and is
      // then refused with 409 because an active order now exists), or the
      // checkout sees the archived tenant and fails with 404.
      const results = await Promise.allSettled([
        orders.checkout(fx.buyerId, 'checkout-vs-archive', {
          tenantId: fx.tenantId,
          slotId: fx.slotId,
          expectedSlotVersion: fx.slotVersion,
          items: [{ menuItemId: fx.itemId, quantity: 1 }],
        }),
        tenants.archive(fx.adminId, fx.campusId, fx.tenantId, {
          reason: 'Tenant berhenti beroperasi',
          expectedUpdatedAt: tenant.updatedAt,
        }),
      ]);
      const [checkoutResult, archiveResult] = results;

      const finalTenant = await tenantState(pool, fx.tenantId);
      const ordersCount = await pool.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM orders WHERE tenant_id = $1',
        [fx.tenantId],
      );
      const orderCount = Number(ordersCount.rows[0].total);

      if (checkoutResult.status === 'fulfilled') {
        // Checkout won: the archive must have been refused, never silently
        // applied over a freshly created order.
        assert.equal(archiveResult.status, 'rejected');
        assert.ok(
          (archiveResult as PromiseRejectedResult).reason instanceof
            ConflictException,
          'archive must be refused with 409 when an active order exists',
        );
        assert.equal(finalTenant.status, 'open');
        assert.equal(orderCount, 1);
        // The order was created while the tenant was still open: its creation
        // precedes any archive (there is none) and the row is intact.
        const created = await pool.query<{ status: string }>(
          'SELECT status FROM orders WHERE tenant_id = $1',
          [fx.tenantId],
        );
        assert.equal(created.rows[0].status, 'paid_awaiting_tenant');
      } else {
        // Archive won: the checkout must have failed and left no order behind.
        assert.equal(finalTenant.status, 'archived');
        assert.equal(orderCount, 0, 'no order born on an archived tenant');
        const failure = (checkoutResult as PromiseRejectedResult).reason;
        assert.ok(
          failure instanceof NotFoundException ||
            failure instanceof ConflictException,
          `expected 404/409, got: ${String(failure)}`,
        );
        assert.equal((await slotRow(pool, fx.slotId)).reserved_count, 0);
        assert.equal(await walletBalance(pool, fx.buyerId), '10000000');
      }
    });

    it('holds the tenants row lock for the whole checkout transaction', async () => {
      const fx = await createFixture(pool);
      const tenant = await tenantState(pool, fx.tenantId);
      const client = await pool.connect();
      try {
        // Simulate a checkout that has already taken its shared tenant lock and
        // is still running: a concurrent archive must wait, not slip through.
        await client.query('BEGIN');
        await client.query(
          `SELECT t.id FROM tenants t JOIN campuses c ON c.id = t.campus_id
            WHERE t.id = $1 AND t.status <> 'archived' AND c.status = 'active'
            FOR SHARE OF t, c`,
          [fx.tenantId],
        );
        const archive = tenants.archive(fx.adminId, fx.campusId, fx.tenantId, {
          reason: 'Tenant berhenti beroperasi',
          expectedUpdatedAt: tenant.updatedAt,
        });
        let archiveSettled = false;
        archive
          .then(() => {
            archiveSettled = true;
          })
          .catch(() => {
            archiveSettled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(
          archiveSettled,
          false,
          'archive must block while the checkout holds the tenant lock',
        );
        await client.query('COMMIT');
        // Once the checkout commits, the archive proceeds and is refused 409
        // because the dependency count is re-evaluated under its own lock.
        await assert.rejects(archive, ConflictException);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      assert.equal((await tenantState(pool, fx.tenantId)).status, 'open');
    });
  },
);

async function insertSlot(
  pool: Pool,
  tenantId: string,
): Promise<{ id: string; version: number }> {
  const result = await pool.query<{ id: string; version: number }>(
    "INSERT INTO pickup_slots (tenant_id, starts_at, ends_at, capacity, reserved_count, status, updated_at) VALUES ($1, now() + interval '30 minutes', now() + interval '90 minutes', 5, 0, 'open', now()) RETURNING id, version",
    [tenantId],
  );
  return result.rows[0];
}

async function tenantState(
  pool: Pool,
  tenantId: string,
): Promise<{ status: string; updatedAt: string }> {
  const result = await pool.query<{ status: string; updated_at: string }>(
    `SELECT status, ${TS('updated_at')} AS updated_at FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return {
    status: result.rows[0].status,
    updatedAt: result.rows[0].updated_at,
  };
}

async function slotRow(
  pool: Pool,
  slotId: string,
): Promise<{ reserved_count: number }> {
  const result = await pool.query<{ reserved_count: number }>(
    'SELECT reserved_count FROM pickup_slots WHERE id = $1',
    [slotId],
  );
  return result.rows[0];
}

async function walletBalance(pool: Pool, userId: string): Promise<string> {
  const result = await pool.query<{ balance_minor: string }>(
    "SELECT coalesce(balance_minor,0)::text AS balance_minor FROM wallet_accounts WHERE account_type = 'wallet' AND owner_user_id = $1",
    [userId],
  );
  return result.rows[0]?.balance_minor ?? '0';
}

async function createFixture(
  pool: Pool,
  options: { withSlot?: boolean } = {},
): Promise<Fixture> {
  const id = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      "INSERT INTO campuses (name, timezone, status) VALUES ($1, 'Asia/Jakarta', 'active') RETURNING id",
      ['Campus ' + id],
    )
  ).rows[0].id;
  const tenantId = (
    await pool.query<{ id: string }>(
      "INSERT INTO tenants (campus_id, name, location, status) VALUES ($1, $2, 'Kantin Uji', 'open') RETURNING id",
      [campusId, 'Tenant ' + id],
    )
  ).rows[0].id;
  const insertUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'INSERT INTO users (display_name) VALUES ($1) RETURNING id',
        [name + ' ' + id],
      )
    ).rows[0].id;
  const buyerId = await insertUser('Buyer');
  const ownerId = await insertUser('Owner');
  const adminId = await insertUser('CampusAdmin');

  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) VALUES ($1, $2, 'owner', '{}', 'active', now())",
    [tenantId, ownerId],
  );
  await pool.query(
    "INSERT INTO campus_memberships (campus_id, user_id, permissions, status) VALUES ($1, $2, '{campus.tenants.manage}', 'active')",
    [campusId, adminId],
  );
  await pool.query(
    "INSERT INTO tenant_operating_hours (tenant_id, weekday, is_open, opens_at, closes_at, updated_at) SELECT $1, g, true, '00:00:00'::time, '23:59:59'::time, now() FROM generate_series(0, 6) AS g",
    [tenantId],
  );
  const categoryId = (
    await pool.query<{ id: string }>(
      "INSERT INTO menu_categories (tenant_id, name, sort_order, status) VALUES ($1, 'Makanan', 0, 'active') RETURNING id",
      [tenantId],
    )
  ).rows[0].id;
  const itemId = (
    await pool.query<{ id: string }>(
      "INSERT INTO menu_items (tenant_id, category_id, name, description, price_minor, status, version, updated_at) VALUES ($1,$2,'Nasi Ayam','Deskripsi',$3,'active',1, now()) RETURNING id",
      [tenantId, categoryId, ITEM_PRICE_MINOR],
    )
  ).rows[0].id;
  const slot: { id: string; version: number } =
    options.withSlot === false
      ? { id: '', version: 1 }
      : await insertSlot(pool, tenantId);
  const funding = await wallet.ensureSystemAccount('test.funding', 'IDR');
  const target = await wallet.getOrCreateWallet(buyerId, 'IDR');
  await wallet.postTransfer({
    idempotencyScope: 'test.funding',
    idempotencyKey: randomUUID(),
    currency: 'IDR',
    amountMinor: '10000000',
    debitAccountId: funding.accountId,
    creditAccountId: target.accountId,
    actor: { type: 'service', id: 'test.funding' },
    reason: 'test funding',
  });
  return {
    campusId,
    tenantId,
    buyerId,
    ownerId,
    adminId,
    itemId,
    slotId: slot.id,
    slotVersion: slot.version,
  };
}
