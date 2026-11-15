import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { uuidPattern } from '../notifications/outbox.service';

/**
 * Position in a recipient's notification stream.
 *
 * Timestamps are the PostgreSQL microsecond strings produced by to_char, never
 * a JS Date: a cursor rounded to milliseconds could skip or repeat a row that
 * shares the same millisecond with a neighbour.
 */
export interface EventsCursor {
  createdAt: string | null;
  id: string | null;
}

export interface NotificationEvent {
  id: string;
  template: string;
  data: { aggregateType: string; aggregateId: string };
  createdAt: string;
  readAt: string | null;
}

/** No cursor: stream every row still after this point (used when none exist). */
export const EMPTY_EVENTS_CURSOR: EventsCursor = { createdAt: null, id: null };

/**
 * microsecond UTC ISO text straight from PostgreSQL.
 *
 * Never round a timestamp through a JS Date here: milliseconds would make the
 * cursor and the event id disagree about ordering, and the id could then be
 * replayed or skipped.
 */
const timestamp = (column: 'created_at' | 'read_at'): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;

/**
 * Read side of the notification stream that GET /events/stream tails.
 *
 * The notifications table is the source of truth. Notifications are written by
 * whichever API/worker process handled the domain change, so polling rows is
 * what makes the stream survive more than one API instance and a deploy that
 * moves a client between instances. An in-process pub/sub bus would drop those
 * events; the outbox->notifications delivery is already the durable fan-out.
 */
@Injectable()
export class EventsService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Cursor the stream starts from.
   *
   * With `lastEventId` (Last-Event-ID header or ?last_event_id=) the stream
   * resumes after that row, so a reconnect does not replay the backlog. Without
   * it the stream starts at the newest row the caller already has: history is
   * what GET /me/notifications is for, and replaying it here would hand a fresh
   * connection an unbounded burst.
   *
   * An id that is unknown, malformed or belongs to another user is rejected
   * before a single byte is written, so the client sees 400 rather than a
   * stream that silently starts somewhere else.
   */
  async startCursor(
    userId: string,
    lastEventId?: string,
  ): Promise<EventsCursor> {
    if (lastEventId !== undefined) {
      if (!uuidPattern.test(lastEventId)) throw this.invalidLastEventId();
      const row = await this.database.pool.query<{ created_at: string }>(
        `SELECT ${timestamp('created_at')}
           FROM notifications
          WHERE id = $1 AND recipient_user_id = $2`,
        [lastEventId, userId],
      );
      if (!row.rows[0]) throw this.invalidLastEventId();
      return { createdAt: row.rows[0].created_at, id: lastEventId };
    }
    const latest = await this.database.pool.query<{
      id: string;
      created_at: string;
    }>(
      `SELECT id, ${timestamp('created_at')}
         FROM notifications
        WHERE recipient_user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [userId],
    );
    const row = latest.rows[0];
    return row
      ? { createdAt: row.created_at, id: row.id }
      : EMPTY_EVENTS_CURSOR;
  }

  /**
   * Rows for this recipient strictly after `cursor`, oldest first.
   *
   * The (created_at, id) tuple comparison matches notifications_recipient_cursor_idx
   * and keeps two rows created in the same microsecond from being skipped or
   * repeated. It is user-scoped in the WHERE clause, so another recipient's row
   * can never appear on someone else's stream.
   */
  async fetchAfter(
    userId: string,
    cursor: EventsCursor,
    limit: number,
  ): Promise<NotificationEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new RangeError('Notification batch size out of range');
    const rows = await this.database.pool.query<{
      id: string;
      template: string;
      data: NotificationEvent['data'];
      created_at: string;
      read_at: string | null;
    }>(
      `SELECT id, template, data, ${timestamp('created_at')}, ${timestamp('read_at')}
         FROM notifications
        WHERE recipient_user_id = $1
          AND (
            $2::timestamptz IS NULL
            OR (created_at, id) > ($2::timestamptz, $3::uuid)
          )
        ORDER BY created_at ASC, id ASC
        LIMIT $4`,
      [userId, cursor.createdAt, cursor.id, limit],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      template: row.template,
      data: row.data,
      createdAt: row.created_at,
      readAt: row.read_at,
    }));
  }

  private invalidLastEventId(): BadRequestException {
    return new BadRequestException({
      code: 'EVENTS_INVALID_LAST_EVENT_ID',
      message:
        'last_event_id must be a notification id previously delivered to you on this stream',
    });
  }
}
