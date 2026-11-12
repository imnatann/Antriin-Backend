import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AvailabilityService } from '../src/modules/availability/availability.service';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { generateOrderNumber } from '../src/modules/orders/order-number';
import { TenantOperatingHoursService } from '../src/modules/tenants/tenant-operating-hours.service';
import { WalletService } from '../src/modules/wallet/wallet.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const ITEM_PRICE_MINOR = 15000;
const CHOICE_DELTA_MINOR = 2000;
const UNIT_PRICE_MINOR = ITEM_PRICE_MINOR + CHOICE_DELTA_MINOR;

interface Fixture {
  campusId: string;
  tenantId: string;
  tenant2Id: string;
  buyerId: string;
  buyer2Id: string;
  ownerId: string;
  owner2Id: string;
  kitchenId: string;
  pickupStaffId: string;
  readonlyOnlyId: string;
  categoryId: string;
  itemId: string;
  item2Id: string;
  /** Ten plain items (same price) so parallel checkouts can use distinct payloads. */
  itemIds: string[];
  groupId: string;
  choiceId: string;
  localDate: string;
}

interface SlotRow {
  id: string;
  version: number;
  capacity: number;
  reserved_count: number;
  starts_at_text: string;
  ends_at_text: string;
}

describe(
  'Orders checkout atomicity, idempotency and concurrency (PostgreSQL)',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let orders: OrdersService;
    let availability: AvailabilityService;
    let wallet: WalletService;
    let config: Record<string, number>;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 30 });
      await pool.query('select 1');
      const database = { pool } as unknown as DatabaseService;
      const access = new AccessService(database);
      const audit = new AuditService(database, access);
      const operatingHours = new TenantOperatingHoursService(
        database,
        access,
        audit,
      );
      availability = new AvailabilityService(
        database,
        access,
        operatingHours,
        audit,
      );
      const catalog = new CatalogService(database, access, availability, audit);
      wallet = new WalletService(database);
      const outbox = new OutboxService(database);
      config = {
        ORDER_PROPOSAL_TTL_SECONDS: 600,
        ORDER_PREPARATION_LEAD_SECONDS: 0,
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
      // Forces a failure AFTER the wallet debit and after the capacity
      // reservation (order_payments is written right after the ledger post), so
      // the test proves the debit + reservation + order all roll back together.
      await pool.query(`
        CREATE OR REPLACE FUNCTION orders_test_fail_payment() RETURNS trigger AS $$
        DECLARE requested varchar(500);
        BEGIN
          SELECT special_request INTO requested FROM orders WHERE id = NEW.order_id;
          IF requested = 'force-fail' THEN
            RAISE EXCEPTION 'forced checkout failure after wallet debit';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`);
      await pool.query(
        'DROP TRIGGER IF EXISTS orders_test_fail_payment ON order_payments',
      );
      await pool.query(
        `CREATE TRIGGER orders_test_fail_payment BEFORE INSERT ON order_payments
           FOR EACH ROW EXECUTE FUNCTION orders_test_fail_payment()`,
      );
      // Sequence (not a table): nextval survives the rollback of the failing
      // transaction, so it can count retry attempts.
      await pool.query(
        'CREATE SEQUENCE IF NOT EXISTS orders_test_deadlock_seq START 1',
      );
      // The deadlock trigger is scoped by tenant so concurrently running spec
      // files (same database) are never affected.
      await pool.query(
        'CREATE TABLE IF NOT EXISTS orders_test_deadlock_target (tenant_id uuid PRIMARY KEY)',
      );
      // Two injection points, both tenant-scoped so concurrently running spec
      // files on the same database are never affected:
      // - orders: the 40P01 is raised by OUR OWN statement, so it reaches the
      //   checkout retry as a raw database error.
      // - pickup_slots: the 40P01 is raised inside availability, which (R2-02)
      //   maps it to a 409 contract error before the checkout sees it.
      await pool.query(
        `CREATE OR REPLACE FUNCTION orders_test_force_deadlock() RETURNS trigger AS $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM orders_test_deadlock_target WHERE tenant_id = NEW.tenant_id
          ) THEN
            PERFORM nextval('orders_test_deadlock_seq');
            RAISE EXCEPTION 'deadlock detected (test)' USING ERRCODE = '40P01';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`,
      );
      await pool.query(
        'DROP TRIGGER IF EXISTS orders_test_force_deadlock ON pickup_slots',
      );
      await pool.query(
        `CREATE TRIGGER orders_test_force_deadlock
           BEFORE UPDATE OF reserved_count ON pickup_slots
           FOR EACH ROW EXECUTE FUNCTION orders_test_force_deadlock()`,
      );
      await pool.query(
        'DROP TRIGGER IF EXISTS orders_test_force_deadlock_orders ON orders',
      );
      await pool.query(
        `CREATE TRIGGER orders_test_force_deadlock_orders
           BEFORE UPDATE OF paid_at ON orders
           FOR EACH ROW EXECUTE FUNCTION orders_test_force_deadlock()`,
      );
    });

    after(async () => {
      await pool?.query(
        'DROP TRIGGER IF EXISTS orders_test_fail_payment ON order_payments',
      );
      await pool?.query(
        'DROP TRIGGER IF EXISTS orders_test_force_deadlock ON pickup_slots',
      );
      await pool?.query(
        'DROP TRIGGER IF EXISTS orders_test_force_deadlock_orders ON orders',
      );
      await pool?.query('DROP SEQUENCE IF EXISTS orders_test_deadlock_seq');
      await pool?.query('DROP TABLE IF EXISTS orders_test_deadlock_target');
      await pool?.end();
    });

    it('creates the whole order graph in one transaction and moves money and capacity exactly once', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const before = await snapshot(pool, fx, slot.id);

      const result = await orders.checkout(fx.buyerId, 'checkout-ok-0001', {
        tenantId: fx.tenantId,
        slotId: slot.id,
        expectedSlotVersion: slot.version,
        items: [
          { menuItemId: fx.itemId, quantity: 2, optionIds: [fx.choiceId] },
        ],
        specialRequest: 'pedas sedang',
      });

      assert.equal(result.meta.replayed, false);
      const order = result.data;
      assert.equal(order.status, 'paid_awaiting_tenant');
      assert.match(order.orderNumber, /^AN-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/);
      assert.equal(order.subtotalMinor, '34000');
      assert.equal(order.totalMinor, '34000');
      assert.equal(order.currency, 'IDR');
      assert.equal(order.specialRequest, 'pedas sedang');
      assert.equal(order.buyer.id, fx.buyerId);
      assert.equal(order.slotId, slot.id);
      assert.equal(order.paidAt?.endsWith('Z'), true);
      assert.equal(order.confirmedAt, null);

      // Immutable item + option snapshots (price formula D12.1).
      assert.equal(order.items.length, 1);
      const line = order.items[0];
      assert.equal(line.menuItemId, fx.itemId);
      assert.equal(line.quantity, 2);
      assert.equal(line.baseUnitPriceMinor, String(ITEM_PRICE_MINOR));
      assert.equal(line.unitPriceMinor, String(UNIT_PRICE_MINOR));
      assert.equal(line.lineTotalMinor, '34000');
      assert.equal(line.menuVersion, 1);
      assert.equal(line.options.length, 1);
      assert.equal(line.options[0].choiceId, fx.choiceId);
      assert.equal(line.options[0].priceDeltaMinor, String(CHOICE_DELTA_MINOR));
      assert.equal(line.options[0].groupVersion, 1);
      assert.equal(line.options[0].choiceVersion, 1);

      // Payment points at the double-entry ledger transaction.
      assert.ok(order.payment);
      assert.equal(order.payment.method, 'wallet');
      assert.equal(order.payment.status, 'succeeded');
      assert.equal(order.payment.amountMinor, '34000');
      assert.equal(order.payment.currency, 'IDR');

      const ledger = await pool.query<{
        transaction_id: string;
        direction: string;
        amount_minor: string;
        account_id: string;
      }>(
        `SELECT e.transaction_id, e.direction, e.amount_minor::text AS amount_minor,
                e.account_id
           FROM ledger_entries e
          WHERE e.transaction_id = $1 ORDER BY e.direction`,
        [order.payment.ledgerTransactionId],
      );
      assert.equal(
        ledger.rows.length,
        2,
        'double-entry: one debit, one credit',
      );
      assert.deepEqual(
        ledger.rows.map((row) => row.direction),
        ['credit', 'debit'],
      );
      assert.equal(ledger.rows[0].amount_minor, '34000');
      assert.equal(ledger.rows[1].amount_minor, '34000');

      // Wallet balance decreased by exactly the total.
      assert.equal(
        await walletBalance(pool, fx.buyerId),
        String(Number(before.buyerBalance) - 34000),
      );
      // The payment is held in the escrow system account, apart from tenant
      // payables (PILOT-POLICY): asserted per buyer, never on the global balance.
      assert.equal(
        Number(await escrowHeld(pool, fx.buyerId)) - Number(before.escrowHeld),
        34000,
      );
      // Slot capacity reserved exactly once.
      const after = await slotState(pool, slot.id);
      assert.equal(after.reserved_count, before.reservedCount + 1);
      assert.equal(
        after.version,
        slot.version,
        'D3: reserve never bumps version',
      );

      // Event, audit and outbox written in the same transaction.
      const events = await pool.query<{
        event_type: string;
        from_status: string | null;
        to_status: string | null;
        actor_user_id: string | null;
        request_id: string | null;
      }>(
        `SELECT event_type, from_status, to_status, actor_user_id, request_id
           FROM order_events WHERE order_id = $1 ORDER BY version`,
        [order.id],
      );
      assert.equal(events.rows.length, 1);
      assert.equal(events.rows[0].event_type, 'order.created');
      assert.equal(events.rows[0].from_status, null);
      assert.equal(events.rows[0].to_status, 'paid_awaiting_tenant');
      assert.equal(events.rows[0].actor_user_id, fx.buyerId);
      assert.ok(
        events.rows[0].request_id,
        'event links the idempotency record',
      );

      const audit = await pool.query<{
        action: string;
        scope_type: string;
        scope_id: string;
        target_type: string;
        target_id: string;
        actor_user_id: string | null;
      }>(
        `SELECT action, scope_type, scope_id, target_type, target_id, actor_user_id
           FROM audit_events WHERE target_id = $1 AND target_type = 'order'`,
        [order.id],
      );
      assert.equal(audit.rows.length, 1);
      assert.equal(audit.rows[0].action, 'order.created');
      assert.equal(audit.rows[0].scope_type, 'tenant');
      assert.equal(audit.rows[0].scope_id, fx.tenantId);
      assert.equal(audit.rows[0].actor_user_id, fx.buyerId);

      const outbox = await pool.query<{
        event_type: string;
        recipient_ids: string[];
        aggregate_id: string;
      }>(
        `SELECT event_type, recipient_ids, aggregate_id FROM outbox_events
          WHERE aggregate_id = $1 AND event_type = 'order.created'`,
        [order.id],
      );
      assert.equal(outbox.rows.length, 1);
      assert.equal(outbox.rows[0].event_type, 'order.created');
      const recipients = outbox.rows[0].recipient_ids;
      assert.ok(recipients.includes(fx.ownerId), 'owner notified');
      assert.ok(recipients.includes(fx.kitchenId), 'kitchen staff notified');
      assert.ok(
        recipients.includes(fx.pickupStaffId),
        'pickup staff holding tenant.orders.read is notified',
      );
      assert.ok(
        !recipients.includes(fx.buyerId),
        'buyer is not a staff recipient',
      );
    });

    it('rolls the wallet debit, the reservation and the order back together', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 4 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const before = await snapshot(pool, fx, slot.id);

      await assert.rejects(
        orders.checkout(fx.buyerId, 'checkout-rollback-0001', {
          tenantId: fx.tenantId,
          slotId: slot.id,
          expectedSlotVersion: slot.version,
          items: [{ menuItemId: fx.itemId, quantity: 1 }],
          specialRequest: 'force-fail',
        }),
        /forced checkout failure after wallet debit/,
      );

      const after = await snapshot(pool, fx, slot.id);
      assert.equal(
        after.buyerBalance,
        before.buyerBalance,
        'no debit left behind',
      );
      assert.equal(after.escrowHeld, before.escrowHeld, 'no escrow credit');
      assert.equal(
        after.reservedCount,
        before.reservedCount,
        'no seat consumed',
      );
      assert.equal(after.orderCount, before.orderCount, 'no order row');
      assert.equal(
        after.ledgerCount,
        before.ledgerCount,
        'no ledger transaction',
      );
      assert.equal(after.reservationCount, before.reservationCount);
      assert.equal(after.idempotencyCount, before.idempotencyCount);
      assert.equal(after.paymentCount, before.paymentCount, 'no payment row');
      assert.equal(after.itemCount, before.itemCount, 'no snapshot rows');
      assert.equal(after.eventCount, before.eventCount, 'no order event');
    });

    it('replays the same key and payload as one order and one debit', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const body = {
        tenantId: fx.tenantId,
        slotId: slot.id,
        expectedSlotVersion: slot.version,
        items: [
          { menuItemId: fx.itemId, quantity: 2, optionIds: [fx.choiceId] },
        ],
      };
      const before = await snapshot(pool, fx, slot.id);

      const [first, second] = await Promise.all([
        orders.checkout(fx.buyerId, 'checkout-parallel-key-1', body),
        orders.checkout(fx.buyerId, 'checkout-parallel-key-1', body),
      ]);
      assert.equal(
        first.data.id,
        second.data.id,
        'both requests see one order',
      );
      assert.deepEqual([first.meta.replayed, second.meta.replayed].sort(), [
        false,
        true,
      ]);

      const replay = await orders.checkout(
        fx.buyerId,
        'checkout-parallel-key-1',
        body,
      );
      assert.equal(replay.meta.replayed, true);
      assert.deepEqual(
        replay.data,
        first.meta.replayed ? second.data : first.data,
      );

      const after = await snapshot(pool, fx, slot.id);
      assert.equal(
        after.orderCount,
        before.orderCount + 1,
        'exactly one order',
      );
      assert.equal(
        after.ledgerCount,
        before.ledgerCount + 1,
        'exactly one debit',
      );
      assert.equal(after.reservedCount, before.reservedCount + 1);
      assert.equal(
        Number(before.buyerBalance) - Number(after.buyerBalance),
        34000,
      );
    });

    it('rejects a reused key with a different payload and a different key with the same payload', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const body = {
        tenantId: fx.tenantId,
        slotId: slot.id,
        expectedSlotVersion: slot.version,
        items: [{ menuItemId: fx.itemId, quantity: 1 }],
      };
      await orders.checkout(fx.buyerId, 'checkout-key-conflict-1', body);

      await assert.rejects(
        orders.checkout(fx.buyerId, 'checkout-key-conflict-1', {
          ...body,
          items: [{ menuItemId: fx.itemId, quantity: 3 }],
        }),
        (error: unknown) =>
          error instanceof ConflictException &&
          (error.getResponse() as { code?: string }).code ===
            'IDEMPOTENCY_KEY_REUSED',
      );

      await assert.rejects(
        orders.checkout(fx.buyerId, 'checkout-key-conflict-2', body),
        (error: unknown) =>
          error instanceof ConflictException &&
          (error.getResponse() as { code?: string }).code ===
            'IDEMPOTENCY_PAYLOAD_REUSED',
      );

      const count = await pool.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM orders WHERE buyer_id = $1',
        [fx.buyerId],
      );
      assert.equal(count.rows[0].total, '1');
    });

    it('lets exactly K of N parallel checkouts win on a slot with capacity K', async () => {
      const fx = await createFixture(pool);
      const capacity = 3;
      const racers = 8;
      const slot = await insertSlot(pool, fx.tenantId, { capacity });
      // Balance is enough for more than the capacity: capacity is the only limit.
      await fundWallet(pool, wallet, fx.buyerId, 500000);
      const before = await snapshot(pool, fx, slot.id);

      const results = await Promise.allSettled(
        Array.from({ length: racers }, (_, index) =>
          orders.checkout(fx.buyerId, `checkout-capacity-${index}`, {
            tenantId: fx.tenantId,
            slotId: slot.id,
            expectedSlotVersion: slot.version,
            // Distinct lines keep every racer's payload unique (a different key
            // for an identical payload is rejected by the idempotency guard).
            items: [{ menuItemId: fx.itemIds[index], quantity: 1 }],
          }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult[];
      assert.equal(fulfilled.length, capacity);
      assert.equal(rejected.length, racers - capacity);
      for (const failure of rejected) {
        assert.ok(
          failure.reason instanceof ConflictException,
          `expected ConflictException, got: ${String(failure.reason)}`,
        );
      }

      const after = await snapshot(pool, fx, slot.id);
      assert.equal(after.reservedCount, capacity);
      assert.equal(after.orderCount, capacity);
      assert.equal(after.ledgerCount, before.ledgerCount + capacity);
      assert.equal(
        Number(before.buyerBalance) - Number(after.buyerBalance),
        capacity * ITEM_PRICE_MINOR,
        'exactly K debits, never a debit for a lost race',
      );
      const orders_ = await pool.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM slot_reservations WHERE slot_id = $1',
        [slot.id],
      );
      assert.equal(orders_.rows[0].total, String(capacity));
    });

    it('lets 10 parallel checkouts on a large slot all succeed without a deadlock', async () => {
      const fx = await createFixture(pool);
      const capacity = 20;
      const racers = 10;
      const slot = await insertSlot(pool, fx.tenantId, { capacity });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const before = await snapshot(pool, fx, slot.id);

      const results = await Promise.allSettled(
        Array.from({ length: racers }, (_, index) =>
          orders.checkout(fx.buyerId, `checkout-no-deadlock-${index}`, {
            tenantId: fx.tenantId,
            slotId: slot.id,
            expectedSlotVersion: slot.version,
            items: [{ menuItemId: fx.itemIds[index], quantity: 1 }],
          }),
        ),
      );
      const failures = results.filter(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult[];
      // D15.B: no 500 and no deadlock escalation; every request must succeed.
      assert.deepEqual(
        failures.map((f) => String(f.reason)),
        [],
        'no checkout may fail (deadlock/500) on a slot with enough capacity',
      );
      for (const result of results as PromiseFulfilledResult<{
        data: { id: string };
      }>[]) {
        assert.ok(result.value.data.id);
      }

      const after = await snapshot(pool, fx, slot.id);
      assert.equal(
        after.reservedCount,
        racers,
        'one seat per successful order',
      );
      assert.equal(after.orderCount, before.orderCount + racers);
      assert.equal(after.ledgerCount, before.ledgerCount + racers);
      assert.equal(
        Number(before.buyerBalance) - Number(after.buyerBalance),
        racers * ITEM_PRICE_MINOR,
      );
      const reconciled = await pool.query<{
        occupied: string;
        reserved: string;
      }>(
        `SELECT (SELECT count(*) FROM slot_reservations
                   WHERE slot_id = $1 AND status IN ('reserved','consumed'))::text
                   AS occupied,
                (SELECT reserved_count FROM pickup_slots WHERE id = $1)::text
                   AS reserved`,
        [slot.id],
      );
      assert.equal(reconciled.rows[0].occupied, reconciled.rows[0].reserved);
      assert.equal(reconciled.rows[0].reserved, String(racers));
    });

    it('retries a raw deadlock from its own statement exactly once, then returns 409 (not 500)', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const before = await snapshot(pool, fx, slot.id);

      // The trigger raises 40P01 from OUR OWN `UPDATE orders SET paid_at`
      // (step 6 of D15), i.e. AFTER the wallet debit and the reservation.
      await armDeadlock(pool, fx.tenantId);
      try {
        await assert.rejects(
          orders.checkout(fx.buyerId, 'checkout-deadlock-raw', {
            tenantId: fx.tenantId,
            slotId: slot.id,
            expectedSlotVersion: slot.version,
            items: [{ menuItemId: fx.itemId, quantity: 1 }],
          }),
          (error: unknown) =>
            error instanceof ConflictException &&
            (error.getResponse() as { code?: string }).code ===
              'CHECKOUT_RETRY_CONFLICT',
        );
        // D15.B: the transaction is re-run at most once (2 attempts total).
        assert.equal(
          await deadlockAttempts(pool),
          '2',
          'exactly one retry, never an unbounded loop',
        );
      } finally {
        await disarmDeadlock(pool, fx.tenantId);
      }

      // The retried transaction never committed: no order, no debit, no seat.
      const after = await snapshot(pool, fx, slot.id);
      assert.equal(after.buyerBalance, before.buyerBalance);
      assert.equal(after.orderCount, before.orderCount);
      assert.equal(after.paymentCount, before.paymentCount);
      assert.equal(after.ledgerCount, before.ledgerCount);
      assert.equal(after.reservedCount, before.reservedCount);
      assert.equal(after.reservationCount, before.reservationCount);
      assert.equal(after.idempotencyCount, before.idempotencyCount);

      // With the injection removed the same request succeeds.
      const ok = await orders.checkout(fx.buyerId, 'checkout-deadlock-raw', {
        tenantId: fx.tenantId,
        slotId: slot.id,
        expectedSlotVersion: slot.version,
        items: [{ menuItemId: fx.itemId, quantity: 1 }],
      });
      assert.equal(ok.meta.replayed, false);
      assert.equal((await slotState(pool, slot.id)).reserved_count, 1);
    });

    it('retries once when availability surfaces the DATABASE_DEADLOCK contract code', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);

      // R2-02 contract: availability maps 40P01/40001 to
      // ConflictException({code:'DATABASE_DEADLOCK'}). Simulate exactly that
      // shape on the first call and delegate afterwards.
      const original = availability.reserveForCheckout.bind(availability);
      let calls = 0;
      availability.reserveForCheckout = (async (
        ...args: Parameters<typeof original>
      ) => {
        calls += 1;
        if (calls === 1) {
          throw new ConflictException({
            code: 'DATABASE_DEADLOCK',
            message: 'Concurrent slot update conflicted; retry the request',
          });
        }
        return original(...args);
      }) as typeof availability.reserveForCheckout;
      try {
        const result = await orders.checkout(
          fx.buyerId,
          'checkout-deadlock-mapped',
          {
            tenantId: fx.tenantId,
            slotId: slot.id,
            expectedSlotVersion: slot.version,
            items: [{ menuItemId: fx.itemId, quantity: 1 }],
          },
        );
        assert.equal(calls, 2, 'exactly one retry');
        assert.equal(result.meta.replayed, false);
        assert.equal(result.data.status, 'paid_awaiting_tenant');
        // The retry committed exactly one of everything.
        assert.equal((await slotState(pool, slot.id)).reserved_count, 1);
        assert.equal(await countOrders(pool, fx.buyerId), 1);
      } finally {
        availability.reserveForCheckout = original;
      }
    });

    it('returns 409 CHECKOUT_RETRY_CONFLICT when the mapped deadlock persists after the retry', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const before = await snapshot(pool, fx, slot.id);

      const original = availability.reserveForCheckout.bind(availability);
      let calls = 0;
      availability.reserveForCheckout = (async () => {
        calls += 1;
        throw new ConflictException({
          code: 'DATABASE_DEADLOCK',
          message: 'Concurrent slot update conflicted; retry the request',
        });
      }) as typeof availability.reserveForCheckout;
      try {
        await assert.rejects(
          orders.checkout(fx.buyerId, 'checkout-deadlock-persistent', {
            tenantId: fx.tenantId,
            slotId: slot.id,
            expectedSlotVersion: slot.version,
            items: [{ menuItemId: fx.itemId, quantity: 1 }],
          }),
          (error: unknown) =>
            error instanceof ConflictException &&
            (error.getResponse() as { code?: string }).code ===
              'CHECKOUT_RETRY_CONFLICT',
        );
        assert.equal(calls, 2, 'exactly one retry, never an unbounded loop');
      } finally {
        availability.reserveForCheckout = original;
      }

      const after = await snapshot(pool, fx, slot.id);
      assert.equal(after.buyerBalance, before.buyerBalance);
      assert.equal(after.orderCount, before.orderCount);
      assert.equal(after.paymentCount, before.paymentCount);
      assert.equal(after.reservedCount, before.reservedCount);
      assert.equal(after.idempotencyCount, before.idempotencyCount);
    });

    it('maps a deadlock raised inside availability to 409 without leaking a 500 or side effects', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const before = await snapshot(pool, fx, slot.id);

      // Real 40P01 raised by availability's own UPDATE on pickup_slots. Since
      // R2-02 availability maps it to ConflictException({code:
      // 'DATABASE_DEADLOCK'}), so the checkout retry MUST fire through the
      // contract-code path (not only on a raw database error).
      await armDeadlock(pool, fx.tenantId);
      try {
        await assert.rejects(
          orders.checkout(fx.buyerId, 'checkout-deadlock-availability', {
            tenantId: fx.tenantId,
            slotId: slot.id,
            expectedSlotVersion: slot.version,
            items: [{ menuItemId: fx.itemId, quantity: 1 }],
          }),
          (error: unknown) => {
            // Never a 500: the mapped deadlock is retried once and then
            // reported as the stable checkout conflict code.
            assert.ok(
              error instanceof ConflictException,
              `expected ConflictException, got: ${String(error)}`,
            );
            const body = error.getResponse() as { code?: string };
            assert.equal(
              body.code,
              'CHECKOUT_RETRY_CONFLICT',
              'the availability DATABASE_DEADLOCK must be retried once and then surface as CHECKOUT_RETRY_CONFLICT',
            );
            return true;
          },
        );
        // STRICT (root decision): the contract code triggers the retry, so the
        // transaction runs exactly twice - one initial attempt plus one retry.
        assert.equal(
          await deadlockAttempts(pool),
          '2',
          'availability DATABASE_DEADLOCK must trigger exactly one retry',
        );
      } finally {
        await disarmDeadlock(pool, fx.tenantId);
      }

      const after = await snapshot(pool, fx, slot.id);
      assert.equal(after.buyerBalance, before.buyerBalance);
      assert.equal(after.orderCount, before.orderCount);
      assert.equal(after.paymentCount, before.paymentCount);
      assert.equal(after.ledgerCount, before.ledgerCount);
      assert.equal(after.reservedCount, before.reservedCount);
      assert.equal(after.idempotencyCount, before.idempotencyCount);
    });

    it('rejects a reservation for an order row that does not exist (FK -> REFERENCE_CONFLICT)', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      const missingOrderId = randomUUID();
      // Migration 0007 added slot_reservations.order_id -> orders(id); the
      // official checkout order therefore inserts orders BEFORE reserving.
      // R2-02: availability maps the raw 23503 to a 409 carrying the stable
      // contract code REFERENCE_CONFLICT instead of leaking a database error.
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            slot.id,
            slot.version,
            missingOrderId,
          ),
        ),
        (error: unknown) => {
          assertMappedConflict(error, 'REFERENCE_CONFLICT');
          return true;
        },
      );
      const row = await pool.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM slot_reservations WHERE order_id = $1',
        [missingOrderId],
      );
      assert.equal(row.rows[0].total, '0');
      assert.equal((await slotState(pool, slot.id)).reserved_count, 0);
    });

    it('stops at the wallet balance and never leaves a debit without an order', async () => {
      const fx = await createFixture(pool);
      const capacity = 10;
      const racers = 6;
      const slot = await insertSlot(pool, fx.tenantId, { capacity });
      // Only two checkouts are affordable (each plain item costs ITEM_PRICE).
      await fundWallet(pool, wallet, fx.buyerId, ITEM_PRICE_MINOR * 2);
      const before = await snapshot(pool, fx, slot.id);

      const results = await Promise.allSettled(
        Array.from({ length: racers }, (_, index) =>
          orders.checkout(fx.buyerId, `checkout-balance-${index}`, {
            tenantId: fx.tenantId,
            slotId: slot.id,
            expectedSlotVersion: slot.version,
            items: [{ menuItemId: fx.itemIds[index], quantity: 1 }],
          }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult[];
      assert.equal(fulfilled.length, 2);
      assert.equal(rejected.length, racers - 2);
      for (const failure of rejected) {
        assert.ok(failure.reason instanceof ConflictException);
        assert.equal(
          (failure.reason.getResponse() as { code?: string }).code,
          'INSUFFICIENT_WALLET_BALANCE',
        );
      }

      const after = await snapshot(pool, fx, slot.id);
      assert.equal(after.buyerBalance, '0', 'balance never goes negative');
      assert.equal(
        after.reservedCount,
        2,
        'reservation rolled back on failure',
      );
      assert.equal(after.orderCount, 2);
      assert.equal(after.ledgerCount, before.ledgerCount + 2);
      assert.equal(
        Number(await escrowHeld(pool, fx.buyerId)) - Number(before.escrowHeld),
        ITEM_PRICE_MINOR * 2,
      );
    });

    it('refuses a stale slot version and a checkout for a closed tenant', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 3 });

      await assert.rejects(
        orders.checkout(fx.buyerId, 'checkout-stale-version', {
          tenantId: fx.tenantId,
          slotId: slot.id,
          expectedSlotVersion: slot.version + 5,
          items: [{ menuItemId: fx.itemId, quantity: 1 }],
        }),
        ConflictException,
      );
      assert.equal((await slotState(pool, slot.id)).reserved_count, 0);

      await pool.query("UPDATE tenants SET status = 'closed' WHERE id = $1", [
        fx.tenantId,
      ]);
      await assert.rejects(
        orders.checkout(fx.buyerId, 'checkout-closed-tenant', {
          tenantId: fx.tenantId,
          slotId: slot.id,
          expectedSlotVersion: slot.version,
          items: [{ menuItemId: fx.itemId, quantity: 1 }],
        }),
        ConflictException,
      );
      assert.equal((await slotState(pool, slot.id)).reserved_count, 0);
    });

    it('rejects invalid checkout input before touching the database', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 3 });

      await assert.rejects(
        orders.checkout(fx.buyerId, 'short', {
          tenantId: fx.tenantId,
          slotId: slot.id,
          expectedSlotVersion: slot.version,
          items: [{ menuItemId: fx.itemId, quantity: 1 }],
        }),
        BadRequestException,
      );
      await assert.rejects(
        orders.checkout(fx.buyerId, 'checkout-bad-quantity', {
          tenantId: fx.tenantId,
          slotId: slot.id,
          expectedSlotVersion: slot.version,
          items: [{ menuItemId: fx.itemId, quantity: 0 }],
        }),
        BadRequestException,
      );
      await assert.rejects(
        orders.checkout(fx.buyerId, 'checkout-empty-cart', {
          tenantId: fx.tenantId,
          slotId: slot.id,
          expectedSlotVersion: slot.version,
          items: [],
        }),
        BadRequestException,
      );
      await assert.rejects(
        orders.checkout(fx.buyerId, 'checkout-unknown-option', {
          tenantId: fx.tenantId,
          slotId: slot.id,
          expectedSlotVersion: slot.version,
          items: [
            { menuItemId: fx.itemId, quantity: 1, optionIds: [randomUUID()] },
          ],
        }),
        (error: unknown) => error instanceof BadRequestException,
      );
      const count = await pool.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM orders WHERE buyer_id = $1',
        [fx.buyerId],
      );
      assert.equal(count.rows[0].total, '0');
    });

    it('enforces the 0007 money and status invariants in the database itself', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 3 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const result = await orders.checkout(
        fx.buyerId,
        'checkout-invariants-1',
        {
          tenantId: fx.tenantId,
          slotId: slot.id,
          expectedSlotVersion: slot.version,
          items: [{ menuItemId: fx.itemId, quantity: 1 }],
        },
      );
      const orderId = result.data.id;
      const insertOrder = (
        subtotal: number,
        total: number,
        status = 'paid_awaiting_tenant',
      ) =>
        pool.query(
          `INSERT INTO orders
             (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot,
              tenant_timezone_snapshot, pickup_starts_at, pickup_ends_at,
              status, currency, subtotal_minor, total_minor, paid_at, updated_at)
           VALUES ($1,$2,$3,'T','Asia/Jakarta', now() + interval '1 hour',
                   now() + interval '2 hours', $4, 'IDR', $5, $6, now(), now())`,
          [fx.buyerId, fx.tenantId, slot.id, status, subtotal, total],
        );

      // total_minor must equal subtotal_minor (no fee/tax in the pilot).
      await assert.rejects(insertOrder(1000, 900), sqlState('23514'));
      // Zero-total orders are rejected.
      await assert.rejects(insertOrder(0, 0), sqlState('23514'));
      // Status/timestamp agreement (confirmed requires confirmed_at).
      await assert.rejects(
        insertOrder(1000, 1000, 'confirmed'),
        sqlState('23514'),
      );

      // line_total_minor must equal unit_price_minor * quantity.
      await assert.rejects(
        pool.query(
          `INSERT INTO order_items
             (order_id, source_menu_item_id, source_category_id, name_snapshot,
              description_snapshot, menu_version, quantity,
              base_unit_price_minor, unit_price_minor, line_total_minor)
           VALUES ($1,$2,$3,'X','',1,2,1000,1000,1000)`,
          [orderId, fx.itemId, fx.categoryId],
        ),
        sqlState('23514'),
      );
      // quantity outside 1..999 is rejected.
      await assert.rejects(
        pool.query(
          `INSERT INTO order_items
             (order_id, source_menu_item_id, source_category_id, name_snapshot,
              description_snapshot, menu_version, quantity,
              base_unit_price_minor, unit_price_minor, line_total_minor)
           VALUES ($1,$2,$3,'X','',1,0,1000,1000,0)`,
          [orderId, fx.itemId, fx.categoryId],
        ),
        sqlState('23514'),
      );
      // Monotonic transition timestamps.
      await assert.rejects(
        pool.query(
          `UPDATE orders SET status = 'confirmed',
                  confirmed_at = created_at - interval '1 minute',
                  version = version + 1, updated_at = now()
            WHERE id = $1`,
          [orderId],
        ),
        sqlState('23514'),
      );
      // One payment row per order.
      const payment = await pool.query<{ ledger_transaction_id: string }>(
        'SELECT ledger_transaction_id FROM order_payments WHERE order_id = $1',
        [orderId],
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO order_payments
             (order_id, method, status, amount_minor, currency,
              ledger_transaction_id, succeeded_at, updated_at)
           VALUES ($1,'wallet','succeeded',17000,'IDR',$2, now(), now())`,
          [orderId, payment.rows[0].ledger_transaction_id],
        ),
        sqlState('23505'),
      );
    });

    it('generates readable, unique order numbers', () => {
      const seen = new Set<string>();
      for (let index = 0; index < 5000; index += 1) {
        const value = generateOrderNumber();
        assert.match(value, /^AN-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/);
        assert.equal(value.length, 18);
        seen.add(value);
      }
      assert.equal(seen.size, 5000, 'no collision in 5000 draws');
    });
  },
);

interface Snapshot {
  buyerBalance: string;
  /** Escrow credit attributable to THIS buyer's orders (scoped, not global). */
  escrowHeld: string;
  reservedCount: number;
  orderCount: number;
  ledgerCount: number;
  reservationCount: number;
  idempotencyCount: number;
  paymentCount: number;
  itemCount: number;
  eventCount: number;
}

async function snapshot(
  pool: Pool,
  fx: Fixture,
  slotId: string,
): Promise<Snapshot> {
  const balance = await pool.query<{ balance_minor: string }>(
    `SELECT coalesce(balance_minor,0)::text AS balance_minor FROM wallet_accounts
      WHERE account_type = 'wallet' AND owner_user_id = $1`,
    [fx.buyerId],
  );
  const counts = await pool.query<{
    orders: string;
    ledger: string;
    reservations: string;
    idempotency: string;
    payments: string;
    items: string;
    events: string;
  }>(
    `SELECT (SELECT count(*) FROM orders WHERE buyer_id = $1)::text AS orders,
            (SELECT count(*) FROM ledger_transactions lt
               JOIN orders o ON o.id::text = lt.reference_id
              WHERE o.buyer_id = $1)::text AS ledger,
            (SELECT count(*) FROM slot_reservations WHERE slot_id = $2)::text
              AS reservations,
            (SELECT count(*) FROM order_request_idempotency
              WHERE actor_user_id = $1)::text AS idempotency,
            (SELECT count(*) FROM order_payments p
               JOIN orders o ON o.id = p.order_id
              WHERE o.buyer_id = $1)::text AS payments,
            (SELECT count(*) FROM order_items i
               JOIN orders o ON o.id = i.order_id
              WHERE o.buyer_id = $1)::text AS items,
            (SELECT count(*) FROM order_events e
               JOIN orders o ON o.id = e.order_id
              WHERE o.buyer_id = $1)::text AS events`,
    [fx.buyerId, slotId],
  );
  const slot = await slotState(pool, slotId);
  return {
    buyerBalance: balance.rows[0]?.balance_minor ?? '0',
    escrowHeld: await escrowHeld(pool, fx.buyerId),
    reservedCount: slot.reserved_count,
    orderCount: Number(counts.rows[0].orders),
    ledgerCount: Number(counts.rows[0].ledger),
    reservationCount: Number(counts.rows[0].reservations),
    idempotencyCount: Number(counts.rows[0].idempotency),
    paymentCount: Number(counts.rows[0].payments),
    itemCount: Number(counts.rows[0].items),
    eventCount: Number(counts.rows[0].events),
  };
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

async function slotState(
  pool: Pool,
  slotId: string,
): Promise<{ reserved_count: number; version: number }> {
  const result = await pool.query<{ reserved_count: number; version: number }>(
    'SELECT reserved_count, version FROM pickup_slots WHERE id = $1',
    [slotId],
  );
  return result.rows[0];
}

async function walletBalance(pool: Pool, userId: string): Promise<string> {
  const result = await pool.query<{ balance_minor: string }>(
    `SELECT coalesce(balance_minor,0)::text AS balance_minor FROM wallet_accounts
      WHERE account_type = 'wallet' AND owner_user_id = $1`,
    [userId],
  );
  return result.rows[0]?.balance_minor ?? '0';
}

/**
 * Escrow credits attributable to one buyer's orders. The escrow system account
 * itself is global (shared by every tenant and by concurrently running test
 * files), so tests must never assert on its absolute balance.
 */
async function escrowHeld(pool: Pool, buyerId: string): Promise<string> {
  const result = await pool.query<{ total: string }>(
    `SELECT coalesce(sum(e.amount_minor),0)::text AS total
       FROM ledger_entries e
       JOIN ledger_transactions lt ON lt.id = e.transaction_id
       JOIN orders o ON o.id::text = lt.reference_id
      WHERE o.buyer_id = $1 AND e.direction = 'credit'`,
    [buyerId],
  );
  return result.rows[0]?.total ?? '0';
}

async function fundWallet(
  pool: Pool,
  wallet: WalletService,
  userId: string,
  amountMinor: number,
): Promise<void> {
  const funding = await wallet.ensureSystemAccount('test.funding', 'IDR');
  const target = await wallet.getOrCreateWallet(userId, 'IDR');
  await wallet.postTransfer({
    idempotencyScope: 'test.funding',
    idempotencyKey: randomUUID(),
    currency: 'IDR',
    amountMinor: String(amountMinor),
    debitAccountId: funding.accountId,
    creditAccountId: target.accountId,
    actor: { type: 'service', id: 'test.funding' },
    reason: 'test funding',
  });
}

/** Arms both tenant-scoped deadlock triggers for one fixture tenant. */
async function armDeadlock(pool: Pool, tenantId: string): Promise<void> {
  await pool.query('ALTER SEQUENCE orders_test_deadlock_seq RESTART WITH 1');
  await pool.query(
    'INSERT INTO orders_test_deadlock_target (tenant_id) VALUES ($1)',
    [tenantId],
  );
}

async function disarmDeadlock(pool: Pool, tenantId: string): Promise<void> {
  await pool.query(
    'DELETE FROM orders_test_deadlock_target WHERE tenant_id = $1',
    [tenantId],
  );
}

/** Number of transaction attempts that hit the injected deadlock. */
async function deadlockAttempts(pool: Pool): Promise<string> {
  const result = await pool.query<{ last_value: string }>(
    'SELECT last_value::text AS last_value FROM orders_test_deadlock_seq',
  );
  return result.rows[0].last_value;
}

async function countOrders(pool: Pool, buyerId: string): Promise<number> {
  const result = await pool.query<{ total: string }>(
    'SELECT count(*)::text AS total FROM orders WHERE buyer_id = $1',
    [buyerId],
  );
  return Number(result.rows[0].total);
}

/**
 * R2-02: availability maps database rejections to stable 409 contract codes
 * (DATABASE_DEADLOCK / REFERENCE_CONFLICT / CHECK_CONSTRAINT_VIOLATION /
 * SLOT_WINDOW_CONFLICT / RESERVATION_IN_PROGRESS). The strict code assertion
 * activates as soon as availability attaches the code; until then the mapped
 * ConflictException carries only a message, which is tolerated here but never a
 * different code and never a non-Conflict error.
 */
function assertMappedConflict(error: unknown, expected: string): void {
  assert.ok(
    error instanceof ConflictException,
    `expected ConflictException, got: ${String(error)}`,
  );
  const body: unknown = (error as ConflictException).getResponse();
  if (typeof body === 'object' && body !== null && 'code' in body) {
    assert.equal((body as { code?: string }).code, expected);
  }
}

function sqlState(code: string) {
  return (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code;
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
      `INSERT INTO campuses (name, timezone, status)
       VALUES ($1, 'Asia/Jakarta', 'active') RETURNING id`,
      [`Campus ${id}`],
    )
  ).rows[0].id;
  const insertTenant = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO tenants (campus_id, name, location, status)
         VALUES ($1, $2, 'Kantin Uji', 'open') RETURNING id`,
        [campusId, `${name} ${id}`],
      )
    ).rows[0].id;
  const tenantId = await insertTenant('Tenant A');
  const tenant2Id = await insertTenant('Tenant B');
  const insertUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'INSERT INTO users (display_name) VALUES ($1) RETURNING id',
        [`${name} ${id}`],
      )
    ).rows[0].id;
  const buyerId = await insertUser('Buyer');
  const buyer2Id = await insertUser('Buyer2');
  const ownerId = await insertUser('Owner');
  const owner2Id = await insertUser('Owner2');
  const kitchenId = await insertUser('Kitchen');
  const pickupStaffId = await insertUser('PickupStaff');
  const readonlyOnlyId = await insertUser('ReadOnly');

  await pool.query(
    `INSERT INTO tenant_memberships
       (tenant_id, user_id, role, permissions, status, owner_verified_at)
     VALUES ($1, $2, 'owner', '{}', 'active', now())`,
    [tenantId, ownerId],
  );
  await pool.query(
    `INSERT INTO tenant_memberships
       (tenant_id, user_id, role, permissions, status, owner_verified_at)
     VALUES ($1, $2, 'owner', '{}', 'active', now())`,
    [tenant2Id, owner2Id],
  );
  await pool.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status)
     VALUES ($1, $2, 'kitchen',
             '{tenant.orders.read,tenant.orders.accept,tenant.orders.prepare}',
             'active')`,
    [tenantId, kitchenId],
  );
  await pool.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status)
     VALUES ($1, $2, 'pickup',
             '{tenant.orders.read,tenant.orders.handover}', 'active')`,
    [tenantId, pickupStaffId],
  );
  await pool.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status)
     VALUES ($1, $2, 'kitchen', '{tenant.orders.read}', 'active')`,
    [tenantId, readonlyOnlyId],
  );
  for (const tenant of [tenantId, tenant2Id]) {
    await pool.query(
      `INSERT INTO tenant_operating_hours
         (tenant_id, weekday, is_open, opens_at, closes_at, updated_at)
       SELECT $1, g, true, '00:00:00'::time, '23:59:59'::time, now()
         FROM generate_series(0, 6) AS g`,
      [tenant],
    );
  }

  const categoryId = (
    await pool.query<{ id: string }>(
      `INSERT INTO menu_categories (tenant_id, name, sort_order, status)
       VALUES ($1, 'Makanan', 0, 'active') RETURNING id`,
      [tenantId],
    )
  ).rows[0].id;
  const insertItem = async (name: string, priceMinor: number) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO menu_items
           (tenant_id, category_id, name, description, price_minor, status,
            version, updated_at)
         VALUES ($1,$2,$3,'Deskripsi',$4,'active',1, now()) RETURNING id`,
        [tenantId, categoryId, name, priceMinor],
      )
    ).rows[0].id;
  const itemId = await insertItem('Nasi Ayam', ITEM_PRICE_MINOR);
  const item2Id = await insertItem('Es Teh', ITEM_PRICE_MINOR);
  const itemIds = [itemId, item2Id];
  for (let index = 2; index < 10; index += 1) {
    itemIds.push(await insertItem(`Menu ${index}`, ITEM_PRICE_MINOR));
  }
  const groupId = (
    await pool.query<{ id: string }>(
      `INSERT INTO menu_option_groups
         (tenant_id, menu_item_id, name, min_selections, max_selections,
          sort_order, status, version, updated_at)
       VALUES ($1,$2,'Sambal',0,2,0,'active',1, now()) RETURNING id`,
      [tenantId, itemId],
    )
  ).rows[0].id;
  const choiceId = (
    await pool.query<{ id: string }>(
      `INSERT INTO menu_option_choices
         (tenant_id, group_id, name, price_delta_minor, status, version,
          updated_at)
       VALUES ($1,$2,'Extra pedas',$3,'active',1, now()) RETURNING id`,
      [tenantId, groupId, CHOICE_DELTA_MINOR],
    )
  ).rows[0].id;

  return {
    campusId,
    tenantId,
    tenant2Id,
    buyerId,
    buyer2Id,
    ownerId,
    owner2Id,
    kitchenId,
    pickupStaffId,
    readonlyOnlyId,
    categoryId,
    itemId,
    item2Id,
    itemIds,
    groupId,
    choiceId,
    localDate: jakartaLocalDate(1),
  };
}

async function insertSlot(
  pool: Pool,
  tenantId: string,
  options: {
    localDate?: string;
    start?: string;
    end?: string;
    capacity?: number;
    status?: 'open' | 'closed';
  } = {},
): Promise<SlotRow> {
  const result = await pool.query<SlotRow>(
    `INSERT INTO pickup_slots
       (tenant_id, starts_at, ends_at, capacity, reserved_count, status,
        updated_at)
     VALUES ($1,
       (($2::date + $3::time)::timestamp AT TIME ZONE 'Asia/Jakarta'),
       (($2::date + $4::time)::timestamp AT TIME ZONE 'Asia/Jakarta'),
       $5, 0, $6, now())
     RETURNING id, version, capacity, reserved_count,
       to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at_text,
       to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at_text`,
    [
      tenantId,
      options.localDate ?? jakartaLocalDate(1),
      options.start ?? '10:00',
      options.end ?? '11:00',
      options.capacity ?? 5,
      options.status ?? 'open',
    ],
  );
  return result.rows[0];
}
