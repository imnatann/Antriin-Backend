import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AvailabilityService } from '../src/modules/availability/availability.service';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { TenantOperatingHoursService } from '../src/modules/tenants/tenant-operating-hours.service';
import { WalletService } from '../src/modules/wallet/wallet.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const ITEM_PRICE_MINOR = 25000;

interface Fixture {
  campusId: string;
  tenantId: string;
  tenant2Id: string;
  buyerId: string;
  ownerId: string;
  kitchenId: string;
  pickupStaffId: string;
  managerId: string;
  categoryId: string;
  itemId: string;
}

let service: OrdersService;
let wallet: WalletService;

describe(
  'Orders cancellation for manager refund decisions (PostgreSQL)',
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
      service = new OrdersService(
        database,
        access,
        catalog,
        availability,
        wallet,
        audit,
        outbox,
        configService,
      );
    });

    after(async () => {
      await pool?.end();
    });

    for (const sourceStatus of [
      'paid_awaiting_tenant',
      'confirmed',
      'preparing',
      'ready_for_pickup',
    ] as const) {
      it(`cancels a ${sourceStatus} order for a refund decision and returns the payment id`, async () => {
        const fx = await createFixture(pool);
        const slot = await insertSlot(pool, fx.tenantId);
        const order = await placeOrder(fx, slot);
        await advanceTo(fx, order.id, sourceStatus);
        assert.equal(await orderStatus(pool, order.id), sourceStatus);
        assert.equal((await slotRow(pool, slot.id)).reserved_count, 1);

        const paymentId = await pool.query<{ id: string }>(
          'SELECT id FROM order_payments WHERE order_id = $1',
          [order.id],
        );
        const expectedPaymentId = paymentId.rows[0].id;
        const beforeVersion = await orderVersion(pool, order.id);

        const result = await withTx(pool, (client) =>
          service.cancelForRefundDecision(
            client,
            order.id,
            fx.managerId,
            'Kendala operasional: bahan habis',
          ),
        );

        assert.deepEqual(result, {
          orderId: order.id,
          buyerId: fx.buyerId,
          tenantId: fx.tenantId,
          status: 'cancelled',
          totalMinor: String(ITEM_PRICE_MINOR),
          currency: 'IDR',
          orderPaymentId: expectedPaymentId,
        });

        // Order row: cancelled + cancelled_at + version bumped.
        const row = await pool.query<{
          status: string;
          cancelled_at: Date | null;
          version: number;
        }>('SELECT status, cancelled_at, version FROM orders WHERE id = $1', [
          order.id,
        ]);
        assert.equal(row.rows[0].status, 'cancelled');
        assert.ok(row.rows[0].cancelled_at, 'CHECK 0007 requires cancelled_at');
        assert.equal(row.rows[0].version, beforeVersion + 1);

        // Capacity returned exactly once.
        assert.equal((await slotRow(pool, slot.id)).reserved_count, 0);
        const reservation = await pool.query<{ status: string }>(
          'SELECT status FROM slot_reservations WHERE order_id = $1',
          [order.id],
        );
        assert.equal(reservation.rows[0].status, 'released');

        // Event with actor + reason, single row.
        const events = await pool.query<{
          event_type: string;
          from_status: string | null;
          to_status: string | null;
          actor_user_id: string | null;
          reason: string;
        }>(
          "SELECT event_type, from_status, to_status, actor_user_id, reason FROM order_events WHERE order_id = $1 AND event_type = 'order.cancelled'",
          [order.id],
        );
        assert.equal(events.rows.length, 1);
        assert.equal(events.rows[0].from_status, sourceStatus);
        assert.equal(events.rows[0].to_status, 'cancelled');
        assert.equal(events.rows[0].actor_user_id, fx.managerId);
        assert.equal(events.rows[0].reason, 'Kendala operasional: bahan habis');

        // Immutable audit with the manager action + reason.
        const audit = await pool.query<{
          action: string;
          scope_type: string;
          scope_id: string;
          target_type: string;
          target_id: string;
          actor_user_id: string | null;
          reason: string;
        }>(
          "SELECT action, scope_type, scope_id, target_type, target_id, actor_user_id, reason FROM audit_events WHERE target_id = $1 AND action = 'tenant.orders.cancelled_by_manager'",
          [order.id],
        );
        assert.equal(audit.rows.length, 1);
        assert.equal(audit.rows[0].scope_type, 'tenant');
        assert.equal(audit.rows[0].scope_id, fx.tenantId);
        assert.equal(audit.rows[0].target_type, 'order');
        assert.equal(audit.rows[0].actor_user_id, fx.managerId);
        assert.equal(audit.rows[0].reason, 'Kendala operasional: bahan habis');

        // Buyer notification queued in the same transaction.
        const outbox = await pool.query<{
          event_type: string;
          recipient_ids: string[];
        }>(
          'SELECT event_type, recipient_ids FROM outbox_events WHERE aggregate_id = $1 AND event_key = $2',
          [order.id, 'order.cancelled:' + order.id],
        );
        assert.equal(outbox.rows.length, 1);
        assert.equal(outbox.rows[0].event_type, 'order.status_changed');
        assert.deepEqual(outbox.rows[0].recipient_ids, [fx.buyerId]);
      });
    }

    it('rejects cancellation of completed, cancelled and declined orders with 409 and no side effects', async () => {
      const fx = await createFixture(pool);

      // completed
      const completedSlot = await insertSlot(pool, fx.tenantId);
      const completedOrder = await placeOrder(fx, completedSlot);
      await advanceTo(fx, completedOrder.id, 'ready_for_pickup');
      await withTx(pool, (client) =>
        service.markHandedOver(
          client,
          fx.tenantId,
          completedOrder.id,
          fx.pickupStaffId,
        ),
      );
      const completedBefore = await cancelSideEffects(pool, completedOrder.id);
      await assert.rejects(
        withTx(pool, (client) =>
          service.cancelForRefundDecision(
            client,
            completedOrder.id,
            fx.managerId,
            'Terlambat',
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          (error.getResponse() as { code?: string }).code ===
            'ORDER_CANCEL_CONFLICT',
      );
      assert.equal(await orderStatus(pool, completedOrder.id), 'completed');
      assert.deepEqual(
        await cancelSideEffects(pool, completedOrder.id),
        completedBefore,
      );

      // declined
      const declinedSlot = await insertSlot(pool, fx.tenantId);
      const declinedOrder = await placeOrder(fx, declinedSlot);
      await service.tenantTransition(
        fx.ownerId,
        fx.tenantId,
        declinedOrder.id,
        'decline',
        { reason: 'Bahan habis' },
      );
      const declinedBefore = await cancelSideEffects(pool, declinedOrder.id);
      await assert.rejects(
        withTx(pool, (client) =>
          service.cancelForRefundDecision(
            client,
            declinedOrder.id,
            fx.managerId,
            'Duplikat',
          ),
        ),
        ConflictException,
      );
      assert.equal(await orderStatus(pool, declinedOrder.id), 'declined');
      assert.deepEqual(
        await cancelSideEffects(pool, declinedOrder.id),
        declinedBefore,
      );

      // cancelled (already cancelled once)
      const cancelledSlot = await insertSlot(pool, fx.tenantId);
      const cancelledOrder = await placeOrder(fx, cancelledSlot);
      await withTx(pool, (client) =>
        service.cancelForRefundDecision(
          client,
          cancelledOrder.id,
          fx.managerId,
          'Kendala operasional',
        ),
      );
      const cancelledBefore = await cancelSideEffects(pool, cancelledOrder.id);
      await assert.rejects(
        withTx(pool, (client) =>
          service.cancelForRefundDecision(
            client,
            cancelledOrder.id,
            fx.managerId,
            'Ulangi',
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          (error.getResponse() as { code?: string }).code ===
            'ORDER_CANCEL_CONFLICT',
      );
      // Replay must not write a second event/audit or release capacity twice.
      assert.deepEqual(
        await cancelSideEffects(pool, cancelledOrder.id),
        cancelledBefore,
      );
      assert.equal((await slotRow(pool, cancelledSlot.id)).reserved_count, 0);
    });

    it('lets exactly one of two parallel cancellations win', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId);
      const order = await placeOrder(fx, slot);
      await advanceTo(fx, order.id, 'confirmed');

      const results = await Promise.allSettled([
        withTx(pool, (client) =>
          service.cancelForRefundDecision(
            client,
            order.id,
            fx.managerId,
            'Kendala operasional A',
          ),
        ),
        withTx(pool, (client) =>
          service.cancelForRefundDecision(
            client,
            order.id,
            fx.managerId,
            'Kendala operasional B',
          ),
        ),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult[];
      assert.equal(fulfilled.length, 1, 'exactly one cancellation wins');
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0].reason instanceof ConflictException);
      assert.equal(
        (rejected[0].reason.getResponse() as { code?: string }).code,
        'ORDER_CANCEL_CONFLICT',
      );

      // Capacity released exactly once, one event, one audit, one outbox row.
      assert.equal((await slotRow(pool, slot.id)).reserved_count, 0);
      const counts = await cancelSideEffects(pool, order.id);
      assert.equal(counts.cancelledEvents, 1);
      assert.equal(counts.audits, 1);
      assert.equal(counts.outbox, 1);
      assert.equal(await orderStatus(pool, order.id), 'cancelled');
    });

    it('requires a non-empty reason and an existing order', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId);
      const order = await placeOrder(fx, slot);

      await assert.rejects(
        withTx(pool, (client) =>
          service.cancelForRefundDecision(
            client,
            order.id,
            fx.managerId,
            '   ',
          ),
        ),
        BadRequestException,
      );
      await assert.rejects(
        withTx(pool, (client) =>
          service.cancelForRefundDecision(
            client,
            order.id,
            fx.managerId,
            'x'.repeat(501),
          ),
        ),
        BadRequestException,
      );
      assert.equal(await orderStatus(pool, order.id), 'paid_awaiting_tenant');
      assert.equal((await slotRow(pool, slot.id)).reserved_count, 1);

      await assert.rejects(
        withTx(pool, (client) =>
          service.cancelForRefundDecision(
            client,
            randomUUID(),
            fx.managerId,
            'Tidak ada',
          ),
        ),
        NotFoundException,
      );
      // Tenant/buyer/amount always come from the locked order row, never from a
      // parameter: the returned context is that of the order's own tenant.
      const result = await withTx(pool, (client) =>
        service.cancelForRefundDecision(
          client,
          order.id,
          fx.managerId,
          'Kendala operasional',
        ),
      );
      assert.equal(result.tenantId, fx.tenantId);
      assert.equal(result.buyerId, fx.buyerId);
    });
  },
);

