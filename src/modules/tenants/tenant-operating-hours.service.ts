import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';

/**
 * Cross-slice read contract D8 (root-approved): `resolveOperatingWindow` is
 * the single source of operating-hours truth for slot validation. Wave 2
 * (orders/checkout) and availability must consume this method instead of
 * querying the tables directly. The signature is frozen; changes require a
 * message to root.
 *
 * Weekday convention D12: 0=Sunday .. 6=Saturday (JS `Date.getDay()`),
 * evaluated in the tenant/campus timezone. `localDate` is the tenant-local
 * calendar date ('YYYY-MM-DD'); the returned weekday is the weekday of that
 * local calendar date.
 *
 * Pilot limitation: windows crossing midnight are forbidden by the schema
 * CHECK (opens_at < closes_at), so late-night tenants spanning midnight are
 * not supported yet (needs a product decision).
 */
export interface OperatingWindow {
  tenantId: string;
  timezone: string;
  localDate: string;
  /** 0=Sunday .. 6=Saturday for `localDate` (D12). */
  weekday: number;
  isOpen: boolean;
  /** 'HH:MM:SS' local wall-clock time, or null when closed. */
  opensAt: string | null;
  /** 'HH:MM:SS' local wall-clock time, or null when closed. */
  closesAt: string | null;
  source: 'override' | 'weekly' | 'none';
}

export interface WeeklyOperatingDayInput {
  weekday: number;
  isOpen: boolean;
  opensAt?: string;
  closesAt?: string;
}

export interface OperatingHourOverrideInput {
  isClosed: boolean;
  opensAt?: string;
  closesAt?: string;
  reason: string;
}

export interface WeeklyOperatingDay {
  weekday: number;
  isOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

export interface OperatingHourOverride {
  localDate: string;
  isClosed: boolean;
  opensAt: string | null;
  closesAt: string | null;
  reason: string;
}

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function normalizeTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

/** Weekday (0=Sunday) of a 'YYYY-MM-DD' calendar date, timezone-independent. */
function weekdayOfLocalDate(localDate: string): number {
  return new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
}

@Injectable()
export class TenantOperatingHoursService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------- read (D8)

  /**
   * Resolves the effective operating window for one tenant-local date.
   * A date-specific override always beats the weekly schedule. Missing or
   * closed rows resolve to `isOpen: false`. Archived tenants and inactive
   * campuses are a 404.
   *
   * When `client` is provided the queries run read-only inside the caller's
   * transaction WITHOUT taking locks or opening a nested transaction (D8);
   * callers needing serialization must lock the tenant row themselves.
   */
  async resolveOperatingWindow(
    tenantId: string,
    localDate: string,
    client?: PoolClient,
  ): Promise<OperatingWindow> {
    this.assertLocalDate(localDate);
    const query = client
      ? client.query.bind(client)
      : this.database.pool.query.bind(this.database.pool);
    const timezone = await this.requireActiveTenantTimezone(query, tenantId);
    const weekday = weekdayOfLocalDate(localDate);
    const override = await query<{
      is_closed: boolean;
      opens_at: string | null;
      closes_at: string | null;
    }>(
      `SELECT is_closed, opens_at::text AS opens_at, closes_at::text AS closes_at
         FROM tenant_operating_hour_overrides
        WHERE tenant_id = $1 AND local_date = $2::date`,
      [tenantId, localDate],
    );
    if (override.rows[0]) {
      const row = override.rows[0];
      return {
        tenantId,
        timezone,
        localDate,
        weekday,
        isOpen: !row.is_closed,
        opensAt: row.is_closed ? null : row.opens_at,
        closesAt: row.is_closed ? null : row.closes_at,
        source: 'override',
      };
    }
    const weekly = await query<{
      is_open: boolean;
      opens_at: string | null;
      closes_at: string | null;
    }>(
      `SELECT is_open, opens_at::text AS opens_at, closes_at::text AS closes_at
         FROM tenant_operating_hours
        WHERE tenant_id = $1 AND weekday = $2`,
      [tenantId, weekday],
    );
    if (weekly.rows[0]) {
      const row = weekly.rows[0];
      return {
        tenantId,
        timezone,
        localDate,
        weekday,
        isOpen: row.is_open,
        opensAt: row.is_open ? row.opens_at : null,
        closesAt: row.is_open ? row.closes_at : null,
        source: 'weekly',
      };
    }
    return {
      tenantId,
      timezone,
      localDate,
      weekday,
      isOpen: false,
      opensAt: null,
      closesAt: null,
      source: 'none',
    };
  }

