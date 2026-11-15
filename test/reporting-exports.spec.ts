import 'reflect-metadata';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { ReportingService } from '../src/modules/reporting/reporting.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const WINDOW = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
};

/** D7: timestamps travel as microsecond UTC strings, never through Date. */
const MICRO_UTC_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

type Env = Awaited<ReturnType<typeof createEnv>>;

/** Every user this file creates, so each test can drop its own pending rows. */
const createdUserIds: string[] = [];

async function createEnv(pool: Pool) {
  const tag = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      'insert into campuses (name) values ($1) returning id',
      ['Campus ' + tag],
    )
  ).rows[0].id;
  // A second campus in another zone proves the scheduled hour is local to the
  // campus rather than UTC.
  const nyCampusId = (
    await pool.query<{ id: string }>(
      "insert into campuses (name, timezone) values ($1, 'America/New_York') returning id",
      ['NY campus ' + tag],
    )
  ).rows[0].id;
  const tenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusId, 'Tenant ' + tag, 'Location ' + tag],
    )
  ).rows[0].id;
  const nyTenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [nyCampusId, 'NY tenant ' + tag, 'NY location ' + tag],
    )
  ).rows[0].id;
  const mkUser = async (name: string) => {
    const id = (
      await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [name + ' ' + tag],
      )
    ).rows[0].id;
    createdUserIds.push(id);
    return id;
  };
  const ownerId = await mkUser('Owner');
  const adminId = await mkUser('CampusAdmin');
  const outsiderId = await mkUser('Outsider');
  for (const tenant of [tenantId, nyTenantId]) {
    await pool.query(
      "insert into tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) values ($1, $2, 'owner', $3::text[], 'active', now())",
      [tenant, ownerId, ['tenant.sales.read']],
    );
  }
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [campusId, adminId, ['campus.transactions.read']],
  );
  return {
    tag,
    campusId,
    nyCampusId,
    tenantId,
    nyTenantId,
    ownerId,
    adminId,
    outsiderId,
  };
}

async function expectHttpStatus(
  promise: Promise<unknown>,
  status: number,
  code?: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const httpError = error as {
      status?: number;
      getResponse?: () => unknown;
    };
    assert.equal(httpError.status, status);
    if (code) {
      const body = httpError.getResponse?.() as { code?: string } | undefined;
      assert.equal(body?.code, code);
    }
    return true;
  });
}

/** Local wall-clock hour of an instant in a zone, read with Intl. */
function localHour(instant: string, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(instant)),
  );
}

function tenantTarget(env: Env) {
  return { type: 'tenant' as const, id: env.tenantId };
}

function campusTarget(env: Env) {
  return { type: 'campus' as const, id: env.campusId };
}

