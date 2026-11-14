import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
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
const ITEM_PRICE_MINOR = 15000;
const CHOICE_DELTA_MINOR = 2000;
const UNIT_PRICE_MINOR = ITEM_PRICE_MINOR + CHOICE_DELTA_MINOR;
/** 2 x 17000: the cart used by the price-parity and no-write tests. */
const CART_TOTAL_MINOR = UNIT_PRICE_MINOR * 2;

interface Fixture {
  campusId: string;
  tenantId: string;
  tenant2Id: string;
  buyerId: string;
  buyer2Id: string;
  ownerId: string;
  owner2Id: string;
  kitchenId: string;
  noReadStaffId: string;
  outsiderId: string;
  categoryId: string;
  itemId: string;
  groupId: string;
  choiceId: string;
}

interface SlotRow {
  id: string;
  version: number;
  capacity: number;
  reserved_count: number;
}

/**
 * Every row count here is scoped to the fixture (buyer, slot or tenant) so
 * concurrently running spec files on the same database never leak into the
 * "the quote wrote nothing" assertions.
 */
interface Counts {
  orders: number;
  events: number;
  idempotency: number;
  payments: number;
  items: number;
  reservations: number;
  ledger: number;
  balance: string;
  reservedCount: number;
  slotVersion: number;
}

