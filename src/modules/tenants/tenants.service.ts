import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';

export interface TenantListOptions {
  campusId?: string;
  limit?: number;
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
  ) {}

  async list(options: TenantListOptions = {}) {
    if (options.campusId && !/^[0-9a-f-]{36}$/i.test(options.campusId)) {
      throw new NotFoundException('Campus not found');
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
    const result = await this.database.pool.query<{
      id: string;
      campus_id: string;
      campus_name: string;
      name: string;
      location: string;
      status: string;
      timezone: string;
    }>(
      `SELECT t.id, t.campus_id, c.name AS campus_name, t.name, t.location,
              t.status, c.timezone
         FROM tenants t
         JOIN campuses c ON c.id = t.campus_id
        WHERE c.status = 'active'
          AND t.status <> 'archived'
          AND ($1::uuid IS NULL OR t.campus_id = $1)
        ORDER BY c.name, t.name, t.id
        LIMIT $2`,
      [options.campusId ?? null, limit],
    );
    return { data: result.rows.map((row) => this.presentTenant(row)) };
  }

  async get(tenantId: string) {
    const result = await this.database.pool.query<{
      id: string;
      campus_id: string;
      campus_name: string;
      name: string;
      location: string;
      status: string;
      timezone: string;
    }>(
      `SELECT t.id, t.campus_id, c.name AS campus_name, t.name, t.location,
              t.status, c.timezone
         FROM tenants t
         JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND t.status <> 'archived' AND c.status = 'active'`,
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Tenant not found');
    return { data: this.presentTenant(row) };
  }

  async create(
    actorUserId: string,
    campusId: string,
    input: { name: string; location: string },
  ) {
    return this.withTransaction(async (client) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.tenants.manage',
        client,
      );
      const result = await client.query<{
        id: string;
        name: string;
        location: string;
        status: string;
        updated_at: Date;
      }>(
        `INSERT INTO tenants (campus_id, name, location, status, updated_at)
         VALUES ($1, $2, $3, 'closed', now())
         RETURNING id, name, location, status, updated_at`,
        [
          campusId,
          this.requiredText(input.name),
          this.requiredText(input.location),
        ],
      );
      const row = result.rows[0];
      return {
        data: {
          id: row.id,
          campusId,
          name: row.name,
          location: row.location,
          status: row.status,
          updatedAt: row.updated_at.toISOString(),
        },
      };
    });
  }

  async update(
    actorUserId: string,
    campusId: string,
    tenantId: string,
    input: { name: string; location: string; expectedUpdatedAt: string },
  ) {
    return this.withTransaction(async (client) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.tenants.manage',
        client,
      );
      const result = await client.query<{
        id: string;
        name: string;
        location: string;
        status: string;
        updated_at: Date;
      }>(
        `UPDATE tenants
            SET name = $3, location = $4, updated_at = now()
          WHERE id = $1 AND campus_id = $2 AND status <> 'archived'
            AND updated_at = $5::timestamptz
          RETURNING id, name, location, status, updated_at`,
        [
          tenantId,
          campusId,
          this.requiredText(input.name),
          this.requiredText(input.location),
          input.expectedUpdatedAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new ConflictException('Tenant changed or unavailable');
      return {
        data: {
          id: row.id,
          campusId,
          name: row.name,
          location: row.location,
          status: row.status,
          updatedAt: row.updated_at.toISOString(),
        },
      };
    });
  }

  async archive(
    actorUserId: string,
    campusId: string,
    tenantId: string,
    expectedUpdatedAt: string,
  ) {
    return this.withTransaction(async (client) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.tenants.manage',
        client,
      );
      const result = await client.query(
        `UPDATE tenants SET status = 'archived', updated_at = now()
          WHERE id = $1 AND campus_id = $2 AND status <> 'archived'
            AND updated_at = $3::timestamptz
          RETURNING id`,
        [tenantId, campusId, expectedUpdatedAt],
      );
      if (result.rowCount !== 1) {
        throw new ConflictException('Tenant changed or unavailable');
      }
      return { data: { id: tenantId, status: 'archived' } };
    });
  }

  private presentTenant(row: {
    id: string;
    campus_id: string;
    campus_name: string;
    name: string;
    location: string;
    status: string;
    timezone: string;
  }) {
    return {
      id: row.id,
      campusId: row.campus_id,
      campusName: row.campus_name,
      name: row.name,
      location: row.location,
      status: row.status,
      timezone: row.timezone,
    };
  }

  private requiredText(value: string): string {
    const normalized = value.trim();
    if (!normalized)
      throw new ConflictException('Required text cannot be empty');
    return normalized;
  }

  private async withTransaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
