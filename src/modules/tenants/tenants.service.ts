import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import type { TenantPermission } from '../access/access.service';
import { AuditService } from '../audit/audit.service';

/**
 * Convention D7 (root decision): mutation responses return `updatedAt` as a
 * microsecond-precise ISO-8601 string rendered by PostgreSQL. JavaScript Date
 * only keeps milliseconds, so a `Date.toISOString()` round-trip silently
 * truncates `now()` precision and breaks optimistic-concurrency equality.
 * Clients must echo this string back verbatim in `expectedUpdatedAt`.
 */
const UPDATED_AT_ISO = `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const TENANT_STATUSES = new Set(['open', 'closed', 'paused', 'any']);
const OPERATIONAL_STATUSES = new Set(['open', 'closed', 'paused']);
const ACTIVE_ORDER_STATUSES = [
  'paid_awaiting_tenant',
  'confirmed',
  'preparing',
  'ready_for_pickup',
];

export interface TenantListOptions {
  campusId?: string;
  status?: string;
  search?: string;
  limit?: number;
}

export interface TenantRecord {
  id: string;
  campusId: string;
  name: string;
  location: string;
  status: string;
  updatedAt: string;
}

export interface TenantMutationInput {
  name: string;
  location: string;
  reason: string;
  expectedUpdatedAt?: string;
}

export interface TenantStatusInput {
  status: string;
  reason: string;
  expectedUpdatedAt: string;
}

export interface ArchiveInput {
  reason: string;
  expectedUpdatedAt: string;
}

interface TenantReadRow {
  id: string;
  campus_id: string;
  campus_name: string;
  name: string;
  location: string;
  status: string;
  timezone: string;
}

function clampLimit(limit: number | undefined, fallback = 50): number {
  if (limit === undefined) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function likePattern(search: string | undefined): string | null {
  const normalized = search?.trim();
  if (!normalized) return null;
  return `%${normalized.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- public

  async list(options: TenantListOptions = {}): Promise<{
    data: Array<{
      id: string;
      campusId: string;
      campusName: string;
      name: string;
      location: string;
      status: string;
      timezone: string;
    }>;
  }> {
    const status = options.status ?? 'any';
    if (!TENANT_STATUSES.has(status)) {
      throw new BadRequestException('Invalid tenant status filter');
    }
    const limit = clampLimit(options.limit);
    const result = await this.database.pool.query<TenantReadRow>(
      `SELECT t.id, t.campus_id, c.name AS campus_name, t.name, t.location,
              t.status, c.timezone
         FROM tenants t
         JOIN campuses c ON c.id = t.campus_id
        WHERE c.status = 'active'
          AND t.status <> 'archived'
          AND ($1::uuid IS NULL OR t.campus_id = $1)
          AND ($2::text = 'any' OR t.status = $2)
          AND ($3::text IS NULL OR t.name ILIKE $3)
        ORDER BY c.name, t.name, t.id
        LIMIT $4`,
      [options.campusId ?? null, status, likePattern(options.search), limit],
    );
    return { data: result.rows.map((row) => this.presentTenant(row)) };
  }

  async get(tenantId: string): Promise<{
    data: {
      id: string;
      campusId: string;
      campusName: string;
      name: string;
      location: string;
      status: string;
      timezone: string;
    };
  }> {
    const result = await this.database.pool.query<TenantReadRow>(
      `SELECT t.id, t.campus_id, c.name AS campus_name, t.name, t.location,
              t.status, c.timezone
         FROM tenants t
         JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND t.status <> 'archived' AND c.status = 'active'`,
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Tenant not found');
    return { data: this.presentTenant(row) };
  }

  // -------------------------------------------------- campus admin mutation

  async create(
    actorUserId: string,
    campusId: string,
    input: TenantMutationInput,
  ): Promise<{ data: TenantRecord }> {
    const name = this.requiredText(input.name, 'name');
    const location = this.requiredText(input.location, 'location');
    const reason = this.requiredReason(input.reason);
    return this.withTransaction(async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.tenants.manage',
        tx,
      );
      const result = await tx.query<{
        id: string;
        name: string;
        location: string;
        status: string;
        updated_at_iso: string;
      }>(
        `INSERT INTO tenants (campus_id, name, location, status, updated_at)
         VALUES ($1, $2, $3, 'closed', now())
         RETURNING id, name, location, status, ${UPDATED_AT_ISO} AS updated_at_iso`,
        [campusId, name, location],
      );
      const row = result.rows[0];
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: row.id,
        action: 'tenant.created',
        targetType: 'tenant',
        targetId: row.id,
        reason,
        metadata: { campusId },
      });
      return {
        data: {
          id: row.id,
          campusId,
          name: row.name,
          location: row.location,
          status: row.status,
          updatedAt: row.updated_at_iso,
        },
      };
    });
  }

  async update(
    actorUserId: string,
    campusId: string,
    tenantId: string,
    input: TenantMutationInput & { expectedUpdatedAt: string },
  ): Promise<{ data: TenantRecord }> {
    const name = this.requiredText(input.name, 'name');
    const location = this.requiredText(input.location, 'location');
    const reason = this.requiredReason(input.reason);
    return this.withTransaction(async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.tenants.manage',
        tx,
      );
      const before = await this.lockEditableTenant(tx, tenantId, campusId);
      const result = await tx.query<{
        id: string;
        name: string;
        location: string;
        status: string;
        updated_at_iso: string;
      }>(
        `UPDATE tenants
            SET name = $3, location = $4, updated_at = now()
          WHERE id = $1 AND campus_id = $2
            AND updated_at = $5::timestamptz
         RETURNING id, name, location, status, ${UPDATED_AT_ISO} AS updated_at_iso`,
        [tenantId, campusId, name, location, input.expectedUpdatedAt],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ConflictException(
          'Tenant changed since it was read; refresh expectedUpdatedAt',
        );
      }
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: 'tenant.updated',
        targetType: 'tenant',
        targetId: tenantId,
        reason,
        metadata: {
          campusId,
          before: { name: before.name, location: before.location },
        },
      });
      return {
        data: {
          id: row.id,
          campusId,
          name: row.name,
          location: row.location,
          status: row.status,
          updatedAt: row.updated_at_iso,
        },
      };
    });
  }

  /**
   * Campus-admin oversight transition (open/closed/paused). Archiving is a
   * separate operation with active-dependency checks.
   */
  async setStatusByCampusAdmin(
    actorUserId: string,
    campusId: string,
    tenantId: string,
    input: TenantStatusInput,
  ): Promise<{
    data: { tenantId: string; status: string; updatedAt: string };
  }> {
    return this.withTransaction(async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.tenants.manage',
        tx,
      );
      return this.applyStatusChange(tx, {
        actorUserId,
        tenantId,
        campusId,
        input,
        via: 'campus_admin',
      });
    });
  }

  /**
   * Tenant-staff operational transition: pausing order intake requires
   * `tenant.orders.pause`; opening/closing requires `tenant.capacity.manage`
   * (matches the pilot permission model where kitchen staff may pause and
   * manage capacity but only with explicit grants).
   */
  async setStatusByStaff(
    actorUserId: string,
    tenantId: string,
    input: TenantStatusInput,
  ): Promise<{
    data: { tenantId: string; status: string; updatedAt: string };
  }> {
    this.assertOperationalStatus(input.status);
    const permission: TenantPermission =
      input.status === 'paused'
        ? 'tenant.orders.pause'
        : 'tenant.capacity.manage';
    return this.withTransaction(async (tx) => {
      await this.access.requireTenant(actorUserId, tenantId, permission, tx);
      return this.applyStatusChange(tx, {
        actorUserId,
        tenantId,
        campusId: undefined,
        input,
        via: 'tenant_staff',
      });
    });
  }

  /**
   * Archive without deleting data. Refuses while the tenant still has active
   * buyer commitments: unpaid-in-flight orders, pending schedule proposals,
   * reserved (unconsumed) slot reservations, or open future pickup slots.
   * Completed/declined/cancelled history never blocks archiving and is kept.
   */
  async archive(
    actorUserId: string,
    campusId: string,
    tenantId: string,
    input: ArchiveInput,
  ): Promise<{
    data: {
      id: string;
      campusId: string;
      status: 'archived';
      updatedAt: string;
    };
  }> {
    const reason = this.requiredReason(input.reason);
    return this.withTransaction(async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.tenants.manage',
        tx,
      );
      const tenant = await this.lockEditableTenant(tx, tenantId, campusId);
      const dependencies = await tx.query<{
        active_orders: number;
        pending_proposals: number;
        reserved_slots: number;
        open_future_slots: number;
      }>(
        `SELECT
           (SELECT count(*) FROM orders o
             WHERE o.tenant_id = $1 AND o.status = ANY($2))::int AS active_orders,
           (SELECT count(*) FROM schedule_proposals sp
             WHERE sp.tenant_id = $1 AND sp.status = 'pending_buyer')::int AS pending_proposals,
           (SELECT count(*) FROM slot_reservations r
             WHERE r.tenant_id = $1 AND r.status = 'reserved')::int AS reserved_slots,
           (SELECT count(*) FROM pickup_slots s
             WHERE s.tenant_id = $1 AND s.status = 'open'
               AND s.ends_at > now())::int AS open_future_slots`,
        [tenantId, ACTIVE_ORDER_STATUSES],
      );
      const blocking = dependencies.rows[0];
      const blockers: string[] = [];
      if (blocking.active_orders > 0)
        blockers.push(`${blocking.active_orders} active order(s)`);
      if (blocking.pending_proposals > 0)
        blockers.push(
          `${blocking.pending_proposals} pending schedule proposal(s)`,
        );
      if (blocking.reserved_slots > 0)
        blockers.push(`${blocking.reserved_slots} reserved slot(s)`);
      if (blocking.open_future_slots > 0)
        blockers.push(
          `${blocking.open_future_slots} open future pickup slot(s)`,
        );
      if (blockers.length > 0) {
        throw new ConflictException(
          `Tenant cannot be archived while it has ${blockers.join(', ')}`,
        );
      }
      const result = await tx.query<{ updated_at_iso: string }>(
        `UPDATE tenants
            SET status = 'archived', updated_at = now()
          WHERE id = $1 AND campus_id = $2
            AND updated_at = $3::timestamptz
         RETURNING ${UPDATED_AT_ISO} AS updated_at_iso`,
        [tenantId, campusId, input.expectedUpdatedAt],
      );
      if (!result.rows[0]) {
        throw new ConflictException(
          'Tenant changed since it was read; refresh expectedUpdatedAt',
        );
      }
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: 'tenant.archived',
        targetType: 'tenant',
        targetId: tenantId,
        reason,
        metadata: { campusId, before: { status: tenant.status } },
      });
      return {
        data: {
          id: tenantId,
          campusId,
          status: 'archived' as const,
          updatedAt: result.rows[0].updated_at_iso,
        },
      };
    });
  }

  // --------------------------------------------------------------- private

  private async applyStatusChange(
    tx: PoolClient,
    change: {
      actorUserId: string;
      tenantId: string;
      campusId: string | undefined;
      input: TenantStatusInput;
      via: 'campus_admin' | 'tenant_staff';
    },
  ): Promise<{
    data: { tenantId: string; status: string; updatedAt: string };
  }> {
    this.assertOperationalStatus(change.input.status);
    const reason = this.requiredReason(change.input.reason);
    const before = await this.lockEditableTenant(
      tx,
      change.tenantId,
      change.campusId,
    );
    const result = await tx.query<{ status: string; updated_at_iso: string }>(
      `UPDATE tenants
          SET status = $3, updated_at = now()
        WHERE id = $1
          AND ($2::uuid IS NULL OR campus_id = $2)
          AND updated_at = $4::timestamptz
       RETURNING status, ${UPDATED_AT_ISO} AS updated_at_iso`,
      [
        change.tenantId,
        change.campusId ?? null,
        change.input.status,
        change.input.expectedUpdatedAt,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ConflictException(
        'Tenant changed since it was read; refresh expectedUpdatedAt',
      );
    }
    await this.audit.append(tx, {
      actor: { userId: change.actorUserId },
      scopeType: 'tenant',
      scopeId: change.tenantId,
      action: 'tenant.status_changed',
      targetType: 'tenant',
      targetId: change.tenantId,
      reason,
      metadata: {
        from: before.status,
        to: row.status,
        via: change.via,
        ...(change.campusId ? { campusId: change.campusId } : {}),
      },
    });
    return {
      data: {
        tenantId: change.tenantId,
        status: row.status,
        updatedAt: row.updated_at_iso,
      },
    };
  }

  /**
   * Locks the tenant row for the mutation and normalizes the not-editable
   * outcomes: missing tenant, tenant bound to another campus, and archived
   * tenants all surface as 404 so admin routes do not leak foreign or
   * archived records.
   */
  private async lockEditableTenant(
    tx: PoolClient,
    tenantId: string,
    campusId?: string,
  ): Promise<{
    id: string;
    campus_id: string;
    status: string;
    name: string;
    location: string;
  }> {
    const scoped = await tx.query<{
      id: string;
      campus_id: string;
      status: string;
      name: string;
      location: string;
    }>(
      `SELECT id, campus_id, status, name, location
         FROM tenants
        WHERE id = $1 AND ($2::uuid IS NULL OR campus_id = $2)
        FOR UPDATE`,
      [tenantId, campusId ?? null],
    );
    const row = scoped.rows[0];
    if (row && row.status === 'archived') {
      throw new NotFoundException('Tenant not found');
    }
    if (row) return row;
    throw new NotFoundException('Tenant not found');
  }

  private assertOperationalStatus(status: string): void {
    if (!OPERATIONAL_STATUSES.has(status)) {
      throw new BadRequestException(
        'Status must be one of open, closed, paused; archiving is a separate operation',
      );
    }
  }

  private presentTenant(row: TenantReadRow) {
    return {
      id: row.id,
      campusId: row.campus_id,
      campusName: row.campus_name,
      name: row.name,
      location: row.location,
      status: row.status,
      timezone: row.timezone,
    };
  }

  private requiredText(value: string, field: string): string {
    const normalized = value?.trim();
    if (!normalized) {
      throw new BadRequestException(`${field} must not be empty`);
    }
    return normalized;
  }

  private requiredReason(reason: string): string {
    const normalized = reason?.trim();
    if (!normalized || normalized.length > 500) {
      throw new BadRequestException(
        'A reason of 1 to 500 characters is required',
      );
    }
    return normalized;
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
