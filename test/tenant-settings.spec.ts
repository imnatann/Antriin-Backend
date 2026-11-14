import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { TenantsService } from '../src/modules/tenants/tenants.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const MICRO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

async function createEnv(pool: Pool) {
  const tag = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      `insert into campuses (name, timezone, status)
       values ($1, 'Asia/Jakarta', 'active') returning id`,
      ['Campus ' + tag],
    )
  ).rows[0].id;
  const tenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusId, 'Tenant ' + tag, 'Loket ' + tag],
    )
  ).rows[0].id;
  const mkUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [name + ' ' + tag],
      )
    ).rows[0].id;
  const ownerId = await mkUser('Owner');
  const kitchenId = await mkUser('Kitchen');
  const kitchenElevatedId = await mkUser('KitchenElevated');
  const outsiderId = await mkUser('Outsider');
  const campusAdminId = await mkUser('CampusAdmin');
  await pool.query(
    `insert into tenant_memberships
       (tenant_id, user_id, role, permissions, status, owner_verified_at)
     values ($1, $2, 'owner', '{}'::text[], 'active', now())`,
    [tenantId, ownerId],
  );
  // Kitchen staff never hold tenant.settings.manage: the role allowlist in
  // AccessService does not include it, so even an explicit grant is refused.
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role, permissions, status)
     values ($1, $2, 'kitchen', $3::text[], 'active')`,
    [tenantId, kitchenId, ['tenant.orders.read', 'tenant.capacity.manage']],
  );
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role, permissions, status)
     values ($1, $2, 'kitchen', $3::text[], 'active')`,
    [tenantId, kitchenElevatedId, ['tenant.settings.manage']],
  );
  await pool.query(
    `insert into campus_memberships (campus_id, user_id, permissions, status)
     values ($1, $2, $3::text[], 'active')`,
    [campusId, campusAdminId, ['campus.tenants.manage']],
  );
  return {
    tag,
    campusId,
    tenantId,
    ownerId,
    kitchenId,
    kitchenElevatedId,
    outsiderId,
    campusAdminId,
  };
}

