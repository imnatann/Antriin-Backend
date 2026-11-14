import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';

export const TENANT_PERMISSIONS = [
  'tenant.orders.read',
  'tenant.orders.accept',
  'tenant.orders.prepare',
  'tenant.orders.handover',
  'tenant.orders.pause',
  'tenant.menu.manage',
  'tenant.capacity.manage',
  'tenant.staff.manage',
  'tenant.reviews.reply',
  'tenant.incidents.report',
  'tenant.sales.read',
  'tenant.finance.read',
  'tenant.bank_account.manage',
  'tenant.payout.request',
  // Public stall profile: name, description, contact, pickup instructions.
  // Owner-only in practice (staff role allowlists below do not include it).
  'tenant.settings.manage',
] as const;
export type TenantPermission = (typeof TENANT_PERMISSIONS)[number];
export type TenantStaffRole = 'kitchen' | 'pickup';

export const CAMPUS_PERMISSIONS = [
  'campus.transactions.read',
  'campus.tenants.manage',
  'campus.access.manage',
  'campus.reviews.moderate',
  'campus.cases.read',
  'campus.cases.decide',
  'campus.refunds.initiate',
  'campus.payouts.read',
  // Reading the risk/AI queue is separate from deciding on it: an analyst may
  // review signals without being able to record a decision.
  'campus.risk.read',
  'campus.ai_reviews.decide',
  'campus.audit.read',
] as const;
export type CampusPermission = (typeof CAMPUS_PERMISSIONS)[number];

const TENANT_FINANCE_PERMISSIONS = new Set<TenantPermission>([
  'tenant.finance.read',
  'tenant.bank_account.manage',
  'tenant.payout.request',
]);
const STAFF_ROLE_PERMISSIONS: Record<
  TenantStaffRole,
  ReadonlySet<TenantPermission>
> = {
  kitchen: new Set([
    'tenant.orders.read',
    'tenant.orders.accept',
    'tenant.orders.prepare',
    'tenant.orders.pause',
    'tenant.menu.manage',
    'tenant.capacity.manage',
    'tenant.reviews.reply',
    'tenant.incidents.report',
  ]),
  pickup: new Set([
    'tenant.orders.read',
    'tenant.orders.handover',
    'tenant.incidents.report',
  ]),
};

export interface TenantAuthorization {
  tenantId: string;
  campusId: string;
  userId: string;
  membershipId: string;
  role: 'owner' | TenantStaffRole;
  permissions: readonly TenantPermission[];
}

export interface CampusAuthorization {
  campusId: string;
  userId: string;
  membershipId: string;
  permissions: readonly CampusPermission[];
}

export interface GrantTenantMembershipInput {
  actorUserId: string;
  tenantId: string;
  subjectUserId: string;
  role: TenantStaffRole;
  permissions: readonly TenantPermission[];
  reason: string;
}

export interface RevokeTenantMembershipInput {
  actorUserId: string;
  tenantId: string;
  subjectUserId: string;
  reason: string;
}

export interface TenantStaffRecord {
  userId: string;
  role: TenantStaffRole;
  permissions: readonly TenantPermission[];
  status: 'active' | 'revoked';
}

interface TenantMembershipRow {
  membership_id: string;
  campus_id: string;
  role: 'owner' | TenantStaffRole;
  permissions: string[];
  owner_verified_at: Date | null;
}

interface CampusMembershipRow {
  membership_id: string;
  permissions: string[];
}

@Injectable()
export class AccessService {
  constructor(private readonly database: DatabaseService) {}

