import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { uuidPattern } from './outbox.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly database: DatabaseService) {}
  async list(userId: string, limit = 20, cursor?: string) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (cursor && !uuidPattern.test(cursor))
    ) {
      throw new BadRequestException('Invalid notification pagination');
    }
    let cursorTime: string | null = null;
    if (cursor) {
      const row = await this.database.pool.query<{ created_at: string }>(
        'SELECT created_at::text FROM notifications WHERE id = $1 AND recipient_user_id = $2',
        [cursor, userId],
      );
      if (!row.rows[0])
        throw new BadRequestException('Invalid notification cursor');
      // Preserve PostgreSQL microseconds; never round a cursor through JS Date.
      cursorTime = row.rows[0].created_at;
    }
    const rows = await this.database.pool.query<{
      id: string;
      template: string;
      data: { aggregateType: string; aggregateId: string };
      created_at: Date;
      read_at: Date | null;
    }>(
      `SELECT id, template, data, created_at, read_at FROM notifications
        WHERE recipient_user_id = $1 AND ($2::uuid IS NULL OR (created_at, id) < ($3::timestamptz, $2::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [userId, cursor ?? null, cursorTime, limit + 1],
    );
    const more = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit);
    return {
      data: page.map((r) => ({
        id: r.id,
        template: r.template,
        data: r.data,
        createdAt: r.created_at.toISOString(),
        readAt: r.read_at?.toISOString() ?? null,
      })),
      meta: { nextCursor: more ? (page.at(-1)?.id ?? null) : null },
    };
  }
  async markRead(userId: string, id: string): Promise<void> {
    const result = await this.database.pool.query(
      'UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND recipient_user_id = $2',
      [id, userId],
    );
    if (result.rowCount === 0)
      throw new NotFoundException('Notification not found');
  }
}
