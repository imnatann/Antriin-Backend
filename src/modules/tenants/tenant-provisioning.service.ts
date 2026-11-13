import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';

export interface ProvisionTenantOwnerInput {
  subjectUserId: string;
  reason: string;
}

export interface ProvisionTenantOwnerResult {
  tenantId: string;
  campusId: string;
  membershipId: string;
  ownerUserId: string;
  role: 'owner';
  status: 'active';
}

/**
 * Controlled bootstrap of the FIRST verified tenant owner (root-approved
 * provisioning decision, task-3):
 * - HTTP surface: POST /v1/campuses/:campusId/tenants/:tenantId/owner.
 * - Actor must hold `campus.access.manage` on the tenant's campus.
 * - Only bootstraps while the tenant has no active owner; a second owner or
 *   ownership transfer is an open product decision (409 for now).
 * - Actor cannot provision itself; subject must be an existing active user.
 * - Takes the same advisory lock key as AccessService.grantTenantMembership
 *   (tenantId:subjectUserId) so a staff grant and an owner bootstrap for the
 *   same user serialize (docs/ACCESS.md).
 * - Writes tenant_memberships(role='owner', owner_verified_at=now()),
 *   access_audit_events(grant) and audit_events atomically in one
 *   transaction. An existing kitchen/pickup membership for the subject is
 *   promoted; an existing (even revoked) ACTIVE owner row is never
 *   overwritten. Revoked owner rows may be re-provisioned (re-bootstrap).
 */
@Injectable()
export class TenantProvisioningService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async provisionTenantOwner(
    actorUserId: string,
    campusId: string,
    tenantId: string,
    input: ProvisionTenantOwnerInput,
    client?: PoolClient,
  ): Promise<{ data: ProvisionTenantOwnerResult }> {
    const reason = this.validateReason(input.reason);
    if (actorUserId === input.subjectUserId) {
      throw new ForbiddenException('Self-provisioning is not allowed');
    }
    return this.withTransaction(client, async (tx) => {
      // Same key as AccessService.grantTenantMembership (docs/ACCESS.md).
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`,
        [tenantId, input.subjectUserId],
      );
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.access.manage',
        tx,
      );
      const tenant = await tx.query<{ id: string; campus_id: string }>(
        `SELECT id, campus_id FROM tenants
          WHERE id = $1 AND campus_id = $2 AND status <> 'archived'
          FOR UPDATE`,
        [tenantId, campusId],
      );
      if (!tenant.rows[0]) throw new NotFoundException('Tenant not found');
      // The owner-exists conflict dominates subject validation: once an
      // active owner exists, bootstrapping is impossible for ANY subject,
      // so report 409 before probing the target user.
      const existingOwner = await tx.query<{ id: string }>(
        `SELECT id FROM tenant_memberships
          WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'
          LIMIT 1`,
        [tenantId],
      );
      if (existingOwner.rows[0]) {
        throw new ConflictException('Tenant already has an active owner');
      }
      const subject = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM users WHERE id = $1 FOR SHARE`,
        [input.subjectUserId],
      );
      if (subject.rows[0]?.status !== 'active') {
        throw new NotFoundException('Active target user not found');
      }
      const membership = await tx.query<{ id: string }>(
        `INSERT INTO tenant_memberships
           (tenant_id, user_id, role, permissions, status, owner_verified_at,
            revoked_at, updated_at)
         VALUES ($1, $2, 'owner', '{}'::text[], 'active', now(), NULL, now())
         ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET role = 'owner',
               permissions = '{}'::text[],
               status = 'active',
               owner_verified_at = now(),
               revoked_at = NULL,
               updated_at = now()
           WHERE NOT (
             tenant_memberships.role = 'owner'
             AND tenant_memberships.status = 'active'
           )
         RETURNING id`,
        [tenantId, input.subjectUserId],
      );
      const membershipId = membership.rows[0]?.id;
      if (!membershipId) {
        // Guarded upsert refused: an owner row appeared concurrently.
        throw new ConflictException('Tenant already has an active owner');
      }
      await tx.query(
        `INSERT INTO access_audit_events
           (actor_user_id, subject_user_id, scope_type, scope_id, membership_id,
            action, reason, details)
         VALUES ($1, $2, 'tenant', $3, $4, 'grant', $5, $6::text[])`,
        [
          actorUserId,
          input.subjectUserId,
          tenantId,
          membershipId,
          reason,
          ['role:owner'],
        ],
      );
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: 'tenant.owner_provisioned',
        targetType: 'membership',
        targetId: membershipId,
        reason,
        metadata: {
          subjectUserId: input.subjectUserId,
          campusId,
          role: 'owner',
        },
      });
      return {
        data: {
          tenantId,
          campusId,
          membershipId,
          ownerUserId: input.subjectUserId,
          role: 'owner' as const,
          status: 'active' as const,
        },
      };
    });
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
}
