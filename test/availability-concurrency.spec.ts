import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { ConflictException } from '@nestjs/common';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AvailabilityService } from '../src/modules/availability/availability.service';
import { TenantOperatingHoursService } from '../src/modules/tenants/tenant-operating-hours.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe(
  'Availability capacity concurrency and reconciliation (PostgreSQL)',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let availability: AvailabilityService;

    before(async () => {
      // Enough connections for the parallel reserve fan-out below.
      pool = new Pool({ connectionString: testDatabaseUrl, max: 28 });
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
    });

    after(async () => {
      await pool?.end();
    });

    it('lets exactly K of N parallel reserves win on a slot with capacity K', async () => {
      const fx = await createFixture(pool);
      const capacity = 5;
      const racers = 12;
      const slot = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        capacity,
      });
      // FK 0007: every racer needs a real orders row before reserving.
      const orders: string[] = [];
      for (let i = 0; i < racers + 1; i += 1) {
        orders.push(await newOrder(pool, fx, slot.id));
      }
      // Every racer quotes the same version, like N buyers checking out at once.
      const results = await Promise.allSettled(
        orders
          .slice(0, racers)
          .map((orderId) =>
            withTx(pool, (client) =>
              availability.reserveForCheckout(
                client,
                fx.tenantId,
                slot.id,
                slot.version,
                orderId,
              ),
            ),
          ),
      );
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult[];
      assert.equal(fulfilled.length, capacity);
      assert.equal(rejected.length, racers - capacity);
      for (const failure of rejected) {
        assert.ok(
          failure.reason instanceof ConflictException,
          `expected ConflictException, got: ${String(failure.reason)}`,
        );
        assert.match(
          (failure.reason as Error).message,
          /full/,
          'over-capacity losers must fail on capacity, not deadlocks',
        );
      }
      const row = await readSlot(pool, slot.id);
      assert.equal(row.reserved_count, capacity);
      assert.ok(row.reserved_count <= row.capacity);
      assert.equal(
        row.version,
        slot.version,
        'D3: reserves never bump version',
      );
      assert.equal(await countOccupiedSeats(pool, slot.id), capacity);

      // The next racer also fails while the slot is full.
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            slot.id,
            slot.version,
            orders[racers],
          ),
        ),
        ConflictException,
      );
      assert.equal((await readSlot(pool, slot.id)).reserved_count, capacity);
    });

    it('survives 8 parallel quote-then-reserve transactions without lock-upgrade deadlock (D15)', async () => {
      const fx = await createFixture(pool);
      const capacity = 3;
      const slot = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        capacity,
      });
      const orders: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        orders.push(await newOrder(pool, fx, slot.id));
      }
      // Reviewer-proven failure mode: quote taking FOR SHARE then reserve
      // taking FOR UPDATE on the same row deadlocks (40P01) under parallel
      // checkouts. Quote now uses lock mode 'none' (plain SELECT) and reserve
      // is the single FOR UPDATE authority.
      const results = await Promise.allSettled(
        orders.map((orderId) =>
          withTx(pool, async (client) => {
            const quote = await availability.assertBookableSlot(
              client,
              fx.tenantId,
              slot.id,
              'none',
            );
            return availability.reserveForCheckout(
              client,
              fx.tenantId,
              slot.id,
              quote.version,
              orderId,
            );
          }),
        ),
      );
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult[];
      assert.equal(fulfilled.length, capacity);
      assert.equal(rejected.length, 8 - capacity);
      for (const failure of rejected) {
        assert.ok(
          failure.reason instanceof ConflictException,
          `expected ConflictException (no deadlock 40P01), got: ${String(
            failure.reason,
          )}`,
        );
      }
      const row = await readSlot(pool, slot.id);
      assert.equal(row.reserved_count, capacity);
      assert.equal(await countOccupiedSeats(pool, slot.id), capacity);
    });

    it('replays the same order idempotently, even concurrently', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        capacity: 4,
      });
      const orderId = await newOrder(pool, fx, slot.id);
      // Three concurrent checkouts replaying the same order id (retry storm).
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          withTx(pool, (client) =>
            availability.reserveForCheckout(
              client,
              fx.tenantId,
              slot.id,
              slot.version,
              orderId,
            ),
          ),
        ),
      );
      const ids = new Set(results.map((result) => result.reservationId));
      assert.equal(ids.size, 1, 'all replays return the same reservation');
      assert.equal((await readSlot(pool, slot.id)).reserved_count, 1);
      assert.equal(await countOccupiedSeats(pool, slot.id), 1);

      // Sequential replay after commit stays a no-op.
      const replay = await withTx(pool, (client) =>
        availability.reserveForCheckout(
          client,
          fx.tenantId,
          slot.id,
          slot.version,
          orderId,
        ),
      );
      assert.equal(replay.reservationId, results[0].reservationId);
      assert.equal((await readSlot(pool, slot.id)).reserved_count, 1);

      // The same order cannot claim a different slot.
      const other = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '13:00',
        end: '14:00',
        capacity: 2,
      });
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            other.id,
            other.version,
            orderId,
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /another slot reservation/.test((error as Error).message),
      );
      assert.equal((await readSlot(pool, other.id)).reserved_count, 0);
    });

    it('serializes a concurrent release/consume race into one terminal state', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        capacity: 2,
      });
      const orderId = await newOrder(pool, fx, slot.id);
      await withTx(pool, (client) =>
        availability.reserveForCheckout(
          client,
          fx.tenantId,
          slot.id,
          slot.version,
          orderId,
        ),
      );
      const results = await Promise.allSettled([
        withTx(pool, (client) =>
          availability.releaseReservation(client, fx.tenantId, orderId),
        ),
        withTx(pool, (client) =>
          availability.consumeReservation(client, fx.tenantId, orderId),
        ),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult[];
      assert.equal(fulfilled.length, 1, 'exactly one transition may win');
      assert.equal(
        (fulfilled[0] as PromiseFulfilledResult<boolean>).value,
        true,
      );
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0].reason instanceof ConflictException);

      const reservation = await readReservation(pool, orderId);
      const row = await readSlot(pool, slot.id);
      if (reservation.status === 'released') {
        assert.equal(row.reserved_count, 0);
        assert.notEqual(reservation.released_at, null);
        assert.equal(reservation.consumed_at, null);
      } else {
        assert.equal(reservation.status, 'consumed');
        assert.equal(row.reserved_count, 1);
        assert.equal(reservation.released_at, null);
        assert.notEqual(reservation.consumed_at, null);
      }
      assert.equal(row.reserved_count, await countOccupiedSeats(pool, slot.id));
    });

    it('reconciles reserved_count with occupied rows after mixed parallel operations (R1-18)', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        capacity: 4,
      });
      const orders: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        orders.push(await newOrder(pool, fx, slot.id));
      }
      const firstWave = await Promise.allSettled(
        orders.map((orderId) =>
          withTx(pool, (client) =>
            availability.reserveForCheckout(
              client,
              fx.tenantId,
              slot.id,
              slot.version,
              orderId,
            ),
          ),
        ),
      );
      assert.equal(
        firstWave.filter((result) => result.status === 'fulfilled').length,
        4,
      );
      await assertReconciled(pool, slot.id, 4);

      // Mixed parallel wave: two releases, one consume, two fresh reserves.
      // Individual outcomes depend on commit order; the invariants must not.
      const winners = orders.filter(
        (orderId, index) => firstWave[index].status === 'fulfilled',
      );
      const secondWave = await Promise.allSettled([
        withTx(pool, (client) =>
          availability.releaseReservation(client, fx.tenantId, winners[0]),
        ),
        withTx(pool, (client) =>
          availability.releaseReservation(client, fx.tenantId, winners[1]),
        ),
        withTx(pool, (client) =>
          availability.consumeReservation(client, fx.tenantId, winners[2]),
        ),
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            slot.id,
            slot.version,
            orders[4],
          ),
        ),
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            slot.id,
            slot.version,
            orders[5],
          ),
        ),
      ]);
      for (const failure of secondWave.filter(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult[]) {
        assert.ok(
          failure.reason instanceof ConflictException,
          `expected ConflictException, got: ${String(failure.reason)}`,
        );
      }
      const row = await readSlot(pool, slot.id);
      assert.ok(row.reserved_count >= 0 && row.reserved_count <= row.capacity);
      assert.equal(row.version, slot.version);
      await assertReconciled(pool, slot.id);

      // Drain everything still reserved; consumed seats stay occupied by design.
      const remaining = await pool.query<{ order_id: string }>(
        `SELECT order_id FROM slot_reservations
          WHERE slot_id = $1 AND status = 'reserved'`,
        [slot.id],
      );
      for (const entry of remaining.rows) {
        await withTx(pool, (client) =>
          availability.releaseReservation(client, fx.tenantId, entry.order_id),
        );
      }
      const consumedTotal = await pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM slot_reservations
          WHERE slot_id = $1 AND status = 'consumed'`,
        [slot.id],
      );
      await assertReconciled(
        pool,
        slot.id,
        Number(consumedTotal.rows[0].total),
      );
    });

    it('moves reservations into a limited target up to its capacity in parallel', async () => {
      const fx = await createFixture(pool);
      const source = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '10:00',
        end: '11:00',
        capacity: 5,
      });
      const target = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '12:00',
        end: '13:00',
        capacity: 2,
      });
      const orders: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const orderId = await newOrder(pool, fx, source.id);
        orders.push(orderId);
        await withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            source.id,
            source.version,
            orderId,
          ),
        );
      }
      assert.equal((await readSlot(pool, source.id)).reserved_count, 3);

      const results = await Promise.allSettled(
        orders.map((orderId) =>
          withTx(pool, (client) =>
            availability.moveReservation(
              client,
              fx.tenantId,
              orderId,
              target.id,
              target.version,
            ),
          ),
        ),
      );
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult[];
      assert.equal(fulfilled.length, 2, 'target capacity is 2');
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0].reason instanceof ConflictException);
      assert.match((rejected[0].reason as Error).message, /full/);

      assert.equal((await readSlot(pool, source.id)).reserved_count, 1);
      assert.equal((await readSlot(pool, target.id)).reserved_count, 2);
      assert.equal((await readSlot(pool, source.id)).version, source.version);
      assert.equal((await readSlot(pool, target.id)).version, target.version);
      await assertReconciled(pool, source.id, 1);
      await assertReconciled(pool, target.id, 2);
    });
  },
);

interface Fixture {
  id: string;
  campusId: string;
  tenantId: string;
  tenant2Id: string;
  ownerId: string;
  buyerId: string;
  localDate: string;
  todayLocal: string;
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
  const tenantId = (
    await pool.query<{ id: string }>(
      `INSERT INTO tenants (campus_id, name, location, status)
       VALUES ($1, $2, 'Kantin Uji', 'open') RETURNING id`,
      [campusId, `Tenant ${id}`],
    )
  ).rows[0].id;
  const tenant2Id = (
    await pool.query<{ id: string }>(
      `INSERT INTO tenants (campus_id, name, location, status)
       VALUES ($1, $2, 'Kantin Uji', 'open') RETURNING id`,
      [campusId, `Tenant2 ${id}`],
    )
  ).rows[0].id;
  const insertUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'INSERT INTO users (display_name) VALUES ($1) RETURNING id',
        [`${name} ${id}`],
      )
    ).rows[0].id;
  const ownerId = await insertUser('Owner');
  const buyerId = await insertUser('Buyer');
  await pool.query(
    `INSERT INTO tenant_memberships
       (tenant_id, user_id, role, permissions, status, owner_verified_at)
     VALUES ($1, $2, 'owner', '{}', 'active', now())`,
    [tenantId, ownerId],
  );
  await pool.query(
    `INSERT INTO tenant_operating_hours
       (tenant_id, weekday, is_open, opens_at, closes_at, updated_at)
     SELECT $1, g, true, '00:00:00'::time, '23:59:59'::time, now()
       FROM generate_series(0, 6) AS g`,
    [tenantId],
  );
  return {
    id,
    campusId,
    tenantId,
    tenant2Id,
    ownerId,
    buyerId,
    localDate: jakartaLocalDate(2),
    todayLocal: jakartaLocalDate(0),
  };
}

interface SlotFixture {
  id: string;
  capacity: number;
  reserved_count: number;
  status: 'open' | 'closed';
  version: number;
  starts_at_text: string;
  ends_at_text: string;
}

async function insertSlot(
  pool: Pool,
  tenantId: string,
  options: {
    localDate: string;
    start?: string;
    end?: string;
    capacity?: number;
    reserved?: number;
    status?: 'open' | 'closed';
  },
): Promise<SlotFixture> {
  const result = await pool.query<SlotFixture>(
    `INSERT INTO pickup_slots
       (tenant_id, starts_at, ends_at, capacity, reserved_count, status)
     VALUES ($1,
       (($2::date + $3::time)::timestamp AT TIME ZONE 'Asia/Jakarta'),
       (($2::date + $4::time)::timestamp AT TIME ZONE 'Asia/Jakarta'),
       $5, $6, $7)
     RETURNING id, capacity, reserved_count, status, version,
       to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at_text,
       to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at_text`,
    [
      tenantId,
      options.localDate,
      options.start ?? '10:00',
      options.end ?? '11:00',
      options.capacity ?? 5,
      options.reserved ?? 0,
      options.status ?? 'open',
    ],
  );
  return result.rows[0];
}

/**
 * Minimal REAL orders row: 0007 adds FK slot_reservations.order_id ->
 * orders(id), so reserve requires an existing order. Satisfies
 * orders_tenant_slot_fk (slot of the same tenant), orders_positive_totals_check
 * (subtotal = total > 0) and orders_order_number_uq (unique test number).
 */
async function newOrder(
  pool: Pool,
  fx: Fixture,
  slotId: string,
): Promise<string> {
  const id = randomUUID();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO orders (id, order_number, buyer_id, tenant_id, pickup_slot_id,
       tenant_name_snapshot, tenant_timezone_snapshot,
       pickup_starts_at, pickup_ends_at, status, currency,
       subtotal_minor, total_minor)
     SELECT $1, $2, $3, $4, ps.id, t.name, c.timezone, ps.starts_at,
            ps.ends_at, 'paid_awaiting_tenant', 'IDR', 1000, 1000
       FROM pickup_slots ps
       JOIN tenants t ON t.id = ps.tenant_id
       JOIN campuses c ON c.id = t.campus_id
      WHERE ps.id = $5 AND ps.tenant_id = $4
     RETURNING id`,
    [id, `TST-${id.slice(0, 8)}`, fx.buyerId, fx.tenantId, slotId],
  );
  if (!result.rows[0]) {
    throw new Error('order fixture requires an existing slot of the tenant');
  }
  return result.rows[0].id;
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