describe(
  'Orders quote and order events (PostgreSQL)',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let orders: OrdersService;
    let wallet: WalletService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 10 });
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
      // A week of lead time keeps a slot that starts tomorrow "preparable", so
      // the timeline test can walk paid_awaiting_tenant -> confirmed ->
      // preparing instead of stopping after two events.
      const config: Record<string, number> = {
        ORDER_PROPOSAL_TTL_SECONDS: 600,
        ORDER_PREPARATION_LEAD_SECONDS: 604_800,
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
    });

    after(async () => {
      await pool?.end();
    });

    it('quotes the same total checkout charges and writes no rows at all', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const before = await readCounts(pool, fx, slot.id);
      const cart = [
        { menuItemId: fx.itemId, quantity: 2, optionIds: [fx.choiceId] },
      ];

      const quote = await orders.quoteForBuyer(fx.buyerId, {
        tenantId: fx.tenantId,
        slotId: slot.id,
        expectedSlotVersion: slot.version,
        items: cart,
        specialRequest: 'pedas sedang',
      });

      const data = quote.data;
      assert.equal(data.tenant.id, fx.tenantId);
      assert.equal(data.tenant.campusId, fx.campusId);
      assert.equal(data.tenant.timezone, 'Asia/Jakarta');
      assert.equal(data.slot.id, slot.id);
      assert.equal(data.slot.version, slot.version);
      assert.match(
        data.slot.startsAt,
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/,
      );
      assert.equal(data.currency, 'IDR');
      assert.equal(data.subtotalMinor, String(CART_TOTAL_MINOR));
      assert.equal(data.totalMinor, String(CART_TOTAL_MINOR));
      assert.equal(data.items.length, 1);
      const line = data.items[0];
      assert.equal(line.menuItemId, fx.itemId);
      assert.equal(line.quantity, 2);
      assert.equal(line.baseUnitPriceMinor, String(ITEM_PRICE_MINOR));
      assert.equal(line.unitPriceMinor, String(UNIT_PRICE_MINOR));
      assert.equal(line.lineTotalMinor, String(CART_TOTAL_MINOR));
      assert.equal(line.options.length, 1);
      assert.equal(line.options[0].id, fx.choiceId);
      assert.equal(line.options[0].priceDeltaMinor, String(CHOICE_DELTA_MINOR));
      assert.equal(data.wallet.currency, 'IDR');
      assert.equal(data.wallet.availableMinor, '10000000');
      assert.equal(data.wallet.sufficient, true);

      // A quote is a preview: no order, reservation, ledger entry, payment,
      // idempotency record or event, and the slot/wallet stay untouched.
      const afterQuote = await readCounts(pool, fx, slot.id);
      assert.deepEqual(afterQuote, before);
      assert.equal(afterQuote.orders, 0);
      assert.equal(afterQuote.reservations, 0);
      assert.equal(afterQuote.reservedCount, 0);
      assert.equal(afterQuote.slotVersion, slot.version);

      // Same input through checkout charges exactly the quoted total, proving
      // both paths share CatalogService.quote.
      const checkout = await orders.checkout(fx.buyerId, 'quote-parity-0001', {
        tenantId: fx.tenantId,
        slotId: slot.id,
        expectedSlotVersion: slot.version,
        items: cart,
      });
      assert.equal(checkout.data.totalMinor, data.totalMinor);
      assert.equal(checkout.data.subtotalMinor, data.subtotalMinor);
      assert.equal(
        checkout.data.items[0].lineTotalMinor,
        data.items[0].lineTotalMinor,
      );
      assert.equal(
        checkout.data.items[0].unitPriceMinor,
        data.items[0].unitPriceMinor,
      );
      assert.equal(await walletBalance(pool, fx.buyerId), '9966000');
    });

    it('reports an insufficient wallet balance without failing the quote', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 1000);

      const quote = await orders.quoteForBuyer(fx.buyerId, {
        tenantId: fx.tenantId,
        slotId: slot.id,
        items: [
          { menuItemId: fx.itemId, quantity: 2, optionIds: [fx.choiceId] },
        ],
      });
      assert.equal(quote.data.totalMinor, String(CART_TOTAL_MINOR));
      assert.equal(quote.data.wallet.availableMinor, '1000');
      assert.equal(quote.data.wallet.sufficient, false);
      assert.equal(await walletBalance(pool, fx.buyerId), '1000');
    });

    it('treats a buyer without a wallet as zero balance', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });

      const quote = await orders.quoteForBuyer(fx.buyerId, {
        tenantId: fx.tenantId,
        slotId: slot.id,
        items: [{ menuItemId: fx.itemId, quantity: 1 }],
      });
      assert.equal(quote.data.wallet.availableMinor, '0');
      assert.equal(quote.data.wallet.sufficient, false);
      // Reading a missing wallet must not create one.
      const created = await pool.query(
        'select 1 from wallet_accounts where owner_user_id = $1',
        [fx.buyerId],
      );
      assert.equal(created.rowCount, 0);
    });

    it('refuses a full slot and a closed tenant with 409', async () => {
      const fx = await createFixture(pool);
      // One tenant may hold a single slot per window (pickup_slots_tenant_window_uq),
      // so the two scenarios use different windows.
      const full = await insertSlot(pool, fx.tenantId, {
        capacity: 1,
        start: '10:00',
        end: '11:00',
      });
      await pool.query(
        'UPDATE pickup_slots SET reserved_count = 1 WHERE id = $1',
        [full.id],
      );
      await expectStatus(
        () =>
          orders.quoteForBuyer(fx.buyerId, {
            tenantId: fx.tenantId,
            slotId: full.id,
            items: [{ menuItemId: fx.itemId, quantity: 1 }],
          }),
        409,
      );

      const open = await insertSlot(pool, fx.tenantId, {
        capacity: 5,
        start: '12:00',
        end: '13:00',
      });
      await pool.query("UPDATE tenants SET status = 'closed' WHERE id = $1", [
        fx.tenantId,
      ]);
      await expectStatus(
        () =>
          orders.quoteForBuyer(fx.buyerId, {
            tenantId: fx.tenantId,
            slotId: open.id,
            items: [{ menuItemId: fx.itemId, quantity: 1 }],
          }),
        409,
      );

      // Neither failure created anything.
      const counts = await readCounts(pool, fx, open.id);
      assert.equal(counts.orders, 0);
      assert.equal(counts.reservations, 0);
      assert.equal(counts.events, 0);
    });

    it('rejects a stale expectedSlotVersion with SLOT_CHANGED', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const cart = [{ menuItemId: fx.itemId, quantity: 1 }];

      const fresh = await orders.quoteForBuyer(fx.buyerId, {
        tenantId: fx.tenantId,
        slotId: slot.id,
        expectedSlotVersion: slot.version,
        items: cart,
      });
      assert.equal(fresh.data.slot.version, slot.version);

      // A management change (capacity) bumps pickup_slots.version.
      await pool.query(
        'UPDATE pickup_slots SET capacity = capacity + 1, version = version + 1, updated_at = now() WHERE id = $1',
        [slot.id],
      );
      await expectStatus(
        () =>
          orders.quoteForBuyer(fx.buyerId, {
            tenantId: fx.tenantId,
            slotId: slot.id,
            expectedSlotVersion: slot.version,
            items: cart,
          }),
        409,
        'SLOT_CHANGED',
      );

      // Without the optional guard the quote still works and reports the new
      // version, so a client can re-price and retry.
      const unguarded = await orders.quoteForBuyer(fx.buyerId, {
        tenantId: fx.tenantId,
        slotId: slot.id,
        items: cart,
      });
      assert.equal(unguarded.data.slot.version, slot.version + 1);
    });

    it('validates the cart before pricing anything', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      for (const bad of [
        { items: [] as { menuItemId: string; quantity: number }[] },
        { items: [{ menuItemId: fx.itemId, quantity: 0 }] },
        { items: [{ menuItemId: fx.itemId, quantity: 201 }] },
        { items: [{ menuItemId: 'not-a-uuid', quantity: 1 }] },
        { tenantId: 'not-a-uuid' },
        { slotId: 'not-a-uuid' },
      ]) {
        await expectStatus(
          () =>
            orders.quoteForBuyer(fx.buyerId, {
              tenantId: fx.tenantId,
              slotId: slot.id,
              items: [{ menuItemId: fx.itemId, quantity: 1 }],
              ...bad,
            }),
          400,
        );
      }
      await expectStatus(
        () =>
          orders.quoteForBuyer(fx.buyerId, {
            tenantId: fx.tenantId,
            slotId: slot.id,
            expectedSlotVersion: 0,
            items: [{ menuItemId: fx.itemId, quantity: 1 }],
          }),
        400,
      );
      const counts = await readCounts(pool, fx, slot.id);
      assert.equal(counts.orders, 0);
      assert.equal(counts.events, 0);
    });

    it('returns the buyer timeline ordered by occurredAt then version', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const checkout = await orders.checkout(
        fx.buyerId,
        'timeline-checkout-0001',
        {
          tenantId: fx.tenantId,
          slotId: slot.id,
          expectedSlotVersion: slot.version,
          items: [{ menuItemId: fx.itemId, quantity: 1 }],
        },
      );
      const orderId = checkout.data.id;
      await orders.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        orderId,
        'confirm',
      );
      await orders.tenantTransition(
        fx.kitchenId,
        fx.tenantId,
        orderId,
        'prepare',
      );

      const events = await orders.listOrderEvents(fx.buyerId, orderId);
      assert.equal(events.data.length, 3);
      assert.deepEqual(
        events.data.map((event) => event.eventType),
        ['order.created', 'order.status_changed', 'order.status_changed'],
      );
      assert.deepEqual(
        events.data.map((event) => event.version),
        [1, 2, 3],
      );
      assert.equal(events.data[0].fromStatus, null);
      assert.equal(events.data[0].toStatus, 'paid_awaiting_tenant');
      assert.equal(events.data[1].fromStatus, 'paid_awaiting_tenant');
      assert.equal(events.data[1].toStatus, 'confirmed');
      assert.equal(events.data[2].toStatus, 'preparing');
      for (const event of events.data) {
        // D7: the API hands back the PostgreSQL microsecond timestamp.
        assert.match(
          event.occurredAt,
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/,
        );
        assert.equal(typeof event.metadata, 'object');
      }
      assert.equal(events.data[0].actorUserId, fx.buyerId);
      assert.equal(events.data[0].actorService, null);
      assert.equal(events.data[0].metadata.tenantId, fx.tenantId);
      // The cart carried no option, so the paid amount is the base price.
      assert.equal(
        events.data[0].metadata.totalMinor,
        String(ITEM_PRICE_MINOR),
      );
      assert.equal(events.data[1].actorUserId, fx.kitchenId);
      const timestamps = events.data.map((event) => event.occurredAt);
      assert.deepEqual([...timestamps].sort(), timestamps);

      // A row recorded with an earlier timestamp sorts first even though its
      // version is the highest: the contract is (occurredAt, version).
      await pool.query(
        `INSERT INTO order_events
           (order_id, version, event_type, from_status, to_status,
            actor_service, reason, metadata, occurred_at)
         VALUES ($1, 99, 'order.status_changed', NULL, NULL, 'test.service',
                 'synthetic backfill', '{"source":"synthetic"}'::jsonb,
                 now() - interval '5 minutes')`,
        [orderId],
      );
      const reordered = await orders.listOrderEvents(fx.buyerId, orderId);
      assert.equal(reordered.data.length, 4);
      assert.equal(reordered.data[0].version, 99);
      assert.equal(reordered.data[0].actorService, 'test.service');
      assert.equal(reordered.data[0].actorUserId, null);
      // metadata is handed back exactly as the jsonb column stores it.
      assert.deepEqual(reordered.data[0].metadata, { source: 'synthetic' });
      assert.deepEqual(
        reordered.data.slice(1).map((event) => event.version),
        [1, 2, 3],
      );
    });

    it('hides another buyer order and another tenant order (404) and requires the tenant permission (403)', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, { capacity: 5 });
      await fundWallet(pool, wallet, fx.buyerId, 10_000_000);
      const checkout = await orders.checkout(
        fx.buyerId,
        'scoping-checkout-0001',
        {
          tenantId: fx.tenantId,
          slotId: slot.id,
          expectedSlotVersion: slot.version,
          items: [{ menuItemId: fx.itemId, quantity: 1 }],
        },
      );
      const orderId = checkout.data.id;

      // Buyer scope: another buyer sees a 404, never a 403.
      await expectStatus(
        () => orders.listOrderEvents(fx.buyer2Id, orderId),
        404,
      );
      await expectStatus(
        () => orders.listOrderEvents(fx.buyerId, randomUUID()),
        404,
      );

      // Tenant scope: the owning tenant may read, the other tenant gets 404.
      const staffView = await orders.listTenantOrderEvents(
        fx.ownerId,
        fx.tenantId,
        orderId,
      );
      assert.equal(staffView.data.length, 1);
      assert.equal(staffView.data[0].eventType, 'order.created');
      await expectStatus(
        () => orders.listTenantOrderEvents(fx.owner2Id, fx.tenant2Id, orderId),
        404,
      );
      // A tenant id the actor is not a member of is a 403, not a leak.
      await expectStatus(
        () => orders.listTenantOrderEvents(fx.owner2Id, fx.tenantId, orderId),
        403,
      );
      // A member without tenant.orders.read is refused too.
      await expectStatus(
        () =>
          orders.listTenantOrderEvents(fx.noReadStaffId, fx.tenantId, orderId),
        403,
      );
      await expectStatus(
        () => orders.listTenantOrderEvents(fx.outsiderId, fx.tenantId, orderId),
        403,
      );
    });
  },
);

