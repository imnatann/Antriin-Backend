import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export interface CampusListOptions {
  search?: string;
  limit?: number;
}

export interface CampusTenantListOptions {
  status?: string;
  limit?: number;
}

export interface CampusRow {
  id: string;
  name: string;
  timezone: string;
  status: string;
}

const TENANT_STATUS_FILTERS = new Set(['open', 'closed', 'paused', 'any']);

function clampLimit(limit: number | undefined, fallback = 50): number {
  if (limit === undefined) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function likePattern(search: string): string | null {
  const normalized = search.trim();
  if (!normalized) return null;
  return `%${normalized.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * Public campus discovery. Only active campuses and non-archived tenants are
 * ever exposed; inactive campuses are indistinguishable from missing ones
 * (404) so their existence and tenant roster are not leaked.
 */
@Injectable()
export class CampusesService {
  constructor(private readonly database: DatabaseService) {}

  async list(options: CampusListOptions = {}): Promise<{ data: CampusRow[] }> {
    const limit = clampLimit(options.limit);
    const pattern = options.search ? likePattern(options.search) : null;
    const result = await this.database.pool.query<CampusRow>(
      `SELECT id, name, timezone, status
         FROM campuses
        WHERE status = 'active'
          AND ($1::text IS NULL OR name ILIKE $1)
        ORDER BY name, id
        LIMIT $2`,
      [pattern, limit],
    );
    return { data: result.rows };
  }

  async get(campusId: string): Promise<{ data: CampusRow }> {
    const result = await this.database.pool.query<CampusRow>(
      `SELECT id, name, timezone, status
         FROM campuses
        WHERE id = $1 AND status = 'active'`,
      [campusId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Campus not found');
    return { data: row };
  }

  async listTenants(
    campusId: string,
    options: CampusTenantListOptions = {},
  ): Promise<{
    data: Array<{
      id: string;
      name: string;
      location: string;
      status: string;
    }>;
    meta: { campusId: string; campusName: string; timezone: string };
  }> {
    const status = options.status ?? 'open';
    if (!TENANT_STATUS_FILTERS.has(status)) {
      throw new BadRequestException('Invalid tenant status filter');
    }
    const limit = clampLimit(options.limit);
    const campus = await this.database.pool.query<CampusRow>(
      `SELECT id, name, timezone, status
         FROM campuses
        WHERE id = $1 AND status = 'active'`,
      [campusId],
    );
    if (!campus.rows[0]) throw new NotFoundException('Campus not found');
    const result = await this.database.pool.query<{
      id: string;
      name: string;
      location: string;
      status: string;
    }>(
      `SELECT t.id, t.name, t.location, t.status
         FROM tenants t
        WHERE t.campus_id = $1
          AND t.status <> 'archived'
          AND ($2::text = 'any' OR t.status = $2)
        ORDER BY t.name, t.id
        LIMIT $3`,
      [campusId, status, limit],
    );
    return {
      data: result.rows,
      meta: {
        campusId,
        campusName: campus.rows[0].name,
        timezone: campus.rows[0].timezone,
      },
    };
  }
}
