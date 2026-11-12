import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { uuidPattern } from '../notifications/outbox.service';

export interface AuditInput {
  actor: { userId: string } | { service: string };
  scopeType: 'user' | 'tenant' | 'campus';
  scopeId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}
@Injectable()
export class AuditService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
  ) {}
  async append(client: PoolClient, input: AuditInput): Promise<void> {
    const userId = 'userId' in input.actor ? input.actor.userId : null;
    const service = 'service' in input.actor ? input.actor.service : null;
    if (
      (userId && !uuidPattern.test(userId)) ||
      (service && !/^[a-z][a-z0-9._-]{0,79}$/.test(service)) ||
      !['user', 'tenant', 'campus'].includes(input.scopeType) ||
      !uuidPattern.test(input.scopeId) ||
      !uuidPattern.test(input.targetId) ||
      !/^[a-z][a-z0-9._-]{0,99}$/.test(input.action) ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(input.targetType) ||
      !input.reason.trim() ||
      input.reason.length > 500
    )
      throw new BadRequestException('Invalid audit event');
    await client.query(
      `INSERT INTO audit_events (actor_user_id, actor_service, scope_type, scope_id, action, target_type, target_id, reason, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        userId,
        service,
        input.scopeType,
        input.scopeId,
        input.action,
        input.targetType,
        input.targetId,
        input.reason,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }
  async listCampus(
    userId: string,
    campusId: string,
    limit = 25,
    beforeId?: string,
  ) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (beforeId && !uuidPattern.test(beforeId))
    )
      throw new BadRequestException('Invalid audit pagination');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await this.access.requireCampus(
        userId,
        campusId,
        'campus.audit.read',
        client,
      );
      const rows = await client.query<{
        id: string;
        action: string;
        target_type: string;
        target_id: string;
        reason: string;
        occurred_at: Date;
        actor_user_id: string | null;
        actor_service: string | null;
        metadata: Record<string, unknown>;
      }>(
        `
      WITH scoped AS (
        SELECT a.id, a.action, a.target_type, a.target_id, a.reason, a.occurred_at, a.actor_user_id, a.actor_service, a.metadata
        FROM audit_events a
        LEFT JOIN tenants t ON a.scope_type = 'tenant' AND t.id = a.scope_id
        WHERE (a.scope_type = 'campus' AND a.scope_id = $1) OR (a.scope_type = 'tenant' AND t.campus_id = $1)
        UNION ALL
        SELECT a.id, 'access.' || a.action, 'membership', a.membership_id, a.reason, a.occurred_at, a.actor_user_id, null::varchar,
          jsonb_build_object('subjectUserId',a.subject_user_id,'permissions',a.details)
        FROM access_audit_events a LEFT JOIN tenants t ON a.scope_type = 'tenant' AND t.id = a.scope_id
        WHERE (a.scope_type = 'campus' AND a.scope_id = $1) OR (a.scope_type = 'tenant' AND t.campus_id = $1)
      ) SELECT * FROM scoped WHERE $2::uuid IS NULL OR (occurred_at,id) < ((SELECT occurred_at FROM scoped WHERE id=$2),$2::uuid)
      ORDER BY occurred_at DESC,id DESC LIMIT $3`,
        [campusId, beforeId ?? null, limit + 1],
      );
      await client.query('COMMIT');
      const page = rows.rows.slice(0, limit);
      return {
        data: page.map((r) => ({
          id: r.id,
          actorUserId: r.actor_user_id,
          actorService: r.actor_service,
          action: r.action,
          targetType: r.target_type,
          targetId: r.target_id,
          reason: r.reason,
          metadata: r.metadata,
          occurredAt: r.occurred_at.toISOString(),
        })),
        meta: {
          nextCursor:
            rows.rows.length > limit ? (page.at(-1)?.id ?? null) : null,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