async function expectStatus(
  run: () => Promise<unknown>,
  status: number,
  code?: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.ok(
      error instanceof HttpException,
      `expected an HttpException, got: ${String(error)}`,
    );
    assert.equal(
      error.getStatus(),
      status,
      `expected ${status}, got ${error.getStatus()}: ${error.message}`,
    );
    if (code !== undefined) {
      const body: unknown = error.getResponse();
      assert.equal((body as { code?: string }).code, code);
    }
    return;
  }
  assert.fail(`expected a ${status} rejection`);
}

async function readCounts(
  pool: Pool,
  fx: Fixture,
  slotId: string,
): Promise<Counts> {
  const counts = await pool.query<{
    orders: string;
    events: string;
    idempotency: string;
    payments: string;
    items: string;
    reservations: string;
    ledger: string;
  }>(
    `SELECT
       (SELECT count(*) FROM orders WHERE buyer_id = $1)::text AS orders,
       (SELECT count(*) FROM order_events e
          JOIN orders o ON o.id = e.order_id
         WHERE o.buyer_id = $1)::text AS events,
       (SELECT count(*) FROM order_request_idempotency
         WHERE actor_user_id = $1)::text AS idempotency,
       (SELECT count(*) FROM order_payments p
          JOIN orders o ON o.id = p.order_id
         WHERE o.buyer_id = $1)::text AS payments,
       (SELECT count(*) FROM order_items i
          JOIN orders o ON o.id = i.order_id
         WHERE o.buyer_id = $1)::text AS items,
       (SELECT count(*) FROM slot_reservations WHERE slot_id = $2)::text
         AS reservations,
       (SELECT count(*) FROM ledger_entries e
          JOIN wallet_accounts a ON a.id = e.account_id
         WHERE a.owner_user_id = $1)::text AS ledger`,
    [fx.buyerId, slotId],
  );
  const slot = await pool.query<{ reserved_count: number; version: number }>(
    'SELECT reserved_count, version FROM pickup_slots WHERE id = $1',
    [slotId],
  );
  const row = counts.rows[0];
  return {
    orders: Number(row.orders),
    events: Number(row.events),
    idempotency: Number(row.idempotency),
    payments: Number(row.payments),
    items: Number(row.items),
    reservations: Number(row.reservations),
    ledger: Number(row.ledger),
    balance: await walletBalance(pool, fx.buyerId),
    reservedCount: slot.rows[0].reserved_count,
    slotVersion: slot.rows[0].version,
  };
}

