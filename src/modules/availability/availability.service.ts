import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';

export type TenantAvailabilityStatus = 'open' | 'closed' | 'paused';

export interface SlotQuoteContext {
  slotId: string;
  startsAt: string;
  endsAt: string;
  version: number;
  remainingCapacity: number;
  timezone: string;
}

export interface SlotReservation {
  reservationId: string;
  orderId: string;
  slotId: string;
  startsAt: string;
  endsAt: string;
  version: number;
  reservedCount: number;
}

export interface OperatingHoursEntry {
  weekday: number;
  isOpen: boolean;
  opensAt?: string;
  closesAt?: string;
}

export interface OperatingHourOverride {
  isClosed: boolean;
  opensAt?: string;
  closesAt?: string;
  reason?: string;
}

interface SlotRow {
  id: string;
  tenant_id: string;
  starts_at: Date;
  ends_at: Date;
  capacity: number;
  reserved_count: number;
  status: 'open' | 'closed';
  version: number;
  tenant_status: string;
  campus_status: string;
  timezone: string;
}

interface LocalDateTime {
  date: string;
  weekday: number;
  time: string;
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
  ) {}

  async assertBookableSlot(
    client: PoolClient,
    tenantId: string,
    slotId: string,
    lock: 'share' | 'update' = 'share',
  ): Promise<SlotQuoteContext> {
    const tenant = await this.lockTenantContext(client, tenantId);
    const lockSql = lock === 'update' ? 'FOR UPDATE OF ps' : 'FOR SHARE OF ps';
    const result = await client.query<SlotRow>(
      `SELECT ps.id, ps.tenant_id, ps.starts_at, ps.ends_at, ps.capacity,
              ps.reserved_count, ps.status, ps.version
         FROM pickup_slots ps
        WHERE ps.id = $1 AND ps.tenant_id = $2
        ${lockSql}`,
      [slotId, tenantId],
    );
    const slot = result.rows[0];
    if (!slot) throw new NotFoundException('Pickup slot not found');
    slot.tenant_status = tenant.status;
    slot.campus_status = tenant.campus_status;
    slot.timezone = tenant.timezone;
    if (
      slot.status !== 'open' ||
      slot.tenant_status !== 'open' ||
      slot.campus_status !== 'active' ||
      slot.starts_at.getTime() <= Date.now()
    ) {
      throw new ConflictException('Pickup slot is unavailable');
    }
    if (slot.reserved_count >= slot.capacity) {
      throw new ConflictException('Pickup slot is full');
    }
    if (!(await this.slotFitsOperatingHours(client, slot, true))) {
      throw new ConflictException('Pickup slot is outside operating hours');
    }
    return {
      slotId: slot.id,
      startsAt: slot.starts_at.toISOString(),
      endsAt: slot.ends_at.toISOString(),
      version: slot.version,
      remainingCapacity: slot.capacity - slot.reserved_count,
      timezone: slot.timezone,
    };
  }

  async listAvailability(tenantId: string, localDate: string) {
    this.assertLocalDate(localDate);
    const tenantResult = await this.database.pool.query<{
      id: string;
      name: string;
      location: string;
      status: TenantAvailabilityStatus | 'archived';
      timezone: string;
      campus_status: string;
    }>(
      `SELECT t.id, t.name, t.location, t.status, c.timezone,
              c.status AS campus_status
         FROM tenants t JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND t.status <> 'archived' AND c.status = 'active'`,
      [tenantId],
    );
    const tenant = tenantResult.rows[0];
    if (!tenant) throw new NotFoundException('Tenant not found');
    if (tenant.status !== 'open') {
      return {
        data: {
          tenantId,
          status: tenant.status,
          timezone: tenant.timezone,
          slots: [],
        },
      };
    }
    const slots = await this.database.pool.query<{
      id: string;
      starts_at: Date;
      ends_at: Date;
      capacity: number;
      reserved_count: number;
      version: number;
    }>(
      `SELECT id, starts_at, ends_at, capacity, reserved_count, version
         FROM pickup_slots
        WHERE tenant_id = $1 AND status = 'open'
          AND starts_at > now() AND reserved_count < capacity
          AND (starts_at AT TIME ZONE $3)::date = $2::date
        ORDER BY starts_at, id LIMIT 200`,
      [tenantId, localDate, tenant.timezone],
    );
    const available = [];
    for (const slot of slots.rows) {
      const fits = await this.slotFitsOperatingHours(
        undefined,
        {
          ...slot,
          tenant_id: tenantId,
          timezone: tenant.timezone,
        },
        false,
      );
      if (fits) {
        available.push({
          id: slot.id,
          startsAt: slot.starts_at.toISOString(),
          endsAt: slot.ends_at.toISOString(),
          remainingCapacity: slot.capacity - slot.reserved_count,
          version: slot.version,
        });
      }
    }
    return {
      data: {
        tenantId,
        status: tenant.status,
        timezone: tenant.timezone,
        slots: available,
      },
    };
  }

  async createSlot(
    actorUserId: string,
    tenantId: string,
    input: { startsAt: string; endsAt: string; capacity: number },
  ) {
    const startsAt = this.parseFutureDate(input.startsAt, 'startsAt');
    const endsAt = this.parseFutureDate(input.endsAt, 'endsAt');
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('endsAt must be after startsAt');
    }
    if (!Number.isSafeInteger(input.capacity) || input.capacity < 1) {
      throw new BadRequestException('capacity must be a positive integer');
    }
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.capacity.manage',
        client,
      );
      const candidate = {
        starts_at: startsAt,
        ends_at: endsAt,
        timezone: await this.getTimezone(client, tenantId),
      } as SlotRow;
      if (!(await this.slotFitsOperatingHours(client, candidate, true))) {
        throw new BadRequestException(
          'Pickup slot must fit within local operating hours',
        );
      }
      const result = await client.query<{
        id: string;
        starts_at: Date;
        ends_at: Date;
        capacity: number;
        version: number;
      }>(
        `INSERT INTO pickup_slots (tenant_id, starts_at, ends_at, capacity, updated_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING id, starts_at, ends_at, capacity, version`,
        [
          tenantId,
          startsAt.toISOString(),
          endsAt.toISOString(),
          input.capacity,
        ],
      );
      const slot = result.rows[0];
      return {
        data: {
          id: slot.id,
          tenantId,
          startsAt: slot.starts_at.toISOString(),
          endsAt: slot.ends_at.toISOString(),
          capacity: slot.capacity,
          reservedCount: 0,
          version: slot.version,
        },
      };
    });
  }

  async updateSlot(
    actorUserId: string,
    tenantId: string,
    slotId: string,
    input: {
      capacity?: number;
      status?: 'open' | 'closed';
      expectedVersion: number;
    },
  ) {
    if (
      input.capacity !== undefined &&
      (!Number.isSafeInteger(input.capacity) || input.capacity < 1)
    ) {
      throw new BadRequestException('capacity must be a positive integer');
    }
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.capacity.manage',
        client,
      );
      const current = await client.query<{
        id: string;
        capacity: number;
        reserved_count: number;
        status: 'open' | 'closed';
        version: number;
      }>(
        `SELECT id, capacity, reserved_count, status, version
           FROM pickup_slots WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, slotId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Pickup slot not found');
      if (row.version !== input.expectedVersion) {
        throw new ConflictException('Pickup slot changed');
      }
      const capacity = input.capacity ?? row.capacity;
      if (capacity < row.reserved_count) {
        throw new ConflictException('Capacity cannot be below reserved orders');
      }
      const status = input.status ?? row.status;
      if (status === 'open' && row.status !== 'open') {
        const slotInfo = await client.query<{
          starts_at: Date;
          ends_at: Date;
        }>(`SELECT starts_at, ends_at FROM pickup_slots WHERE id = $1`, [
          slotId,
        ]);
        const timezone = await this.getTimezone(client, tenantId);
        if (
          !(await this.slotFitsOperatingHours(
            client,
            {
              starts_at: slotInfo.rows[0].starts_at,
              ends_at: slotInfo.rows[0].ends_at,
              timezone,
              tenant_id: tenantId,
            },
            true,
          ))
        ) {
          throw new ConflictException('Pickup slot is outside operating hours');
        }
      }
      const result = await client.query<{
        capacity: number;
        status: string;
        version: number;
      }>(
        `UPDATE pickup_slots
            SET capacity = $3, status = $4, version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND version = $5
          RETURNING capacity, status, version`,
        [tenantId, slotId, capacity, status, input.expectedVersion],
      );
      if (result.rowCount !== 1)
        throw new ConflictException('Pickup slot changed');
      return { data: { id: slotId, ...result.rows[0] } };
    });
  }

  async reserveForCheckout(
    client: PoolClient,
    tenantId: string,
    slotId: string,
    expectedVersion: number,
    orderId: string,
  ): Promise<SlotReservation> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        orderId,
      )
    ) {
      throw new BadRequestException('Invalid order id');
    }
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [orderId],
    );
    const existing = await client.query<{
      id: string;
      tenant_id: string;
      slot_id: string;
      status: string;
    }>(
      `SELECT id, tenant_id, slot_id, status
         FROM slot_reservations WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    );
    if (existing.rows[0]) {
      const reservation = existing.rows[0];
      if (
        reservation.tenant_id !== tenantId ||
        reservation.slot_id !== slotId ||
        reservation.status !== 'reserved'
      ) {
        throw new ConflictException(
          'Order already has another slot reservation',
        );
      }
      const current = await client.query<{
        starts_at: Date;
        ends_at: Date;
        version: number;
        reserved_count: number;
      }>(
        `SELECT starts_at, ends_at, version, reserved_count
           FROM pickup_slots WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
        [tenantId, slotId],
      );
      if (!current.rows[0])
        throw new NotFoundException('Pickup slot not found');
      return {
        reservationId: reservation.id,
        orderId,
        slotId,
        startsAt: current.rows[0].starts_at.toISOString(),
        endsAt: current.rows[0].ends_at.toISOString(),
        version: current.rows[0].version,
        reservedCount: current.rows[0].reserved_count,
      };
    }

    const slot = await this.assertBookableSlot(
      client,
      tenantId,
      slotId,
      'update',
    );
    if (slot.version !== expectedVersion) {
      throw new ConflictException('Pickup slot changed; request a new quote');
    }
    const updated = await client.query<{
      reserved_count: number;
      version: number;
    }>(
      `UPDATE pickup_slots SET reserved_count = reserved_count + 1,
              version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND version = $3
          AND status = 'open' AND reserved_count < capacity
        RETURNING reserved_count, version`,
      [tenantId, slotId, expectedVersion],
    );
    if (updated.rowCount !== 1)
      throw new ConflictException('Pickup slot is full or changed');
    const reservation = await client.query<{ id: string }>(
      `INSERT INTO slot_reservations (tenant_id, slot_id, order_id, status)
       VALUES ($1, $2, $3, 'reserved') RETURNING id`,
      [tenantId, slotId, orderId],
    );
    return {
      reservationId: reservation.rows[0].id,
      orderId,
      slotId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      version: updated.rows[0].version,
      reservedCount: updated.rows[0].reserved_count,
    };
  }

  async releaseReservation(
    client: PoolClient,
    orderId: string,
  ): Promise<boolean> {
    const result = await client.query<{
      id: string;
      tenant_id: string;
      slot_id: string;
      status: string;
    }>(
      `SELECT id, tenant_id, slot_id, status
         FROM slot_reservations WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    );
    const reservation = result.rows[0];
    if (!reservation || reservation.status !== 'reserved') return false;
    const slot = await client.query<{ reserved_count: number }>(
      `SELECT reserved_count FROM pickup_slots
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [reservation.tenant_id, reservation.slot_id],
    );
    if (!slot.rows[0] || slot.rows[0].reserved_count < 1) {
      throw new ConflictException('Pickup slot reservation is inconsistent');
    }
    await client.query(
      `UPDATE pickup_slots SET reserved_count = reserved_count - 1,
              version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [reservation.tenant_id, reservation.slot_id],
    );
    await client.query(
      `UPDATE slot_reservations SET status = 'released', released_at = now()
        WHERE id = $1 AND status = 'reserved'`,
      [reservation.id],
    );
    return true;
  }

  async moveReservation(
    client: PoolClient,
    tenantId: string,
    orderId: string,
    newSlotId: string,
    expectedNewSlotVersion: number,
  ): Promise<SlotReservation> {
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(orderId) || !uuidPattern.test(newSlotId)) {
      throw new BadRequestException('Invalid reservation reference');
    }
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [orderId],
    );
    const result = await client.query<{
      id: string;
      tenant_id: string;
      slot_id: string;
      status: string;
    }>(
      `SELECT id, tenant_id, slot_id, status
         FROM slot_reservations WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    );
    const reservation = result.rows[0];
    if (!reservation || reservation.tenant_id !== tenantId) {
      throw new NotFoundException('Slot reservation not found');
    }
    if (reservation.status !== 'reserved') {
      throw new ConflictException('Only active reservations can move');
    }
    if (reservation.slot_id === newSlotId) {
      const same = await client.query<{
        starts_at: Date;
        ends_at: Date;
        version: number;
        reserved_count: number;
      }>(
        `SELECT starts_at, ends_at, version, reserved_count
           FROM pickup_slots WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
        [tenantId, newSlotId],
      );
      if (!same.rows[0]) throw new NotFoundException('Pickup slot not found');
      return {
        reservationId: reservation.id,
        orderId,
        slotId: newSlotId,
        startsAt: same.rows[0].starts_at.toISOString(),
        endsAt: same.rows[0].ends_at.toISOString(),
        version: same.rows[0].version,
        reservedCount: same.rows[0].reserved_count,
      };
    }

    await this.lockTenantContext(client, tenantId);
    const lockedSlots = await client.query<{ id: string }>(
      `SELECT id FROM pickup_slots
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id FOR UPDATE`,
      [tenantId, [reservation.slot_id, newSlotId]],
    );
    if (lockedSlots.rowCount !== 2) {
      throw new NotFoundException('Pickup slot not found');
    }
    const target = await this.assertBookableSlot(
      client,
      tenantId,
      newSlotId,
      'update',
    );
    if (target.version !== expectedNewSlotVersion) {
      throw new ConflictException(
        'Pickup slot changed; request a new proposal',
      );
    }
    const old = await client.query<{ reserved_count: number }>(
      `SELECT reserved_count FROM pickup_slots
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, reservation.slot_id],
    );
    if (!old.rows[0] || old.rows[0].reserved_count < 1) {
      throw new ConflictException('Pickup slot reservation is inconsistent');
    }
    const oldUpdate = await client.query(
      `UPDATE pickup_slots SET reserved_count = reserved_count - 1,
              version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND reserved_count > 0`,
      [tenantId, reservation.slot_id],
    );
    if (oldUpdate.rowCount !== 1) {
      throw new ConflictException('Pickup slot reservation is inconsistent');
    }
    const newUpdate = await client.query<{
      reserved_count: number;
      version: number;
    }>(
      `UPDATE pickup_slots SET reserved_count = reserved_count + 1,
              version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND version = $3
          AND status = 'open' AND reserved_count < capacity
        RETURNING reserved_count, version`,
      [tenantId, newSlotId, expectedNewSlotVersion],
    );
    if (newUpdate.rowCount !== 1) {
      throw new ConflictException('Pickup slot is full or changed');
    }
    await client.query(
      'UPDATE slot_reservations SET slot_id = $2 WHERE id = $1',
      [reservation.id, newSlotId],
    );
    return {
      reservationId: reservation.id,
      orderId,
      slotId: newSlotId,
      startsAt: target.startsAt,
      endsAt: target.endsAt,
      version: newUpdate.rows[0].version,
      reservedCount: newUpdate.rows[0].reserved_count,
    };
  }

  async consumeReservation(
    client: PoolClient,
    orderId: string,
  ): Promise<boolean> {
    const result = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM slot_reservations WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    );
    const reservation = result.rows[0];
    if (!reservation) throw new NotFoundException('Slot reservation not found');
    if (reservation.status === 'consumed') return false;
    if (reservation.status !== 'reserved') {
      throw new ConflictException('Released reservation cannot be consumed');
    }
    await client.query(
      `UPDATE slot_reservations SET status = 'consumed'
        WHERE id = $1 AND status = 'reserved'`,
      [reservation.id],
    );
    return true;
  }

  async listOperatingHours(tenantId: string) {
    const tenant = await this.database.pool.query<{ timezone: string }>(
      `SELECT c.timezone FROM tenants t JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND t.status <> 'archived' AND c.status = 'active'`,
      [tenantId],
    );
    if (!tenant.rows[0]) throw new NotFoundException('Tenant not found');
    const hours = await this.database.pool.query<{
      weekday: number;
      is_open: boolean;
      opens_at: string | null;
      closes_at: string | null;
    }>(
      `SELECT weekday, is_open, opens_at, closes_at
         FROM tenant_operating_hours WHERE tenant_id = $1 ORDER BY weekday`,
      [tenantId],
    );
    const overrides = await this.database.pool.query<{
      local_date: string;
      is_closed: boolean;
      opens_at: string | null;
      closes_at: string | null;
      reason: string;
    }>(
      `SELECT local_date::text, is_closed, opens_at, closes_at, reason
         FROM tenant_operating_hour_overrides
        WHERE tenant_id = $1 AND local_date >= (now() AT TIME ZONE $2)::date
        ORDER BY local_date LIMIT 90`,
      [tenantId, tenant.rows[0].timezone],
    );
    return {
      data: {
        tenantId,
        timezone: tenant.rows[0].timezone,
        weekly: hours.rows,
        overrides: overrides.rows,
      },
    };
  }

  async replaceOperatingHours(
    actorUserId: string,
    tenantId: string,
    entries: readonly OperatingHoursEntry[],
  ) {
    this.validateWeeklyHours(entries);
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.capacity.manage',
        client,
      );
      // Serialize schedule edits with slot quoting and reservation.
      await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [
        tenantId,
      ]);
      await client.query(
        'DELETE FROM tenant_operating_hours WHERE tenant_id = $1',
        [tenantId],
      );
      for (const entry of entries) {
        await client.query(
          `INSERT INTO tenant_operating_hours
             (tenant_id, weekday, is_open, opens_at, closes_at, updated_at)
           VALUES ($1, $2, $3, $4::time, $5::time, now())`,
          [
            tenantId,
            entry.weekday,
            entry.isOpen,
            entry.isOpen ? entry.opensAt : null,
            entry.isOpen ? entry.closesAt : null,
          ],
        );
      }
      return this.listOperatingHoursUsing(client, tenantId);
    });
  }

  async setOperatingHourOverride(
    actorUserId: string,
    tenantId: string,
    localDate: string,
    input: OperatingHourOverride,
  ) {
    this.assertLocalDate(localDate);
    this.validateOverride(input);
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.capacity.manage',
        client,
      );
      await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [
        tenantId,
      ]);
      const result = await client.query(
        `INSERT INTO tenant_operating_hour_overrides
           (tenant_id, local_date, is_closed, opens_at, closes_at, reason, updated_at)
         VALUES ($1, $2::date, $3, $4::time, $5::time, $6, now())
         ON CONFLICT (tenant_id, local_date) DO UPDATE
           SET is_closed = EXCLUDED.is_closed, opens_at = EXCLUDED.opens_at,
               closes_at = EXCLUDED.closes_at, reason = EXCLUDED.reason, updated_at = now()
         RETURNING local_date::text, is_closed, opens_at, closes_at, reason`,
        [
          tenantId,
          localDate,
          input.isClosed,
          input.isClosed ? null : input.opensAt,
          input.isClosed ? null : input.closesAt,
          (input.reason ?? '').trim(),
        ],
      );
      return { data: result.rows[0] };
    });
  }

  async removeOperatingHourOverride(
    actorUserId: string,
    tenantId: string,
    localDate: string,
  ) {
    this.assertLocalDate(localDate);
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.capacity.manage',
        client,
      );
      await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [
        tenantId,
      ]);
      const result = await client.query(
        `DELETE FROM tenant_operating_hour_overrides
          WHERE tenant_id = $1 AND local_date = $2::date RETURNING local_date::text`,
        [tenantId, localDate],
      );
      if (result.rowCount !== 1) {
        throw new NotFoundException('Operating hour override not found');
      }
      return { data: { tenantId, localDate, removed: true } };
    });
  }

  async updateTenantStatus(
    actorUserId: string,
    tenantId: string,
    input: {
      status: TenantAvailabilityStatus;
      expectedUpdatedAt: string;
    },
  ) {
    const permission =
      input.status === 'paused'
        ? 'tenant.orders.pause'
        : 'tenant.capacity.manage';
    return this.withTransaction(async (client) => {
      const access = await this.access.requireTenant(
        actorUserId,
        tenantId,
        permission,
        client,
      );
      const result = await client.query<{
        status: TenantAvailabilityStatus;
        updated_at: Date;
      }>(
        `UPDATE tenants SET status = $3, updated_at = now()
          WHERE id = $1 AND campus_id = $2 AND status <> 'archived'
            AND updated_at = $4::timestamptz
          RETURNING status, updated_at`,
        [tenantId, access.campusId, input.status, input.expectedUpdatedAt],
      );
      if (!result.rows[0]) {
        throw new ConflictException('Tenant status changed');
      }
      return {
        data: {
          tenantId,
          status: result.rows[0].status,
          updatedAt: result.rows[0].updated_at.toISOString(),
        },
      };
    });
  }

  private async listOperatingHoursUsing(client: PoolClient, tenantId: string) {
    const [tenant, hours, overrides] = await Promise.all([
      client.query<{ timezone: string }>(
        `SELECT c.timezone FROM tenants t JOIN campuses c ON c.id = t.campus_id WHERE t.id = $1`,
        [tenantId],
      ),
      client.query(
        `SELECT weekday, is_open, opens_at, closes_at FROM tenant_operating_hours WHERE tenant_id = $1 ORDER BY weekday`,
        [tenantId],
      ),
      client.query(
        `SELECT local_date::text, is_closed, opens_at, closes_at, reason FROM tenant_operating_hour_overrides WHERE tenant_id = $1 ORDER BY local_date LIMIT 90`,
        [tenantId],
      ),
    ]);
    return {
      data: {
        tenantId,
        timezone: tenant.rows[0].timezone,
        weekly: hours.rows,
        overrides: overrides.rows,
      },
    };
  }

  private validateWeeklyHours(entries: readonly OperatingHoursEntry[]): void {
    if (
      entries.length !== 7 ||
      new Set(entries.map((entry) => entry.weekday)).size !== 7 ||
      entries.some(
        (entry) =>
          !Number.isInteger(entry.weekday) ||
          entry.weekday < 0 ||
          entry.weekday > 6,
      )
    ) {
      throw new BadRequestException(
        'Weekly schedule must define each weekday once',
      );
    }
    for (const entry of entries) {
      if (entry.isOpen) {
        if (
          !this.isLocalTime(entry.opensAt) ||
          !this.isLocalTime(entry.closesAt) ||
          entry.opensAt! >= entry.closesAt!
        ) {
          throw new BadRequestException(
            'Open days require a valid opening window',
          );
        }
      }
    }
  }

  private validateOverride(input: OperatingHourOverride): void {
    const reason = input.reason?.trim() ?? '';
    if (reason.length > 300)
      throw new BadRequestException('reason is too long');
    if (
      !input.isClosed &&
      (!this.isLocalTime(input.opensAt) ||
        !this.isLocalTime(input.closesAt) ||
        input.opensAt! >= input.closesAt!)
    ) {
      throw new BadRequestException(
        'Open overrides require a valid opening window',
      );
    }
  }

  private isLocalTime(value?: string): value is string {
    return (
      typeof value === 'string' &&
      /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)
    );
  }

  private async slotFitsOperatingHours(
    client: PoolClient | undefined,
    slot: Pick<SlotRow, 'starts_at' | 'ends_at' | 'timezone' | 'tenant_id'>,
    lock: boolean,
  ): Promise<boolean> {
    const start = this.localDateTime(slot.starts_at, slot.timezone);
    const end = this.localDateTime(slot.ends_at, slot.timezone);
    if (start.date !== end.date || start.time >= end.time) return false;
    const query = client
      ? client.query.bind(client)
      : this.database.pool.query.bind(this.database.pool);
    const lockSql = client && lock ? 'FOR SHARE' : '';
    const override = await query<{
      is_closed: boolean;
      opens_at: string | null;
      closes_at: string | null;
    }>(
      `SELECT is_closed, opens_at, closes_at
         FROM tenant_operating_hour_overrides
        WHERE tenant_id = $1 AND local_date = $2::date ${lockSql}`,
      [slot.tenant_id, start.date],
    );
    let opensAt: string | null;
    let closesAt: string | null;
    if (override.rows[0]) {
      if (override.rows[0].is_closed) return false;
      opensAt = override.rows[0].opens_at;
      closesAt = override.rows[0].closes_at;
    } else {
      const hours = await query<{
        is_open: boolean;
        opens_at: string | null;
        closes_at: string | null;
      }>(
        `SELECT is_open, opens_at, closes_at
           FROM tenant_operating_hours
          WHERE tenant_id = $1 AND weekday = $2 ${lockSql}`,
        [slot.tenant_id, start.weekday],
      );
      if (!hours.rows[0]?.is_open) return false;
      opensAt = hours.rows[0].opens_at;
      closesAt = hours.rows[0].closes_at;
    }
    return Boolean(
      opensAt && closesAt && start.time >= opensAt && end.time <= closesAt,
    );
  }

  private async lockTenantContext(client: PoolClient, tenantId: string) {
    const result = await client.query<{
      status: string;
      campus_status: string;
      timezone: string;
    }>(
      `SELECT t.status, c.status AS campus_status, c.timezone
         FROM tenants t JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND t.status <> 'archived'
        FOR SHARE OF t, c`,
      [tenantId],
    );
    const row = result.rows[0];
    if (!row || row.campus_status !== 'active') {
      throw new NotFoundException('Tenant not found');
    }
    return {
      status: row.status,
      campus_status: row.campus_status,
      timezone: row.timezone,
    };
  }

  private localDateTime(date: Date, timezone: string): LocalDateTime {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date);
      const values = Object.fromEntries(
        parts.map((part) => [part.type, part.value]),
      );
      const weekdays: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
      };
      return {
        date: `${values.year}-${values.month}-${values.day}`,
        weekday: weekdays[values.weekday],
        time: `${values.hour}:${values.minute}:${values.second}`,
      };
    } catch {
      throw new BadRequestException('Tenant timezone is invalid');
    }
  }

  private async getTimezone(
    client: PoolClient,
    tenantId: string,
  ): Promise<string> {
    const result = await client.query<{ timezone: string }>(
      `SELECT c.timezone FROM tenants t JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND c.status = 'active'`,
      [tenantId],
    );
    if (!result.rows[0]) throw new NotFoundException('Tenant not found');
    return result.rows[0].timezone;
  }

  private parseFutureDate(value: string, field: string): Date {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
      throw new BadRequestException(`${field} must be a future timestamp`);
    }
    return date;
  }

  private assertLocalDate(value: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException('date must use YYYY-MM-DD format');
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    ) {
      throw new BadRequestException('date is invalid');
    }
  }

  private async withTransaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
