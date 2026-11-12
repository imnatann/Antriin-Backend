import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService, CAMPUS_PERMISSIONS } from '../access/access.service';
import type { CampusPermission } from '../access/access.service';
import { AuditService } from '../audit/audit.service';

/**
 * A provisioning actor is either an authenticated user (a campus admin with
 * `campus.access.manage`) or a trusted service principal used only by the
 * controlled bootstrap path (script/worker). There is deliberately no public
 * HTTP surface for campus membership grants: docs/ACCESS.md forbids public
 * endpoints that grant campus access.
 */
export type ProvisioningActor = { userId: string } | { service: string };

const SERVICE_ACTOR_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;

export interface ProvisionCampusAdminInput {
  actor: ProvisioningActor;
  campusId: string;
  subjectUserId: string;
  permissions: readonly CampusPermission[];
  reason: string;
}

export interface RevokeCampusAdminInput {
  actor: ProvisioningActor;
  campusId: string;
  subjectUserId: string;
  reason: string;
}

export interface CampusMembershipResult {
  membershipId: string;
  campusId: string;
  subjectUserId: string;
  status: 'active' | 'revoked';
  permissions?: CampusPermission[];
}

@Injectable()
export class CampusProvisioningService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Grants (or re-grants after revocation) a campus membership with an
   * explicit permission list. User actors must themselves hold
   * `campus.access.manage` on that campus and cannot provision themselves.
   * Service actors are the controlled bootstrap for the first campus admin.
   *
   * Schema limitation (root decision D-task-3): `access_audit_events`
   * requires a non-null `actor_user_id`, so service-actor bootstraps record
   * the grant only in `audit_events` (actor_service).
   */
  async provisionCampusAdmin(
    input: ProvisionCampusAdminInput,
    client?: PoolClient,
  ): Promise<CampusMembershipResult> {
    const permissions = this.validatePermissions(input.permissions);
    const reason = this.validateReason(input.reason);
    this.assertNotSelf(input.actor, input.subjectUserId);

    return this.withTransaction(client, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `campus-membership:${input.campusId}:${input.subjectUserId}`,
      ]);
      await this.authorizeActor(input.actor, input.campusId, tx);
      const campus = await tx.query<{ id: string }>(
        `SELECT id FROM campuses WHERE id = $1 AND status = 'active' FOR UPDATE`,
        [input.campusId],
      );
      if (!campus.rows[0]) throw new NotFoundException('Campus not found');
      await this.requireActiveUser(tx, input.subjectUserId);

      const membership = await tx.query<{ id: string }>(
        `INSERT INTO campus_memberships
           (campus_id, user_id, permissions, status, revoked_at, updated_at)
         VALUES ($1, $2, $3::text[], 'active', NULL, now())
         ON CONFLICT (campus_id, user_id) DO UPDATE
           SET permissions = EXCLUDED.permissions,
               status = 'active',
               revoked_at = NULL,
               updated_at = now()
         RETURNING id`,
        [input.campusId, input.subjectUserId, permissions],
      );
      const membershipId = membership.rows[0].id;
      if ('userId' in input.actor) {
        await this.appendAccessAudit(
          tx,
          input.actor.userId,
          input.subjectUserId,
          input.campusId,
          membershipId,
          'grant',
          reason,
          permissions,
        );
      }
      await this.audit.append(tx, {
        actor: input.actor,
        scopeType: 'campus',
        scopeId: input.campusId,
        action: 'campus.admin_provisioned',
        targetType: 'membership',
        targetId: membershipId,
        reason,
        metadata: { subjectUserId: input.subjectUserId, permissions },
      });
      return {
        membershipId,
        campusId: input.campusId,
        subjectUserId: input.subjectUserId,
        status: 'active' as const,
        permissions,
      };
    });
  }

  /**
   * Revokes a campus membership immediately; subsequent `requireCampus`
   * checks fail. User actors need `campus.access.manage` and cannot revoke
   * themselves; service actors act through the controlled bootstrap path.
   */
  async revokeCampusAdmin(
    input: RevokeCampusAdminInput,
    client?: PoolClient,
  ): Promise<CampusMembershipResult> {
    const reason = this.validateReason(input.reason);
    this.assertNotSelf(input.actor, input.subjectUserId);

    return this.withTransaction(client, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `campus-membership:${input.campusId}:${input.subjectUserId}`,
      ]);
      await this.authorizeActor(input.actor, input.campusId, tx);
      const campus = await tx.query<{ id: string }>(
        `SELECT id FROM campuses WHERE id = $1 AND status = 'active' FOR UPDATE`,
        [input.campusId],
      );
      if (!campus.rows[0]) throw new NotFoundException('Campus not found');
      const membership = await tx.query<{ id: string; permissions: string[] }>(
        `SELECT id, permissions FROM campus_memberships
          WHERE campus_id = $1 AND user_id = $2 AND status = 'active'
          FOR UPDATE`,
        [input.campusId, input.subjectUserId],
      );
      const row = membership.rows[0];
      if (!row) {
        throw new NotFoundException('Active campus membership not found');
      }
      await tx.query(
        `UPDATE campus_memberships
            SET status = 'revoked', revoked_at = now(), updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      if ('userId' in input.actor) {
        await this.appendAccessAudit(
          tx,
          input.actor.userId,
          input.subjectUserId,
          input.campusId,
          row.id,
          'revoke',
          reason,
          row.permissions as CampusPermission[],
        );
      }
      await this.audit.append(tx, {
        actor: input.actor,
        scopeType: 'campus',
        scopeId: input.campusId,
        action: 'campus.admin_revoked',
        targetType: 'membership',
        targetId: row.id,
        reason,
        metadata: { subjectUserId: input.subjectUserId },
      });
      return {
        membershipId: row.id,
        campusId: input.campusId,
        subjectUserId: input.subjectUserId,
        status: 'revoked' as const,
      };
    });
  }

  private async authorizeActor(
    actor: ProvisioningActor,
    campusId: string,
    tx: PoolClient,
  ): Promise<void> {
    if ('userId' in actor) {
      await this.access.requireCampus(
        actor.userId,
        campusId,
        'campus.access.manage',
        tx,
      );
      return;
    }
    if (!SERVICE_ACTOR_PATTERN.test(actor.service)) {
      throw new ForbiddenException('Invalid service principal');
    }
  }

  private async requireActiveUser(
    tx: PoolClient,
    userId: string,
  ): Promise<void> {
    const target = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE id = $1 FOR SHARE`,
      [userId],
    );
    if (target.rows[0]?.status !== 'active') {
      throw new NotFoundException('Active target user not found');
    }
  }

  private async appendAccessAudit(
    tx: PoolClient,
    actorUserId: string,
    subjectUserId: string,
    campusId: string,
    membershipId: string,
    action: 'grant' | 'revoke',
    reason: string,
    permissions: readonly CampusPermission[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO access_audit_events
         (actor_user_id, subject_user_id, scope_type, scope_id, membership_id,
          action, reason, details)
       VALUES ($1, $2, 'campus', $3, $4, $5, $6, $7::text[])`,
      [
        actorUserId,
        subjectUserId,
        campusId,
        membershipId,
        action,
        reason,
        permissions,
      ],
    );
  }

  private validatePermissions(
    permissions: readonly CampusPermission[],
  ): CampusPermission[] {
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new ForbiddenException(
        'At least one explicit campus permission is required',
      );
    }
    if (new Set(permissions).size !== permissions.length) {
      throw new ForbiddenException(
        'Permissions must be a unique explicit list',
      );
    }
    for (const permission of permissions) {
      if (!(CAMPUS_PERMISSIONS as readonly string[]).includes(permission)) {
        throw new ForbiddenException('Unknown campus permission');
      }
    }
    return [...permissions];
  }

  private assertNotSelf(actor: ProvisioningActor, subjectUserId: string): void {
    if ('userId' in actor && actor.userId === subjectUserId) {
      throw new ForbiddenException('Self-provisioning is not allowed');
    }
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
