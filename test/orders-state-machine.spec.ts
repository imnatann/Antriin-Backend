import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
const ITEM_PRICE_MINOR = 20000;
const TTL_SECONDS = 600;

interface Fixture {
  campusId: string;
  tenantId: string;
  tenant2Id: string;
  buyerId: string;
  buyer2Id: string;
  ownerId: string;
  owner2Id: string;
  kitchenId: string;
  acceptOnlyId: string;
  pickupStaffId: string;
  categoryId: string;
  itemId: string;
}

let service: OrdersService;
let wallet: WalletService;

describe(
  'Orders state machine, schedule proposals and scope (PostgreSQL)',
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
        ORDER_PROPOSAL_TTL_SECONDS: TTL_SECONDS,
        // Pilot max lead (2h): a slot 30 minutes out is inside the prep window.
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
    it('runs the legal transitions in order and rejects illegal ones with 409', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { minutesFromNow: 30 });
      const order = await placeOrder(fx, slot);

      // Cannot prepare before confirming, cannot be ready before preparing.
      await assert.rejects(
        service.tenantTransition(
          fx.kitchenId,
          fx.tenantId,
          order.id,
          'prepare',
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          (error.getResponse() as { code?: string }).code ===
            'ORDER_STATE_CONFLICT',
      );
      await assert.rejects(
        service.tenantTransition(fx.kitchenId, fx.tenantId, order.id, 'ready'),
        ConflictException,
      );

      const confirmed = await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        order.id,
        'confirm',
      );
      assert.equal(confirmed.data.status, 'confirmed');
      assert.ok(confirmed.data.confirmedAt);
      assert.ok(confirmed.data.paidAt, 'paid_at was stamped by checkout');
      assert.equal(confirmed.data.preparingAt, null);

      // Idempotent replay: same state, no duplicate event, no version bump.
      const replay = await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        order.id,
        'confirm',
      );
      assert.equal(replay.data.status, 'confirmed');
      assert.equal(replay.data.version, confirmed.data.version);
      assert.equal(
        (await events(pool, order.id)).filter(
          (event) => event.event_type === 'order.status_changed',
        ).length,
        1,
        'replay must not duplicate the event',
      );

      // Stale expectedStatus is a 409.
      await assert.rejects(
        service.tenantTransition(
          fx.kitchenId,
          fx.tenantId,
          order.id,
          'prepare',
          { expectedStatus: 'paid_awaiting_tenant' },
        ),
        ConflictException,
      );

      const preparing = await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        order.id,
        'prepare',
      );
      assert.equal(preparing.data.status, 'preparing');
      assert.ok(preparing.data.preparingAt);

      const ready = await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        order.id,
        'ready',
      );
      assert.equal(ready.data.status, 'ready_for_pickup');
      assert.ok(ready.data.readyAt);

      // Terminal for the tenant: decline is no longer possible.
      await assert.rejects(
        service.tenantTransition(
          fx.kitchenId,
          fx.tenantId,
          order.id,
          'decline',
          {
            reason: 'too late',
          },
        ),
        ConflictException,
      );

      assert.deepEqual(
        (await events(pool, order.id)).map((event) => event.to_status),
        ['paid_awaiting_tenant', 'confirmed', 'preparing', 'ready_for_pickup'],
      );
      const audits = await pool.query<{ action: string }>(
        "SELECT action FROM audit_events WHERE target_id = $1 AND target_type = 'order' ORDER BY occurred_at",
        [order.id],
      );
      assert.deepEqual(
        audits.rows.map((row) => row.action),
        [
          'order.created',
          'order.confirmed',
          'order.preparing',
          'order.ready_for_pickup',
        ],
      );
      // Fulfilment transitions never move money or capacity.
      assert.equal((await slotRow(pool, slot.id)).reserved_count, 1);
    });

    it('declines an order: reason required, capacity released, refund only as an obligation', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId);
      const order = await placeOrder(fx, slot);
      const balanceBefore = await balance(pool, fx.buyerId);

      await assert.rejects(
        service.tenantTransition(
          fx.ownerId,
          fx.tenantId,
          order.id,
          'decline',
          {},
        ),
        BadRequestException,
      );
      await assert.rejects(
        service.tenantTransition(fx.ownerId, fx.tenantId, order.id, 'decline', {
          reason: '   ',
        }),
        BadRequestException,
      );
      assert.equal(await orderStatus(pool, order.id), 'paid_awaiting_tenant');
      assert.equal((await slotRow(pool, slot.id)).reserved_count, 1);

      const declined = await service.tenantTransition(
        fx.ownerId,
        fx.tenantId,
        order.id,
        'decline',
        { reason: 'Bahan habis' },
      );
      assert.equal(declined.data.status, 'declined');
      assert.ok(declined.data.declinedAt);
      assert.equal((await slotRow(pool, slot.id)).reserved_count, 0);
      const reservation = await pool.query<{ status: string }>(
        'SELECT status FROM slot_reservations WHERE order_id = $1',
        [order.id],
      );
      assert.equal(reservation.rows[0].status, 'released');
      // No wallet credit in this slice: the refund is executed by the wave-3
      // refunds module after provider success + dedupe.
      assert.equal(await balance(pool, fx.buyerId), balanceBefore);
      const declinedEvent = (await events(pool, order.id)).find(
        (event) => event.event_type === 'order.declined',
      );
      assert.ok(declinedEvent);
      assert.equal(
        (declinedEvent.metadata as { refundObligation?: string })
          .refundObligation,
        'pending',
      );

      // Replay: idempotent, and capacity is not released twice.
      const replay = await service.tenantTransition(
        fx.ownerId,
        fx.tenantId,
        order.id,
        'decline',
        { reason: 'Bahan habis' },
      );
      assert.equal(replay.data.status, 'declined');
      assert.equal((await slotRow(pool, slot.id)).reserved_count, 0);
    });
    it('moves the reservation and the order window when the buyer accepts a proposal', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, {
        start: '10:00',
        end: '11:00',
      });
      const newSlot = await insertSlot(pool, fx.tenantId, {
        start: '14:00',
        end: '15:00',
      });
      const order = await placeOrder(fx, slot);

      const proposal = await service.createScheduleProposal(
        fx.ownerId,
        fx.tenantId,
        order.id,
        { proposedSlotId: newSlot.id, reason: 'Dapur penuh pagi' },
      );
      assert.equal(proposal.data.status, 'pending_buyer');
      assert.equal(proposal.data.oldSlotId, slot.id);
      assert.equal(proposal.data.proposedSlotId, newSlot.id);
      const ttl = await pool.query<{ seconds: number }>(
        'SELECT extract(epoch FROM (expires_at - created_at))::int AS seconds FROM schedule_proposals WHERE id = $1',
        [proposal.data.id],
      );
      assert.equal(ttl.rows[0].seconds, TTL_SECONDS);

      const decided = await service.decideScheduleProposal(
        fx.buyerId,
        order.id,
        proposal.data.id,
        'accept',
      );
      assert.equal(decided.data.status, 'accepted');
      assert.ok(decided.data.decidedAt);
      assert.equal(decided.meta.replayed, false);

      // Reservation and order window move atomically.
      assert.equal((await slotRow(pool, slot.id)).reserved_count, 0);
      assert.equal((await slotRow(pool, newSlot.id)).reserved_count, 1);
      const reservation = await pool.query<{ slot_id: string }>(
        'SELECT slot_id FROM slot_reservations WHERE order_id = $1',
        [order.id],
      );
      assert.equal(reservation.rows[0].slot_id, newSlot.id);
      const moved = await service.getBuyerOrder(fx.buyerId, order.id);
      assert.equal(moved.data.slotId, newSlot.id);
      assert.equal(moved.data.pickupStartsAt, newSlot.starts_at_text);

      // Replaying the same decision is idempotent.
      const replay = await service.decideScheduleProposal(
        fx.buyerId,
        order.id,
        proposal.data.id,
        'accept',
      );
      assert.equal(replay.meta.replayed, true);
      assert.equal((await slotRow(pool, newSlot.id)).reserved_count, 1);
    });

    it('leaves the order and the slot untouched when the buyer rejects a proposal', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, {
        start: '10:00',
        end: '11:00',
      });
      const newSlot = await insertSlot(pool, fx.tenantId, {
        start: '14:00',
        end: '15:00',
      });
      const order = await placeOrder(fx, slot);
      const proposal = await service.createScheduleProposal(
        fx.ownerId,
        fx.tenantId,
        order.id,
        { proposedSlotId: newSlot.id, reason: 'Dapur penuh' },
      );

      const rejected = await service.decideScheduleProposal(
        fx.buyerId,
        order.id,
        proposal.data.id,
        'reject',
      );
      assert.equal(rejected.data.status, 'rejected');
      assert.ok(rejected.data.decidedAt);
      assert.equal((await slotRow(pool, slot.id)).reserved_count, 1);
      assert.equal((await slotRow(pool, newSlot.id)).reserved_count, 0);
      const current = await service.getBuyerOrder(fx.buyerId, order.id);
      assert.equal(current.data.slotId, slot.id);
      assert.equal(current.data.pickupStartsAt, slot.starts_at_text);

      // A conflicting later decision is a 409.
      await assert.rejects(
        service.decideScheduleProposal(
          fx.buyerId,
          order.id,
          proposal.data.id,
          'accept',
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          (error.getResponse() as { code?: string }).code ===
            'SCHEDULE_PROPOSAL_DECIDED',
      );
    });

    it('allows only one pending proposal per order', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, {
        start: '10:00',
        end: '11:00',
      });
      const newSlot = await insertSlot(pool, fx.tenantId, {
        start: '14:00',
        end: '15:00',
      });
      const otherSlot = await insertSlot(pool, fx.tenantId, {
        start: '16:00',
        end: '17:00',
      });
      const order = await placeOrder(fx, slot);
      await service.createScheduleProposal(fx.ownerId, fx.tenantId, order.id, {
        proposedSlotId: newSlot.id,
        reason: 'Dapur penuh',
      });
      await assert.rejects(
        service.createScheduleProposal(fx.ownerId, fx.tenantId, order.id, {
          proposedSlotId: otherSlot.id,
          reason: 'Coba lagi',
        }),
        (error: unknown) =>
          error instanceof ConflictException &&
          (error.getResponse() as { code?: string }).code ===
            'SCHEDULE_PROPOSAL_PENDING',
      );
      const count = await pool.query<{ total: string }>(
        "SELECT count(*)::text AS total FROM schedule_proposals WHERE order_id = $1 AND status = 'pending_buyer'",
        [order.id],
      );
      assert.equal(count.rows[0].total, '1');
    });

    it('marks an expired proposal expired: never accepted, never producing, never refunding', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, {
        start: '10:00',
        end: '11:00',
      });
      const newSlot = await insertSlot(pool, fx.tenantId, {
        start: '14:00',
        end: '15:00',
      });
      const order = await placeOrder(fx, slot);
      const proposal = await service.createScheduleProposal(
        fx.ownerId,
        fx.tenantId,
        order.id,
        { proposedSlotId: newSlot.id, reason: 'Dapur penuh' },
      );
      // The TTL elapses; no background job exists in this slice. created_at is
      // moved too because 0007 requires expires_at > created_at.
      await pool.query(
        "UPDATE schedule_proposals SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1",
        [proposal.data.id],
      );

      await assert.rejects(
        service.decideScheduleProposal(
          fx.buyerId,
          order.id,
          proposal.data.id,
          'accept',
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          (error.getResponse() as { code?: string }).code ===
            'SCHEDULE_PROPOSAL_EXPIRED',
      );

      const stored = await pool.query<{
        status: string;
        decided_at: Date | null;
      }>('SELECT status, decided_at FROM schedule_proposals WHERE id = $1', [
        proposal.data.id,
      ]);
      assert.equal(stored.rows[0].status, 'expired');
      assert.ok(stored.rows[0].decided_at);
      assert.equal((await slotRow(pool, slot.id)).reserved_count, 1);
      assert.equal((await slotRow(pool, newSlot.id)).reserved_count, 0);
      assert.equal(await orderStatus(pool, order.id), 'paid_awaiting_tenant');

      // Reading the order is the other allowed place to mark it expired.
      const fx2 = await createFixture(pool);
      const slot2 = await insertSlot(pool, fx2.tenantId, {
        start: '10:00',
        end: '11:00',
      });
      const newSlot2 = await insertSlot(pool, fx2.tenantId, {
        start: '14:00',
        end: '15:00',
      });
      const order2 = await placeOrder(fx2, slot2);
      const proposal2 = await service.createScheduleProposal(
        fx2.ownerId,
        fx2.tenantId,
        order2.id,
        { proposedSlotId: newSlot2.id, reason: 'Dapur penuh' },
      );
      await pool.query(
        "UPDATE schedule_proposals SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1",
        [proposal2.data.id],
      );
      const read = await service.getBuyerOrder(fx2.buyerId, order2.id);
      assert.equal(read.data.scheduleProposal?.status, 'expired');
      assert.equal((await slotRow(pool, slot2.id)).reserved_count, 1);
    });

    it('rejects a proposal for the current slot, a full slot or a finished order', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, {
        start: '10:00',
        end: '11:00',
      });
      const fullSlot = await insertSlot(pool, fx.tenantId, {
        start: '14:00',
        end: '15:00',
        capacity: 1,
      });
      const order = await placeOrder(fx, slot);
      const other = await placeOrder(fx, fullSlot);

      await assert.rejects(
        service.createScheduleProposal(fx.ownerId, fx.tenantId, order.id, {
          proposedSlotId: slot.id,
          reason: 'Slot sama',
        }),
        BadRequestException,
      );
      await assert.rejects(
        service.createScheduleProposal(fx.ownerId, fx.tenantId, order.id, {
          proposedSlotId: fullSlot.id,
          reason: 'Slot penuh',
        }),
        ConflictException,
      );
      await assert.rejects(
        service.createScheduleProposal(fx.ownerId, fx.tenantId, order.id, {
          proposedSlotId: randomUUID(),
          reason: 'Tidak ada',
        }),
        NotFoundException,
      );
      await service.tenantTransition(
        fx.ownerId,
        fx.tenantId,
        other.id,
        'decline',
        {
          reason: 'Bahan habis',
        },
      );
      await assert.rejects(
        service.createScheduleProposal(fx.ownerId, fx.tenantId, other.id, {
          proposedSlotId: slot.id,
          reason: 'Terlambat',
        }),
        ConflictException,
      );
    });
    it('scopes reads to the owner: another buyer gets 404, another tenant gets 403', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { minutesFromNow: 30 });
      const order = await placeOrder(fx, slot);

      await assert.rejects(
        service.getBuyerOrder(fx.buyer2Id, order.id),
        NotFoundException,
      );
      const otherBuyerList = await service.listBuyerOrders(fx.buyer2Id, {});
      assert.equal(
        otherBuyerList.data.some((row) => row.id === order.id),
        false,
      );

      await assert.rejects(
        service.getTenantOrder(fx.owner2Id, fx.tenantId, order.id),
        ForbiddenException,
      );
      await assert.rejects(
        service.listTenantOrders(fx.owner2Id, fx.tenantId, {}),
        ForbiddenException,
      );
      await assert.rejects(
        service.getTenantOrder(fx.ownerId, fx.tenant2Id, order.id),
        ForbiddenException,
      );

      // Pickup staff can read but cannot confirm/decline.
      await assert.rejects(
        service.tenantTransition(
          fx.pickupStaffId,
          fx.tenantId,
          order.id,
          'confirm',
        ),
        ForbiddenException,
      );
      await assert.rejects(
        service.tenantTransition(
          fx.pickupStaffId,
          fx.tenantId,
          order.id,
          'decline',
          {
            reason: 'x',
          },
        ),
        ForbiddenException,
      );

      // accept-only staff: confirm is allowed, prepare is not, ready is (accept OR prepare).
      const confirmed = await service.tenantTransition(
        fx.acceptOnlyId,
        fx.tenantId,
        order.id,
        'confirm',
      );
      assert.equal(confirmed.data.status, 'confirmed');
      await assert.rejects(
        service.tenantTransition(
          fx.acceptOnlyId,
          fx.tenantId,
          order.id,
          'prepare',
        ),
        ForbiddenException,
      );
      await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        order.id,
        'prepare',
      );
      const ready = await service.tenantTransition(
        fx.acceptOnlyId,
        fx.tenantId,
        order.id,
        'ready',
      );
      assert.equal(ready.data.status, 'ready_for_pickup');

      const buyerView = await service.getBuyerOrder(fx.buyerId, order.id);
      assert.equal(buyerView.data.id, order.id);
      const queue = await service.listTenantOrders(fx.ownerId, fx.tenantId, {
        status: 'ready_for_pickup',
      });
      assert.ok(queue.data.some((row) => row.id === order.id));
    });

    it('pages buyer orders with a stable cursor', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 10 });
      for (let index = 0; index < 3; index += 1) {
        // Distinct quantities keep each payload unique (the idempotency guard
        // rejects a different key for an identical payload).
        await placeOrder(fx, slot, 'checkout-page-' + index, index + 1);
      }
      const first = await service.listBuyerOrders(fx.buyerId, { limit: 2 });
      assert.equal(first.data.length, 2);
      assert.ok(first.meta.next_cursor);
      const second = await service.listBuyerOrders(fx.buyerId, {
        limit: 2,
        cursor: first.meta.next_cursor,
      });
      assert.equal(second.data.length, 1);
      assert.equal(second.meta.next_cursor, null);
      const ids = new Set([
        ...first.data.map((row) => row.id),
        ...second.data.map((row) => row.id),
      ]);
      assert.equal(ids.size, 3);
      await assert.rejects(
        service.listBuyerOrders(fx.buyerId, { cursor: 'not-a-cursor' }),
        BadRequestException,
      );
    });

    it('exposes the pickup handover contract and completes the order exactly once', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { minutesFromNow: 30 });
      const order = await placeOrder(fx, slot);
      await service.tenantTransition(
        fx.ownerId,
        fx.tenantId,
        order.id,
        'confirm',
      );
      await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        order.id,
        'prepare',
      );
      await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        order.id,
        'ready',
      );

      const handover = await withTx(pool, (client) =>
        service.getOrderForHandover(client, fx.tenantId, order.id),
      );
      assert.deepEqual(handover, {
        orderId: order.id,
        tenantId: fx.tenantId,
        buyerId: fx.buyerId,
        status: 'ready_for_pickup',
        pickupSlotId: slot.id,
        totalMinor: String(ITEM_PRICE_MINOR),
        currency: 'IDR',
      });
      await assert.rejects(
        withTx(pool, (client) =>
          service.getOrderForHandover(client, fx.tenant2Id, order.id),
        ),
        NotFoundException,
      );

      await withTx(pool, (client) =>
        service.markHandedOver(client, fx.tenantId, order.id, fx.pickupStaffId),
      );
      const completed = await service.getTenantOrder(
        fx.ownerId,
        fx.tenantId,
        order.id,
      );
      assert.equal(completed.data.status, 'completed');
      assert.ok(completed.data.completedAt);
      // Consumed reservation keeps the seat occupied for its slot.
      assert.equal((await slotRow(pool, slot.id)).reserved_count, 1);
      const reservation = await pool.query<{ status: string }>(
        'SELECT status FROM slot_reservations WHERE order_id = $1',
        [order.id],
      );
      assert.equal(reservation.rows[0].status, 'consumed');

      // Replay is a no-op.
      await withTx(pool, (client) =>
        service.markHandedOver(client, fx.tenantId, order.id, fx.pickupStaffId),
      );

      // A non-ready order cannot be completed.
      const otherSlot = await insertSlot(pool, fx.tenantId, {
        minutesFromNow: 120,
      });
      const pending = await placeOrder(fx, otherSlot, 'checkout-not-ready');
      await assert.rejects(
        withTx(pool, (client) =>
          service.markHandedOver(
            client,
            fx.tenantId,
            pending.id,
            fx.pickupStaffId,
          ),
        ),
        ConflictException,
      );

      // Handover requires tenant.orders.handover.
      const thirdSlot = await insertSlot(pool, fx.tenantId, {
        minutesFromNow: 60,
      });
      const ready2 = await placeOrder(fx, thirdSlot, 'checkout-handover-perm');
      await service.tenantTransition(
        fx.ownerId,
        fx.tenantId,
        ready2.id,
        'confirm',
      );
      await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        ready2.id,
        'prepare',
      );
      await service.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        ready2.id,
        'ready',
      );
      await assert.rejects(
        withTx(pool, (client) =>
          service.markHandedOver(client, fx.tenantId, ready2.id, fx.kitchenId),
        ),
        ForbiddenException,
      );
    });
  },
);

