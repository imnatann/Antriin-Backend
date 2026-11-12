import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe(
  'AccessService PostgreSQL authorization',
  { skip: !databaseUrl },
  () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const service = new AccessService({ pool } as DatabaseService);
    const campusId = randomUUID();
    const otherCampusId = randomUUID();
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const ownerId = randomUUID();
    const kitchenId = randomUUID();
    const pickupId = randomUUID();
    const campusManagerId = randomUUID();
    const inactiveUserId = randomUUID();

    before(async () => {
      await pool.query(
        `INSERT INTO campuses (id, name) VALUES ($1, 'Access test campus'), ($2, 'Other test campus')`,
        [campusId, otherCampusId],
      );
      await pool.query(
        `INSERT INTO tenants (id, campus_id, name, location, status)
       VALUES ($1, $3, 'Access test tenant', 'Test location', 'open'),
              ($2, $4, 'Other test tenant', 'Test location', 'open')`,
        [tenantId, otherTenantId, campusId, otherCampusId],
      );
      await pool.query(
        `INSERT INTO users (id, display_name, status)
       VALUES ($1, 'Access test owner', 'active'),
              ($2, 'Access test kitchen', 'active'),
              ($3, 'Access test pickup', 'active'),
              ($4, 'Access test campus manager', 'active'),
              ($5, 'Access test inactive user', 'closed')`,
        [ownerId, kitchenId, pickupId, campusManagerId, inactiveUserId],
      );
      await pool.query(
        `INSERT INTO tenant_memberships
         (tenant_id, user_id, role, permissions, owner_verified_at)
       VALUES ($1, $2, 'owner', '{}'::text[], now()),
              ($1, $3, 'kitchen', ARRAY['tenant.orders.read', 'tenant.finance.read']::text[], NULL),
              ($1, $4, 'pickup', ARRAY['tenant.orders.read', 'tenant.orders.handover']::text[], NULL)`,
        [tenantId, ownerId, kitchenId, pickupId],
      );
      await pool.query(
        `INSERT INTO campus_memberships (campus_id, user_id, permissions)
       VALUES ($1, $2, ARRAY['campus.cases.read']::text[])`,
        [campusId, campusManagerId],
      );
    });

    after(async () => {
      // These fixtures live only in the isolated, disposable TEST_DATABASE_URL.
      // Audit rows are immutable and intentionally retained with their actors.
      await pool.end();
    });

    it('checks tenant membership and blocks cross-tenant access', async () => {
      const access = await service.requireTenant(
        ownerId,
        tenantId,
        'tenant.staff.manage',
      );
      assert.equal(access.role, 'owner');
      assert.equal(access.campusId, campusId);
      await assert.rejects(
        service.requireTenant(ownerId, otherTenantId, 'tenant.orders.read'),
        /Tenant access denied/,
      );
    });

    it('hard-denies finance to kitchen staff even if the stored grant is invalid', async () => {
      await service.requireTenant(kitchenId, tenantId, 'tenant.orders.read');
      await assert.rejects(
        service.requireTenant(kitchenId, tenantId, 'tenant.finance.read'),
        /Tenant finance access denied/,
      );
    });

    it('checks campus permission explicitly and denies other campus scope', async () => {
      const access = await service.requireCampus(
        campusManagerId,
        campusId,
        'campus.cases.read',
      );
      assert.equal(access.campusId, campusId);
      await assert.rejects(
        service.requireCampus(
          campusManagerId,
          otherCampusId,
          'campus.cases.read',
        ),
        /Campus access denied/,
      );
      await assert.rejects(
        service.requireCampus(campusManagerId, campusId, 'campus.cases.decide'),
        /Campus permission denied/,
      );
    });

    it('audits grant and immediate revocation in the same transaction', async () => {
      const granted = await service.grantTenantMembership({
        actorUserId: ownerId,
        tenantId,
        subjectUserId: pickupId,
        role: 'pickup',
        permissions: ['tenant.orders.read'],
        reason: 'Assign pickup shift',
      });
      assert.equal(typeof granted.membershipId, 'string');
      await service.requireTenant(pickupId, tenantId, 'tenant.orders.read');
      await service.revokeTenantMembership({
        actorUserId: ownerId,
        tenantId,
        subjectUserId: pickupId,
        reason: 'Remove pickup shift',
      });
      await assert.rejects(
        service.requireTenant(pickupId, tenantId, 'tenant.orders.read'),
        /Tenant access denied/,
      );
      const audit = await pool.query<{ action: string; reason: string }>(
        `SELECT action, reason FROM access_audit_events
        WHERE scope_id = $1 AND subject_user_id = $2 ORDER BY occurred_at`,
        [tenantId, pickupId],
      );
      assert.deepEqual(
        audit.rows.map(({ action, reason }) => [action, reason]),
        [
          ['grant', 'Assign pickup shift'],
          ['revoke', 'Remove pickup shift'],
        ],
      );
      await assert.rejects(
        pool.query(
          `UPDATE access_audit_events SET reason = 'tampered'
          WHERE scope_id = $1 AND subject_user_id = $2`,
          [tenantId, pickupId],
        ),
        /append-only/,
      );
      await assert.rejects(
        pool.query(
          `DELETE FROM access_audit_events WHERE scope_id = $1 AND subject_user_id = $2`,
          [tenantId, pickupId],
        ),
        /append-only/,
      );
    });

    it('rejects staff privilege escalation and changes by non-owners', async () => {
      await assert.rejects(
        service.grantTenantMembership({
          actorUserId: ownerId,
          tenantId,
          subjectUserId: pickupId,
          role: 'pickup',
          permissions: ['tenant.payout.request'],
          reason: 'Should not be granted',
        }),
        /Permission cannot be granted/,
      );
      await assert.rejects(
        service.grantTenantMembership({
          actorUserId: kitchenId,
          tenantId,
          subjectUserId: pickupId,
          role: 'pickup',
          permissions: ['tenant.orders.read'],
          reason: 'Kitchen cannot manage staff',
        }),
        /Tenant permission denied/,
      );
      await assert.rejects(
        service.grantTenantMembership({
          actorUserId: ownerId,
          tenantId,
          subjectUserId: inactiveUserId,
          role: 'pickup',
          permissions: ['tenant.orders.read'],
          reason: 'Inactive accounts cannot be added',
        }),
        /Active target user not found/,
      );
    });
  },
);