interface CancelSideEffects {
  cancelledEvents: number;
  audits: number;
  outbox: number;
  status: string;
  cancelledAt: string | null;
}

async function cancelSideEffects(
  pool: Pool,
  orderId: string,
): Promise<CancelSideEffects> {
  const result = await pool.query<{
    status: string;
    cancelled_at: string | null;
    events: string;
    audits: string;
    outbox: string;
  }>(
    `SELECT o.status,
            to_char(o.cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cancelled_at,
            (SELECT count(*) FROM order_events e
              WHERE e.order_id = o.id AND e.event_type = 'order.cancelled')::text AS events,
            (SELECT count(*) FROM audit_events a
              WHERE a.target_id = o.id
                AND a.action = 'tenant.orders.cancelled_by_manager')::text AS audits,
            (SELECT count(*) FROM outbox_events ob
              WHERE ob.aggregate_id = o.id
                AND ob.event_key = 'order.cancelled:' || o.id::text)::text AS outbox
       FROM orders o WHERE o.id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  return {
    cancelledEvents: Number(row.events),
    audits: Number(row.audits),
    outbox: Number(row.outbox),
    status: row.status,
    cancelledAt: row.cancelled_at,
  };
}

async function advanceTo(
  fx: Fixture,
  orderId: string,
  target:
    'paid_awaiting_tenant' | 'confirmed' | 'preparing' | 'ready_for_pickup',
): Promise<void> {
  if (target === 'paid_awaiting_tenant') return;
  await service.tenantTransition(fx.ownerId, fx.tenantId, orderId, 'confirm');
  if (target === 'confirmed') return;
  await service.tenantTransition(fx.kitchenId, fx.tenantId, orderId, 'prepare');
  if (target === 'preparing') return;
  await service.tenantTransition(fx.kitchenId, fx.tenantId, orderId, 'ready');
}

async function placeOrder(fx: Fixture, slot: { id: string; version: number }) {
  const result = await service.checkout(
    fx.buyerId,
    'checkout-' + randomUUID(),
    {
      tenantId: fx.tenantId,
      slotId: slot.id,
      expectedSlotVersion: slot.version,
      items: [{ menuItemId: fx.itemId, quantity: 1 }],
    },
  );
  return result.data;
}

async function orderStatus(pool: Pool, orderId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM orders WHERE id = $1',
    [orderId],
  );
  return result.rows[0].status;
}

async function orderVersion(pool: Pool, orderId: string): Promise<number> {
  const result = await pool.query<{ version: number }>(
    'SELECT version FROM orders WHERE id = $1',
    [orderId],
  );
  return result.rows[0].version;
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

async function withTx<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createFixture(pool: Pool): Promise<Fixture> {
  const id = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      "INSERT INTO campuses (name, timezone, status) VALUES ($1, 'Asia/Jakarta', 'active') RETURNING id",
      ['Campus ' + id],
    )
  ).rows[0].id;
  const insertTenant = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        "INSERT INTO tenants (campus_id, name, location, status) VALUES ($1, $2, 'Kantin Uji', 'open') RETURNING id",
        [campusId, name + ' ' + id],
      )
    ).rows[0].id;
  const tenantId = await insertTenant('Tenant A');
  const tenant2Id = await insertTenant('Tenant B');
  const insertUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'INSERT INTO users (display_name) VALUES ($1) RETURNING id',
        [name + ' ' + id],
      )
    ).rows[0].id;
  const buyerId = await insertUser('Buyer');
  const ownerId = await insertUser('Owner');
  const kitchenId = await insertUser('Kitchen');
  const pickupStaffId = await insertUser('PickupStaff');
  const managerId = await insertUser('CampusManager');

  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) VALUES ($1, $2, 'owner', '{}', 'active', now())",
    [tenantId, ownerId],
  );
  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status) VALUES ($1, $2, 'kitchen', '{tenant.orders.read,tenant.orders.accept,tenant.orders.prepare}', 'active')",
    [tenantId, kitchenId],
  );
  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status) VALUES ($1, $2, 'pickup', '{tenant.orders.read,tenant.orders.handover}', 'active')",
    [tenantId, pickupStaffId],
  );
  // Campus manager: the refund decision belongs to the campus/cases slice, so
  // the actor only needs to be a real, active user for this contract.
  await pool.query(
    "INSERT INTO campus_memberships (campus_id, user_id, permissions, status) VALUES ($1, $2, '{campus.cases.decide,campus.refunds.initiate}', 'active')",
    [campusId, managerId],
  );
  for (const tenant of [tenantId, tenant2Id]) {
    await pool.query(
      "INSERT INTO tenant_operating_hours (tenant_id, weekday, is_open, opens_at, closes_at, updated_at) SELECT $1, g, true, '00:00:00'::time, '23:59:59'::time, now() FROM generate_series(0, 6) AS g",
      [tenant],
    );
  }
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
    tenant2Id,
    buyerId,
    ownerId,
    kitchenId,
    pickupStaffId,
    managerId,
    categoryId,
    itemId,
  };
}

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
