import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { uuidPattern } from './outbox.service';

/**
 * Response timestamps are the PostgreSQL microsecond UTC strings themselves
 * (repository convention): re-serializing through Date.toISOString() would
 * silently truncate to milliseconds.
 */
const TS = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface NotificationPage {
  data: {
    id: string;
    template: string;
    data: { aggregateType: string; aggregateId: string };
    createdAt: string;
    readAt: string | null;
  }[];
  /** Cursor piggy-backs on the last row id; unreadCount is independent of it. */
  meta: { nextCursor: string | null; unreadCount: number };
}

@Injectable()
export class NotificationsService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * One page of the recipient's in-app notifications, newest first.
   *
   * The cursor contract is unchanged (opaque id of the last row of the previous
   * page, resolved back to its created_at inside the recipient's own rows).
   * `unread` is an OPTIONAL filter over the same ordering, so paging through
   * unread-only notifications keeps the exact same semantics. meta.unreadCount
   * always counts the recipient's unread rows — not just this page or the
   * current filter — so a badge stays correct while a filter is applied.
   */
  async list(
    userId: string,
    limit = 20,
    cursor?: string,
    unread?: boolean,
  ): Promise<NotificationPage> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (cursor && !uuidPattern.test(cursor)) ||
      (unread !== undefined && typeof unread !== 'boolean')
    ) {
      throw new BadRequestException('Invalid notification pagination');
    }
    let cursorTime: string | null = null;
    if (cursor) {
      const row = await this.database.pool.query<{ created_at: string }>(
        `SELECT ${TS('created_at')} AS created_at FROM notifications WHERE id = $1 AND recipient_user_id = $2`,
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
      created_at: string;
      read_at: string | null;
    }>(
      `SELECT id, template, data,
              ${TS('created_at')} AS created_at,
              ${TS('read_at')} AS read_at
         FROM notifications
        WHERE recipient_user_id = $1
          AND ($2::uuid IS NULL OR (created_at, id) < ($3::timestamptz, $2::uuid))
          AND ($5::boolean IS NULL OR read_at IS NULL)
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [
        userId,
        cursor ?? null,
        cursorTime,
        limit + 1,
        unread === true ? true : null,
      ],
    );
    const unreadRows = await this.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM notifications WHERE recipient_user_id = $1 AND read_at IS NULL',
      [userId],
    );
    const more = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit);
    return {
      data: page.map((r) => ({
        id: r.id,
        template: r.template,
        data: r.data,
        createdAt: r.created_at,
        readAt: r.read_at,
      })),
      meta: {
        nextCursor: more ? (page.at(-1)?.id ?? null) : null,
        unreadCount: Number(unreadRows.rows[0]?.count ?? '0'),
      },
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