  /**
   * Public read used by GET /v1/tenants/:tenantId/operating-hours: the full
   * weekly schedule plus overrides from the tenant-local today onwards.
   */
  async listOperatingHours(tenantId: string): Promise<{
    data: {
      tenantId: string;
      timezone: string;
      weekly: WeeklyOperatingDay[];
      overrides: OperatingHourOverride[];
    };
  }> {
    return this.listUsing(this.database.pool, tenantId);
  }

  // ------------------------------------------------------- staff mutation

  /**
   * Replaces the complete weekly schedule: exactly seven entries, each
   * weekday 0..6 once. Open days need a valid window with opens < closes;
   * closed days must carry no times (mirrors the DB CHECK). Requires
   * `tenant.capacity.manage`. The tenant row is locked so concurrent slot
   * validation (which share-locks the tenant) serializes with this edit.
   */
  async replaceOperatingHours(
    actorUserId: string,
    tenantId: string,
    days: readonly WeeklyOperatingDayInput[],
    reason: string,
  ): Promise<{
    data: {
      tenantId: string;
      timezone: string;
      weekly: WeeklyOperatingDay[];
      overrides: OperatingHourOverride[];
    };
  }> {
    const entries = this.validateWeeklySchedule(days);
    const auditReason = this.requiredReason(reason);
    return this.withTransaction(async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.capacity.manage',
        tx,
      );
      await this.lockEditableTenant(tx, tenantId);
      await tx.query(
        `DELETE FROM tenant_operating_hours WHERE tenant_id = $1`,
        [tenantId],
      );
      for (const entry of entries) {
        await tx.query(
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
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: 'tenant.operating_hours_replaced',
        targetType: 'tenant',
        targetId: tenantId,
        reason: auditReason,
        metadata: {
          openDays: entries.filter((entry) => entry.isOpen).length,
        },
      });
      return this.listUsing(tx, tenantId);
    });
  }

  /**
   * Sets (upserts) the override for one tenant-local date; unique per
   * (tenant_id, local_date). `isClosed=true` closes the day and must carry no
   * times; `isClosed=false` replaces the weekly window and requires
   * opens < closes. Past local dates are rejected. Requires
   * `tenant.capacity.manage`.
   */
  async setOverride(
    actorUserId: string,
    tenantId: string,
    localDate: string,
    input: OperatingHourOverrideInput,
  ): Promise<{ data: OperatingHourOverride & { tenantId: string } }> {
    this.assertLocalDate(localDate);
    const isClosed = Boolean(input.isClosed);
    const reason = this.validateOverrideReason(input.reason);
    let opensAt: string | null = null;
    let closesAt: string | null = null;
    if (isClosed) {
      if (input.opensAt || input.closesAt) {
        throw new BadRequestException(
          'Closed overrides must not include opening times',
        );
      }
    } else {
      const window = this.validateWindow(input.opensAt, input.closesAt);
      opensAt = window.opensAt;
      closesAt = window.closesAt;
    }
    return this.withTransaction(async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.capacity.manage',
        tx,
      );
      await this.lockEditableTenant(tx, tenantId);
      const today = await tx.query<{ today: string }>(
        `SELECT (now() AT TIME ZONE c.timezone)::date::text AS today
           FROM tenants t JOIN campuses c ON c.id = t.campus_id
          WHERE t.id = $1`,
        [tenantId],
      );
      if (today.rows[0] && localDate < today.rows[0].today) {
        throw new BadRequestException(
          'Override date is in the past for the tenant timezone',
        );
      }
      const result = await tx.query<{
        local_date: string;
        is_closed: boolean;
        opens_at: string | null;
        closes_at: string | null;
        reason: string;
      }>(
        `INSERT INTO tenant_operating_hour_overrides
           (tenant_id, local_date, is_closed, opens_at, closes_at, reason, updated_at)
         VALUES ($1, $2::date, $3, $4::time, $5::time, $6, now())
         ON CONFLICT (tenant_id, local_date) DO UPDATE
           SET is_closed = EXCLUDED.is_closed,
               opens_at = EXCLUDED.opens_at,
               closes_at = EXCLUDED.closes_at,
               reason = EXCLUDED.reason,
               updated_at = now()
         RETURNING local_date::text AS local_date, is_closed,
                   opens_at::text AS opens_at, closes_at::text AS closes_at, reason`,
        [tenantId, localDate, isClosed, opensAt, closesAt, reason],
      );
      const row = result.rows[0];
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: 'tenant.operating_hour_override_set',
        targetType: 'tenant',
        targetId: tenantId,
        reason,
        metadata: { localDate, isClosed },
      });
      return {
        data: {
          tenantId,
          localDate: row.local_date,
          isClosed: row.is_closed,
          opensAt: row.is_closed ? null : row.opens_at,
          closesAt: row.is_closed ? null : row.closes_at,
          reason: row.reason,
        },
      };
    });
  }

  /**
   * Removes the override for one tenant-local date, restoring the weekly
   * schedule for that date. Requires `tenant.capacity.manage`.
   */
  async removeOverride(
    actorUserId: string,
    tenantId: string,
    localDate: string,
    reason: string,
  ): Promise<{ data: { tenantId: string; localDate: string; removed: true } }> {
    this.assertLocalDate(localDate);
    const auditReason = this.requiredReason(reason);
    return this.withTransaction(async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.capacity.manage',
        tx,
      );
      await this.lockEditableTenant(tx, tenantId);
      const result = await tx.query<{
        is_closed: boolean;
        opens_at: string | null;
        closes_at: string | null;
      }>(
        `DELETE FROM tenant_operating_hour_overrides
          WHERE tenant_id = $1 AND local_date = $2::date
         RETURNING is_closed, opens_at::text AS opens_at, closes_at::text AS closes_at`,
        [tenantId, localDate],
      );
      const removed = result.rows[0];
      if (!removed) {
        throw new NotFoundException('Operating hour override not found');
      }
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: 'tenant.operating_hour_override_removed',
        targetType: 'tenant',
        targetId: tenantId,
        reason: auditReason,
        metadata: {
          localDate,
          wasClosed: removed.is_closed,
        },
      });
      return { data: { tenantId, localDate, removed: true as const } };
    });
  }

  // ------------------------------------------------------------- private

  private async requireActiveTenantTimezone(
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>,
    tenantId: string,
  ): Promise<string> {
    const tenant = await query<{ timezone: string }>(
      `SELECT c.timezone
         FROM tenants t
         JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND t.status <> 'archived' AND c.status = 'active'`,
      [tenantId],
    );
    if (!tenant.rows[0]) throw new NotFoundException('Tenant not found');
    return tenant.rows[0].timezone;
  }

  private async listUsing(
    tx: Pick<PoolClient, 'query'>,
    tenantId: string,
  ): Promise<{
    data: {
      tenantId: string;
      timezone: string;
      weekly: WeeklyOperatingDay[];
      overrides: OperatingHourOverride[];
    };
  }> {
    const timezone = await this.requireActiveTenantTimezone(
      tx.query.bind(tx),
      tenantId,
    );
    const [weekly, overrides] = await Promise.all([
      tx.query<{
        weekday: number;
        is_open: boolean;
        opens_at: string | null;
        closes_at: string | null;
      }>(
        `SELECT weekday, is_open, opens_at::text AS opens_at, closes_at::text AS closes_at
           FROM tenant_operating_hours
          WHERE tenant_id = $1
          ORDER BY weekday`,
        [tenantId],
      ),
      tx.query<{
        local_date: string;
        is_closed: boolean;
        opens_at: string | null;
        closes_at: string | null;
        reason: string;
      }>(
        `SELECT local_date::text AS local_date, is_closed,
                opens_at::text AS opens_at, closes_at::text AS closes_at, reason
           FROM tenant_operating_hour_overrides
          WHERE tenant_id = $1
            AND local_date >= (now() AT TIME ZONE $2)::date
          ORDER BY local_date
          LIMIT 90`,
        [tenantId, timezone],
      ),
    ]);
    return {
      data: {
        tenantId,
        timezone,
        weekly: weekly.rows.map((row) => ({
          weekday: row.weekday,
          isOpen: row.is_open,
          opensAt: row.is_open ? row.opens_at : null,
          closesAt: row.is_open ? row.closes_at : null,
        })),
        overrides: overrides.rows.map((row) => ({
          localDate: row.local_date,
          isClosed: row.is_closed,
          opensAt: row.is_closed ? null : row.opens_at,
          closesAt: row.is_closed ? null : row.closes_at,
          reason: row.reason,
        })),
      },
    };
  }

  private validateWeeklySchedule(
    days: readonly WeeklyOperatingDayInput[],
  ): Array<{
    weekday: number;
    isOpen: boolean;
    opensAt: string | null;
    closesAt: string | null;
  }> {
    if (!Array.isArray(days) || days.length !== 7) {
      throw new BadRequestException(
        'Weekly schedule must define each weekday 0..6 exactly once',
      );
    }
    const seen = new Set<number>();
    const entries: Array<{
      weekday: number;
      isOpen: boolean;
      opensAt: string | null;
      closesAt: string | null;
    }> = [];
    for (const day of days) {
      if (
        !Number.isInteger(day.weekday) ||
        day.weekday < 0 ||
        day.weekday > 6 ||
        seen.has(day.weekday)
      ) {
        throw new BadRequestException(
          'Weekly schedule must define each weekday 0..6 exactly once',
        );
      }
      seen.add(day.weekday);
      if (day.isOpen) {
        const window = this.validateWindow(day.opensAt, day.closesAt);
        entries.push({
          weekday: day.weekday,
          isOpen: true,
          opensAt: window.opensAt,
          closesAt: window.closesAt,
        });
      } else {
        if (day.opensAt || day.closesAt) {
          throw new BadRequestException(
            'Closed days must not include opening times',
          );
        }
        entries.push({
          weekday: day.weekday,
          isOpen: false,
          opensAt: null,
          closesAt: null,
        });
      }
    }
    return entries;
  }

  private validateWindow(
    opensAt: string | undefined,
    closesAt: string | undefined,
  ): { opensAt: string; closesAt: string } {
    if (
      typeof opensAt !== 'string' ||
      typeof closesAt !== 'string' ||
      !LOCAL_TIME_PATTERN.test(opensAt) ||
      !LOCAL_TIME_PATTERN.test(closesAt)
    ) {
      throw new BadRequestException(
        'Open periods require opensAt and closesAt as HH:MM or HH:MM:SS',
      );
    }
    const open = normalizeTime(opensAt);
    const close = normalizeTime(closesAt);
    if (open >= close) {
      throw new BadRequestException(
        'closesAt must be later than opensAt; windows crossing midnight are not supported',
      );
    }
    return { opensAt: open, closesAt: close };
  }

  private async lockEditableTenant(
    tx: PoolClient,
    tenantId: string,
  ): Promise<void> {
    const result = await tx.query<{ id: string }>(
      `SELECT id FROM tenants WHERE id = $1 AND status <> 'archived' FOR UPDATE`,
      [tenantId],
    );
    if (!result.rows[0]) throw new NotFoundException('Tenant not found');
  }

  private assertLocalDate(value: string): void {
    if (typeof value !== 'string' || !LOCAL_DATE_PATTERN.test(value)) {
      throw new BadRequestException('localDate must use YYYY-MM-DD format');
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    ) {
      throw new BadRequestException('localDate is not a real calendar date');
    }
  }

  private validateOverrideReason(reason: string): string {
    const normalized = reason?.trim();
    if (!normalized || normalized.length > 300) {
      throw new BadRequestException(
        'A reason of 1 to 300 characters is required',
      );
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
