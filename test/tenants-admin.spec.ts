import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { TenantsService } from '../src/modules/tenants/tenants.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MICRO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

describe(
  'TenantsService PostgreSQL administration',
  { skip: !databaseUrl },
  () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const database = { pool } as DatabaseService;
    const access = new AccessService(database);
    const audit = new AuditService(database, access);
    const tenants = new TenantsService(database, access, audit);

    // Unique per-run token so repeated runs against the same database never
    // collide on name-based search assertions.
    const run = randomUUID().slice(0, 8);
    const campusA = randomUUID();
    const campusB = randomUUID();
    const adminA = randomUUID();
    const adminB = randomUUID();
    const viewerA = randomUUID();
    const outsider = randomUUID();
    const ownerT1 = randomUUID();
    const ownerT2 = randomUUID();
    const kitchenPause = randomUUID();
    const kitchenPlain = randomUUID();
    const buyer = randomUUID();
    const tenantA1 = randomUUID();
    const tenantB1 = randomUUID();
    const tenantArchived = randomUUID();
    const tenantRace = randomUUID();

    const currentUpdatedAt = async (tenantId: string): Promise<string> => {
      const result = await pool.query<{ iso: string }>(
        `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS iso
         FROM tenants WHERE id = $1`,
        [tenantId],
      );
      return result.rows[0].iso;
    };

    before(async () => {
      await pool.query(
        `INSERT INTO campuses (id, name, timezone, status) VALUES
         ($1, $3, 'Asia/Jakarta', 'active'),
         ($2, $4, 'Asia/Jakarta', 'active')`,
        [
          campusA,
          campusB,
          `Kampus Admin Alpha ${run}`,
          `Kampus Admin Beta ${run}`,
        ],
      );
      await pool.query(
        `INSERT INTO users (id, display_name, status) VALUES
         ($1, 'Admin A', 'active'),
         ($2, 'Admin B', 'active'),
         ($3, 'Viewer A', 'active'),
         ($4, 'Outsider', 'active'),
         ($5, 'Owner T1', 'active'),
         ($6, 'Owner T2', 'active'),
         ($7, 'Kitchen pause', 'active'),
         ($8, 'Kitchen plain', 'active'),
         ($9, 'Buyer', 'active')`,
        [
          adminA,
          adminB,
          viewerA,
          outsider,
          ownerT1,
          ownerT2,
          kitchenPause,
          kitchenPlain,
          buyer,
        ],
      );
      await pool.query(
        `INSERT INTO tenants (id, campus_id, name, location, status) VALUES
         ($1, $5, $7, 'Gedung A', 'open'),
         ($2, $6, $8, 'Gedung B', 'open'),
         ($3, $5, $9, 'Gedung C', 'archived'),
         ($4, $5, $10, 'Gedung D', 'closed')`,
        [
          tenantA1,
          tenantB1,
          tenantArchived,
          tenantRace,
          campusA,
          campusB,
          `Kantin Admin Satu ${run}`,
          `Kantin Admin Beta ${run}`,
          `Kantin Admin Arsip ${run}`,
          `Kantin Admin Race ${run}`,
        ],
      );
      await pool.query(
        `INSERT INTO campus_memberships (campus_id, user_id, permissions) VALUES
         ($1, $3, ARRAY['campus.tenants.manage','campus.access.manage']::text[]),
         ($2, $4, ARRAY['campus.tenants.manage']::text[]),
         ($1, $5, ARRAY['campus.transactions.read']::text[]),
         ($2, $3, ARRAY['campus.transactions.read']::text[])`,
        [campusA, campusB, adminA, adminB, viewerA],
      );
      await pool.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, owner_verified_at) VALUES
         ($1, $3, 'owner', '{}'::text[], now()),
         ($2, $4, 'owner', '{}'::text[], now()),
         ($1, $5, 'kitchen', ARRAY['tenant.orders.pause']::text[], NULL),
         ($1, $6, 'kitchen', ARRAY['tenant.orders.read']::text[], NULL)`,
        [tenantA1, tenantB1, ownerT1, ownerT2, kitchenPause, kitchenPlain],
      );
    });

    after(async () => {
      await pool.end();
    });

    it('exposes only active-campus non-archived tenants publicly', async () => {
      const byCampus = await tenants.list({ campusId: campusA, limit: 100 });
      const ids = byCampus.data.map((row) => row.id);
      assert.ok(ids.includes(tenantA1));
      assert.ok(
        !ids.includes(tenantB1),
        'campus filter must exclude other campuses',
      );
      assert.ok(
        !ids.includes(tenantArchived),
        'archived tenants must never be listed',
      );
      assert.ok(byCampus.data.every((row) => row.campusId === campusA));

      const inB = await tenants.list({ campusId: campusB });
      assert.ok(inB.data.some((row) => row.id === tenantB1));

      const searched = await tenants.list({
        search: `KANTIN ADMIN SATU ${run}`,
      });
      assert.deepEqual(
        searched.data.map((row) => row.id),
        [tenantA1],
      );

      const detail = await tenants.get(tenantA1);
      assert.equal(detail.data.status, 'open');
      assert.equal(detail.data.timezone, 'Asia/Jakarta');
      assert.equal(detail.data.campusName, `Kampus Admin Alpha ${run}`);
      await assert.rejects(tenants.get(tenantArchived), /Tenant not found/);
    });

    it('creates tenants only for authorized campus admins and audits them', async () => {
      const created = await tenants.create(adminA, campusA, {
        name: '  Kantin Baru Admin  ',
        location: 'Gedung E',
        reason: 'Onboarding new canteen',
      });
      assert.equal(created.data.status, 'closed');
      assert.equal(created.data.name, 'Kantin Baru Admin');
      assert.match(
        created.data.updatedAt,
        MICRO_ISO,
        'D7 microsecond updatedAt',
      );

      const auditRow = await pool.query(
        `SELECT actor_user_id, scope_type, action, reason, metadata
         FROM audit_events WHERE scope_id = $1 AND action = 'tenant.created'`,
        [created.data.id],
      );
      assert.equal(auditRow.rows.length, 1);
      assert.equal(auditRow.rows[0].actor_user_id, adminA);
      assert.equal(auditRow.rows[0].reason, 'Onboarding new canteen');
      assert.equal(auditRow.rows[0].metadata.campusId, campusA);

      // adminA holds a campus-B membership without tenants.manage.
      await assert.rejects(
        tenants.create(adminA, campusB, {
          name: 'X',
          location: 'Y',
          reason: 'Cross campus',
        }),
        /Campus permission denied/,
      );
      // adminB has no membership at all in campus A.
      await assert.rejects(
        tenants.create(adminB, campusA, {
          name: 'X',
          location: 'Y',
          reason: 'Admin B in campus A',
        }),
        /Campus access denied/,
      );
      await assert.rejects(
        tenants.create(viewerA, campusA, {
          name: 'X',
          location: 'Y',
          reason: 'Viewer cannot manage',
        }),
        /Campus permission denied/,
      );
      await assert.rejects(
        tenants.create(outsider, campusA, {
          name: 'X',
          location: 'Y',
          reason: 'No membership',
        }),
        /Campus access denied/,
      );
      await assert.rejects(
        tenants.create(adminA, campusA, {
          name: '   ',
          location: 'Y',
          reason: 'Blank name',
        }),
        /name must not be empty/,
      );
    });

    it('updates with optimistic concurrency, cross-campus isolation and audit before-image', async () => {
      const expected = await currentUpdatedAt(tenantA1);
      const updated = await tenants.update(adminA, campusA, tenantA1, {
        name: 'Kantin Admin Satu Renamed',
        location: 'Gedung A Lantai 2',
        reason: 'Relocate to second floor',
        expectedUpdatedAt: expected,
      });
      assert.equal(updated.data.name, 'Kantin Admin Satu Renamed');
      assert.match(updated.data.updatedAt, MICRO_ISO);
      assert.notEqual(updated.data.updatedAt, expected);

      const auditRow = await pool.query(
        `SELECT reason, metadata FROM audit_events
        WHERE scope_id = $1 AND action = 'tenant.updated' ORDER BY occurred_at DESC LIMIT 1`,
        [tenantA1],
      );
      assert.equal(auditRow.rows[0].reason, 'Relocate to second floor');
      assert.equal(
        auditRow.rows[0].metadata.before.name,
        `Kantin Admin Satu ${run}`,
      );
      assert.equal(auditRow.rows[0].metadata.before.location, 'Gedung A');

      // Stale token -> 409.
      await assert.rejects(
        tenants.update(adminA, campusA, tenantA1, {
          name: 'Stale update',
          location: 'Anywhere',
          reason: 'Stale token',
          expectedUpdatedAt: expected,
        }),
        /Tenant changed since it was read/,
      );

      // Cross-campus isolation: adminA holds only transactions.read in campus B.
      await assert.rejects(
        tenants.update(adminA, campusB, tenantB1, {
          name: 'Hijack',
          location: 'X',
          reason: 'Admin A cannot touch campus B',
          expectedUpdatedAt: await currentUpdatedAt(tenantB1),
        }),
        /Campus permission denied/,
      );
      await assert.rejects(
        tenants.update(adminA, campusA, tenantB1, {
          name: 'Hijack',
          location: 'X',
          reason: 'Tenant bound to another campus',
          expectedUpdatedAt: await currentUpdatedAt(tenantB1),
        }),
        /Tenant not found/,
      );
      await assert.rejects(
        tenants.update(adminA, campusA, tenantArchived, {
          name: 'Ghost',
          location: 'X',
          reason: 'Archived tenants are not editable',
          expectedUpdatedAt: await currentUpdatedAt(tenantArchived),
        }),
        /Tenant not found/,
      );
    });

    it('enforces staff status permissions and audits every transition', async () => {
      // Plain kitchen cannot pause.
      await assert.rejects(
        tenants.setStatusByStaff(kitchenPlain, tenantA1, {
          status: 'paused',
          reason: 'No pause permission',
          expectedUpdatedAt: await currentUpdatedAt(tenantA1),
        }),
        /Tenant permission denied/,
      );
      // Kitchen with tenant.orders.pause can pause.
      const paused = await tenants.setStatusByStaff(kitchenPause, tenantA1, {
        status: 'paused',
        reason: 'Gas habis',
        expectedUpdatedAt: await currentUpdatedAt(tenantA1),
      });
      assert.equal(paused.data.status, 'paused');
      // ...but cannot reopen without tenant.capacity.manage.
      await assert.rejects(
        tenants.setStatusByStaff(kitchenPause, tenantA1, {
          status: 'open',
          reason: 'Reopen attempt without capacity permission',
          expectedUpdatedAt: paused.data.updatedAt,
        }),
        /Tenant permission denied/,
      );
      // Verified owner holds all tenant permissions and reopens.
      const reopened = await tenants.setStatusByStaff(ownerT1, tenantA1, {
        status: 'open',
        reason: 'Gas restored',
        expectedUpdatedAt: paused.data.updatedAt,
      });
      assert.equal(reopened.data.status, 'open');

      const auditRows = await pool.query(
        `SELECT actor_user_id, reason, metadata FROM audit_events
        WHERE scope_id = $1 AND action = 'tenant.status_changed'
        ORDER BY occurred_at`,
        [tenantA1],
      );
      assert.deepEqual(
        auditRows.rows.map((row) => [
          row.actor_user_id,
          row.metadata.from,
          row.metadata.to,
          row.metadata.via,
        ]),
        [
          [kitchenPause, 'open', 'paused', 'tenant_staff'],
          [ownerT1, 'paused', 'open', 'tenant_staff'],
        ],
      );
      assert.equal(auditRows.rows[0].reason, 'Gas habis');

      // Foreign tenant staff is denied.
      await assert.rejects(
        tenants.setStatusByStaff(ownerT2, tenantA1, {
          status: 'paused',
          reason: 'Cross tenant attempt',
          expectedUpdatedAt: reopened.data.updatedAt,
        }),
        /Tenant access denied/,
      );
      // Stale token -> 409.
      await assert.rejects(
        tenants.setStatusByStaff(ownerT1, tenantA1, {
          status: 'closed',
          reason: 'Stale token',
          expectedUpdatedAt: paused.data.updatedAt,
        }),
        /Tenant changed since it was read/,
      );
      // Archived tenants are not reachable for staff.
      await assert.rejects(
        tenants.setStatusByStaff(ownerT1, tenantArchived, {
          status: 'open',
          reason: 'Archived tenant',
          expectedUpdatedAt: await currentUpdatedAt(tenantArchived),
        }),
        /Tenant access denied/,
      );
    });

    it('lets campus admins transition status with oversight audit', async () => {
      const expected = await currentUpdatedAt(tenantA1);
      const closed = await tenants.setStatusByCampusAdmin(
        adminA,
        campusA,
        tenantA1,
        {
          status: 'closed',
          reason: 'Campus-wide maintenance',
          expectedUpdatedAt: expected,
        },
      );
      assert.equal(closed.data.status, 'closed');
      const auditRow = await pool.query(
        `SELECT actor_user_id, metadata FROM audit_events
        WHERE scope_id = $1 AND action = 'tenant.status_changed'
        ORDER BY occurred_at DESC LIMIT 1`,
        [tenantA1],
      );
      assert.equal(auditRow.rows[0].actor_user_id, adminA);
      assert.equal(auditRow.rows[0].metadata.via, 'campus_admin');
      assert.equal(auditRow.rows[0].metadata.to, 'closed');

      // Restore to open for the archive tests.
      await tenants.setStatusByCampusAdmin(adminA, campusA, tenantA1, {
        status: 'open',
        reason: 'Maintenance finished',
        expectedUpdatedAt: closed.data.updatedAt,
      });

      await assert.rejects(
        tenants.setStatusByCampusAdmin(adminB, campusA, tenantA1, {
          status: 'paused',
          reason: 'Admin B is not a member of campus A',
          expectedUpdatedAt: await currentUpdatedAt(tenantA1),
        }),
        /Campus access denied/,
      );
      // adminA holds only transactions.read in campus B.
      await assert.rejects(
        tenants.setStatusByCampusAdmin(adminA, campusB, tenantB1, {
          status: 'paused',
          reason: 'Admin A has no manage permission in campus B',
          expectedUpdatedAt: await currentUpdatedAt(tenantB1),
        }),
        /Campus permission denied/,
      );
      await assert.rejects(
        tenants.setStatusByCampusAdmin(adminA, campusA, tenantB1, {
          status: 'paused',
          reason: 'Tenant of another campus',
          expectedUpdatedAt: await currentUpdatedAt(tenantB1),
        }),
        /Tenant not found/,
      );
    });

    it('refuses archiving while active buyer commitments exist, then archives with audit', async () => {
      const orderId = randomUUID();
      const slotId = randomUUID();
      const proposedSlotId = randomUUID();
      const reservationId = randomUUID();
      // Migration 0007: orders must reference a real (tenant_id, slot) pair,
      // order/proposal statuses require their timestamps, and consumed
      // reservations require consumed_at.
      await pool.query(
        `INSERT INTO pickup_slots (id, tenant_id, starts_at, ends_at, capacity, status) VALUES
           ($1, $3, now() + interval '1 day', now() + interval '1 day 2 hours', 5, 'open'),
           ($2, $3, now() - interval '3 hours', now() - interval '2 hours', 5, 'closed')`,
        [slotId, proposedSlotId, tenantA1],
      );
      await pool.query(
        `INSERT INTO orders
         (id, buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot,
          tenant_timezone_snapshot, pickup_starts_at, pickup_ends_at, status,
          currency, subtotal_minor, total_minor, paid_at, confirmed_at)
       VALUES ($1, $2, $3, $4, 'Kantin snapshot', 'Asia/Jakarta',
                now() + interval '1 day', now() + interval '1 day 2 hours',
                'confirmed', 'IDR', '15000', '15000', now(), now())`,
        [orderId, buyer, tenantA1, slotId],
      );
      await assert.rejects(
        tenants.archive(adminA, campusA, tenantA1, {
          reason: 'Close down canteen',
          expectedUpdatedAt: await currentUpdatedAt(tenantA1),
        }),
        /active order/,
      );

      await pool.query(
        `INSERT INTO slot_reservations (id, tenant_id, slot_id, order_id, status)
       VALUES ($1, $2, $3, $4, 'reserved')`,
        [reservationId, tenantA1, slotId, orderId],
      );
      await pool.query(
        `INSERT INTO schedule_proposals
         (id, order_id, tenant_id, buyer_id, old_slot_id, proposed_slot_id,
          old_starts_at, old_ends_at, proposed_starts_at, proposed_ends_at,
          expected_slot_version, expected_order_version, status, reason,
          created_by_user_id, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $5, $6,
                now() + interval '1 day', now() + interval '1 day 2 hours',
                now() + interval '1 day 3 hours', now() + interval '1 day 5 hours',
                1, 1, 'pending_buyer', 'bahan habis', $4, now() + interval '10 minutes')`,
        [orderId, tenantA1, buyer, ownerT1, slotId, proposedSlotId],
      );
      await assert.rejects(
        tenants.archive(adminA, campusA, tenantA1, {
          reason: 'Close down canteen',
          expectedUpdatedAt: await currentUpdatedAt(tenantA1),
        }),
        /active order.*pending schedule proposal.*reserved slot.*open future pickup slot/,
      );

      // Resolve every dependency: history rows remain but no longer block.
      await pool.query(
        `UPDATE orders SET status = 'completed', ready_at = now(), completed_at = now() WHERE id = $1`,
        [orderId],
      );
      await pool.query(
        `UPDATE pickup_slots SET status = 'closed' WHERE id = $1`,
        [slotId],
      );
      await pool.query(
        `UPDATE slot_reservations SET status = 'consumed', consumed_at = now() WHERE id = $1`,
        [reservationId],
      );
      await pool.query(
        `UPDATE schedule_proposals SET status = 'cancelled', decided_at = now() WHERE order_id = $1`,
        [orderId],
      );

      // Stale expectedUpdatedAt still 409s.
      await assert.rejects(
        tenants.archive(adminA, campusA, tenantA1, {
          reason: 'Stale archive attempt',
          expectedUpdatedAt: '2020-01-01T00:00:00.000000Z',
        }),
        /Tenant changed since it was read/,
      );
      // Wrong campus admin cannot archive.
      await assert.rejects(
        tenants.archive(adminB, campusA, tenantA1, {
          reason: 'Foreign admin',
          expectedUpdatedAt: await currentUpdatedAt(tenantA1),
        }),
        /Campus access denied/,
      );

      const archived = await tenants.archive(adminA, campusA, tenantA1, {
        reason: 'Contract ended, close down canteen',
        expectedUpdatedAt: await currentUpdatedAt(tenantA1),
      });
      assert.equal(archived.data.status, 'archived');
      assert.match(archived.data.updatedAt, MICRO_ISO);

      const auditRow = await pool.query(
        `SELECT actor_user_id, reason, metadata FROM audit_events
        WHERE scope_id = $1 AND action = 'tenant.archived'`,
        [tenantA1],
      );
      assert.equal(auditRow.rows.length, 1);
      assert.equal(auditRow.rows[0].actor_user_id, adminA);
      assert.equal(auditRow.rows[0].metadata.before.status, 'open');

      // Archived tenant disappears from public surfaces and staff access.
      await assert.rejects(tenants.get(tenantA1), /Tenant not found/);
      const listed = await tenants.list({
        campusId: campusA,
        status: 'any',
        limit: 100,
      });
      assert.ok(!listed.data.some((row) => row.id === tenantA1));
      await assert.rejects(
        access.requireTenant(ownerT1, tenantA1, 'tenant.orders.read'),
        /Tenant access denied/,
      );
      // Archiving again is a 404, data is retained (order history intact).
      await assert.rejects(
        tenants.archive(adminA, campusA, tenantA1, {
          reason: 'Archive twice',
          expectedUpdatedAt: archived.data.updatedAt,
        }),
        /Tenant not found/,
      );
      const retained = await pool.query(
        `SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1`,
        [tenantA1],
      );
      assert.equal(retained.rows[0].n, 1, 'archive must not delete history');
    });

    it('serializes concurrent archives so exactly one succeeds', async () => {
      const expected = await currentUpdatedAt(tenantRace);
      const attempts = await Promise.allSettled([
        tenants.archive(adminA, campusA, tenantRace, {
          reason: 'Race A',
          expectedUpdatedAt: expected,
        }),
        tenants.archive(adminA, campusA, tenantRace, {
          reason: 'Race B',
          expectedUpdatedAt: expected,
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
      const row = await pool.query(`SELECT status FROM tenants WHERE id = $1`, [
        tenantRace,
      ]);
      assert.equal(row.rows[0].status, 'archived');
    });
  },
);