async function walletBalance(pool: Pool, userId: string): Promise<string> {
  const result = await pool.query<{ balance_minor: string }>(
    `SELECT coalesce(balance_minor, 0)::text AS balance_minor
       FROM wallet_accounts
      WHERE account_type = 'wallet' AND owner_user_id = $1`,
    [userId],
  );
  return result.rows[0]?.balance_minor ?? '0';
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

function jakartaLocalDate(daysFromNow: number): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(Date.now() + daysFromNow * 86_400_000));
}

async function insertSlot(
  pool: Pool,
  tenantId: string,
  options: { capacity?: number; start?: string; end?: string } = {},
): Promise<SlotRow> {
  const result = await pool.query<SlotRow>(
    `INSERT INTO pickup_slots
       (tenant_id, starts_at, ends_at, capacity, reserved_count, status,
        updated_at)
     VALUES ($1,
       (($2::date + $3::time)::timestamp AT TIME ZONE 'Asia/Jakarta'),
       (($2::date + $4::time)::timestamp AT TIME ZONE 'Asia/Jakarta'),
       $5, 0, 'open', now())
     RETURNING id, version, capacity, reserved_count`,
    [
      tenantId,
      jakartaLocalDate(1),
      options.start ?? '10:00',
      options.end ?? '11:00',
      options.capacity ?? 5,
    ],
  );
  return result.rows[0];
}