async function placeOrder(
  fx: Fixture,
  slot: { id: string; version: number },
  key?: string,
  quantity = 1,
) {
  const result = await service.checkout(
    fx.buyerId,
    key ?? 'checkout-' + randomUUID(),
    {
      tenantId: fx.tenantId,
      slotId: slot.id,
      expectedSlotVersion: slot.version,
      items: [{ menuItemId: fx.itemId, quantity }],
    },
  );
  return result.data;
}

async function events(
  pool: Pool,
  orderId: string,
): Promise<
  { event_type: string; to_status: string | null; metadata: unknown }[]
> {
  const result = await pool.query<{
    event_type: string;
    to_status: string | null;
    metadata: unknown;
  }>(
    'SELECT event_type, to_status, metadata FROM order_events WHERE order_id = $1 ORDER BY version',
    [orderId],
  );
  return result.rows;
}

async function orderStatus(pool: Pool, orderId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM orders WHERE id = $1',
    [orderId],
  );
  return result.rows[0].status;
}

async function slotRow(
  pool: Pool,
  slotId: string,
): Promise<{ reserved_count: number; version: number }> {
  const result = await pool.query<{ reserved_count: number; version: number }>(
    'SELECT reserved_count, version FROM pickup_slots WHERE id = $1',
    [slotId],
  );
  return result.rows[0];
}

