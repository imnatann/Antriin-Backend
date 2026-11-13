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
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AvailabilityService } from '../src/modules/availability/availability.service';
import { TenantOperatingHoursService } from '../src/modules/tenants/tenant-operating-hours.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const MICRO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

describe(
  'Availability slot management and reservation lifecycle (PostgreSQL)',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let availability: AvailabilityService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 24 });
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

    it('creates slots through the authorized flow and enforces window rules', async () => {
      const fx = await createFixture(pool);
      const startsAt = `${fx.localDate}T10:00:00+07:00`;
      const endsAt = `${fx.localDate}T11:00:00+07:00`;
      const created = await availability.createSlot(fx.ownerId, fx.tenantId, {
        startsAt,
        endsAt,
        capacity: 4,
        reason: '  Slot uji baru  ',
      });
      assert.equal(created.data.capacity, 4);
      assert.equal(created.data.reservedCount, 0);
      assert.equal(created.data.status, 'open');
      assert.equal(created.data.version, 1);
      // D7: timestamps are DB-generated microsecond strings.
      assert.match(created.data.startsAt, MICRO_TS);
      assert.match(created.data.endsAt, MICRO_TS);
      const audits = await readAudit(pool, created.data.id);
      assert.equal(audits.length, 1);
      assert.equal(audits[0].action, 'tenant.availability.slot.created');
      assert.equal(audits[0].actor_user_id, fx.ownerId);
      assert.equal(audits[0].reason, 'Slot uji baru', 'reason must be trimmed');
      assert.equal(audits[0].metadata.capacity, 4);

      await assert.rejects(
        availability.createSlot(fx.ownerId, fx.tenantId, {
          startsAt,
          endsAt,
          capacity: 9,
        }),
        (error: unknown) =>
          error instanceof ConflictException &&
          /same window already exists/.test(messageOf(error)) &&
          contractCodeOf(error) === 'SLOT_WINDOW_CONFLICT',
      );
      await assert.rejects(
        availability.createSlot(fx.ownerId, fx.tenantId, {
          startsAt: endsAt,
          endsAt: startsAt,
          capacity: 2,
        }),
        BadRequestException,
      );
      await assert.rejects(
        availability.createSlot(fx.ownerId, fx.tenantId, {
          startsAt,
          endsAt,
          capacity: 0,
        }),
        BadRequestException,
      );
      await assert.rejects(
        availability.createSlot(fx.ownerId, fx.tenantId, {
          startsAt: '2020-01-01T03:00:00Z',
          endsAt: '2020-01-01T04:00:00Z',
          capacity: 2,
        }),
        BadRequestException,
      );
      await assert.rejects(
        availability.createSlot(fx.ownerId, fx.tenantId, {
          startsAt: `${fx.localDate} 10:00`,
          endsAt,
          capacity: 2,
        }),
        BadRequestException,
      );
      await assert.rejects(
        availability.createSlot(fx.ownerId, fx.tenantId, {
          startsAt: `${fx.localDate}T12:00:00+07:00`,
          endsAt: `${fx.localDate}T13:00:00+07:00`,
          capacity: 2,
          reason: 'x'.repeat(301),
        }),
        BadRequestException,
      );
      await assert.rejects(
        availability.createSlot(fx.ownerId, fx.tenantId, {
          startsAt: `${fx.localDate}T12:00:00+07:00`,
          endsAt: `${fx.localDate}T13:00:00+07:00`,
          capacity: 2,
          reason: '   ',
        }),
        BadRequestException,
      );
    });

    it('maps a reservation for a missing orders row to REFERENCE_CONFLICT (FK 0007)', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        capacity: 2,
      });
      // No orders row exists for this orderId -> FK slot_reservations_order_fk
      // rejects the INSERT and the mapper must return a stable 409 contract
      // code instead of a raw 23503/500 (orders-slice retry logic keys on it).
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            slot.id,
            slot.version,
            randomUUID(),
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          contractCodeOf(error) === 'REFERENCE_CONFLICT' &&
          /missing order or slot/.test(messageOf(error)),
      );
      const row = await readSlot(pool, slot.id);
      assert.equal(
        row.reserved_count,
        0,
        'failed reserve must not consume a seat',
      );
      assert.equal(row.version, slot.version);
    });

    it('rejects slots outside operating hours using the D8 read contract', async () => {
      const fx = await createFixture(pool);
      await pool.query(
        `INSERT INTO tenant_operating_hour_overrides
           (tenant_id, local_date, is_closed, updated_at)
         VALUES ($1, $2::date, true, now())`,
        [fx.tenantId, fx.localDate],
      );
      await assert.rejects(
        availability.createSlot(fx.ownerId, fx.tenantId, {
          startsAt: `${fx.localDate}T10:00:00+07:00`,
          endsAt: `${fx.localDate}T11:00:00+07:00`,
          capacity: 2,
        }),
        (error: unknown) =>
          error instanceof BadRequestException &&
          /operating hours/.test(messageOf(error)),
      );
      const slot = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
      });
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            slot.id,
            slot.version,
            randomUUID(),
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /outside operating hours/.test(messageOf(error)),
      );
    });

    it('guards updateSlot with version, capacity floor, reason and reopen rules', async () => {
      const fx = await createFixture(pool);
      const slot = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        capacity: 3,
      });
      await assert.rejects(
        availability.updateSlot(fx.ownerId, fx.tenantId, slot.id, {
          expectedVersion: 1,
        }),
        BadRequestException,
      );
      // Capacity increase: no reason needed, bumps version, writes no audit.
      const grown = await availability.updateSlot(
        fx.ownerId,
        fx.tenantId,
        slot.id,
        { capacity: 5, expectedVersion: 1 },
      );
      assert.equal(grown.data.version, 2);
      assert.equal(grown.data.capacity, 5);
      assert.equal((await readAudit(pool, slot.id)).length, 0);
      await assert.rejects(
        availability.updateSlot(fx.ownerId, fx.tenantId, slot.id, {
          capacity: 6,
          expectedVersion: 1,
        }),
        (error: unknown) =>
          error instanceof ConflictException &&
          /refresh and retry/.test(messageOf(error)),
      );

      // Fill two seats through real orders (FK 0007); reserves keep version.
      const orderA = await newOrder(pool, fx, slot.id);
      const orderB = await newOrder(pool, fx, slot.id);
      await withTx(pool, (client) =>
        availability.reserveForCheckout(
          client,
          fx.tenantId,
          slot.id,
          2,
          orderA,
        ),
      );
      await withTx(pool, (client) =>
        availability.reserveForCheckout(
          client,
          fx.tenantId,
          slot.id,
          2,
          orderB,
        ),
      );
      let row = await readSlot(pool, slot.id);
      assert.equal(row.reserved_count, 2);
      assert.equal(row.version, 2, 'reserve must not bump the config version');

      // Capacity below reserved orders -> 409 (before the reason rule).
      await assert.rejects(
        availability.updateSlot(fx.ownerId, fx.tenantId, slot.id, {
          capacity: 1,
          expectedVersion: 2,
        }),
        (error: unknown) =>
          error instanceof ConflictException &&
          /below reserved orders/.test(messageOf(error)),
      );
      // Capacity reduction without reason -> 400.
      await assert.rejects(
        availability.updateSlot(fx.ownerId, fx.tenantId, slot.id, {
          capacity: 2,
          expectedVersion: 2,
        }),
        (error: unknown) =>
          error instanceof BadRequestException &&
          /reason/.test(messageOf(error)),
      );
      const shrunk = await availability.updateSlot(
        fx.ownerId,
        fx.tenantId,
        slot.id,
        { capacity: 2, expectedVersion: 2, reason: 'Kapasitas disesuaikan' },
      );
      assert.equal(shrunk.data.version, 3);
      assert.equal(shrunk.data.capacity, 2);
      assert.equal(shrunk.data.reservedCount, 2);

      // Close requires a reason; reopen validates the window again.
      await assert.rejects(
        availability.updateSlot(fx.ownerId, fx.tenantId, slot.id, {
          status: 'closed',
          expectedVersion: 3,
        }),
        (error: unknown) =>
          error instanceof BadRequestException &&
          /reason/.test(messageOf(error)),
      );
      const closed = await availability.updateSlot(
        fx.ownerId,
        fx.tenantId,
        slot.id,
        { status: 'closed', expectedVersion: 3, reason: 'Bahan habis' },
      );
      assert.equal(closed.data.status, 'closed');
      assert.equal(closed.data.version, 4);
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            slot.id,
            4,
            randomUUID(),
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /unavailable/.test(messageOf(error)),
      );
      const reopened = await availability.updateSlot(
        fx.ownerId,
        fx.tenantId,
        slot.id,
        { status: 'open', expectedVersion: 4 },
      );
      assert.equal(reopened.data.version, 5);
      row = await readSlot(pool, slot.id);
      assert.equal(row.reserved_count, 2);

      // Audit trail: capacity_reduced + closed + reopened, actor from session.
      const audits = await readAudit(pool, slot.id);
      assert.deepEqual(
        audits.map((entry) => entry.action),
        [
          'tenant.availability.slot.capacity_reduced',
          'tenant.availability.slot.closed',
          'tenant.availability.slot.reopened',
        ],
      );
      assert.equal(
        audits.every((entry) => entry.actor_user_id === fx.ownerId),
        true,
      );
      assert.equal(
        audits.every((entry) => entry.scope_type === 'tenant'),
        true,
      );
      assert.equal(audits[0].reason, 'Kapasitas disesuaikan');
      assert.equal(audits[0].metadata.previousCapacity, 5);
      assert.equal(audits[0].metadata.capacity, 2);
      assert.equal(audits[0].metadata.activeReservations, 2);
      assert.equal(audits[1].reason, 'Bahan habis');
      assert.equal(audits[1].metadata.activeReservations, 2);
      assert.equal(audits[2].reason, 'Pickup slot reopened');

      // Reopening a slot that already started is rejected.
      const started = await insertSlot(pool, fx.tenantId, {
        localDate: fx.todayLocal,
        start: '00:00',
        end: '23:59',
      });
      await availability.updateSlot(fx.ownerId, fx.tenantId, started.id, {
        status: 'closed',
        expectedVersion: started.version,
        reason: 'Tutup untuk uji reopen',
      });
      await assert.rejects(
        availability.updateSlot(fx.ownerId, fx.tenantId, started.id, {
          status: 'open',
          expectedVersion: started.version + 1,
        }),
        (error: unknown) =>
          error instanceof ConflictException &&
          /already started/.test(messageOf(error)),
      );
    });

    it('enforces tenant.capacity.manage and tenant scope on management actions', async () => {
      const fx = await createFixture(pool);
      const input = {
        startsAt: `${fx.localDate}T10:00:00+07:00`,
        endsAt: `${fx.localDate}T11:00:00+07:00`,
        capacity: 2,
      };
      const byStaff = await availability.createSlot(
        fx.staffId,
        fx.tenantId,
        input,
      );
      assert.equal(byStaff.data.capacity, 2);
      const staffAudit = await readAudit(pool, byStaff.data.id);
      assert.equal(staffAudit[0].actor_user_id, fx.staffId);
      assert.equal(
        staffAudit[0].reason,
        'Pickup slot created',
        'create without reason falls back to the default audit reason',
      );
      await assert.rejects(
        availability.createSlot(fx.staffNoCapId, fx.tenantId, {
          ...input,
          startsAt: `${fx.localDate}T12:00:00+07:00`,
          endsAt: `${fx.localDate}T13:00:00+07:00`,
        }),
        ForbiddenException,
      );
      await assert.rejects(
        availability.createSlot(fx.outsiderId, fx.tenantId, input),
        ForbiddenException,
      );
      await assert.rejects(
        availability.createSlot(fx.owner2Id, fx.tenantId, input),
        ForbiddenException,
      );
      await assert.rejects(
        availability.updateSlot(fx.owner2Id, fx.tenantId, byStaff.data.id, {
          capacity: 9,
          expectedVersion: 1,
        }),
        ForbiddenException,
      );
      await assert.rejects(
        availability.listManagedSlots(fx.owner2Id, fx.tenantId, {
          from: fx.localDate,
          to: fx.localDate,
        }),
        ForbiddenException,
      );
      await assert.rejects(
        availability.listManagedSlots(fx.staffNoCapId, fx.tenantId, {
          from: fx.localDate,
          to: fx.localDate,
        }),
        ForbiddenException,
      );
      const managed = await availability.listManagedSlots(
        fx.staffId,
        fx.tenantId,
        { from: fx.localDate, to: fx.localDate },
      );
      assert.equal(managed.data.slots.length, 1);
    });

    it('lists bookable slots for buyers scoped to tenant and local-date range', async () => {
      const fx = await createFixture(pool);
      const nextLocal = jakartaLocalDate(3);
      const open = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        capacity: 2,
      });
      const full = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '12:00',
        end: '13:00',
        capacity: 1,
        reserved: 1,
      });
      const closed = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '14:00',
        end: '15:00',
        capacity: 3,
        status: 'closed',
      });
      const past = await insertSlot(pool, fx.tenantId, {
        localDate: fx.todayLocal,
        start: '00:00',
        end: '23:59',
        capacity: 3,
      });
      const otherTenant = await insertSlot(pool, fx.tenant2Id, {
        localDate: fx.localDate,
        capacity: 4,
      });
      const nextDay = await insertSlot(pool, fx.tenantId, {
        localDate: nextLocal,
        capacity: 1,
      });

      const single = await availability.listAvailability(fx.tenantId, {
        date: fx.localDate,
      });
      assert.equal(single.data.tenantId, fx.tenantId);
      assert.equal(single.data.timezone, 'Asia/Jakarta');
      assert.equal(single.data.status, 'open');
      assert.deepEqual(single.data.range, {
        from: fx.localDate,
        to: fx.localDate,
      });
      assert.deepEqual(
        single.data.slots.map((slot) => slot.id),
        [open.id],
      );
      assert.equal(single.data.slots[0].localDate, fx.localDate);
      assert.equal(single.data.slots[0].remainingCapacity, 2);
      assert.equal(single.data.slots[0].version, 1);
      assert.match(single.data.slots[0].startsAt, MICRO_TS);

      const ranged = await availability.listAvailability(fx.tenantId, {
        from: fx.localDate,
        to: nextLocal,
      });
      assert.deepEqual(
        ranged.data.slots.map((slot) => slot.id),
        [open.id, nextDay.id],
      );

      await assert.rejects(
        availability.listAvailability(fx.tenantId, {
          date: fx.localDate,
          from: fx.localDate,
          to: fx.localDate,
        }),
        BadRequestException,
      );
      await assert.rejects(
        availability.listAvailability(fx.tenantId, { from: fx.localDate }),
        BadRequestException,
      );
      await assert.rejects(
        availability.listAvailability(fx.tenantId, {}),
        BadRequestException,
      );
      await assert.rejects(
        availability.listAvailability(fx.tenantId, {
          from: nextLocal,
          to: fx.localDate,
        }),
        BadRequestException,
      );
      await assert.rejects(
        availability.listAvailability(fx.tenantId, {
          from: fx.localDate,
          to: jakartaLocalDate(40),
        }),
        BadRequestException,
      );
      await assert.rejects(
        availability.listAvailability(fx.tenantId, { date: '2026-13-45' }),
        BadRequestException,
      );
      await assert.rejects(
        availability.listAvailability(randomUUID(), { date: fx.localDate }),
        NotFoundException,
      );

      await pool.query(`UPDATE tenants SET status = 'paused' WHERE id = $1`, [
        fx.tenantId,
      ]);
      const paused = await availability.listAvailability(fx.tenantId, {
        date: fx.localDate,
      });
      assert.equal(paused.data.status, 'paused');
      assert.deepEqual(paused.data.slots, []);
      void full;
      void closed;
      void past;
      void otherTenant;
    });

    it('lists managed slots including closed and full ones for authorized staff', async () => {
      const fx = await createFixture(pool);
      const open = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        capacity: 2,
      });
      const closed = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '12:00',
        end: '13:00',
        capacity: 1,
        status: 'closed',
      });
      const full = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '14:00',
        end: '15:00',
        capacity: 1,
        reserved: 1,
      });
      await insertSlot(pool, fx.tenant2Id, { localDate: fx.localDate });

      const managed = await availability.listManagedSlots(
        fx.ownerId,
        fx.tenantId,
        { from: fx.localDate, to: fx.localDate },
      );
      assert.equal(managed.data.timezone, 'Asia/Jakarta');
      const byId = new Map(
        managed.data.slots.map((slot) => [slot.id, slot] as const),
      );
      assert.equal(managed.data.slots.length, 3);
      assert.equal(byId.get(open.id)?.status, 'open');
      assert.equal(byId.get(closed.id)?.status, 'closed');
      assert.equal(byId.get(full.id)?.reservedCount, 1);
      assert.equal(byId.get(full.id)?.remainingCapacity, 0);
      assert.match(byId.get(open.id)!.updatedAt, MICRO_TS);
      assert.equal(
        managed.data.slots.every((slot) => slot.localDate === fx.localDate),
        true,
      );
      await assert.rejects(
        availability.listManagedSlots(fx.ownerId, fx.tenantId, {
          from: fx.localDate,
          to: jakartaLocalDate(120),
        }),
        BadRequestException,
      );
    });

    it('rejects reserve for closed, past, paused, full, stale-version and cross-tenant slots', async () => {
      const fx = await createFixture(pool);
      const closed = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        capacity: 2,
        status: 'closed',
      });
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            closed.id,
            closed.version,
            randomUUID(),
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /unavailable/.test(messageOf(error)),
      );

      const past = await insertSlot(pool, fx.tenantId, {
        localDate: fx.todayLocal,
        start: '00:00',
        end: '23:59',
      });
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            past.id,
            past.version,
            randomUUID(),
          ),
        ),
        ConflictException,
      );

      const small = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '15:00',
        end: '16:00',
        capacity: 1,
      });
      const firstOrder = await newOrder(pool, fx, small.id);
      const first = await withTx(pool, (client) =>
        availability.reserveForCheckout(
          client,
          fx.tenantId,
          small.id,
          small.version,
          firstOrder,
        ),
      );
      assert.equal(first.reservedCount, 1);
      // Rejected before the reservation INSERT (slot full), so no orders row
      // is needed for this attempt.
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            small.id,
            small.version,
            randomUUID(),
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException && /full/.test(messageOf(error)),
      );

      const stale = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '17:00',
        end: '18:00',
        capacity: 3,
      });
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            stale.id,
            stale.version + 41,
            randomUUID(),
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /request a new quote/.test(messageOf(error)),
      );

      const foreign = await insertSlot(pool, fx.tenant2Id, {
        localDate: fx.localDate,
      });
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            foreign.id,
            foreign.version,
            randomUUID(),
          ),
        ),
        NotFoundException,
      );
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            foreign.id,
            foreign.version,
            'not-a-uuid',
          ),
        ),
        BadRequestException,
      );

      const pauseSlot = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '19:00',
        end: '20:00',
      });
      await pool.query(`UPDATE tenants SET status = 'paused' WHERE id = $1`, [
        fx.tenantId,
      ]);
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            pauseSlot.id,
            pauseSlot.version,
            randomUUID(),
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /unavailable/.test(messageOf(error)),
      );
    });

    it('release restores capacity once, stamps released_at and rejects replays', async () => {
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
      assert.equal((await readSlot(pool, slot.id)).reserved_count, 1);

      const released = await withTx(pool, (client) =>
        availability.releaseReservation(client, fx.tenantId, orderId),
      );
      assert.equal(released, true);
      let row = await readSlot(pool, slot.id);
      assert.equal(row.reserved_count, 0);
      assert.equal(row.version, slot.version, 'release must not bump version');
      let reservation = await readReservation(pool, orderId);
      assert.equal(reservation.status, 'released');
      assert.ok(
        reservation.released_at !== null &&
          MICRO_TS.test(reservation.released_at),
        'released_at must be stamped with microsecond precision',
      );
      assert.equal(reservation.consumed_at, null);
      assert.match(reservation.updated_at, MICRO_TS);
      const firstReleasedAt = reservation.released_at;

      const replay = await withTx(pool, (client) =>
        availability.releaseReservation(client, fx.tenantId, orderId),
      );
      assert.equal(replay, false);
      row = await readSlot(pool, slot.id);
      assert.equal(row.reserved_count, 0);
      reservation = await readReservation(pool, orderId);
      assert.equal(reservation.released_at, firstReleasedAt);

      await assert.rejects(
        withTx(pool, (client) =>
          availability.consumeReservation(client, fx.tenantId, orderId),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /Released reservation cannot be consumed/.test(messageOf(error)),
      );

      const order2 = await newOrder(pool, fx, slot.id);
      await withTx(pool, (client) =>
        availability.reserveForCheckout(
          client,
          fx.tenantId,
          slot.id,
          slot.version,
          order2,
        ),
      );
      await assert.rejects(
        withTx(pool, (client) =>
          availability.releaseReservation(client, fx.tenant2Id, order2),
        ),
        NotFoundException,
      );
      await assert.rejects(
        withTx(pool, (client) =>
          availability.releaseReservation(client, fx.tenantId, randomUUID()),
        ),
        NotFoundException,
      );
      assert.equal((await readSlot(pool, slot.id)).reserved_count, 1);

      // R2-11: replaying reserve for a released reservation gives an
      // actionable conflict, not the misleading "another slot" message.
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            slot.id,
            slot.version,
            orderId,
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /was released; create a new checkout/.test(messageOf(error)),
      );

      // The released_at CHECK constraint is enforced by PostgreSQL itself.
      await assert.rejects(
        pool.query(
          `UPDATE slot_reservations SET released_at = NULL WHERE order_id = $1`,
          [orderId],
        ),
        (error: unknown) => pgCodeOf(error) === '23514',
      );
    });

    it('consume only from reserved, stamps consumed_at, is idempotent and keeps the seat', async () => {
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
      const consumed = await withTx(pool, (client) =>
        availability.consumeReservation(client, fx.tenantId, orderId),
      );
      assert.equal(consumed, true);
      let reservation = await readReservation(pool, orderId);
      assert.equal(reservation.status, 'consumed');
      assert.equal(reservation.released_at, null);
      assert.ok(
        reservation.consumed_at !== null &&
          MICRO_TS.test(reservation.consumed_at),
        'consumed_at must be stamped (0007 two-way CHECK)',
      );
      assert.match(reservation.updated_at, MICRO_TS);
      assert.equal(
        (await readSlot(pool, slot.id)).reserved_count,
        1,
        'consume must keep the seat occupied',
      );

      const replay = await withTx(pool, (client) =>
        availability.consumeReservation(client, fx.tenantId, orderId),
      );
      assert.equal(replay, false);
      reservation = await readReservation(pool, orderId);
      assert.equal(reservation.status, 'consumed');

      // R2-11: reserve replay on a consumed reservation is an explicit conflict.
      await assert.rejects(
        withTx(pool, (client) =>
          availability.reserveForCheckout(
            client,
            fx.tenantId,
            slot.id,
            slot.version,
            orderId,
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /already consumed/.test(messageOf(error)),
      );

      await assert.rejects(
        withTx(pool, (client) =>
          availability.releaseReservation(client, fx.tenantId, orderId),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /Consumed reservation cannot be released/.test(messageOf(error)),
      );
      await assert.rejects(
        withTx(pool, (client) =>
          availability.consumeReservation(client, fx.tenantId, randomUUID()),
        ),
        NotFoundException,
      );
      await assert.rejects(
        withTx(pool, (client) =>
          availability.consumeReservation(client, fx.tenant2Id, orderId),
        ),
        NotFoundException,
      );
      assert.equal((await readSlot(pool, slot.id)).reserved_count, 1);

      // The consumed_at CHECK constraint is enforced by PostgreSQL itself.
      await assert.rejects(
        pool.query(
          `UPDATE slot_reservations SET consumed_at = NULL WHERE order_id = $1`,
          [orderId],
        ),
        (error: unknown) => pgCodeOf(error) === '23514',
      );
    });

    it('moveReservation moves capacity atomically within the tenant only', async () => {
      const fx = await createFixture(pool);
      const source = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '10:00',
        end: '11:00',
        capacity: 3,
      });
      const targetFull = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '12:00',
        end: '13:00',
        capacity: 1,
      });
      const targetOpen = await insertSlot(pool, fx.tenantId, {
        localDate: fx.localDate,
        start: '14:00',
        end: '15:00',
        capacity: 2,
      });
      const foreign = await insertSlot(pool, fx.tenant2Id, {
        localDate: fx.localDate,
        start: '16:00',
        end: '17:00',
      });

      const orderMove = await newOrder(pool, fx, source.id);
      const orderFiller = await newOrder(pool, fx, targetFull.id);
      await withTx(pool, (client) =>
        availability.reserveForCheckout(
          client,
          fx.tenantId,
          source.id,
          source.version,
          orderMove,
        ),
      );
      await withTx(pool, (client) =>
        availability.reserveForCheckout(
          client,
          fx.tenantId,
          targetFull.id,
          targetFull.version,
          orderFiller,
        ),
      );

      // Target full -> rejected and the source seat is untouched (atomicity).
      await assert.rejects(
        withTx(pool, (client) =>
          availability.moveReservation(
            client,
            fx.tenantId,
            orderMove,
            targetFull.id,
            targetFull.version,
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException && /full/.test(messageOf(error)),
      );
      assert.equal((await readSlot(pool, source.id)).reserved_count, 1);
      assert.equal((await readSlot(pool, targetFull.id)).reserved_count, 1);

      // Stale target version -> proposal-friendly conflict.
      const edited = await availability.updateSlot(
        fx.ownerId,
        fx.tenantId,
        targetOpen.id,
        { capacity: 4, expectedVersion: targetOpen.version },
      );
      await assert.rejects(
        withTx(pool, (client) =>
          availability.moveReservation(
            client,
            fx.tenantId,
            orderMove,
            targetOpen.id,
            targetOpen.version,
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /request a new proposal/.test(messageOf(error)),
      );
      assert.equal((await readSlot(pool, source.id)).reserved_count, 1);
      assert.equal((await readSlot(pool, targetOpen.id)).reserved_count, 0);

      // Successful move with the fresh version.
      const moved = await withTx(pool, (client) =>
        availability.moveReservation(
          client,
          fx.tenantId,
          orderMove,
          targetOpen.id,
          edited.data.version,
        ),
      );
      assert.equal(moved.slotId, targetOpen.id);
      assert.equal(moved.reservationId.length > 0, true);
      assert.equal((await readSlot(pool, source.id)).reserved_count, 0);
      assert.equal((await readSlot(pool, targetOpen.id)).reserved_count, 1);
      assert.equal(
        (await readSlot(pool, targetOpen.id)).version,
        edited.data.version,
        'capacity moves must not bump version',
      );
      const movedReservation = await readReservation(pool, orderMove);
      assert.equal(movedReservation.slot_id, targetOpen.id);
      assert.match(movedReservation.updated_at, MICRO_TS);

      // Replaying the same move is a no-op success.
      const replayed = await withTx(pool, (client) =>
        availability.moveReservation(
          client,
          fx.tenantId,
          orderMove,
          targetOpen.id,
          edited.data.version,
        ),
      );
      assert.equal(replayed.reservationId, moved.reservationId);
      assert.equal((await readSlot(pool, source.id)).reserved_count, 0);
      assert.equal((await readSlot(pool, targetOpen.id)).reserved_count, 1);

      // Cross-tenant target -> 404 and the reservation does not move.
      await assert.rejects(
        withTx(pool, (client) =>
          availability.moveReservation(
            client,
            fx.tenantId,
            orderMove,
            foreign.id,
            foreign.version,
          ),
        ),
        NotFoundException,
      );
      // Wrong tenant scope for the reservation itself -> 404.
      await assert.rejects(
        withTx(pool, (client) =>
          availability.moveReservation(
            client,
            fx.tenant2Id,
            orderMove,
            targetOpen.id,
            edited.data.version,
          ),
        ),
        NotFoundException,
      );
      assert.equal(
        (await readReservation(pool, orderMove)).slot_id,
        targetOpen.id,
      );

      // Released reservations cannot move.
      await withTx(pool, (client) =>
        availability.releaseReservation(client, fx.tenantId, orderMove),
      );
      await assert.rejects(
        withTx(pool, (client) =>
          availability.moveReservation(
            client,
            fx.tenantId,
            orderMove,
            source.id,
            source.version,
          ),
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          /Only active reservations can move/.test(messageOf(error)),
      );
      assert.equal((await readSlot(pool, targetOpen.id)).reserved_count, 0);
      assert.equal((await readSlot(pool, source.id)).reserved_count, 0);
    });
  },
);

interface Fixture {
  id: string;
  campusId: string;
  tenantId: string;
  tenant2Id: string;
  ownerId: string;
  owner2Id: string;
  staffId: string;
  staffNoCapId: string;
  outsiderId: string;
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
  const ownerId = await insertUser('Owner');
  const owner2Id = await insertUser('Owner2');
  const staffId = await insertUser('StaffCapacity');
  const staffNoCapId = await insertUser('StaffNoCapacity');
  const outsiderId = await insertUser('Outsider');
  const buyerId = await insertUser('Buyer');
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
     VALUES ($1, $2, 'kitchen', '{tenant.capacity.manage}', 'active')`,
    [tenantId, staffId],
  );
  await pool.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status)
     VALUES ($1, $2, 'kitchen', '{tenant.orders.read}', 'active')`,
    [tenantId, staffNoCapId],
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
  return {
    id,
    campusId,
    tenantId,
    tenant2Id,
    ownerId,
    owner2Id,
    staffId,
    staffNoCapId,
    outsiderId,
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
 * orders_tenant_slot_fk (slot of the same tenant) and
 * orders_positive_totals_check (subtotal = total > 0). Wave-2 checkout must
 * INSERT the order BEFORE calling reserveForCheckout in the same transaction.
 */
async function insertOrder(
  pool: Pool,
  order: { id: string; buyerId: string; tenantId: string; slotId: string },
): Promise<string> {
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
    [
      order.id,
      `TST-${order.id.slice(0, 8)}`,
      order.buyerId,
      order.tenantId,
      order.slotId,
    ],
  );
  if (!result.rows[0]) {
    throw new Error('order fixture requires an existing slot of the tenant');
  }
  return result.rows[0].id;
}

async function newOrder(
  pool: Pool,
  fx: Fixture,
  slotId: string,
): Promise<string> {
  return insertOrder(pool, {
    id: randomUUID(),
    buyerId: fx.buyerId,
    tenantId: fx.tenantId,
    slotId,
  });
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
    tenant_id: string;
    slot_id: string;
    status: string;
    released_at: string | null;
    consumed_at: string | null;
    updated_at: string;
  }>(
    `SELECT id, tenant_id, slot_id, status,
            to_char(released_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS released_at,
            to_char(consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS consumed_at,
            to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
       FROM slot_reservations WHERE order_id = $1`,
    [orderId],
  );
  return result.rows[0];
}

async function readAudit(pool: Pool, targetId: string) {
  const result = await pool.query<{
    action: string;
    actor_user_id: string | null;
    scope_type: string;
    scope_id: string;
    target_type: string;
    target_id: string;
    reason: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT action, actor_user_id, scope_type, scope_id, target_type,
            target_id, reason, metadata
       FROM audit_events WHERE target_id = $1
      ORDER BY occurred_at, id`,
    [targetId],
  );
  return result.rows;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Stable contract code carried in the body of mapped ConflictExceptions. */
function contractCodeOf(error: unknown): string | undefined {
  if (!(error instanceof ConflictException)) return undefined;
  const response = error.getResponse();
  return typeof response === 'object' && response !== null && 'code' in response
    ? String((response as { code?: unknown }).code)
    : undefined;
}

function pgCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
