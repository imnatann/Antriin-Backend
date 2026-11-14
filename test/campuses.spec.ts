import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { CampusesService } from '../src/modules/campuses/campuses.service';
import { CampusProvisioningService } from '../src/modules/campuses/campus-provisioning.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe(
  'Campuses discovery and controlled provisioning',
  { skip: !databaseUrl },
  () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const database = { pool } as DatabaseService;
    const access = new AccessService(database);
    const audit = new AuditService(database, access);
    const campuses = new CampusesService(database);
    const provisioning = new CampusProvisioningService(database, access, audit);

    // Unique per-run token so repeated runs against the same database never
    // collide on name-based search assertions.
    const run = randomUUID().slice(0, 8);
    const campusA = randomUUID();
    const campusB = randomUUID();
    const campusInactive = randomUUID();
    const tenantAOpen = randomUUID();
    const tenantAClosed = randomUUID();
    const tenantAArchived = randomUUID();
    const tenantBOpen = randomUUID();
    const bootstrappedAdmin = randomUUID();
    const secondAdmin = randomUUID();
    const thirdUser = randomUUID();
    const outsider = randomUUID();
    const inactiveUser = randomUUID();

    before(async () => {
      await pool.query(
        `INSERT INTO campuses (id, name, timezone, status) VALUES
         ($1, $4, 'Asia/Jakarta', 'active'),
         ($2, $5, 'Asia/Jakarta', 'active'),
         ($3, $6, 'Asia/Jakarta', 'inactive')`,
        [
          campusA,
          campusB,
          campusInactive,
          `Kampus Alpha Discovery ${run}`,
          `Kampus Beta Discovery ${run}`,
          `Kampus Gamma Nonaktif ${run}`,
        ],
      );
      await pool.query(
        `INSERT INTO tenants (id, campus_id, name, location, status) VALUES
         ($1, $5, 'Kantin Alpha Terbuka', 'Gedung A', 'open'),
         ($2, $5, 'Kantin Alpha Tutup', 'Gedung B', 'closed'),
         ($3, $5, 'Kantin Alpha Arsip', 'Gedung C', 'archived'),
         ($4, $6, 'Kantin Beta Terbuka', 'Gedung D', 'open')`,
        [
          tenantAOpen,
          tenantAClosed,
          tenantAArchived,
          tenantBOpen,
          campusA,
          campusB,
        ],
      );
      await pool.query(
        `INSERT INTO users (id, display_name, status) VALUES
         ($1, 'Bootstrapped admin', 'active'),
         ($2, 'Second admin', 'active'),
         ($3, 'Third user', 'active'),
         ($4, 'Outsider', 'active'),
         ($5, 'Inactive target', 'closed')`,
        [bootstrappedAdmin, secondAdmin, thirdUser, outsider, inactiveUser],
      );
    });

    after(async () => {
      // Fixtures live only in the isolated, disposable TEST_DATABASE_URL.
      await pool.end();
    });

    it('lists and searches only active campuses', async () => {
      // The database is shared between runs, so an unscoped list is capped and
      // ordered globally; scope the membership assertions to this run's names
      // instead of assuming they land inside the first page.
      const all = await campuses.list({ limit: 100 });
      assert.ok(all.data.every((row) => row.status === 'active'));

      const mine = await campuses.list({ search: run, limit: 100 });
      const names = mine.data.map((row) => row.name);
      assert.ok(names.includes(`Kampus Alpha Discovery ${run}`));
      assert.ok(names.includes(`Kampus Beta Discovery ${run}`));
      assert.ok(!names.includes(`Kampus Gamma Nonaktif ${run}`));

      const searched = await campuses.list({
        search: `ALPHA DISCOVERY ${run}`,
      });
      assert.equal(searched.data.length, 1, 'search must be case-insensitive');
      assert.equal(searched.data[0].id, campusA);

      const wildcard = await campuses.list({ search: '%' });
      assert.equal(wildcard.data.length, 0, 'LIKE wildcards must be escaped');

      const limited = await campuses.list({ limit: 1 });
      assert.equal(limited.data.length, 1);
      const clamped = await campuses.list({ limit: 100000 });
      assert.ok(clamped.data.length <= 100);
    });

    it('returns 404 for inactive or unknown campuses on detail', async () => {
      const detail = await campuses.get(campusA);
      assert.equal(detail.data.id, campusA);
      assert.equal(detail.data.timezone, 'Asia/Jakarta');
      await assert.rejects(campuses.get(campusInactive), /Campus not found/);
      await assert.rejects(campuses.get(randomUUID()), /Campus not found/);
    });

    it('lists campus tenants without leaking archived or foreign data', async () => {
      const openOnly = await campuses.listTenants(campusA);
      assert.deepEqual(
        openOnly.data.map((row) => row.id),
        [tenantAOpen],
      );
      assert.equal(openOnly.meta.campusName, `Kampus Alpha Discovery ${run}`);

      const anyStatus = await campuses.listTenants(campusA, { status: 'any' });
      const ids = anyStatus.data.map((row) => row.id).sort();
      assert.deepEqual(ids, [tenantAClosed, tenantAOpen].sort());
      assert.ok(!ids.includes(tenantAArchived));

      const closed = await campuses.listTenants(campusA, { status: 'closed' });
      assert.deepEqual(
        closed.data.map((row) => row.id),
        [tenantAClosed],
      );

      const beta = await campuses.listTenants(campusB);
      assert.deepEqual(
        beta.data.map((row) => row.id),
        [tenantBOpen],
      );

      await assert.rejects(
        campuses.listTenants(campusInactive),
        /Campus not found/,
      );
      await assert.rejects(
        campuses.listTenants(randomUUID()),
        /Campus not found/,
      );
    });

    it('bootstraps the first campus admin via a service principal with audit only in audit_events', async () => {
      const result = await provisioning.provisionCampusAdmin({
        actor: { service: 'bootstrap.test' },
        campusId: campusA,
        subjectUserId: bootstrappedAdmin,
        permissions: ['campus.tenants.manage', 'campus.access.manage'],
        reason: 'Initial campus bootstrap by controlled script',
      });
      assert.equal(result.status, 'active');
      assert.equal(result.campusId, campusA);

      // Membership is effective immediately.
      const authorized = await access.requireCampus(
        bootstrappedAdmin,
        campusA,
        'campus.access.manage',
      );
      assert.equal(authorized.membershipId, result.membershipId);

      // audit_events row written with the service actor.
      const auditRow = await pool.query(
        `SELECT actor_service, actor_user_id, scope_type, scope_id, action, reason, metadata
         FROM audit_events
        WHERE scope_id = $1 AND action = 'campus.admin_provisioned'`,
        [campusA],
      );
      assert.equal(auditRow.rows.length, 1);
      assert.equal(auditRow.rows[0].actor_service, 'bootstrap.test');
      assert.equal(auditRow.rows[0].actor_user_id, null);
      assert.equal(auditRow.rows[0].metadata.subjectUserId, bootstrappedAdmin);

      // Schema limitation: access_audit_events requires actor_user_id NOT NULL,
      // so service-actor bootstraps do not write an access-audit row.
      const accessAudit = await pool.query(
        `SELECT count(*)::int AS n FROM access_audit_events WHERE membership_id = $1`,
        [result.membershipId],
      );
      assert.equal(accessAudit.rows[0].n, 0);
    });

    it('lets an authorized campus admin provision and revoke another admin with both audit trails', async () => {
      const granted = await provisioning.provisionCampusAdmin({
        actor: { userId: bootstrappedAdmin },
        campusId: campusA,
        subjectUserId: secondAdmin,
        permissions: ['campus.transactions.read'],
        reason: 'Add transaction monitoring staff',
      });
      await access.requireCampus(
        secondAdmin,
        campusA,
        'campus.transactions.read',
      );

      const accessAudit = await pool.query(
        `SELECT action, reason, details FROM access_audit_events
        WHERE membership_id = $1 ORDER BY occurred_at`,
        [granted.membershipId],
      );
      assert.deepEqual(
        accessAudit.rows.map((row) => row.action),
        ['grant'],
      );
      assert.equal(
        accessAudit.rows[0].reason,
        'Add transaction monitoring staff',
      );
      assert.deepEqual(accessAudit.rows[0].details, [
        'campus.transactions.read',
      ]);

      const auditRow = await pool.query(
        `SELECT actor_user_id, action FROM audit_events
        WHERE scope_id = $1 AND target_id = $2`,
        [campusA, granted.membershipId],
      );
      assert.equal(auditRow.rows.length, 1);
      assert.equal(auditRow.rows[0].action, 'campus.admin_provisioned');
      assert.equal(auditRow.rows[0].actor_user_id, bootstrappedAdmin);

      // The granted admin only holds transactions.read and cannot provision.
      await assert.rejects(
        provisioning.provisionCampusAdmin({
          actor: { userId: secondAdmin },
          campusId: campusA,
          subjectUserId: thirdUser,
          permissions: ['campus.transactions.read'],
          reason: 'Escalation attempt',
        }),
        /Campus permission denied/,
      );
      await assert.rejects(
        provisioning.provisionCampusAdmin({
          actor: { userId: outsider },
          campusId: campusA,
          subjectUserId: thirdUser,
          permissions: ['campus.transactions.read'],
          reason: 'No membership at all',
        }),
        /Campus access denied/,
      );

      // Revocation stops access immediately and is audited.
      const revoked = await provisioning.revokeCampusAdmin({
        actor: { userId: bootstrappedAdmin },
        campusId: campusA,
        subjectUserId: secondAdmin,
        reason: 'Rotation complete',
      });
      assert.equal(revoked.status, 'revoked');
      await assert.rejects(
        access.requireCampus(secondAdmin, campusA, 'campus.transactions.read'),
        /Campus access denied/,
      );
      const revokeAudit = await pool.query(
        `SELECT action FROM access_audit_events
        WHERE membership_id = $1 ORDER BY occurred_at`,
        [granted.membershipId],
      );
      assert.deepEqual(
        revokeAudit.rows.map((row) => row.action),
        ['grant', 'revoke'],
      );
      await assert.rejects(
        provisioning.revokeCampusAdmin({
          actor: { userId: bootstrappedAdmin },
          campusId: campusA,
          subjectUserId: secondAdmin,
          reason: 'Second revoke',
        }),
        /Active campus membership not found/,
      );

      // Re-provisioning reactivates the revoked membership.
      const reactivated = await provisioning.provisionCampusAdmin({
        actor: { userId: bootstrappedAdmin },
        campusId: campusA,
        subjectUserId: secondAdmin,
        permissions: ['campus.cases.read'],
        reason: 'Reactivate for case review duty',
      });
      assert.equal(reactivated.membershipId, granted.membershipId);
      await access.requireCampus(secondAdmin, campusA, 'campus.cases.read');
    });

    it('rejects self-provisioning, inactive targets, unknown permissions and inactive campuses', async () => {
      await assert.rejects(
        provisioning.provisionCampusAdmin({
          actor: { userId: bootstrappedAdmin },
          campusId: campusA,
          subjectUserId: bootstrappedAdmin,
          permissions: ['campus.access.manage'],
          reason: 'Self escalation',
        }),
        /Self-provisioning is not allowed/,
      );
      await assert.rejects(
        provisioning.provisionCampusAdmin({
          actor: { service: 'bootstrap.test' },
          campusId: campusA,
          subjectUserId: inactiveUser,
          permissions: ['campus.access.manage'],
          reason: 'Inactive target',
        }),
        /Active target user not found/,
      );
      await assert.rejects(
        provisioning.provisionCampusAdmin({
          actor: { service: 'bootstrap.test' },
          campusId: campusA,
          subjectUserId: thirdUser,
          permissions: ['campus.superuser'] as never,
          reason: 'Unknown permission',
        }),
        /Unknown campus permission/,
      );
      await assert.rejects(
        provisioning.provisionCampusAdmin({
          actor: { service: 'bootstrap.test' },
          campusId: campusA,
          subjectUserId: thirdUser,
          permissions: [],
          reason: 'Empty permission list',
        }),
        /At least one explicit campus permission/,
      );
      await assert.rejects(
        provisioning.provisionCampusAdmin({
          actor: { service: 'bootstrap.test' },
          campusId: campusInactive,
          subjectUserId: thirdUser,
          permissions: ['campus.access.manage'],
          reason: 'Inactive campus target',
        }),
        /Campus not found/,
      );
      // Nothing leaked into memberships for the rejected attempts.
      const leaked = await pool.query(
        `SELECT count(*)::int AS n FROM campus_memberships WHERE user_id = $1`,
        [thirdUser],
      );
      assert.equal(leaked.rows[0].n, 0);
    });

    it('protects the audit trail from tampering', async () => {
      await assert.rejects(
        pool.query(
          `UPDATE audit_events SET reason = 'tampered' WHERE action = 'campus.admin_provisioned' AND scope_id = $1`,
          [campusA],
        ),
        /immutable|append-only/,
      );
      await assert.rejects(
        pool.query(
          `DELETE FROM audit_events WHERE action = 'campus.admin_provisioned' AND scope_id = $1`,
          [campusA],
        ),
        /immutable|append-only/,
      );
    });
  },
);