async function balance(pool: Pool, userId: string): Promise<string> {
  const result = await pool.query<{ balance_minor: string }>(
    "SELECT coalesce(balance_minor,0)::text AS balance_minor FROM wallet_accounts WHERE account_type = 'wallet' AND owner_user_id = $1",
    [userId],
  );
  return result.rows[0]?.balance_minor ?? '0';
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
function jakartaLocalDate(daysFromNow: number): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(Date.now() + daysFromNow * 86_400_000));
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
  const buyer2Id = await insertUser('Buyer2');
  const ownerId = await insertUser('Owner');
  const owner2Id = await insertUser('Owner2');
  const kitchenId = await insertUser('Kitchen');
  const acceptOnlyId = await insertUser('AcceptOnly');
  const pickupStaffId = await insertUser('PickupStaff');

  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) VALUES ($1, $2, 'owner', '{}', 'active', now())",
    [tenantId, ownerId],
  );
  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) VALUES ($1, $2, 'owner', '{}', 'active', now())",
    [tenant2Id, owner2Id],
  );
  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status) VALUES ($1, $2, 'kitchen', '{tenant.orders.read,tenant.orders.accept,tenant.orders.prepare}', 'active')",
    [tenantId, kitchenId],
  );
  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status) VALUES ($1, $2, 'kitchen', '{tenant.orders.read,tenant.orders.accept}', 'active')",
    [tenantId, acceptOnlyId],
  );
  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status) VALUES ($1, $2, 'pickup', '{tenant.orders.read,tenant.orders.handover}', 'active')",
    [tenantId, pickupStaffId],
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
  // Fund the buyer so checkout (a real wallet debit) can succeed.
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
    buyer2Id,
    ownerId,
    owner2Id,
    kitchenId,
    acceptOnlyId,
    pickupStaffId,
    categoryId,
    itemId,
  };
}

