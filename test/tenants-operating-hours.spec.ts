import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { TenantOperatingHoursService } from '../src/modules/tenants/tenant-operating-hours.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

/** A tenant-local date 20..40 days in the future whose weekday equals `weekday`. */
function futureLocalDateForWeekday(weekday: number): string {
  for (let add = 20; add <= 40; add += 1) {
    const iso = new Date(Date.now() + add * 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (new Date(`${iso}T00:00:00.000Z`).getUTCDay() === weekday) return iso;
  }
  throw new Error('test helper could not find a future date');
}

function fullWeek(override?: Partial<{ weekday: number; isOpen: boolean }>) {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    if (override && override.weekday === weekday) {
      return {
        weekday,
        isOpen: override.isOpen ?? true,
        ...(override.isOpen === false
          ? {}
          : { opensAt: '08:00', closesAt: '17:00' }),
      };
    }
    return { weekday, isOpen: true, opensAt: '08:00', closesAt: '17:00' };
  });
}

describe(
  'TenantOperatingHoursService PostgreSQL behaviour',
  { skip: !databaseUrl },
  () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const database = { pool } as DatabaseService;
    const access = new AccessService(database);
    const audit = new AuditService(database, access);
    const hours = new TenantOperatingHoursService(database, access, audit);

    const campus = randomUUID();
    const tenant = randomUUID();
    const tenant2 = randomUUID();
    const tenantArchived = randomUUID();
    const owner = randomUUID();
    const kitchenWith = randomUUID();
    const kitchenWithout = randomUUID();
    const kitchen2 = randomUUID();
    const outsider = randomUUID();

    before(async () => {
      await pool.query(
        `INSERT INTO campuses (id, name, timezone, status) VALUES
         ($1, 'Kampus Jam Operasional', 'Asia/Jakarta', 'active')`,
        [campus],
      );
      await pool.query(
        `INSERT INTO tenants (id, campus_id, name, location, status) VALUES
         ($1, $4, 'Kantin Jam Satu', 'Gedung A', 'open'),
         ($2, $4, 'Kantin Jam Dua', 'Gedung B', 'open'),
         ($3, $4, 'Kantin Jam Arsip', 'Gedung C', 'archived')`,
        [tenant, tenant2, tenantArchived, campus],
      );
      await pool.query(
        `INSERT INTO users (id, display_name, status) VALUES
         ($1, 'Owner jam', 'active'),
         ($2, 'Kitchen capacity', 'active'),
         ($3, 'Kitchen plain', 'active'),
         ($4, 'Kitchen tenant2', 'active'),
         ($5, 'Outsider jam', 'active')`,
        [owner, kitchenWith, kitchenWithout, kitchen2, outsider],
      );
      await pool.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, owner_verified_at) VALUES
         ($1, $3, 'owner', '{}'::text[], now()),
         ($1, $4, 'kitchen', ARRAY['tenant.capacity.manage']::text[], NULL),
         ($1, $5, 'kitchen', ARRAY['tenant.orders.read']::text[], NULL),
         ($2, $6, 'kitchen', ARRAY['tenant.capacity.manage']::text[], NULL)`,
        [tenant, tenant2, owner, kitchenWith, kitchenWithout, kitchen2],
      );
    });

    after(async () => {
      await pool.end();
    });

    it('replaces the weekly schedule, normalizes times and audits the change', async () => {
      const days = fullWeek({ weekday: 0, isOpen: false });
      const result = await hours.replaceOperatingHours(
        owner,
        tenant,
        days,
        'Jadwal semester baru',
      );
      assert.equal(result.data.timezone, 'Asia/Jakarta');
      assert.equal(result.data.weekly.length, 7);
      const sunday = result.data.weekly.find((row) => row.weekday === 0);
      assert.deepEqual(sunday, {
        weekday: 0,
        isOpen: false,
        opensAt: null,
        closesAt: null,
      });
      const monday = result.data.weekly.find((row) => row.weekday === 1);
      assert.deepEqual(monday, {
        weekday: 1,
        isOpen: true,
        opensAt: '08:00:00',
        closesAt: '17:00:00',
      });

      const stored = await pool.query(
        `SELECT weekday, is_open, opens_at::text AS opens_at, closes_at::text AS closes_at, updated_at
         FROM tenant_operating_hours WHERE tenant_id = $1 AND weekday = 0`,
        [tenant],
      );
      assert.equal(
        stored.rows[0].opens_at,
        null,
        'closed day must store NULL times',
      );
      assert.equal(stored.rows[0].closes_at, null);

      const auditRow = await pool.query(
        `SELECT actor_user_id, reason, metadata FROM audit_events
        WHERE scope_id = $1 AND action = 'tenant.operating_hours_replaced'
        ORDER BY occurred_at DESC LIMIT 1`,
        [tenant],
      );
      assert.equal(auditRow.rows[0].actor_user_id, owner);
      assert.equal(auditRow.rows[0].reason, 'Jadwal semester baru');
      assert.equal(auditRow.rows[0].metadata.openDays, 6);
    });

    it('validates weekly schedule shape before touching the database', async () => {
      const sixDays = fullWeek().slice(1);
      await assert.rejects(
        hours.replaceOperatingHours(owner, tenant, sixDays, 'Kurang hari'),
        /each weekday 0..6 exactly once/,
      );
      const duplicated = [...fullWeek(), { weekday: 1, isOpen: false }];
      await assert.rejects(
        hours.replaceOperatingHours(owner, tenant, duplicated, 'Duplikat'),
        /each weekday 0..6 exactly once/,
      );
      const badWeekday = fullWeek().map((day, index) =>
        index === 0 ? { ...day, weekday: 7 } : day,
      );
      await assert.rejects(
        hours.replaceOperatingHours(owner, tenant, badWeekday, 'Weekday 7'),
        /each weekday 0..6 exactly once/,
      );
      const missingClose = fullWeek().map((day, index) =>
        index === 1
          ? { weekday: day.weekday, isOpen: true, opensAt: '08:00' }
          : day,
      );
      await assert.rejects(
        hours.replaceOperatingHours(
          owner,
          tenant,
          missingClose,
          'Tanpa closesAt',
        ),
        /opensAt and closesAt/,
      );
      const inverted = fullWeek().map((day, index) =>
        index === 1 ? { ...day, opensAt: '18:00', closesAt: '09:00' } : day,
      );
      await assert.rejects(
        hours.replaceOperatingHours(owner, tenant, inverted, 'Terbalik'),
        /closesAt must be later than opensAt/,
      );
      const closedWithTimes = fullWeek().map((day, index) =>
        index === 0
          ? { weekday: 0, isOpen: false, opensAt: '08:00', closesAt: '09:00' }
          : day,
      );
      await assert.rejects(
        hours.replaceOperatingHours(
          owner,
          tenant,
          closedWithTimes,
          'Tutup dengan waktu',
        ),
        /Closed days must not include opening times/,
      );
    });

    it('enforces permissions and tenant scope on schedule writes', async () => {
      const days = fullWeek();
      await hours.replaceOperatingHours(
        kitchenWith,
        tenant,
        days,
        'Kitchen dengan capacity.manage',
      );
      await assert.rejects(
        hours.replaceOperatingHours(
          kitchenWithout,
          tenant,
          days,
          'Kitchen tanpa permission',
        ),
        /Tenant permission denied/,
      );
      await assert.rejects(
        hours.replaceOperatingHours(outsider, tenant, days, 'Bukan anggota'),
        /Tenant access denied/,
      );
      await assert.rejects(
        hours.replaceOperatingHours(kitchen2, tenant, days, 'Staf tenant lain'),
        /Tenant access denied/,
      );
      await assert.rejects(
        hours.replaceOperatingHours(
          owner,
          tenantArchived,
          days,
          'Tenant archived',
        ),
        /Tenant access denied/,
      );
    });

    it('lets PostgreSQL reject constraint violations inserted behind the service', async () => {
      await assert.rejects(
        pool.query(
          `INSERT INTO tenant_operating_hours (tenant_id, weekday, is_open, opens_at, closes_at) VALUES ($1, 7, true, '08:00', '09:00')`,
          [tenant2],
        ),
        /tenant_operating_hours_weekday_check/,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO tenant_operating_hours (tenant_id, weekday, is_open, opens_at, closes_at) VALUES ($1, 1, true, NULL, '09:00')`,
          [tenant2],
        ),
        /tenant_operating_hours_time_check/,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO tenant_operating_hours (tenant_id, weekday, is_open, opens_at, closes_at) VALUES ($1, 2, false, '08:00', '09:00')`,
          [tenant2],
        ),
        /tenant_operating_hours_time_check/,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO tenant_operating_hours (tenant_id, weekday, is_open, opens_at, closes_at) VALUES ($1, 3, true, '10:00', '09:00')`,
          [tenant2],
        ),
        /tenant_operating_hours_time_check/,
      );
      await pool.query(
        `INSERT INTO tenant_operating_hours (tenant_id, weekday, is_open, opens_at, closes_at) VALUES ($1, 1, true, '08:00', '09:00')`,
        [tenant2],
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO tenant_operating_hours (tenant_id, weekday, is_open, opens_at, closes_at) VALUES ($1, 1, true, '10:00', '11:00')`,
          [tenant2],
        ),
        /duplicate key value/,
      );
      await pool.query(
        `INSERT INTO tenant_operating_hour_overrides (tenant_id, local_date, is_closed) VALUES ($1, '2099-01-01', true)`,
        [tenant2],
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO tenant_operating_hour_overrides (tenant_id, local_date, is_closed) VALUES ($1, '2099-01-01', true)`,
          [tenant2],
        ),
        /duplicate key value/,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO tenant_operating_hour_overrides (tenant_id, local_date, is_closed, opens_at, closes_at) VALUES ($1, '2099-01-02', true, '08:00', '09:00')`,
          [tenant2],
        ),
        /tenant_operating_overrides_window_check/,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO tenant_operating_hour_overrides (tenant_id, local_date, is_closed) VALUES ($1, '2099-01-03', false)`,
          [tenant2],
        ),
        /tenant_operating_overrides_window_check/,
      );
      await pool.query(
        `DELETE FROM tenant_operating_hour_overrides WHERE tenant_id = $1`,
        [tenant2],
      );
      await pool.query(
        `DELETE FROM tenant_operating_hours WHERE tenant_id = $1`,
        [tenant2],
      );
    });

    it('sets, upserts and removes date overrides with validation and audit', async () => {
      const friday = futureLocalDateForWeekday(5);
      const closed = await hours.setOverride(kitchenWith, tenant, friday, {
        isClosed: true,
        reason: 'Libur kampus',
      });
      assert.deepEqual(closed.data, {
        tenantId: tenant,
        localDate: friday,
        isClosed: true,
        opensAt: null,
        closesAt: null,
        reason: 'Libur kampus',
      });

      // Upsert on the same date replaces the row (unique per tenant+date).
      const reopened = await hours.setOverride(owner, tenant, friday, {
        isClosed: false,
        opensAt: '10:00',
        closesAt: '14:00',
        reason: 'Buka terbatas',
      });
      assert.equal(reopened.data.isClosed, false);
      assert.equal(reopened.data.opensAt, '10:00:00');
      assert.equal(reopened.data.closesAt, '14:00:00');
      const count = await pool.query(
        `SELECT count(*)::int AS n FROM tenant_operating_hour_overrides WHERE tenant_id = $1 AND local_date = $2::date`,
        [tenant, friday],
      );
      assert.equal(count.rows[0].n, 1);

      const auditRows = await pool.query(
        `SELECT action, reason, metadata FROM audit_events
        WHERE scope_id = $1 AND action LIKE 'tenant.operating_hour_override%' ORDER BY occurred_at`,
        [tenant],
      );
      assert.deepEqual(
        auditRows.rows.map((row) => row.action),
        [
          'tenant.operating_hour_override_set',
          'tenant.operating_hour_override_set',
        ],
      );
      assert.equal(auditRows.rows[0].metadata.localDate, friday);
      assert.equal(auditRows.rows[0].metadata.isClosed, true);

      // Validation.
      await assert.rejects(
        hours.setOverride(owner, tenant, friday, {
          isClosed: true,
          opensAt: '08:00',
          closesAt: '09:00',
          reason: 'Bawa waktu saat tutup',
        }),
        /Closed overrides must not include opening times/,
      );
      await assert.rejects(
        hours.setOverride(owner, tenant, friday, {
          isClosed: false,
          opensAt: '08:00',
          reason: 'Tanpa closesAt',
        }),
        /opensAt and closesAt/,
      );
      await assert.rejects(
        hours.setOverride(owner, tenant, friday, {
          isClosed: false,
          opensAt: '18:00',
          closesAt: '09:00',
          reason: 'Terbalik',
        }),
        /closesAt must be later than opensAt/,
      );
      await assert.rejects(
        hours.setOverride(owner, tenant, '2020-01-01', {
          isClosed: true,
          reason: 'Tanggal lampau',
        }),
        /in the past for the tenant timezone/,
      );
      await assert.rejects(
        hours.setOverride(owner, tenant, '01-01-2026', {
          isClosed: true,
          reason: 'Format salah',
        }),
        /YYYY-MM-DD/,
      );
      await assert.rejects(
        hours.setOverride(owner, tenant, '2099-02-30', {
          isClosed: true,
          reason: 'Tanggal tidak nyata',
        }),
        /real calendar date/,
      );
      await assert.rejects(
        hours.setOverride(owner, tenant, friday, {
          isClosed: true,
          reason: '',
        }),
        /1 to 300/,
      );
      await assert.rejects(
        hours.setOverride(owner, tenant, friday, {
          isClosed: true,
          reason: 'x'.repeat(301),
        }),
        /1 to 300/,
      );
      await assert.rejects(
        hours.setOverride(kitchenWithout, tenant, friday, {
          isClosed: true,
          reason: 'Tanpa permission',
        }),
        /Tenant permission denied/,
      );

      // Remove restores weekly schedule and audits.
      const removed = await hours.removeOverride(
        owner,
        tenant,
        friday,
        'Batal libur',
      );
      assert.equal(removed.data.removed, true);
      await assert.rejects(
        hours.removeOverride(owner, tenant, friday, 'Hapus lagi'),
        /Operating hour override not found/,
      );
      const removeAudit = await pool.query(
        `SELECT count(*)::int AS n FROM audit_events
        WHERE scope_id = $1 AND action = 'tenant.operating_hour_override_removed'`,
        [tenant],
      );
      assert.equal(removeAudit.rows[0].n, 1);
    });

    it('resolves the effective window: override beats weekly, missing rows are closed', async () => {
      // Weekly: Sunday closed, others 08:00-17:00.
      await hours.replaceOperatingHours(
        owner,
        tenant,
        fullWeek({ weekday: 0, isOpen: false }),
        'Jadwal dasar resolve',
      );

      const monday = futureLocalDateForWeekday(1);
      const weeklyOpen = await hours.resolveOperatingWindow(tenant, monday);
      assert.deepEqual(weeklyOpen, {
        tenantId: tenant,
        timezone: 'Asia/Jakarta',
        localDate: monday,
        weekday: 1,
        isOpen: true,
        opensAt: '08:00:00',
        closesAt: '17:00:00',
        source: 'weekly',
      });

      const sunday = futureLocalDateForWeekday(0);
      const weeklyClosed = await hours.resolveOperatingWindow(tenant, sunday);
      assert.equal(weeklyClosed.isOpen, false);
      assert.equal(weeklyClosed.source, 'weekly');
      assert.equal(weeklyClosed.weekday, 0);
      assert.equal(weeklyClosed.opensAt, null);

      // A closed override on an open weekly day closes the tenant that date,
      // which is how slot validation must reject that day's slots.
      await hours.setOverride(owner, tenant, monday, {
        isClosed: true,
        reason: 'Pemadaman listrik',
      });
      const overrideClosed = await hours.resolveOperatingWindow(tenant, monday);
      assert.deepEqual(overrideClosed, {
        tenantId: tenant,
        timezone: 'Asia/Jakarta',
        localDate: monday,
        weekday: 1,
        isOpen: false,
        opensAt: null,
        closesAt: null,
        source: 'override',
      });

      // An open override beats a closed weekly day.
      await hours.setOverride(owner, tenant, sunday, {
        isClosed: false,
        opensAt: '09:00',
        closesAt: '12:00',
        reason: 'Bazar Minggu',
      });
      const overrideOpen = await hours.resolveOperatingWindow(tenant, sunday);
      assert.equal(overrideOpen.source, 'override');
      assert.equal(overrideOpen.isOpen, true);
      assert.equal(overrideOpen.opensAt, '09:00:00');
      assert.equal(overrideOpen.closesAt, '12:00:00');

      // Missing weekly row resolves to source none / closed.
      await pool.query(
        `DELETE FROM tenant_operating_hours WHERE tenant_id = $1 AND weekday = 3`,
        [tenant],
      );
      const wednesday = futureLocalDateForWeekday(3);
      const none = await hours.resolveOperatingWindow(tenant, wednesday);
      assert.equal(none.source, 'none');
      assert.equal(none.isOpen, false);

      // D12 weekday convention: fixed known calendar facts.
      const knownSunday = await hours.resolveOperatingWindow(
        tenant,
        '2026-11-15',
      );
      assert.equal(knownSunday.weekday, 0, '2026-11-15 is Sunday (0)');
      const knownMonday = await hours.resolveOperatingWindow(
        tenant,
        '2026-11-16',
      );
      assert.equal(knownMonday.weekday, 1, '2026-11-16 is Monday (1)');

      // Archived / unknown tenants are 404; bad dates 400.
      await assert.rejects(
        hours.resolveOperatingWindow(tenantArchived, monday),
        /Tenant not found/,
      );
      await assert.rejects(
        hours.resolveOperatingWindow(randomUUID(), monday),
        /Tenant not found/,
      );
      await assert.rejects(
        hours.resolveOperatingWindow(tenant, '2026-13-45'),
        /real calendar date/,
      );

      // D8: read-only inside a caller transaction via PoolClient.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inTx = await hours.resolveOperatingWindow(tenant, monday, client);
        assert.equal(inTx.source, 'override');
        assert.equal(inTx.isOpen, false);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('lists weekly hours plus only upcoming overrides publicly', async () => {
      const future = futureLocalDateForWeekday(6);
      const past = new Date(Date.now() - 40 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      await pool.query(
        `INSERT INTO tenant_operating_hour_overrides (tenant_id, local_date, is_closed, reason, updated_at)
       VALUES ($1, $2::date, true, 'Sudah lewat', now())`,
        [tenant, past],
      );
      await pool.query(
        `INSERT INTO tenant_operating_hour_overrides (tenant_id, local_date, is_closed, reason, updated_at)
       VALUES ($1, $2::date, true, 'Libur akhir tahun', now())
       ON CONFLICT (tenant_id, local_date) DO NOTHING`,
        [tenant, future],
      );
      const listed = await hours.listOperatingHours(tenant);
      assert.equal(listed.data.timezone, 'Asia/Jakarta');
      const dates = listed.data.overrides.map((row) => row.localDate);
      assert.ok(dates.includes(future));
      assert.ok(!dates.includes(past), 'past overrides must not be listed');
      await assert.rejects(
        hours.listOperatingHours(tenantArchived),
        /Tenant not found/,
      );
    });
  },
);
