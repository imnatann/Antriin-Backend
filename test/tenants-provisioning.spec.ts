import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { TenantProvisioningService } from '../src/modules/tenants/tenant-provisioning.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe(
  'TenantProvisioningService PostgreSQL owner bootstrap',
  { skip: !databaseUrl },
  () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const database = { pool } as DatabaseService;
    const access = new AccessService(database);
    const audit = new AuditService(database, access);
    const provisioning = new TenantProvisioningService(database, access, audit);

    const campusA = randomUUID();
    const campusB = randomUUID();
    const adminAccess = randomUUID();
    const adminTenantsOnly = randomUUID();
    const adminB = randomUUID();
    const tenantNoOwner = randomUUID();
    const tenantWithOwner = randomUUID();
    const tenantPromote = randomUUID();
    const tenantArchived = randomUUID();
    const tenantRace = randomUUID();
    const subjectActive = randomUUID();
    const subjectInactive = randomUUID();
    const subjectStaff = randomUUID();
    const raceSubject1 = randomUUID();
    const raceSubject2 = randomUUID();
    const existingOwner = randomUUID();
    const pickupStaff = randomUUID();

    before(async () => {
      await pool.query(
        `INSERT INTO campuses (id, name, timezone, status) VALUES
         ($1, 'Kampus Provisioning A', 'Asia/Jakarta', 'active'),
         ($2, 'Kampus Provisioning B', 'Asia/Jakarta', 'active')`,
        [campusA, campusB],
      );
      await pool.query(
        `INSERT INTO users (id, display_name, status) VALUES
         ($1, 'Admin access A', 'active'),
         ($2, 'Admin tenants only A', 'active'),
         ($3, 'Admin access B', 'active'),
         ($4, 'Subject active', 'active'),
         ($5, 'Subject inactive', 'closed'),
         ($6, 'Subject staff', 'active'),
         ($7, 'Race subject 1', 'active'),
         ($8, 'Race subject 2', 'active'),
         ($9, 'Existing owner', 'active'),
         ($10, 'Pickup staff', 'active')`,
        [
          adminAccess,
          adminTenantsOnly,
          adminB,
          subjectActive,
          subjectInactive,
          subjectStaff,
          raceSubject1,
          raceSubject2,
          existingOwner,
          pickupStaff,
        ],
      );
      await pool.query(
        `INSERT INTO tenants (id, campus_id, name, location, status) VALUES
         ($1, $6, 'Kantin Tanpa Owner', 'Gedung A', 'open'),
         ($2, $6, 'Kantin Berowner', 'Gedung B', 'open'),
         ($3, $6, 'Kantin Promosi Staf', 'Gedung C', 'open'),
         ($4, $6, 'Kantin Arsip Provisioning', 'Gedung D', 'archived'),
         ($5, $6, 'Kantin Race Provisioning', 'Gedung E', 'open')`,
        [
          tenantNoOwner,
          tenantWithOwner,
          tenantPromote,
          tenantArchived,
          tenantRace,
          campusA,
        ],
      );
      await pool.query(
        `INSERT INTO campus_memberships (campus_id, user_id, permissions) VALUES
         ($1, $3, ARRAY['campus.access.manage','campus.tenants.manage']::text[]),
         ($1, $4, ARRAY['campus.tenants.manage']::text[]),
         ($2, $5, ARRAY['campus.access.manage']::text[])`,
        [campusA, campusB, adminAccess, adminTenantsOnly, adminB],
      );
      await pool.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, owner_verified_at) VALUES
         ($1, $2, 'owner', '{}'::text[], now()),
         ($3, $4, 'kitchen', ARRAY['tenant.orders.read']::text[], NULL)`,
        [tenantWithOwner, existingOwner, tenantPromote, subjectStaff],
      );
    });

    after(async () => {
      await pool.end();
    });

    it('bootstraps the first verified owner with membership and double audit rows', async () => {
      const result = await provisioning.provisionTenantOwner(
        adminAccess,
        campusA,
        tenantNoOwner,
        {
          subjectUserId: subjectActive,
          reason: 'Pemilik pertama diverifikasi pengelola kampus',
        },
      );
      assert.equal(result.data.role, 'owner');
      assert.equal(result.data.status, 'active');
      assert.equal(result.data.ownerUserId, subjectActive);

      const membership = await pool.query(
        `SELECT role, status, owner_verified_at, permissions FROM tenant_memberships WHERE id = $1`,
        [result.data.membershipId],
      );
      assert.equal(membership.rows[0].role, 'owner');
      assert.equal(membership.rows[0].status, 'active');
      assert.ok(membership.rows[0].owner_verified_at instanceof Date);
      assert.deepEqual(membership.rows[0].permissions, []);

      const accessAudit = await pool.query(
        `SELECT actor_user_id, subject_user_id, action, reason FROM access_audit_events WHERE membership_id = $1`,
        [result.data.membershipId],
      );
      assert.equal(accessAudit.rows.length, 1);
      assert.equal(accessAudit.rows[0].action, 'grant');
      assert.equal(accessAudit.rows[0].actor_user_id, adminAccess);

      const auditRow = await pool.query(
        `SELECT actor_user_id, scope_type, action, target_type, reason, metadata FROM audit_events
        WHERE target_id = $1`,
        [result.data.membershipId],
      );
      assert.equal(auditRow.rows.length, 1);
      assert.equal(auditRow.rows[0].action, 'tenant.owner_provisioned');
      assert.equal(auditRow.rows[0].scope_type, 'tenant');
      assert.equal(auditRow.rows[0].target_type, 'membership');
      assert.equal(auditRow.rows[0].metadata.subjectUserId, subjectActive);

      // The new owner passes verified-owner checks, including finance.
      const authorized = await access.requireTenant(
        subjectActive,
        tenantNoOwner,
        'tenant.finance.read',
      );
      assert.equal(authorized.role, 'owner');
      assert.equal(authorized.membershipId, result.data.membershipId);
    });

    it('lets the provisioned owner manage staff, and revocation stops access immediately', async () => {
      await access.grantTenantMembership({
        actorUserId: subjectActive,
        tenantId: tenantNoOwner,
        subjectUserId: pickupStaff,
        role: 'pickup',
        permissions: ['tenant.orders.read', 'tenant.orders.handover'],
        reason: 'Petugas ambil shift siang',
      });
      await access.requireTenant(
        pickupStaff,
        tenantNoOwner,
        'tenant.orders.handover',
      );
      await access.revokeTenantMembership({
        actorUserId: subjectActive,
        tenantId: tenantNoOwner,
        subjectUserId: pickupStaff,
        reason: 'Shift selesai',
      });
      await assert.rejects(
        access.requireTenant(
          pickupStaff,
          tenantNoOwner,
          'tenant.orders.handover',
        ),
        /Tenant access denied/,
      );
    });

    it('refuses a second owner, wrong permissions, wrong campus, self and inactive targets', async () => {
      await assert.rejects(
        provisioning.provisionTenantOwner(adminAccess, campusA, tenantNoOwner, {
          subjectUserId: raceSubject1,
          reason: 'Owner kedua',
        }),
        /Tenant already has an active owner/,
      );
      await assert.rejects(
        provisioning.provisionTenantOwner(
          adminAccess,
          campusA,
          tenantWithOwner,
          {
            subjectUserId: subjectActive,
            reason: 'Tenant sudah berowner',
          },
        ),
        /Tenant already has an active owner/,
      );
      await assert.rejects(
        provisioning.provisionTenantOwner(
          adminTenantsOnly,
          campusA,
          tenantNoOwner,
          {
            subjectUserId: raceSubject1,
            reason: 'Tanpa campus.access.manage',
          },
        ),
        /Campus permission denied/,
      );
      await assert.rejects(
        provisioning.provisionTenantOwner(adminB, campusA, tenantNoOwner, {
          subjectUserId: raceSubject1,
          reason: 'Admin kampus B',
        }),
        /Campus access denied/,
      );
      // adminAccess is not a member of campus B at all.
      await assert.rejects(
        provisioning.provisionTenantOwner(adminAccess, campusB, tenantNoOwner, {
          subjectUserId: raceSubject1,
          reason: 'Bukan anggota kampus B',
        }),
        /Campus access denied/,
      );
      // adminB is authorized in campus B, but the tenant belongs to campus A.
      await assert.rejects(
        provisioning.provisionTenantOwner(adminB, campusB, tenantNoOwner, {
          subjectUserId: raceSubject1,
          reason: 'Tenant terikat kampus lain',
        }),
        /Tenant not found/,
      );
      await assert.rejects(
        provisioning.provisionTenantOwner(adminAccess, campusA, tenantNoOwner, {
          subjectUserId: adminAccess,
          reason: 'Angkat diri sendiri',
        }),
        /Self-provisioning is not allowed/,
      );
      // Uses tenantRace (still ownerless at this point): with the owner-conflict
      // check ordered first, an inactive target must be probed on a tenant that
      // can actually still receive an owner.
      await assert.rejects(
        provisioning.provisionTenantOwner(adminAccess, campusA, tenantRace, {
          subjectUserId: subjectInactive,
          reason: 'Target tidak aktif',
        }),
        /Active target user not found/,
      );
      await assert.rejects(
        provisioning.provisionTenantOwner(
          adminAccess,
          campusA,
          tenantArchived,
          {
            subjectUserId: raceSubject1,
            reason: 'Tenant archived',
          },
        ),
        /Tenant not found/,
      );
      await assert.rejects(
        provisioning.provisionTenantOwner(adminAccess, campusA, tenantNoOwner, {
          subjectUserId: raceSubject1,
          reason: '   ',
        }),
        /reason of 1 to 500/,
      );
    });

    it('promotes an existing staff membership to verified owner', async () => {
      const result = await provisioning.provisionTenantOwner(
        adminAccess,
        campusA,
        tenantPromote,
        {
          subjectUserId: subjectStaff,
          reason: 'Promosi kitchen menjadi owner terverifikasi',
        },
      );
      const membership = await pool.query(
        `SELECT role, status, permissions, owner_verified_at FROM tenant_memberships WHERE id = $1`,
        [result.data.membershipId],
      );
      assert.equal(membership.rows[0].role, 'owner');
      assert.deepEqual(membership.rows[0].permissions, []);
      assert.ok(membership.rows[0].owner_verified_at instanceof Date);
      const rows = await pool.query(
        `SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
        [tenantPromote, subjectStaff],
      );
      assert.equal(
        rows.rows[0].n,
        1,
        'promotion must not create a second membership',
      );
      await access.requireTenant(
        subjectStaff,
        tenantPromote,
        'tenant.finance.read',
      );
    });

    it('serializes concurrent owner bootstraps so exactly one owner wins', async () => {
      const attempts = await Promise.allSettled([
        provisioning.provisionTenantOwner(adminAccess, campusA, tenantRace, {
          subjectUserId: raceSubject1,
          reason: 'Race owner 1',
        }),
        provisioning.provisionTenantOwner(adminAccess, campusA, tenantRace, {
          subjectUserId: raceSubject2,
          reason: 'Race owner 2',
        }),
      ]);
      const fulfilled = attempts.filter(
        (attempt) => attempt.status === 'fulfilled',
      );
      const rejected = attempts.filter(
        (attempt) => attempt.status === 'rejected',
      );
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.match(
        String((rejected[0] as { reason: Error }).reason.message),
        /Tenant already has an active owner/,
      );
      const owners = await pool.query(
        `SELECT count(*)::int AS n FROM tenant_memberships
        WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'`,
        [tenantRace],
      );
      assert.equal(owners.rows[0].n, 1);
    });

    it('keeps the provisioning audit trail immutable', async () => {
      await assert.rejects(
        pool.query(
          `UPDATE audit_events SET reason = 'tampered' WHERE action = 'tenant.owner_provisioned'`,
        ),
        /immutable|append-only/,
      );
      await assert.rejects(
        pool.query(
          `DELETE FROM audit_events WHERE action = 'tenant.owner_provisioned'`,
        ),
        /immutable|append-only/,
      );
    });
  },
);
