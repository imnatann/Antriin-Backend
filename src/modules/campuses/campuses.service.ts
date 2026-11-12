import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class CampusesService {
  constructor(private readonly database: DatabaseService) {}

  async list(limit = 50) {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const result = await this.database.pool.query<{
      id: string;
      name: string;
      timezone: string;
    }>(
      `SELECT id, name, timezone FROM campuses
        WHERE status = 'active'
        ORDER BY name, id
        LIMIT $1`,
      [boundedLimit],
    );
    return { data: result.rows };
  }
}