describe(
  'Report exports PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let secondPool: Pool;
    let reporting: ReportingService;
    let secondWorker: ReportingService;

    const service = (target: Pool) =>
      new ReportingService(
        { pool: target } as unknown as DatabaseService,
        new AccessService({ pool: target } as unknown as DatabaseService),
      );

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      secondPool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
      await pool.query('select 1');
      // runDueExports() claims every due row in the database, so a row left
      // behind by an interrupted earlier run of this file would make the batch
      // non-deterministic. report_exports has no other writer: no other spec
      // creates rows and no endpoint inserts outside these tests.
      await pool.query('delete from report_exports');
      reporting = service(pool);
      secondWorker = service(secondPool);
    });

    after(async () => {
      await pool?.end();
      await secondPool?.end();
    });

    // A due row from an earlier test would be picked up by the next batch, so
    // each test starts with only the rows it creates itself.
    beforeEach(async () => {
      if (createdUserIds.length === 0) return;
      await pool.query(
        'delete from report_exports where created_by = any($1::uuid[])',
        [createdUserIds],
      );
    });

    async function storedRow(id: string) {
      const result = await pool.query<{
        status: string;
        error: string | null;
        next_run_at: Date | null;
        generated_at: Date | null;
        range_from: string | null;
        range_to: string | null;
        schedule: string;
        schedule_hour: number | null;
        media_asset_id: string | null;
      }>(
        `select status, error, next_run_at, generated_at, range_from, range_to,
                schedule, schedule_hour, media_asset_id
           from report_exports where id = $1`,
        [id],
      );
      return result.rows[0];
    }

    it('stores a manual export as due now with a day-granular window', async () => {
      const env = await createEnv(pool);
      const view = await reporting.createExport(
        env.ownerId,
        tenantTarget(env),
        { kind: 'sales', format: 'pdf', ...WINDOW },
      );

      assert.equal(view.kind, 'sales');
      assert.equal(view.format, 'pdf');
      assert.equal(view.schedule, 'manual');
      assert.equal(view.scheduleHour, null);
      // The window is stored as calendar dates and echoed back unchanged.
      assert.equal(view.from, '2026-01-01');
      assert.equal(view.to, '2026-02-01');
      assert.equal(view.status, 'pending');
      assert.equal(view.mediaAssetId, null);
      assert.equal(
        view.downloadPath,
        '/api/v1/tenants/' + env.tenantId + '/reports/sales.pdf',
      );
      assert.match(view.createdAt, MICRO_UTC_PATTERN);
      assert.match(view.nextRunAt ?? '', MICRO_UTC_PATTERN);

      const row = await storedRow(view.id);
      assert.equal(row.schedule, 'manual');
      assert.equal(row.schedule_hour, null);
      assert.equal(row.range_from, '2026-01-01');
      assert.ok(row.next_run_at, 'a manual export is due immediately');
      assert.ok(
        row.next_run_at.getTime() <= Date.now() + 1000,
        'a manual export must not be scheduled in the future',
      );
    });

    it('generates a due manual export once and never again', async () => {
      const env = await createEnv(pool);
      const view = await reporting.createExport(
        env.ownerId,
        tenantTarget(env),
        { kind: 'sales', format: 'pdf', ...WINDOW },
      );

      const first = await reporting.runDueExports();
      assert.equal(first.generated, 1);
      assert.equal(first.failed, 0);

      const row = await storedRow(view.id);
      assert.equal(row.status, 'ready');
      assert.equal(row.error, null);
      assert.ok(row.generated_at, 'generated_at must be stamped');
      // A manual export is one-off: it is never due again.
      assert.equal(row.next_run_at, null);

      const second = await reporting.runDueExports();
      assert.deepEqual(second, { generated: 0, failed: 0 });
    });

    it('schedules a daily export at the next local hour of the campus zone', async () => {
      const env = await createEnv(pool);
      const view = await reporting.createExport(
        env.ownerId,
        { type: 'tenant', id: env.nyTenantId },
        {
          kind: 'sales',
          format: 'pdf',
          ...WINDOW,
          schedule: 'daily',
          scheduleHour: 7,
        },
      );
      assert.equal(view.schedule, 'daily');
      assert.equal(view.scheduleHour, 7);
      assert.ok(view.nextRunAt);
      // Tenant export follows its campus zone, not UTC.
      assert.equal(localHour(view.nextRunAt, 'America/New_York'), 7);
      assert.ok(new Date(view.nextRunAt).getTime() > Date.now());

      // Not due yet: a run generates nothing for it.
      const run = await reporting.runDueExports();
      assert.deepEqual(run, { generated: 0, failed: 0 });
      assert.equal((await storedRow(view.id)).status, 'pending');
    });

    it('regenerates a due scheduled export and advances its next run', async () => {
      const env = await createEnv(pool);
      const view = await reporting.createExport(
        env.adminId,
        campusTarget(env),
        {
          kind: 'dashboard',
          format: 'csv',
          ...WINDOW,
          schedule: 'weekly',
          scheduleHour: 3,
        },
      );
      // Force it due: the schedule itself is unchanged.
      await pool.query(
        "update report_exports set next_run_at = now() - interval '1 hour' where id = $1",
        [view.id],
      );

      const run = await reporting.runDueExports();
      assert.deepEqual(run, { generated: 1, failed: 0 });

      const row = await storedRow(view.id);
      assert.equal(row.status, 'ready');
      assert.ok(row.generated_at);
      assert.ok(row.next_run_at);
      assert.ok(
        row.next_run_at.getTime() > Date.now(),
        'the next run must be in the future, or the row is due again',
      );
      assert.equal(localHour(row.next_run_at.toISOString(), 'Asia/Jakarta'), 3);
      // A weekly schedule moves to the same weekday in a week.
      const advanced = row.next_run_at;
      const previous = new Date(advanced.getTime() - 7 * 24 * 60 * 60 * 1000);
      assert.equal(
        localHour(advanced.toISOString(), 'Asia/Jakarta'),
        localHour(previous.toISOString(), 'Asia/Jakarta'),
      );

      // The immediate second run must find nothing: the schedule advanced.
      const again = await reporting.runDueExports();
      assert.deepEqual(again, { generated: 0, failed: 0 });
    });

    it('claims a due export for exactly one of two concurrent workers', async () => {
      const env = await createEnv(pool);
      const view = await reporting.createExport(
        env.adminId,
        campusTarget(env),
        { kind: 'dashboard', format: 'pdf', ...WINDOW },
      );
      const [first, second] = await Promise.all([
        reporting.runDueExports(),
        secondWorker.runDueExports(),
      ]);
      assert.equal(
        first.generated + second.generated,
        1,
        'a due export was generated twice',
      );
      assert.equal((await storedRow(view.id)).status, 'ready');
    });

    it('records a failed run and advances the schedule instead of retrying forever', async () => {
      const env = await createEnv(pool);
      const view = await reporting.createExport(
        env.adminId,
        campusTarget(env),
        {
          kind: 'dashboard',
          format: 'pdf',
          ...WINDOW,
          schedule: 'daily',
          scheduleHour: 5,
        },
      );
      await pool.query(
        "update report_exports set next_run_at = now() - interval '1 minute' where id = $1",
        [view.id],
      );
      // The creator loses access: a background run must stop, not keep producing
      // reports on behalf of someone who no longer may read them.
      await pool.query(
        "update campus_memberships set status = 'revoked', revoked_at = now() where campus_id = $1 and user_id = $2",
        [env.campusId, env.adminId],
      );

      const run = await reporting.runDueExports();
      assert.deepEqual(run, { generated: 0, failed: 1 });

      const row = await storedRow(view.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.error, 'REPORT_EXPORT_SCOPE_REVOKED');
      assert.ok(
        row.next_run_at && row.next_run_at.getTime() > Date.now(),
        'a failed export still advances its schedule',
      );
    });

    it('stops a schedule whose stored hour cannot place a run', async () => {
      const env = await createEnv(pool);
      const insert = await pool.query<{ id: string }>(
        `insert into report_exports
           (tenant_id, kind, format, range_from, range_to, schedule, schedule_hour,
            next_run_at, status, created_by)
         values ($1, 'sales', 'pdf', '2026-01-01', '2026-02-01', 'daily', null,
                 now() - interval '1 minute', 'pending', $2)
         returning id`,
        [env.tenantId, env.ownerId],
      );
      const id = insert.rows[0].id;

      const run = await reporting.runDueExports();
      assert.deepEqual(run, { generated: 0, failed: 1 });
      const row = await storedRow(id);
      assert.equal(row.status, 'failed');
      assert.ok(row.error && row.error.length > 0);
      // Nothing to advance to: a null next_run_at stops the row instead of
      // leaving an export that is due on every single run.
      assert.equal(row.next_run_at, null);

      const again = await reporting.runDueExports();
      assert.deepEqual(again, { generated: 0, failed: 0 });
    });

    it('lists the scope exports newest first and hides other scopes', async () => {
      const env = await createEnv(pool);
      const first = await reporting.createExport(
        env.ownerId,
        tenantTarget(env),
        {
          kind: 'sales',
          format: 'csv',
          ...WINDOW,
        },
      );
      const second = await reporting.createExport(
        env.ownerId,
        tenantTarget(env),
        {
          kind: 'sales',
          format: 'pdf',
          ...WINDOW,
          schedule: 'daily',
          scheduleHour: 9,
        },
      );
      const campusExport = await reporting.createExport(
        env.adminId,
        campusTarget(env),
        { kind: 'dashboard', format: 'pdf', ...WINDOW },
      );

      const page = await reporting.listExports(env.ownerId, tenantTarget(env));
      assert.deepEqual(
        page.items.map((item) => item.id),
        [second.id, first.id],
      );
      assert.equal(page.truncated, false);
      assert.equal(
        page.items.some((item) => item.id === campusExport.id),
        false,
        'a campus export leaked into the tenant list',
      );
      assert.equal(page.items[0].status, 'pending');

      const campusPage = await reporting.listExports(
        env.adminId,
        campusTarget(env),
      );
      assert.deepEqual(
        campusPage.items.map((item) => item.id),
        [campusExport.id],
      );
    });

    it('denies creating or listing exports without the report permission', async () => {
      const env = await createEnv(pool);
      for (const target of [tenantTarget(env), campusTarget(env)]) {
        await expectHttpStatus(
          reporting.createExport(env.outsiderId, target, {
            kind: target.type === 'tenant' ? 'sales' : 'dashboard',
            format: 'pdf',
            ...WINDOW,
          }),
          403,
        );
        await expectHttpStatus(
          reporting.listExports(env.outsiderId, target),
          403,
        );
      }
      // A tenant owner has no campus permission and vice versa.
      await expectHttpStatus(
        reporting.createExport(env.ownerId, campusTarget(env), {
          kind: 'dashboard',
          format: 'pdf',
          ...WINDOW,
        }),
        403,
      );
      await expectHttpStatus(
        reporting.createExport(env.adminId, tenantTarget(env), {
          kind: 'sales',
          format: 'pdf',
          ...WINDOW,
        }),
        403,
      );
    });

    it('rejects a kind, format or scope combination it cannot produce', async () => {
      const env = await createEnv(pool);
      await expectHttpStatus(
        reporting.createExport(env.ownerId, tenantTarget(env), {
          kind: 'dashboard',
          format: 'pdf',
          ...WINDOW,
        }),
        400,
        'REPORT_EXPORT_KIND_SCOPE_MISMATCH',
      );
      await expectHttpStatus(
        reporting.createExport(env.adminId, campusTarget(env), {
          kind: 'sales',
          format: 'pdf',
          ...WINDOW,
        }),
        400,
        'REPORT_EXPORT_KIND_SCOPE_MISMATCH',
      );
      await expectHttpStatus(
        reporting.createExport(env.ownerId, tenantTarget(env), {
          kind: 'payouts',
          format: 'pdf',
          ...WINDOW,
        }),
        400,
        'REPORT_EXPORT_KIND_INVALID',
      );
      await expectHttpStatus(
        reporting.createExport(env.ownerId, tenantTarget(env), {
          kind: 'sales',
          format: 'xlsx',
          ...WINDOW,
        }),
        400,
        'REPORT_EXPORT_FORMAT_INVALID',
      );

      const stored = await pool.query(
        'select 1 from report_exports where tenant_id = $1',
        [env.tenantId],
      );
      assert.equal(stored.rowCount, 0, 'a rejected request must store nothing');
    });

    it('rejects an impossible schedule and an unrepresentable window', async () => {
      const env = await createEnv(pool);
      await expectHttpStatus(
        reporting.createExport(env.ownerId, tenantTarget(env), {
          kind: 'sales',
          format: 'pdf',
          ...WINDOW,
          schedule: 'daily',
        }),
        400,
        'REPORT_EXPORT_SCHEDULE_HOUR_REQUIRED',
      );
      await expectHttpStatus(
        reporting.createExport(env.ownerId, tenantTarget(env), {
          kind: 'sales',
          format: 'pdf',
          ...WINDOW,
          scheduleHour: 7,
        }),
        400,
        'REPORT_EXPORT_SCHEDULE_HOUR_NOT_ALLOWED',
      );
      await expectHttpStatus(
        reporting.createExport(env.ownerId, tenantTarget(env), {
          kind: 'sales',
          format: 'pdf',
          from: WINDOW.to,
          to: WINDOW.from,
        }),
        400,
        'REPORT_RANGE_INVALID',
      );
      // Stored as calendar dates, so a window shorter than a day cannot be
      // represented; it is refused rather than silently widened.
      await expectHttpStatus(
        reporting.createExport(env.ownerId, tenantTarget(env), {
          kind: 'sales',
          format: 'pdf',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-01T09:00:00.000Z',
        }),
        400,
        'REPORT_EXPORT_RANGE_INVALID',
      );
      await expectHttpStatus(
        reporting.createExport(env.ownerId, tenantTarget(env), {
          kind: 'sales',
          format: 'pdf',
          from: '2025-01-01T00:00:00.000Z',
          to: '2026-06-01T00:00:00.000Z',
        }),
        400,
        'REPORT_RANGE_TOO_LARGE',
      );
    });

    it('does not let two workers claim the same batch of many due exports', async () => {
      const env = await createEnv(pool);
      const ids: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const view = await reporting.createExport(
          env.ownerId,
          tenantTarget(env),
          {
            kind: 'sales',
            format: index % 2 === 0 ? 'pdf' : 'csv',
            ...WINDOW,
          },
        );
        ids.push(view.id);
      }
      const [first, second] = await Promise.all([
        reporting.runDueExports(),
        secondWorker.runDueExports(),
      ]);
      assert.equal(first.generated + second.generated, 6);
      assert.equal(first.failed + second.failed, 0);

      const rows = await pool.query<{
        status: string;
        generated_at: Date | null;
      }>(
        'select status, generated_at from report_exports where id = any($1::uuid[])',
        [ids],
      );
      for (const row of rows.rows) {
        assert.equal(row.status, 'ready');
        assert.ok(row.generated_at);
      }
    });
  },
);