/**
 * Inserts a bookable slot. Default: tomorrow 10:00-11:00 local. With
 * `minutesFromNow` the window starts that many minutes from now, which is how
 * the preparation-lead gate (now >= starts_at - lead) is exercised.
 */
async function insertSlot(
  pool: Pool,
  tenantId: string,
  options: {
    start?: string;
    end?: string;
    capacity?: number;
    minutesFromNow?: number;
  } = {},
): Promise<{ id: string; version: number; starts_at_text: string }> {
  const fromNow = options.minutesFromNow;
  const result = await pool.query<{
    id: string;
    version: number;
    starts_at_text: string;
  }>(
    "INSERT INTO pickup_slots (tenant_id, starts_at, ends_at, capacity, reserved_count, status, updated_at) VALUES ($1, COALESCE(now() + ($2::int * interval '1 minute'), ($3::date + $4::time)::timestamp AT TIME ZONE 'Asia/Jakarta'), COALESCE(now() + (($2::int + 60) * interval '1 minute'), ($3::date + $5::time)::timestamp AT TIME ZONE 'Asia/Jakarta'), $6, 0, 'open', now()) RETURNING id, version, to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS starts_at_text",
    [
      tenantId,
      fromNow ?? null,
      jakartaLocalDate(1),
      options.start ?? '10:00',
      options.end ?? '11:00',
      options.capacity ?? 5,
    ],
  );
  return result.rows[0];
}
