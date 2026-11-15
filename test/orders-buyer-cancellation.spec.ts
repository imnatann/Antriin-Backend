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
const MICRO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

interface Fixture {
  campusId: string;
  tenantId: string;
  buyerId: string;
  otherBuyerId: string;
  ownerId: string;
  kitchenId: string;
  pickupStaffId: string;
  itemId: string;
}

let service: OrdersService;
let wallet: WalletService;

describe(
  'Buyer-initiated order cancellation (PostgreSQL)',
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
        // Large enough that the tenant may move an order to 'preparing'
        // immediately: the lead only gates production, never cancellation.
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

    it('cancels a paid_awaiting_tenant order: capacity released, exactly one pending refund, no wallet credit', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId);
      const order = await placeOrder(fx, slot);
      const balanceBefore = await balanceMinor(fx.buyerId);
      const expectedPaymentId = await orderPaymentId(pool, order.id);

      const result = await service.cancelByBuyer(
        fx.buyerId,
        order.id,
        'Salah pilih jadwal',
      );

      assert.equal(result.meta.replayed, false);
      assert.deepEqual(
        {
          orderId: result.data.orderId,
          orderNumber: result.data.orderNumber,
          status: result.data.status,
          version: result.data.version,
          refundStatus: result.data.refund.status,
          refundAmount: result.data.refund.amountMinor,
          refundCurrency: result.data.refund.currency,
        },
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: 'cancelled',
          version: order.version + 1,
          refundStatus: 'requested',
          refundAmount: String(ITEM_PRICE_MINOR),
          refundCurrency: 'IDR',
        },
      );
      assert.match(result.data.cancelledAt, MICRO_UTC);
      assert.match(result.data.refund.requestedAt, MICRO_UTC);

      // Order row: cancelled + cancelled_at + version bump (CHECK 0007).
      const row = await pool.query<{
        status: string;
        cancelled_at: Date | null;
        version: number;
      }>('SELECT status, cancelled_at, version FROM orders WHERE id = $1', [
        order.id,
      ]);
      assert.equal(row.rows[0].status, 'cancelled');
      assert.ok(row.rows[0].cancelled_at);
      assert.equal(row.rows[0].version, order.version + 1);

      // Capacity returned exactly once.
      assert.equal((await slotReservedCount(pool, slot.id)).reserved_count, 0);
      const reservation = await pool.query<{
        status: string;
        released_at: Date | null;
      }>(
        'SELECT status, released_at FROM slot_reservations WHERE order_id = $1',
        [order.id],
      );
      assert.equal(reservation.rows[0].status, 'released');
      assert.ok(reservation.rows[0].released_at);

      // Exactly one FULL refund, pending, scoped to the order's campus/tenant,
      // requested by the buyer and never decided by a manager.
      const refunds = await pool.query<{
        id: string;
        campus_id: string;
        tenant_id: string;
        order_payment_id: string;
        case_id: string | null;
        buyer_id: string;
        amount_minor: string;
        currency: string;
        status: string;
        provider: string;
        provider_reference: string | null;
        requested_by_user_id: string;
        decided_by_user_id: string | null;
        succeeded_at: Date | null;
        ledger_transaction_id: string | null;
        requested_at: Date | null;
      }>(
        `SELECT id, campus_id, tenant_id, order_payment_id, case_id, buyer_id,
                amount_minor::text AS amount_minor, currency, status, provider,
                provider_reference, requested_by_user_id, decided_by_user_id,
                succeeded_at, ledger_transaction_id, requested_at
           FROM refunds WHERE order_id = $1`,
        [order.id],
      );
      assert.equal(refunds.rows.length, 1, 'exactly one refund per order');
      const refund = refunds.rows[0];
      assert.equal(refund.id, result.data.refund.id);
      assert.equal(refund.campus_id, fx.campusId);
      assert.equal(refund.tenant_id, fx.tenantId);
      assert.equal(refund.order_payment_id, expectedPaymentId);
      assert.equal(
        refund.case_id,
        null,
        'a buyer cancel is not a case decision',
      );
      assert.equal(refund.buyer_id, fx.buyerId);
      assert.equal(refund.amount_minor, String(ITEM_PRICE_MINOR));
      assert.equal(refund.status, 'requested');
      assert.equal(refund.provider, 'sandbox');
      assert.equal(refund.provider_reference, null);
      assert.equal(refund.requested_by_user_id, fx.buyerId);
      assert.equal(refund.decided_by_user_id, null);
      assert.equal(refund.succeeded_at, null);
      assert.equal(
        refund.ledger_transaction_id,
        null,
        'no ledger movement on the cancellation itself',
      );

      // The refund is queued for the refunds worker, not executed here.
      const queued = await pool.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM refund_request_outbox WHERE refund_id = $1',
        [refund.id],
      );
      assert.equal(queued.rows.length, 1);
      assert.equal(queued.rows[0].status, 'pending');
      assert.equal(queued.rows[0].attempts, 0);

      // Money is NOT credited by this path.
      assert.equal(await balanceMinor(fx.buyerId), balanceBefore);

      // Timeline: one order.cancelled event attributed to the buyer.
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
      assert.equal(events.rows[0].from_status, 'paid_awaiting_tenant');
      assert.equal(events.rows[0].to_status, 'cancelled');
      assert.equal(events.rows[0].actor_user_id, fx.buyerId);
      assert.equal(events.rows[0].reason, 'Salah pilih jadwal');

      // Immutable audit inside the tenant scope with the buyer as actor.
      const audits = await pool.query<{
        scope_type: string;
        scope_id: string;
        target_type: string;
        target_id: string;
        actor_user_id: string | null;
        reason: string;
      }>(
        "SELECT scope_type, scope_id, target_type, target_id, actor_user_id, reason FROM audit_events WHERE target_id = $1 AND action = 'order.cancelled_by_buyer'",
        [order.id],
      );
      assert.equal(audits.rows.length, 1);
      assert.equal(audits.rows[0].scope_type, 'tenant');
      assert.equal(audits.rows[0].scope_id, fx.tenantId);
      assert.equal(audits.rows[0].target_type, 'order');
      assert.equal(audits.rows[0].actor_user_id, fx.buyerId);
      assert.equal(audits.rows[0].reason, 'Salah pilih jadwal');

      // Outbox: buyer confirmation + tenant queue update, and the refund event.
      const orderOutbox = await pool.query<{ recipient_ids: string[] }>(
        'SELECT recipient_ids FROM outbox_events WHERE event_key = $1',
        ['order.cancelled:' + order.id],
      );
      assert.equal(orderOutbox.rows.length, 1);
      assert.ok(orderOutbox.rows[0].recipient_ids.includes(fx.buyerId));
      assert.ok(orderOutbox.rows[0].recipient_ids.includes(fx.ownerId));
      const refundOutbox = await pool.query<{ event_type: string }>(
        'SELECT event_type FROM outbox_events WHERE event_key = $1',
        ['refund:' + refund.id + ':requested'],
      );
      assert.equal(refundOutbox.rows.length, 1);
      assert.equal(refundOutbox.rows[0].event_type, 'refund.status_changed');
    });

    it('refuses cancellation once the tenant acted or the order is terminal, leaving no side effects', async () => {
      const fx = await createFixture(pool);

      const confirmed = await placeOrder(
        fx,
        await insertSlot(pool, fx.tenantId),
      );
      await service.tenantTransition(
        fx.ownerId,
        fx.tenantId,
        confirmed.id,
        'confirm',
      );
      await assertCancelRefused(
        pool,
        fx,
        confirmed.id,
        'ORDER_CANCELLATION_STATUS_CONFLICT',
      );

      const preparing = await placeOrder(
        fx,
        await insertSlot(pool, fx.tenantId),
      );
      await service.tenantTransition(
        fx.ownerId,
        fx.tenantId,
        preparing.id,
        'confirm',
      );
      await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        preparing.id,
        'prepare',
      );
      await assertCancelRefused(
        pool,
        fx,
        preparing.id,
        'ORDER_CANCELLATION_STATUS_CONFLICT',
      );

      const ready = await placeOrder(fx, await insertSlot(pool, fx.tenantId));
      await service.tenantTransition(
        fx.ownerId,
        fx.tenantId,
        ready.id,
        'confirm',
      );
      await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        ready.id,
        'prepare',
      );
      await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        ready.id,
        'ready',
      );
      await assertCancelRefused(
        pool,
        fx,
        ready.id,
        'ORDER_CANCELLATION_STATUS_CONFLICT',
      );

      const declined = await placeOrder(
        fx,
        await insertSlot(pool, fx.tenantId),
      );
      await service.tenantTransition(
        fx.ownerId,
        fx.tenantId,
        declined.id,
        'decline',
        { reason: 'Bahan habis' },
      );
      await assertCancelRefused(
        pool,
        fx,
        declined.id,
        'ORDER_CANCELLATION_STATUS_CONFLICT',
      );
    });

    it('refuses cancellation once the pickup window has started', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId);
      const order = await placeOrder(fx, slot);
      // Simulate the clock reaching the pickup window: the snapshot on the
      // order (not the slot) is what the cancellability rule compares.
      await pool.query(
        "UPDATE orders SET pickup_starts_at = now() - interval '1 minute' WHERE id = $1",
        [order.id],
      );

      await assert.rejects(
        service.cancelByBuyer(fx.buyerId, order.id, 'Terlambat'),
        (error: unknown) =>
          error instanceof ConflictException &&
          (error.getResponse() as { code?: string }).code ===
            'ORDER_CANCELLATION_PICKUP_STARTED',
      );

      assert.equal(await orderStatus(pool, order.id), 'paid_awaiting_tenant');
      assert.equal((await slotReservedCount(pool, slot.id)).reserved_count, 1);
      assert.equal(await refundCount(pool, order.id), 0);
    });

    it("refuses another buyer's order with 404 and leaves it untouched", async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId);
      const order = await placeOrder(fx, slot);

      await assert.rejects(
        service.cancelByBuyer(fx.otherBuyerId, order.id, 'Bukan pesanan saya'),
        NotFoundException,
      );

      assert.equal(await orderStatus(pool, order.id), 'paid_awaiting_tenant');
      assert.equal((await slotReservedCount(pool, slot.id)).reserved_count, 1);
      assert.equal(await refundCount(pool, order.id), 0);
    });

    it('is idempotent: a replay returns the same outcome without releasing capacity or refunding twice', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId);
      const order = await placeOrder(fx, slot);

      const first = await service.cancelByBuyer(
        fx.buyerId,
        order.id,
        'Berubah pikiran',
      );
      const releasedAt = await reservationReleasedAt(pool, order.id);

      const replay = await service.cancelByBuyer(
        fx.buyerId,
        order.id,
        'Berubah pikiran lagi',
      );

      assert.equal(replay.meta.replayed, true);
      assert.deepEqual(replay.data, first.data);
      assert.equal(await refundCount(pool, order.id), 1);
      assert.equal((await slotReservedCount(pool, slot.id)).reserved_count, 0);
      assert.equal(await reservationReleasedAt(pool, order.id), releasedAt);
      const counts = await cancelSideEffects(pool, order.id);
      assert.equal(counts.cancelledEvents, 1);
      assert.equal(counts.audits, 1);
      assert.equal(counts.orderOutbox, 1);
    });

    it('answers a documented 409 when the order was cancelled without a refund', async () => {
      const fx = await createFixture(pool);
      const order = await placeOrder(fx, await insertSlot(pool, fx.tenantId));
      // A manager cancellation writes the order cancellation but no refund row
      // (the refunds slice owns that insert); the buyer replay must say 409
      // rather than invent a refund.
      await withTx(pool, (client) =>
        service.cancelForRefundDecision(
          client,
          order.id,
          fx.ownerId,
          'Keputusan pengelola',
        ),
      );

      await assert.rejects(
        service.cancelByBuyer(fx.buyerId, order.id, 'Saya batalkan'),
        (error: unknown) =>
          error instanceof ConflictException &&
          (error.getResponse() as { code?: string }).code ===
            'ORDER_CANCELLATION_ALREADY_CANCELLED',
      );
      assert.equal(await refundCount(pool, order.id), 0);
    });

    it('lets exactly one of two parallel cancellations create the refund', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId);
      const order = await placeOrder(fx, slot);

      const results = await Promise.all([
        service.cancelByBuyer(fx.buyerId, order.id, 'Paralel A'),
        service.cancelByBuyer(fx.buyerId, order.id, 'Paralel B'),
      ]);

      assert.equal(
        results.filter((result) => result.meta.replayed === false).length,
        1,
        'exactly one call performs the cancellation',
      );
      assert.equal(
        results.filter((result) => result.meta.replayed === true).length,
        1,
        'the other call is a replay',
      );
      assert.equal(await refundCount(pool, order.id), 1);
      assert.equal((await slotReservedCount(pool, slot.id)).reserved_count, 0);
      assert.equal(await orderStatus(pool, order.id), 'cancelled');
      const counts = await cancelSideEffects(pool, order.id);
      assert.equal(counts.cancelledEvents, 1);
      assert.equal(counts.audits, 1);
    });

    it('validates the reason and the order id', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId);
      const order = await placeOrder(fx, slot);

      await assert.rejects(
        service.cancelByBuyer(fx.buyerId, order.id, '   '),
        (error: unknown) =>
          error instanceof BadRequestException &&
          (error.getResponse() as { code?: string }).code ===
            'ORDER_CANCELLATION_REASON_REQUIRED',
      );
      await assert.rejects(
        service.cancelByBuyer(fx.buyerId, order.id, 'x'.repeat(501)),
        (error: unknown) =>
          error instanceof BadRequestException &&
          (error.getResponse() as { code?: string }).code ===
            'ORDER_CANCELLATION_REASON_TOO_LONG',
      );
      await assert.rejects(
        service.cancelByBuyer(fx.buyerId, 'not-a-uuid', 'Alasan'),
        BadRequestException,
      );
      // Nothing was cancelled by the refused calls.
      assert.equal(await orderStatus(pool, order.id), 'paid_awaiting_tenant');
      assert.equal((await slotReservedCount(pool, slot.id)).reserved_count, 1);
    });
  },
);