async function currentUpdatedAt(pool: Pool, tenantId: string): Promise<string> {
  const result = await pool.query<{ iso: string }>(
    `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS iso
       FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return result.rows[0].iso;
}

async function assertHttpError(
  promise: Promise<unknown>,
  status: number,
  code?: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const httpError = error as {
      getStatus?: () => number;
      getResponse?: () => unknown;
    };
    assert.equal(
      typeof httpError.getStatus,
      'function',
      'expected an HttpException',
    );
    assert.equal(httpError.getStatus?.(), status);
    if (code) {
      const body = httpError.getResponse?.() as { code?: string } | undefined;
      assert.equal(body?.code, code);
    }
    return true;
  });
}

describe(
  'Tenant settings (owner-managed stall profile) PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let tenants: TenantsService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      await pool.query('select 1');
      const database = { pool } as unknown as DatabaseService;
      const access = new AccessService(database);
      tenants = new TenantsService(
        database,
        access,
        new AuditService(database, access),
      );
    });
    after(async () => {
      await pool?.end();
    });

    it('lets a verified owner update every profile field and audits the change', async () => {
      const env = await createEnv(pool);
      const expected = await currentUpdatedAt(pool, env.tenantId);

      const updated = await tenants.updateSettings(env.ownerId, env.tenantId, {
        name: 'Kantin Sehat',
        description: 'Masakan rumahan tanpa MSG',
        contact: '0812-3456-7890',
        pickupInstructions: 'Ambil di loket A lantai 1, tunjukkan kode pesanan',
        location: 'Gedung C Lantai 1',
        reason: 'Profil publik perdana',
        expectedUpdatedAt: expected,
      });

      assert.equal(updated.data.id, env.tenantId);
      assert.equal(updated.data.campusId, env.campusId);
      assert.equal(updated.data.name, 'Kantin Sehat');
      assert.equal(updated.data.description, 'Masakan rumahan tanpa MSG');
      assert.equal(updated.data.contact, '0812-3456-7890');
      assert.equal(
        updated.data.pickupInstructions,
        'Ambil di loket A lantai 1, tunjukkan kode pesanan',
      );
      assert.equal(updated.data.location, 'Gedung C Lantai 1');
      assert.equal(updated.data.status, 'open', 'status is not changed here');
      assert.equal(updated.data.timezone, 'Asia/Jakarta');
      assert.match(
        updated.data.createdAt,
        MICRO_ISO,
        'D7 microsecond createdAt',
      );
      assert.match(
        updated.data.updatedAt,
        MICRO_ISO,
        'D7 microsecond updatedAt',
      );
      assert.notEqual(updated.data.updatedAt, expected);

      const row = await pool.query<{
        name: string;
        description: string;
        contact: string;
        pickup_instructions: string;
        location: string;
      }>(
        `SELECT name, description, contact, pickup_instructions, location
           FROM tenants WHERE id = $1`,
        [env.tenantId],
      );
      assert.equal(row.rows[0].name, 'Kantin Sehat');
      assert.equal(row.rows[0].description, 'Masakan rumahan tanpa MSG');
      assert.equal(row.rows[0].contact, '0812-3456-7890');
      assert.equal(
        row.rows[0].pickup_instructions,
        'Ambil di loket A lantai 1, tunjukkan kode pesanan',
      );
      assert.equal(row.rows[0].location, 'Gedung C Lantai 1');

      const audit = await pool.query<{
        actor_user_id: string;
        scope_type: string;
        action: string;
        target_type: string;
        target_id: string;
        reason: string;
        metadata: {
          campusId?: string;
          changed?: string[];
          previous?: Record<string, string>;
        };
      }>(
        `SELECT actor_user_id, scope_type, action, target_type, target_id,
                reason, metadata
           FROM audit_events
          WHERE target_id = $1 AND action = 'tenant.settings_updated'`,
        [env.tenantId],
      );
      assert.equal(audit.rows.length, 1);
      assert.equal(audit.rows[0].actor_user_id, env.ownerId);
      assert.equal(audit.rows[0].scope_type, 'tenant');
      assert.equal(audit.rows[0].target_type, 'tenant');
      assert.equal(audit.rows[0].reason, 'Profil publik perdana');
      assert.equal(audit.rows[0].metadata.campusId, env.campusId);
      assert.deepEqual([...(audit.rows[0].metadata.changed ?? [])].sort(), [
        'contact',
        'description',
        'location',
        'name',
        'pickupInstructions',
      ]);
      assert.equal(audit.rows[0].metadata.previous?.name, 'Tenant ' + env.tag);
      assert.equal(audit.rows[0].metadata.previous?.contact, '');

      // A partial patch changes only the supplied field.
      const partial = await tenants.updateSettings(env.ownerId, env.tenantId, {
        contact: '0813-0000-0000',
        reason: 'Ganti nomor kontak',
        expectedUpdatedAt: updated.data.updatedAt,
      });
      assert.equal(partial.data.contact, '0813-0000-0000');
      assert.equal(partial.data.name, 'Kantin Sehat');
      assert.equal(partial.data.description, 'Masakan rumahan tanpa MSG');
      assert.equal(partial.data.location, 'Gedung C Lantai 1');
    });

    it('refuses kitchen staff, outsiders and campus admins without tenant.settings.manage', async () => {
      const env = await createEnv(pool);
      const expected = await currentUpdatedAt(pool, env.tenantId);
      for (const actor of [
        env.kitchenId,
        env.kitchenElevatedId,
        env.outsiderId,
        env.campusAdminId,
      ]) {
        await assertHttpError(
          tenants.updateSettings(actor, env.tenantId, {
            name: 'Tidak berhak',
            reason: 'Unauthorized settings write',
            expectedUpdatedAt: expected,
          }),
          403,
        );
      }
      const row = await pool.query<{ name: string }>(
        'SELECT name FROM tenants WHERE id = $1',
        [env.tenantId],
      );
      assert.equal(row.rows[0].name, 'Tenant ' + env.tag);
    });

    it('rejects a stale expectedUpdatedAt with TENANT_VERSION_CONFLICT', async () => {
      const env = await createEnv(pool);
      const expected = await currentUpdatedAt(pool, env.tenantId);
      const first = await tenants.updateSettings(env.ownerId, env.tenantId, {
        contact: '0811-1111-1111',
        reason: 'Kontak pertama',
        expectedUpdatedAt: expected,
      });
      assert.equal(first.data.contact, '0811-1111-1111');

      await assertHttpError(
        tenants.updateSettings(env.ownerId, env.tenantId, {
          contact: '0822-2222-2222',
          reason: 'Token basi',
          expectedUpdatedAt: expected,
        }),
        409,
        'TENANT_VERSION_CONFLICT',
      );

      // Any other version token is stale too (convention D7).
      await assertHttpError(
        tenants.updateSettings(env.ownerId, env.tenantId, {
          contact: '0833-3333-3333',
          reason: 'Token lain',
          expectedUpdatedAt: '2020-01-01T00:00:00.000000Z',
        }),
        409,
        'TENANT_VERSION_CONFLICT',
      );

      const row = await pool.query<{ contact: string }>(
        'SELECT contact FROM tenants WHERE id = $1',
        [env.tenantId],
      );
      assert.equal(row.rows[0].contact, '0811-1111-1111');
    });

    it('rejects a body without any profile field', async () => {
      const env = await createEnv(pool);
      const expected = await currentUpdatedAt(pool, env.tenantId);

      await assertHttpError(
        tenants.updateSettings(env.ownerId, env.tenantId, {
          reason: 'Tanpa field data',
          expectedUpdatedAt: expected,
        }),
        400,
        'TENANT_SETTINGS_EMPTY',
      );
      await assertHttpError(
        tenants.updateSettings(env.ownerId, env.tenantId, {
          description: 'x'.repeat(2001),
          reason: 'Terlalu panjang',
          expectedUpdatedAt: expected,
        }),
        400,
        'TENANT_SETTINGS_INVALID',
      );
      await assertHttpError(
        tenants.updateSettings(env.ownerId, env.tenantId, {
          name: '   ',
          reason: 'Nama kosong',
          expectedUpdatedAt: expected,
        }),
        400,
      );
      await assertHttpError(
        tenants.updateSettings(env.ownerId, env.tenantId, {
          contact: '0812-0000-0000',
          reason: '   ',
          expectedUpdatedAt: expected,
        }),
        400,
      );
    });

    it('hides archived and missing tenants behind 404', async () => {
      const env = await createEnv(pool);
      await pool.query(
        "UPDATE tenants SET status = 'archived', updated_at = now() WHERE id = $1",
        [env.tenantId],
      );
      const expected = await currentUpdatedAt(pool, env.tenantId);
      await assertHttpError(
        tenants.updateSettings(env.ownerId, env.tenantId, {
          name: 'Arsip',
          reason: 'Tenant sudah diarsipkan',
          expectedUpdatedAt: expected,
        }),
        404,
      );
      await assertHttpError(
        tenants.updateSettings(env.ownerId, randomUUID(), {
          name: 'Hantu',
          reason: 'Tenant tidak ada',
          expectedUpdatedAt: expected,
        }),
        404,
      );
    });

    it('exposes the profile on public reads and defaults to empty strings', async () => {
      const env = await createEnv(pool);
      const fresh = await tenants.get(env.tenantId);
      assert.equal(fresh.data.description, '');
      assert.equal(fresh.data.contact, '');
      assert.equal(fresh.data.pickupInstructions, '');

      await tenants.updateSettings(env.ownerId, env.tenantId, {
        description: 'Deskripsi publik',
        contact: 'kontak@kantin.test',
        pickupInstructions: 'Loket B lantai 2',
        reason: 'Isi profil publik',
        expectedUpdatedAt: await currentUpdatedAt(pool, env.tenantId),
      });

      const detail = await tenants.get(env.tenantId);
      assert.equal(detail.data.description, 'Deskripsi publik');
      assert.equal(detail.data.contact, 'kontak@kantin.test');
      assert.equal(detail.data.pickupInstructions, 'Loket B lantai 2');

      const listed = await tenants.list({ campusId: env.campusId });
      const listedRow = listed.data.find((row) => row.id === env.tenantId);
      assert.equal(listedRow?.description, 'Deskripsi publik');
      assert.equal(listedRow?.contact, 'kontak@kantin.test');
      assert.equal(listedRow?.pickupInstructions, 'Loket B lantai 2');

      // PATCH /settings is guarded by expectedUpdatedAt, so the read models
      // must expose the exact token the owner has to echo back (D7).
      const token = await currentUpdatedAt(pool, env.tenantId);
      assert.equal(detail.data.updatedAt, token);
      assert.equal(listedRow?.updatedAt, token);

      const updated = await tenants.updateSettings(env.ownerId, env.tenantId, {
        contact: 'kontak-baru@kantin.test',
        reason: 'Ubah kontak memakai token dari GET publik',
        expectedUpdatedAt: detail.data.updatedAt,
      });
      assert.equal(updated.data.contact, 'kontak-baru@kantin.test');
    });

    it('echoes the profile to a campus admin without letting them edit it', async () => {
      const env = await createEnv(pool);
      await tenants.updateSettings(env.ownerId, env.tenantId, {
        description: 'Profil milik pemilik',
        contact: 'pemilik@kantin.test',
        pickupInstructions: 'Loket C',
        reason: 'Profil pemilik',
        expectedUpdatedAt: await currentUpdatedAt(pool, env.tenantId),
      });

      const adminUpdate = await tenants.update(
        env.campusAdminId,
        env.campusId,
        env.tenantId,
        {
          name: 'Kantin Admin Rename',
          location: 'Gedung D',
          reason: 'Koreksi nama oleh kampus',
          expectedUpdatedAt: await currentUpdatedAt(pool, env.tenantId),
        },
      );
      assert.equal(adminUpdate.data.name, 'Kantin Admin Rename');
      assert.equal(adminUpdate.data.description, 'Profil milik pemilik');
      assert.equal(adminUpdate.data.contact, 'pemilik@kantin.test');
      assert.equal(adminUpdate.data.pickupInstructions, 'Loket C');

      const row = await pool.query<{
        description: string;
        contact: string;
        pickup_instructions: string;
      }>(
        `SELECT description, contact, pickup_instructions
           FROM tenants WHERE id = $1`,
        [env.tenantId],
      );
      assert.equal(row.rows[0].description, 'Profil milik pemilik');
      assert.equal(row.rows[0].contact, 'pemilik@kantin.test');
      assert.equal(row.rows[0].pickup_instructions, 'Loket C');
    });
  },
);
