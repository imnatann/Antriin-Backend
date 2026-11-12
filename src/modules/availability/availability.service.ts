import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { TenantOperatingHoursService } from '../tenants/tenant-operating-hours.service';

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

export interface SlotListQuery {
  date?: string;
  from?: string;
  to?: string;
}

export interface AvailableSlotView {
  id: string;
  startsAt: string;
  endsAt: string;
  localDate: string;
  remainingCapacity: number;
  version: number;
}

export interface ManagedSlotView {
  id: string;
  startsAt: string;
  endsAt: string;
  localDate: string;
  capacity: number;
  reservedCount: number;
  remainingCapacity: number;
  status: 'open' | 'closed';
  version: number;
  updatedAt: string;
}

interface SlotRow {
  id: string;
  tenant_id: string;
  starts_at: Date;
  ends_at: Date;
  starts_at_text: string;
  ends_at_text: string;
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;
const MAX_BUYER_RANGE_DAYS = 31;
const MAX_MANAGED_RANGE_DAYS = 92;
const BUYER_SLOT_LIMIT = 200;
const MANAGED_SLOT_LIMIT = 500;
// D7: timestamps that clients may echo back are emitted by PostgreSQL with
// microsecond precision; never re-serialize them through new Date().
const TS = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// Audit actions for management decisions that affect buyer commitments
// (root decision 12 Nov 2026). Names must match AuditService's action
// pattern ^[a-z][a-z0-9._-]{0,99}$ and are written in the same transaction.
const AUDIT = {
  slotCreated: 'tenant.availability.slot.created',
  slotClosed: 'tenant.availability.slot.closed',
  slotReopened: 'tenant.availability.slot.reopened',
  slotCapacityReduced: 'tenant.availability.slot.capacity_reduced',
} as const;
const MAX_REASON_LENGTH = 300;

/**
 * Pickup slot capacity and reservation rules (tables pickup_slots and
 * slot_reservations) for tenant staff, buyers and the orders/checkout flow.
 *
 * Concurrency contract (root decision D3, docs/reviews/wave1-decisions.md):
 * - `pickup_slots.version` is a CONFIGURATION version. Only management
 *   actions (updateSlot: capacity/status) increment it.
 * - reserve/release/consume/moveReservation mutate `reserved_count` under
 *   `SELECT ... FOR UPDATE` plus conditional updates and never bump version,
 *   so a quoted version stays valid while seats remain. Oversell is prevented
 *   by the row lock, the `reserved_count < capacity` guard and the database
 *   CHECK `reserved_count BETWEEN 0 AND capacity`.
 * - All mutating reservation calls take the caller's PoolClient so they join
 *   the surrounding checkout/cancel/proposal transaction, and are keyed by
 *   orderId (unique index slot_reservations_order_unique), making replays of
 *   the same order idempotent.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly operatingHours: TenantOperatingHoursService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Validates that a slot can still take a reservation and returns the quote
   * context (also consumed by CatalogService.quote).
   *
   * Lock modes (root decision 12 Nov 2026, reviewer evidence: quote 'share'
   * then reserve FOR UPDATE on the same row deadlocks 40P01 under parallel
   * checkouts — 8 parallel = 7 deadlocks):
   * - 'none' (DEFAULT, quote/read paths): plain SELECT, no row locks at all.
   *   Validation only; the result is a point-in-time snapshot, never an
   *   authority for capacity.
   * - 'share': FOR SHARE on tenant/campus + slot; for callers that must pin
   *   the row without mutating it and will NOT upgrade to UPDATE later in the
   *   same transaction.
   * - 'update': FOR UPDATE on the slot row; the SINGLE authority for capacity
   *   mutations (reserveForCheckout / moveReservation call this).
   */
  async assertBookableSlot(
    client: PoolClient,
    tenantId: string,
    slotId: string,
    lock: 'none' | 'share' | 'update' = 'none',
  ): Promise<SlotQuoteContext> {
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(slotId, 'slot id');
    const tenant = await this.lockTenantContext(
      client,
      tenantId,
      lock !== 'none',
    );
    const lockSql =
      lock === 'update'
        ? 'FOR UPDATE OF ps'
        : lock === 'share'
          ? 'FOR SHARE OF ps'
          : '';
    const result = await client.query<SlotRow>(
      `SELECT ps.id, ps.tenant_id, ps.starts_at, ps.ends_at, ps.capacity,
              ps.reserved_count, ps.status, ps.version,
              ${TS('ps.starts_at')} AS starts_at_text,
              ${TS('ps.ends_at')} AS ends_at_text
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
    if (!(await this.slotFitsOperatingHours(client, slot))) {
      throw new ConflictException('Pickup slot is outside operating hours');
    }
    return {
      slotId: slot.id,
      startsAt: slot.starts_at_text,
      endsAt: slot.ends_at_text,
      version: slot.version,
      remainingCapacity: slot.capacity - slot.reserved_count,
      timezone: slot.timezone,
    };
  }

  /**
   * Public buyer read: slots that are open, start in the future, still have
   * capacity and fit the tenant operating hours, for a local-date range in the
   * tenant timezone. Scoped to one non-archived tenant on an active campus.
   */
  async listAvailability(tenantId: string, query: SlotListQuery) {
    this.assertUuid(tenantId, 'tenant id');
    const range = this.resolveLocalDateRange(query, MAX_BUYER_RANGE_DAYS);
    const tenantResult = await this.database.pool.query<{
      id: string;
      name: string;
      location: string;
      status: string;
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
      // Paused/closed tenants expose no bookable slots but stay discoverable.
      return {
        data: {
          tenantId,
          status: tenant.status,
          timezone: tenant.timezone,
          range,
          slots: [] as AvailableSlotView[],
        },
      };
    }
    const slots = await this.database.pool.query<{
      id: string;
      starts_at: Date;
      ends_at: Date;
      starts_at_text: string;
      ends_at_text: string;
      capacity: number;
      reserved_count: number;
      version: number;
      local_date: string;
    }>(
      `SELECT id, starts_at, ends_at, capacity, reserved_count, version,
              ${TS('starts_at')} AS starts_at_text,
              ${TS('ends_at')} AS ends_at_text,
              (starts_at AT TIME ZONE $4)::date::text AS local_date
         FROM pickup_slots
        WHERE tenant_id = $1 AND status = 'open'
          AND starts_at > now() AND reserved_count < capacity
          AND starts_at >= ($2::date::timestamp AT TIME ZONE $4)
          AND starts_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
        ORDER BY starts_at, id LIMIT ${BUYER_SLOT_LIMIT}`,
      [tenantId, range.from, range.to, tenant.timezone],
    );
    const available: AvailableSlotView[] = [];
    for (const slot of slots.rows) {
      const fits = await this.slotFitsOperatingHours(undefined, {
        ...slot,
        tenant_id: tenantId,
        timezone: tenant.timezone,
      });
      if (fits) {
        available.push({
          id: slot.id,
          startsAt: slot.starts_at_text,
          endsAt: slot.ends_at_text,
          localDate: slot.local_date,
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
        range,
        slots: available,
      },
    };
  }

  /**
   * Tenant-staff management list: every slot (open, closed or full) whose
   * start falls in the local-date range, with capacity counters. Requires
   * `tenant.capacity.manage` (D10).
   */
  async listManagedSlots(
    actorUserId: string,
    tenantId: string,
    query: SlotListQuery,
  ) {
    this.assertUuid(tenantId, 'tenant id');
    const range = this.resolveLocalDateRange(query, MAX_MANAGED_RANGE_DAYS);
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      'tenant.capacity.manage',
    );
    const tenant = await this.database.pool.query<{ timezone: string }>(
      `SELECT c.timezone FROM tenants t JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND t.status <> 'archived' AND c.status = 'active'`,
      [tenantId],
    );
    if (!tenant.rows[0]) throw new NotFoundException('Tenant not found');
    const timezone = tenant.rows[0].timezone;
    const slots = await this.database.pool.query<{
      id: string;
      starts_at_text: string;
      ends_at_text: string;
      capacity: number;
      reserved_count: number;
      status: 'open' | 'closed';
      version: number;
      updated_at_text: string;
      local_date: string;
    }>(
      `SELECT id, capacity, reserved_count, status, version,
              ${TS('starts_at')} AS starts_at_text,
              ${TS('ends_at')} AS ends_at_text,
              ${TS('updated_at')} AS updated_at_text,
              (starts_at AT TIME ZONE $4)::date::text AS local_date
         FROM pickup_slots
        WHERE tenant_id = $1
          AND starts_at >= ($2::date::timestamp AT TIME ZONE $4)
          AND starts_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
        ORDER BY starts_at, id LIMIT ${MANAGED_SLOT_LIMIT}`,
      [tenantId, range.from, range.to, timezone],
    );
    return {
      data: {
        tenantId,
        timezone,
        range,
        slots: slots.rows.map<ManagedSlotView>((slot) => ({
          id: slot.id,
          startsAt: slot.starts_at_text,
          endsAt: slot.ends_at_text,
          localDate: slot.local_date,
          capacity: slot.capacity,
          reservedCount: slot.reserved_count,
          remainingCapacity: slot.capacity - slot.reserved_count,
          status: slot.status,
          version: slot.version,
          updatedAt: slot.updated_at_text,
        })),
      },
    };
  }

  async createSlot(
    actorUserId: string,
    tenantId: string,
    input: {
      startsAt: string;
      endsAt: string;
      capacity: number;
      reason?: string;
    },
  ) {
    this.assertUuid(tenantId, 'tenant id');
    const reason = this.optionalReason(input.reason);
    const startsAt = this.parseFutureInstant(input.startsAt, 'startsAt');
    const endsAt = this.parseFutureInstant(input.endsAt, 'endsAt');
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
        tenant_id: tenantId,
        timezone: await this.getTimezone(client, tenantId),
      } as SlotRow;
      if (!(await this.slotFitsOperatingHours(client, candidate))) {
        throw new BadRequestException(
          'Pickup slot must fit within local operating hours',
        );
      }
      let result;
      try {
        result = await client.query<{
          id: string;
          starts_at_text: string;
          ends_at_text: string;
          capacity: number;
          version: number;
        }>(
          `INSERT INTO pickup_slots (tenant_id, starts_at, ends_at, capacity, updated_at)
           VALUES ($1, $2, $3, $4, now())
           RETURNING id, ${TS('starts_at')} AS starts_at_text,
                     ${TS('ends_at')} AS ends_at_text, capacity, version`,
          [
            tenantId,
            startsAt.toISOString(),
            endsAt.toISOString(),
            input.capacity,
          ],
        );
      } catch (error) {
        throw this.mapSlotWriteError(error);
      }
      const slot = result.rows[0];
      await this.audit.append(client, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: AUDIT.slotCreated,
        targetType: 'pickup_slot',
        targetId: slot.id,
        reason: reason ?? 'Pickup slot created',
        metadata: {
          capacity: slot.capacity,
          startsAt: slot.starts_at_text,
          endsAt: slot.ends_at_text,
        },
      });
      return {
        data: {
          id: slot.id,
          tenantId,
          startsAt: slot.starts_at_text,
          endsAt: slot.ends_at_text,
          capacity: slot.capacity,
          reservedCount: 0,
          status: 'open' as const,
          version: slot.version,
        },
      };
    });
  }

  /**
   * Management mutation: change capacity and/or open/close a slot with
   * optimistic concurrency on `expectedVersion` (D7.4: version is the
   * concurrency token for pickup_slots). This is the ONLY operation that
   * bumps `version`; capacity can never drop below reserved_count.
   */
  async updateSlot(
    actorUserId: string,
    tenantId: string,
    slotId: string,
    input: {
      capacity?: number;
      status?: 'open' | 'closed';
      expectedVersion: number;
      reason?: string;
    },
  ) {
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(slotId, 'slot id');
    if (input.capacity === undefined && input.status === undefined) {
      throw new BadRequestException('Provide capacity and/or status');
    }
    if (
      input.capacity !== undefined &&
      (!Number.isSafeInteger(input.capacity) || input.capacity < 1)
    ) {
      throw new BadRequestException('capacity must be a positive integer');
    }
    if (
      input.status !== undefined &&
      input.status !== 'open' &&
      input.status !== 'closed'
    ) {
      throw new BadRequestException("status must be 'open' or 'closed'");
    }
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      throw new BadRequestException(
        'expectedVersion must be a positive integer',
      );
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
        starts_at: Date;
        ends_at: Date;
        capacity: number;
        reserved_count: number;
        status: 'open' | 'closed';
        version: number;
      }>(
        `SELECT id, starts_at, ends_at, capacity, reserved_count, status, version
           FROM pickup_slots WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, slotId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Pickup slot not found');
      if (row.version !== input.expectedVersion) {
        throw new ConflictException('Pickup slot changed; refresh and retry');
      }
      const capacity = input.capacity ?? row.capacity;
      if (capacity < row.reserved_count) {
        throw new ConflictException(
          'Capacity cannot drop below reserved orders',
        );
      }
      const status = input.status ?? row.status;
      const willClose = status === 'closed' && row.status === 'open';
      const willReopen = status === 'open' && row.status !== 'open';
      const willReduceCapacity = capacity < row.capacity;
      if (willReopen) {
        if (row.starts_at.getTime() <= Date.now()) {
          throw new ConflictException('Pickup slot already started');
        }
        const timezone = await this.getTimezone(client, tenantId);
        if (
          !(await this.slotFitsOperatingHours(client, {
            ...row,
            tenant_id: tenantId,
            timezone,
          }))
        ) {
          throw new ConflictException('Pickup slot is outside operating hours');
        }
      }
      // Root decision (12 Nov 2026): closing a slot or shrinking capacity
      // affects existing buyer commitments and requires an actor-supplied
      // reason; the reason never comes from anything but the validated DTO
      // and the actor always comes from the session principal.
      const reason = this.optionalReason(input.reason);
      if ((willClose || willReduceCapacity) && !reason) {
        throw new BadRequestException(
          `A reason of 1 to ${MAX_REASON_LENGTH} characters is required to close a slot or reduce capacity`,
        );
      }
      let result;
      try {
        result = await client.query<{
          capacity: number;
          reserved_count: number;
          status: 'open' | 'closed';
          version: number;
        }>(
          `UPDATE pickup_slots
              SET capacity = $3, status = $4, version = version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND version = $5
            RETURNING capacity, reserved_count, status, version`,
          [tenantId, slotId, capacity, status, input.expectedVersion],
        );
      } catch (error) {
        throw this.mapSlotWriteError(error);
      }
      if (result.rowCount !== 1) {
        throw new ConflictException('Pickup slot changed; refresh and retry');
      }
      const updated = result.rows[0];
      const auditBase = {
        actor: { userId: actorUserId },
        scopeType: 'tenant' as const,
        scopeId: tenantId,
        targetType: 'pickup_slot',
        targetId: slotId,
      };
      if (willClose) {
        await this.audit.append(client, {
          ...auditBase,
          action: AUDIT.slotClosed,
          reason: reason!,
          metadata: { activeReservations: row.reserved_count },
        });
      }
      if (willReduceCapacity) {
        await this.audit.append(client, {
          ...auditBase,
          action: AUDIT.slotCapacityReduced,
          reason: reason!,
          metadata: {
            previousCapacity: row.capacity,
            capacity: updated.capacity,
            activeReservations: row.reserved_count,
          },
        });
      }
      if (willReopen) {
        await this.audit.append(client, {
          ...auditBase,
          action: AUDIT.slotReopened,
          reason: reason ?? 'Pickup slot reopened',
          metadata: { capacity: updated.capacity },
        });
      }
      return {
        data: {
          id: slotId,
          tenantId,
          capacity: updated.capacity,
          reservedCount: updated.reserved_count,
          status: updated.status,
          version: updated.version,
        },
      };
    });
  }

  /**
   * Reserves exactly one seat for an order inside the caller's transaction
   * (checkout joins quote, reserve, wallet debit and order creation).
   * Replay-safe: reserving the same orderId again returns the existing
   * reservation without consuming capacity twice; a different slot/tenant for
   * an already-reserved order is rejected.
   *
   * PREREQUISITE (migration 0007, FK slot_reservations_order_fk -> orders(id),
   * intentionally NOT relaxed): the orders row MUST already exist in the same
   * transaction before this call. Checkout order of operations:
   * INSERT orders -> reserveForCheckout -> wallet debit -> snapshots/events/
   * audit/outbox -> COMMIT. Takes FOR UPDATE on the slot ('update' mode) as
   * the single capacity authority; quote must have used 'none' (no lock).
   */
  async reserveForCheckout(
    client: PoolClient,
    tenantId: string,
    slotId: string,
    expectedVersion: number,
    orderId: string,
  ): Promise<SlotReservation> {
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(slotId, 'slot id');
    this.assertUuid(orderId, 'order id');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new BadRequestException(
        'expectedVersion must be a positive integer',
      );
    }
    // Serialize every mutation path for the same order (reserve/move replay).
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
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
        starts_at_text: string;
        ends_at_text: string;
        version: number;
        reserved_count: number;
      }>(
        `SELECT ${TS('starts_at')} AS starts_at_text,
                ${TS('ends_at')} AS ends_at_text,
                version, reserved_count
           FROM pickup_slots WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
        [tenantId, slotId],
      );
      if (!current.rows[0])
        throw new NotFoundException('Pickup slot not found');
      return {
        reservationId: reservation.id,
        orderId,
        slotId,
        startsAt: current.rows[0].starts_at_text,
        endsAt: current.rows[0].ends_at_text,
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
    let updated;
    try {
      updated = await client.query<{
        reserved_count: number;
        version: number;
      }>(
        // Capacity mutations never bump `version` (D3): it tracks management
        // edits (capacity/status) only, so a quoted version stays valid while
        // seats remain. Oversell is prevented by the FOR UPDATE row lock taken
        // in assertBookableSlot plus this conditional update and the DB check
        // constraint reserved_count <= capacity.
        `UPDATE pickup_slots SET reserved_count = reserved_count + 1,
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND version = $3
            AND status = 'open' AND reserved_count < capacity
          RETURNING reserved_count, version`,
        [tenantId, slotId, expectedVersion],
      );
    } catch (error) {
      throw this.mapSlotWriteError(error);
    }
    if (updated.rowCount !== 1)
      throw new ConflictException('Pickup slot is full or changed');
    let reservation;
    try {
      reservation = await client.query<{ id: string }>(
        `INSERT INTO slot_reservations (tenant_id, slot_id, order_id, status)
         VALUES ($1, $2, $3, 'reserved') RETURNING id`,
        [tenantId, slotId, orderId],
      );
    } catch (error) {
      // Lost race on slot_reservations_order_unique: a concurrent writer holds
      // the same order id; surface a replayable conflict instead of a 500.
      if (this.isUniqueViolation(error, 'slot_reservations_order_unique')) {
        throw new ConflictException(
          'Order reservation is already being created',
        );
      }
      throw error;
    }
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

  /**
   * Restores one reserved seat and marks the reservation released with
   * released_at (required by slot_reservations_released_at_check exactly when
   * status = 'released'). Returns true when this call performed the release,
   * false when the reservation was already released (idempotent replay;
   * capacity is never restored twice). Consumed reservations are rejected.
   * Scoped by tenantId (D3): a reservation of another tenant is not found.
   */
  async releaseReservation(
    client: PoolClient,
    tenantId: string,
    orderId: string,
  ): Promise<boolean> {
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(orderId, 'order id');
    const result = await client.query<{
      id: string;
      slot_id: string;
      status: string;
    }>(
      `SELECT id, slot_id, status
         FROM slot_reservations WHERE order_id = $1 AND tenant_id = $2 FOR UPDATE`,
      [orderId, tenantId],
    );
    const reservation = result.rows[0];
    if (!reservation) throw new NotFoundException('Slot reservation not found');
    if (reservation.status === 'released') return false;
    if (reservation.status !== 'reserved') {
      throw new ConflictException('Consumed reservation cannot be released');
    }
    const slot = await client.query<{ reserved_count: number }>(
      `SELECT reserved_count FROM pickup_slots
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, reservation.slot_id],
    );
    if (!slot.rows[0] || slot.rows[0].reserved_count < 1) {
      throw new ConflictException('Pickup slot reservation is inconsistent');
    }
    const released = await client.query(
      // Capacity mutations never bump `version` (D3).
      `UPDATE pickup_slots SET reserved_count = reserved_count - 1,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND reserved_count > 0`,
      [tenantId, reservation.slot_id],
    );
    if (released.rowCount !== 1) {
      throw new ConflictException('Pickup slot reservation is inconsistent');
    }
    const marked = await client.query(
      // updated_at is set explicitly on every mutation (no DB trigger);
      // released_at is required by slot_reservations_released_at_check.
      `UPDATE slot_reservations
          SET status = 'released', released_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'reserved'`,
      [reservation.id],
    );
    if (marked.rowCount !== 1) {
      throw new ConflictException('Pickup slot reservation is inconsistent');
    }
    return true;
  }

  /**
   * Atomically moves one reserved seat between two slots of the SAME tenant
   * (release old + reserve new in the caller's transaction). Used by the
   * accepted schedule-change proposal flow. Replaying with the current slot is
   * a no-op success; a full, closed, stale-version or cross-tenant target is
   * rejected without touching the source slot.
   */
  async moveReservation(
    client: PoolClient,
    tenantId: string,
    orderId: string,
    newSlotId: string,
    expectedNewSlotVersion: number,
  ): Promise<SlotReservation> {
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(orderId, 'order id');
    this.assertUuid(newSlotId, 'slot id');
    if (
      !Number.isSafeInteger(expectedNewSlotVersion) ||
      expectedNewSlotVersion < 1
    ) {
      throw new BadRequestException(
        'expectedVersion must be a positive integer',
      );
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
      // Idempotent replay of an already-applied move.
      const same = await client.query<{
        starts_at_text: string;
        ends_at_text: string;
        version: number;
        reserved_count: number;
      }>(
        `SELECT ${TS('starts_at')} AS starts_at_text,
                ${TS('ends_at')} AS ends_at_text,
                version, reserved_count
           FROM pickup_slots WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
        [tenantId, newSlotId],
      );
      if (!same.rows[0]) throw new NotFoundException('Pickup slot not found');
      return {
        reservationId: reservation.id,
        orderId,
        slotId: newSlotId,
        startsAt: same.rows[0].starts_at_text,
        endsAt: same.rows[0].ends_at_text,
        version: same.rows[0].version,
        reservedCount: same.rows[0].reserved_count,
      };
    }

    await this.lockTenantContext(client, tenantId);
    // Lock both slot rows in a deterministic order to avoid deadlocks.
    const lockedSlots = await client.query<{ id: string }>(
      `SELECT id FROM pickup_slots
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id FOR UPDATE`,
      [tenantId, [reservation.slot_id, newSlotId]],
    );
    if (lockedSlots.rowCount !== 2) {
      // Also rejects cross-tenant targets: slots are always matched with the
      // reservation tenant id, never with client-supplied ownership.
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
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND reserved_count > 0`,
      [tenantId, reservation.slot_id],
    );
    if (oldUpdate.rowCount !== 1) {
      throw new ConflictException('Pickup slot reservation is inconsistent');
    }
    let newUpdate;
    try {
      newUpdate = await client.query<{
        reserved_count: number;
        version: number;
      }>(
        `UPDATE pickup_slots SET reserved_count = reserved_count + 1,
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND version = $3
            AND status = 'open' AND reserved_count < capacity
          RETURNING reserved_count, version`,
        [tenantId, newSlotId, expectedNewSlotVersion],
      );
    } catch (error) {
      throw this.mapSlotWriteError(error);
    }
    if (newUpdate.rowCount !== 1) {
      throw new ConflictException('Pickup slot is full or changed');
    }
    await client.query(
      `UPDATE slot_reservations SET slot_id = $2, updated_at = now()
        WHERE id = $1`,
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

  /**
   * Marks the seat used at handover. Only status 'reserved' can be consumed;
   * replaying consume returns false without side effects and a released
   * reservation is rejected. Consuming does NOT free capacity: the seat stays
   * occupied for the slot. Scoped by tenantId (D3); callers (pickup flow)
   * authorize order/handover themselves.
   */
  async consumeReservation(
    client: PoolClient,
    tenantId: string,
    orderId: string,
  ): Promise<boolean> {
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(orderId, 'order id');
    const result = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM slot_reservations
        WHERE order_id = $1 AND tenant_id = $2 FOR UPDATE`,
      [orderId, tenantId],
    );
    const reservation = result.rows[0];
    if (!reservation) throw new NotFoundException('Slot reservation not found');
    if (reservation.status === 'consumed') return false;
    if (reservation.status !== 'reserved') {
      throw new ConflictException('Released reservation cannot be consumed');
    }
    const consumed = await client.query(
      // consumed_at is required by slot_reservations_consumed_at_check (0007)
      // exactly when status = 'consumed'; updated_at is set explicitly.
      `UPDATE slot_reservations
          SET status = 'consumed', consumed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'reserved'`,
      [reservation.id],
    );
    if (consumed.rowCount !== 1) {
      throw new ConflictException('Slot reservation changed');
    }
    return true;
  }

  private resolveLocalDateRange(
    query: SlotListQuery,
    maxDays: number,
  ): { from: string; to: string } {
    const hasDate = query.date !== undefined;
    const hasFrom = query.from !== undefined;
    const hasTo = query.to !== undefined;
    if (hasDate && (hasFrom || hasTo)) {
      throw new BadRequestException("Use either 'date' or 'from'+'to'");
    }
    let from: string;
    let to: string;
    if (hasDate) {
      from = query.date!;
      to = query.date!;
    } else if (hasFrom && hasTo) {
      from = query.from!;
      to = query.to!;
    } else {
      throw new BadRequestException("Provide 'date' or both 'from' and 'to'");
    }
    this.validateLocalDate(from, 'from');
    this.validateLocalDate(to, 'to');
    const fromMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`);
    if (toMs < fromMs) {
      throw new BadRequestException("'to' must not be before 'from'");
    }
    if (toMs - fromMs >= maxDays * DAY_MS) {
      throw new BadRequestException(`Range must not exceed ${maxDays} days`);
    }
    return { from, to };
  }

  private validateLocalDate(value: string, field: string): void {
    if (typeof value !== 'string' || !LOCAL_DATE_PATTERN.test(value)) {
      throw new BadRequestException(`${field} must use YYYY-MM-DD format`);
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    ) {
      throw new BadRequestException(`${field} is not a valid calendar date`);
    }
  }

  private async slotFitsOperatingHours(
    client: PoolClient | undefined,
    slot: Pick<SlotRow, 'starts_at' | 'ends_at' | 'timezone' | 'tenant_id'>,
  ): Promise<boolean> {
    const start = this.localDateTime(slot.starts_at, slot.timezone);
    const end = this.localDateTime(slot.ends_at, slot.timezone);
    // A slot must start and end inside the same local day, strictly forward.
    if (start.date !== end.date || start.time >= end.time) return false;
    // D8: operating-hours truth comes exclusively from the tenant-campus
    // slice contract (TenantsModule export); this module never queries
    // tenant_operating_hours / tenant_operating_hour_overrides itself.
    const window = await this.operatingHours.resolveOperatingWindow(
      slot.tenant_id,
      start.date,
      client,
    );
    if (!window.isOpen || !window.opensAt || !window.closesAt) return false;
    return start.time >= window.opensAt && end.time <= window.closesAt;
  }

  private async lockTenantContext(
    client: PoolClient,
    tenantId: string,
    lock = true,
  ) {
    const result = await client.query<{
      status: string;
      campus_status: string;
      timezone: string;
    }>(
      `SELECT t.status, c.status AS campus_status, c.timezone
         FROM tenants t JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND t.status <> 'archived'
        ${lock ? 'FOR SHARE OF t, c' : ''}`,
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
        WHERE t.id = $1 AND t.status <> 'archived' AND c.status = 'active'`,
      [tenantId],
    );
    if (!result.rows[0]) throw new NotFoundException('Tenant not found');
    return result.rows[0].timezone;
  }

  private parseFutureInstant(value: string, field: string): Date {
    if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) {
      throw new BadRequestException(`${field} must be an ISO-8601 timestamp`);
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new BadRequestException(`${field} is not a valid timestamp`);
    }
    if (date.getTime() <= Date.now()) {
      throw new BadRequestException(`${field} must be a future timestamp`);
    }
    return date;
  }

  /**
   * Normalizes an optional actor-supplied reason (1..300 chars after trim).
   * Empty/whitespace-only or overlong values are rejected with 400.
   */
  private optionalReason(reason: string | undefined): string | undefined {
    if (reason === undefined) return undefined;
    if (typeof reason !== 'string') {
      throw new BadRequestException('reason must be a string');
    }
    const normalized = reason.trim();
    if (normalized.length < 1 || normalized.length > MAX_REASON_LENGTH) {
      throw new BadRequestException(
        `reason must be between 1 and ${MAX_REASON_LENGTH} characters`,
      );
    }
    return normalized;
  }

  private assertUuid(value: string, field: string): void {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new BadRequestException(`Invalid ${field}`);
    }
  }

  private isUniqueViolation(error: unknown, constraint: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505' &&
      'constraint' in error &&
      (error as { constraint?: string }).constraint === constraint
    );
  }

  /**
   * Maps database constraint rejections on slot writes to stable HTTP contract
   * errors instead of 500s: duplicate tenant+window (unique index) and
   * capacity/window CHECK violations (defense in depth; the service validates
   * both before writing).
   */
  private mapSlotWriteError(error: unknown): Error {
    if (this.isUniqueViolation(error, 'pickup_slots_tenant_window_uq')) {
      return new ConflictException(
        'A pickup slot with the same window already exists',
      );
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23514'
    ) {
      return new ConflictException(
        'Pickup slot change violates capacity or window constraints',
      );
    }
    return error instanceof Error ? error : new Error(String(error));
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