async function assertCancelRefused(
  pool: Pool,
  fx: Fixture,
  orderId: string,
  code: string,
): Promise<void> {
  const before = await cancelSideEffects(pool, orderId);
  await assert.rejects(
    service.cancelByBuyer(fx.buyerId, orderId, 'Tidak jadi'),
    (error: unknown) =>
      error instanceof ConflictException &&
      (error.getResponse() as { code?: string }).code === code,
  );
  // Refused calls leave the order, capacity, refund, event and audit rows
  // exactly as they were.
  assert.deepEqual(await cancelSideEffects(pool, orderId), before);
  assert.equal(before.refunds, 0);
}

interface CancelSideEffects {
  status: string;
  cancelledEvents: number;
  audits: number;
  orderOutbox: number;
  refunds: number;
}

async function cancelSideEffects(
  pool: Pool,
  orderId: string,
): Promise<CancelSideEffects> {
  const result = await pool.query<{
    status: string;
    events: string;
    audits: string;
    outbox: string;
    refunds: string;
  }>(
    `SELECT o.status,
            (SELECT count(*) FROM order_events e
              WHERE e.order_id = o.id AND e.event_type = 'order.cancelled')::text AS events,
            (SELECT count(*) FROM audit_events a
              WHERE a.target_id = o.id
                AND a.action = 'order.cancelled_by_buyer')::text AS audits,
            (SELECT count(*) FROM outbox_events ob
              WHERE ob.event_key = 'order.cancelled:' || o.id::text)::text AS outbox,
            (SELECT count(*) FROM refunds r WHERE r.order_id = o.id)::text AS refunds
       FROM orders o WHERE o.id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  return {
    status: row.status,
    cancelledEvents: Number(row.events),
    audits: Number(row.audits),
    orderOutbox: Number(row.outbox),
    refunds: Number(row.refunds),
  };
}

async function orderStatus(pool: Pool, orderId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM orders WHERE id = $1',
    [orderId],
  );
  return result.rows[0].status;
}

async function orderPaymentId(pool: Pool, orderId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM order_payments WHERE order_id = $1',
    [orderId],
  );
  return result.rows[0].id;
}

async function refundCount(pool: Pool, orderId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM refunds WHERE order_id = $1',
    [orderId],
  );
  return Number(result.rows[0].count);
}

async function slotReservedCount(
  pool: Pool,
  slotId: string,
): Promise<{ reserved_count: number }> {
  const result = await pool.query<{ reserved_count: number }>(
    'SELECT reserved_count FROM pickup_slots WHERE id = $1',
    [slotId],
  );
  return result.rows[0];
}

async function reservationReleasedAt(
  pool: Pool,
  orderId: string,
): Promise<string | null> {
  const result = await pool.query<{ released_at: string | null }>(
    'SELECT to_char(released_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS released_at FROM slot_reservations WHERE order_id = $1',
    [orderId],
  );
  return result.rows[0]?.released_at ?? null;
}

async function balanceMinor(userId: string): Promise<string> {
  const [balance] = await wallet.getBalance(userId, 'IDR');
  return balance?.balanceMinor ?? '0';
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
  const otherBuyerId = await insertUser('OtherBuyer');
  const ownerId = await insertUser('Owner');
  const kitchenId = await insertUser('Kitchen');
  const pickupStaffId = await insertUser('PickupStaff');

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

  const funding = await wallet.ensureSystemAccount('test.funding', 'IDR');
  for (const buyer of [buyerId, otherBuyerId]) {
    const target = await wallet.getOrCreateWallet(buyer, 'IDR');
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
  }

  return {
    campusId,
    tenantId,
    buyerId,
    otherBuyerId,
    ownerId,
    kitchenId,
    pickupStaffId,
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