async function createFixture(pool: Pool): Promise<Fixture> {
  const tag = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      `INSERT INTO campuses (name, timezone, status)
       VALUES ($1, 'Asia/Jakarta', 'active') RETURNING id`,
      [`Campus ${tag}`],
    )
  ).rows[0].id;
  const insertTenant = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO tenants (campus_id, name, location, status)
         VALUES ($1, $2, 'Kantin Uji', 'open') RETURNING id`,
        [campusId, `${name} ${tag}`],
      )
    ).rows[0].id;
  const tenantId = await insertTenant('Tenant A');
  const tenant2Id = await insertTenant('Tenant B');
  const insertUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'INSERT INTO users (display_name) VALUES ($1) RETURNING id',
        [`${name} ${tag}`],
      )
    ).rows[0].id;
  const buyerId = await insertUser('Buyer');
  const buyer2Id = await insertUser('Buyer2');
  const ownerId = await insertUser('Owner');
  const owner2Id = await insertUser('Owner2');
  const kitchenId = await insertUser('Kitchen');
  const noReadStaffId = await insertUser('NoRead');
  const outsiderId = await insertUser('Outsider');

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
     VALUES ($1, $2, 'kitchen', '{tenant.orders.accept}', 'active')`,
    [tenantId, noReadStaffId],
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
  const itemId = (
    await pool.query<{ id: string }>(
      `INSERT INTO menu_items
         (tenant_id, category_id, name, description, price_minor, status,
          version, updated_at)
       VALUES ($1,$2,'Nasi Ayam','Deskripsi',$3,'active',1, now()) RETURNING id`,
      [tenantId, categoryId, ITEM_PRICE_MINOR],
    )
  ).rows[0].id;
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
    noReadStaffId,
    outsiderId,
    categoryId,
    itemId,
    groupId,
    choiceId,
  };
}