  async requireTenant(
    userId: string,
    tenantId: string,
    permission: TenantPermission,
    client?: PoolClient,
  ): Promise<TenantAuthorization> {
    this.assertTenantPermission(permission);
    const query = client
      ? client.query.bind(client)
      : this.database.pool.query.bind(this.database.pool);
    const lock = client ? 'FOR SHARE OF tm, t, c, u' : '';
    const result = await query<TenantMembershipRow>(
      `SELECT tm.id AS membership_id, t.campus_id, tm.role, tm.permissions,
              tm.owner_verified_at
         FROM tenant_memberships tm
         JOIN tenants t ON t.id = tm.tenant_id
         JOIN campuses c ON c.id = t.campus_id
         JOIN users u ON u.id = tm.user_id
        WHERE tm.user_id = $1
          AND tm.tenant_id = $2
          AND tm.status = 'active'
          AND t.status <> 'archived'
          AND c.status = 'active'
          AND u.status = 'active'
        ${lock}`,
      [userId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new ForbiddenException('Tenant access denied');

    const role = row.role;
    const ownerVerified = role === 'owner' && row.owner_verified_at !== null;
    if (role === 'owner' && !ownerVerified) {
      throw new ForbiddenException('Tenant owner is not verified');
    }
    if (TENANT_FINANCE_PERMISSIONS.has(permission) && !ownerVerified) {
      throw new ForbiddenException('Tenant finance access denied');
    }
    if (role !== 'owner') {
      if (TENANT_FINANCE_PERMISSIONS.has(permission)) {
        throw new ForbiddenException('Tenant finance access denied');
      }
      const granted = new Set(row.permissions as TenantPermission[]);
      if (
        !STAFF_ROLE_PERMISSIONS[role].has(permission) ||
        !granted.has(permission)
      ) {
        throw new ForbiddenException('Tenant permission denied');
      }
    }

    return {
      tenantId,
      campusId: row.campus_id,
      userId,
      membershipId: row.membership_id,
      role,
      permissions:
        role === 'owner'
          ? TENANT_PERMISSIONS
          : (row.permissions as TenantPermission[]),
    };
  }

  async requireCampus(
    userId: string,
    campusId: string,
    permission: CampusPermission,
    client?: PoolClient,
  ): Promise<CampusAuthorization> {
    this.assertCampusPermission(permission);
    const query = client
      ? client.query.bind(client)
      : this.database.pool.query.bind(this.database.pool);
    const lock = client ? 'FOR SHARE OF cm, c, u' : '';
    const result = await query<CampusMembershipRow>(
      `SELECT cm.id AS membership_id, cm.permissions
         FROM campus_memberships cm
         JOIN campuses c ON c.id = cm.campus_id
         JOIN users u ON u.id = cm.user_id
        WHERE cm.user_id = $1
          AND cm.campus_id = $2
          AND cm.status = 'active'
          AND c.status = 'active'
          AND u.status = 'active'
        ${lock}`,
      [userId, campusId],
    );
    const row = result.rows[0];
    if (!row) throw new ForbiddenException('Campus access denied');
    const permissions = row.permissions as CampusPermission[];
    if (!permissions.includes(permission)) {
      throw new ForbiddenException('Campus permission denied');
    }
    return {
      campusId,
      userId,
      membershipId: row.membership_id,
      permissions,
    };
  }

  async grantTenantMembership(
    input: GrantTenantMembershipInput,
    client?: PoolClient,
  ): Promise<{ membershipId: string }> {
    const permissions = this.validateStaffPermissions(
      input.role,
      input.permissions,
    );
    const reason = this.validateReason(input.reason);
    if (input.actorUserId === input.subjectUserId) {
      throw new ForbiddenException('Self-service role changes are not allowed');
    }

    return this.withTransaction(client, async (tx) => {
      // Bootstrap owner provisioning must take this same key. The guarded
      // upsert below also refuses to overwrite an owner if bootstrap races.
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`,
        [input.tenantId, input.subjectUserId],
      );
      await this.requireTenant(
        input.actorUserId,
        input.tenantId,
        'tenant.staff.manage',
        tx,
      );
      const target = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM users WHERE id = $1 FOR SHARE`,
        [input.subjectUserId],
      );
      if (target.rows[0]?.status !== 'active') {
        throw new NotFoundException('Active target user not found');
      }

      const existing = await tx.query<{
        id: string;
        role: string;
        owner_verified_at: Date | null;
      }>(
        `SELECT id, role, owner_verified_at
           FROM tenant_memberships
          WHERE tenant_id = $1 AND user_id = $2
          FOR UPDATE`,
        [input.tenantId, input.subjectUserId],
      );
      if (
        existing.rows[0] &&
        (existing.rows[0].role === 'owner' ||
          existing.rows[0].owner_verified_at !== null)
      ) {
        throw new ForbiddenException(
          'Owner membership cannot be changed as staff',
        );
      }

      const membership = await tx.query<{ id: string }>(
        `INSERT INTO tenant_memberships
           (tenant_id, user_id, role, permissions, status, revoked_at, updated_at)
         VALUES ($1, $2, $3, $4::text[], 'active', NULL, now())
         ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET role = EXCLUDED.role,
               permissions = EXCLUDED.permissions,
               status = 'active',
               revoked_at = NULL,
               updated_at = now()
           WHERE tenant_memberships.role <> 'owner'
             AND tenant_memberships.owner_verified_at IS NULL
         RETURNING id`,
        [input.tenantId, input.subjectUserId, input.role, permissions],
      );
      const membershipId = membership.rows[0]?.id;
      if (!membershipId) {
        throw new ForbiddenException(
          'Owner membership cannot be changed as staff',
        );
      }
      await tx.query(
        `INSERT INTO access_audit_events
           (actor_user_id, subject_user_id, scope_type, scope_id, membership_id,
            action, reason, details)
         VALUES ($1, $2, 'tenant', $3, $4, 'grant', $5, $6::text[])`,
        [
          input.actorUserId,
          input.subjectUserId,
          input.tenantId,
          membershipId,
          reason,
          permissions,
        ],
      );
      return { membershipId };
    });
  }

  async revokeTenantMembership(
    input: RevokeTenantMembershipInput,
    client?: PoolClient,
  ): Promise<void> {
    const reason = this.validateReason(input.reason);
    if (input.actorUserId === input.subjectUserId) {
      throw new ForbiddenException('Self-service role changes are not allowed');
    }

    await this.withTransaction(client, async (tx) => {
      await this.requireTenant(
        input.actorUserId,
        input.tenantId,
        'tenant.staff.manage',
        tx,
      );
      const membership = await tx.query<{
        id: string;
        role: string;
        permissions: string[];
        status: string;
      }>(
        `SELECT id, role, permissions, status
           FROM tenant_memberships
          WHERE tenant_id = $1 AND user_id = $2
          FOR UPDATE`,
        [input.tenantId, input.subjectUserId],
      );
      const row = membership.rows[0];
      if (!row || row.status !== 'active') {
        throw new NotFoundException('Active tenant membership not found');
      }
      if (row.role === 'owner') {
        throw new ForbiddenException(
          'Owner membership cannot be revoked as staff',
        );
      }
      await tx.query(
        `UPDATE tenant_memberships
            SET status = 'revoked', revoked_at = now(), updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      await tx.query(
        `INSERT INTO access_audit_events
           (actor_user_id, subject_user_id, scope_type, scope_id, membership_id,
            action, reason, details)
         VALUES ($1, $2, 'tenant', $3, $4, 'revoke', $5, $6::text[])`,
        [
          input.actorUserId,
          input.subjectUserId,
          input.tenantId,
          row.id,
          reason,
          row.permissions,
        ],
      );
    });
  }

  async listTenantStaff(
    actorUserId: string,
    tenantId: string,
  ): Promise<TenantStaffRecord[]> {
    await this.requireTenant(actorUserId, tenantId, 'tenant.staff.manage');
    const result = await this.database.pool.query<{
      user_id: string;
      role: TenantStaffRole;
      permissions: string[];
      status: 'active' | 'revoked';
    }>(
      `SELECT user_id, role, permissions, status
         FROM tenant_memberships
        WHERE tenant_id = $1 AND role <> 'owner'
        ORDER BY created_at, id`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      role: row.role,
      permissions: row.permissions as TenantPermission[],
      status: row.status,
    }));
  }

  private async withTransaction<T>(
    client: PoolClient | undefined,
    callback: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (client) return callback(client);
    const tx = await this.database.pool.connect();
    try {
      await tx.query('BEGIN');
      const result = await callback(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }

  private assertTenantPermission(
    permission: string,
  ): asserts permission is TenantPermission {
    if (!(TENANT_PERMISSIONS as readonly string[]).includes(permission)) {
      throw new ForbiddenException('Unknown tenant permission');
    }
  }

  private assertCampusPermission(
    permission: string,
  ): asserts permission is CampusPermission {
    if (!(CAMPUS_PERMISSIONS as readonly string[]).includes(permission)) {
      throw new ForbiddenException('Unknown campus permission');
    }
  }

  private validateStaffPermissions(
    role: TenantStaffRole,
    permissions: readonly TenantPermission[],
  ): TenantPermission[] {
    if (role !== 'kitchen' && role !== 'pickup') {
      throw new ForbiddenException(
        'Only kitchen or pickup staff may be assigned',
      );
    }
    if (
      !Array.isArray(permissions) ||
      new Set(permissions).size !== permissions.length
    ) {
      throw new ForbiddenException(
        'Permissions must be a unique explicit list',
      );
    }
    for (const permission of permissions) {
      this.assertTenantPermission(permission);
      if (
        TENANT_FINANCE_PERMISSIONS.has(permission) ||
        permission === 'tenant.staff.manage' ||
        !STAFF_ROLE_PERMISSIONS[role].has(permission)
      ) {
        throw new ForbiddenException(
          'Permission cannot be granted to this staff role',
        );
      }
    }
    return [...permissions];
  }

  private validateReason(reason: string): string {
    const normalized = reason?.trim();
    if (!normalized || normalized.length > 500) {
      throw new ForbiddenException(
        'A reason of 1 to 500 characters is required',
      );
    }
    return normalized;
  }
}