async function readSlot(pool: Pool, slotId: string) {
  const result = await pool.query<{
    capacity: number;
    reserved_count: number;
    status: 'open' | 'closed';
    version: number;
  }>(
    'SELECT capacity, reserved_count, status, version FROM pickup_slots WHERE id = $1',
    [slotId],
  );
  return result.rows[0];
}

async function readReservation(pool: Pool, orderId: string) {
  const result = await pool.query<{
    id: string;
    status: string;
    released_at: string | null;
    consumed_at: string | null;
  }>(
    `SELECT id, status,
            to_char(released_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS released_at,
            to_char(consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS consumed_at
       FROM slot_reservations WHERE order_id = $1`,
    [orderId],
  );
  return result.rows[0];
}

/**
 * Seats occupied against capacity (final root-approved formula): a 'consumed'
 * reservation (handover done) keeps its seat; only 'released' returns it.
 * Invariant: reserved_count = COUNT(status IN ('reserved','consumed')).
 */
async function countOccupiedSeats(pool: Pool, slotId: string): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM slot_reservations
      WHERE slot_id = $1 AND status IN ('reserved', 'consumed')`,
    [slotId],
  );
  return Number(result.rows[0].total);
}

async function assertReconciled(
  pool: Pool,
  slotId: string,
  expected?: number,
): Promise<void> {
  const row = await readSlot(pool, slotId);
  const occupiedRows = await countOccupiedSeats(pool, slotId);
  assert.equal(
    row.reserved_count,
    occupiedRows,
    'reserved_count must equal COUNT(slot_reservations status IN reserved,consumed)',
  );
  if (expected !== undefined) assert.equal(row.reserved_count, expected);
  assert.ok(row.reserved_count >= 0 && row.reserved_count <= row.capacity);
}
