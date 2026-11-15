import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DatabaseService } from '../src/database/database.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const MICRO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

describe(
  'Unread notifications (PostgreSQL)',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let notifications: NotificationsService;
    let recipient: string;
    let otherUser: string;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
      notifications = new NotificationsService({ pool } as DatabaseService);
      recipient = await insertUser(pool, 'Unread recipient');
      otherUser = await insertUser(pool, 'Other recipient');
      // Three notifications for the recipient (one already read) and one for
      // somebody else, so both the filter and the ownership scope are testable.
      await insertNotification(pool, recipient, 'order.created', 3, true);
      await insertNotification(pool, recipient, 'order.created', 2, false);
      await insertNotification(
        pool,
        recipient,
        'refund.status_changed',
        1,
        false,
      );
      await insertNotification(pool, otherUser, 'order.created', 4, false);
    });

    after(async () => {
      await pool?.end();
    });

    it('reports the total unread count and keeps the cursor contract', async () => {
      const page = await notifications.list(recipient, 2);

      assert.equal(page.data.length, 2);
      assert.ok(page.meta.nextCursor, 'a second page exists');
      assert.equal(page.meta.unreadCount, 2, 'read rows are not counted');
      // Microsecond UTC strings, newest first, read state of each row intact.
      for (const row of page.data) {
        assert.match(row.createdAt, MICRO_UTC);
        if (row.readAt !== null) assert.match(row.readAt, MICRO_UTC);
      }
      assert.equal(page.data[0].readAt, null);
      assert.equal(page.data[1].readAt, null);

      const second = await notifications.list(
        recipient,
        2,
        page.meta.nextCursor!,
      );
      assert.equal(second.data.length, 1);
      assert.equal(second.meta.nextCursor, null);
      assert.ok(second.data[0].readAt, 'the read row is last by createdAt');
      assert.equal(second.meta.unreadCount, 2);
      assert.equal(
        new Set([...page.data, ...second.data].map((row) => row.id)).size,
        3,
        'no row is repeated across pages',
      );
    });

    it('filters to unread rows only while counting all unread rows', async () => {
      const page = await notifications.list(recipient, 20, undefined, true);

      assert.equal(page.data.length, 2);
      assert.ok(page.data.every((row) => row.readAt === null));
      assert.equal(page.meta.unreadCount, 2);

      const readIncluded = await notifications.list(
        recipient,
        20,
        undefined,
        false,
      );
      assert.equal(readIncluded.data.length, 3);
      assert.equal(readIncluded.meta.unreadCount, 2);
    });

    it('pages through unread notifications with the same cursor semantics', async () => {
      const first = await notifications.list(recipient, 1, undefined, true);
      assert.equal(first.data.length, 1);
      assert.ok(first.meta.nextCursor);
      const second = await notifications.list(
        recipient,
        1,
        first.meta.nextCursor!,
        true,
      );
      assert.equal(second.data.length, 1);
      assert.notEqual(second.data[0].id, first.data[0].id);
      assert.equal(second.data[0].readAt, null);
      assert.equal(second.meta.nextCursor, null);
      assert.equal(second.meta.unreadCount, 2);
    });

    it('tracks the count after a row is marked read, scoped to its owner', async () => {
      const target = (await notifications.list(recipient, 1, undefined, true))
        .data[0];
      await notifications.markRead(recipient, target.id);

      const page = await notifications.list(recipient);
      assert.equal(page.meta.unreadCount, 1);
      assert.equal(page.data.filter((row) => row.readAt === null).length, 1);

      // Another user's row cannot be marked read, and their count is untouched.
      const otherPage = await notifications.list(otherUser);
      await assert.rejects(
        notifications.markRead(recipient, otherPage.data[0].id),
        /Notification not found/,
      );
      assert.equal((await notifications.list(otherUser)).meta.unreadCount, 1);
    });

    it('rejects an invalid unread argument instead of coercing it', async () => {
      await assert.rejects(
        notifications.list(
          recipient,
          20,
          undefined,
          'true' as unknown as boolean,
        ),
        /Invalid notification pagination/,
      );
    });
  },
);

async function insertUser(pool: Pool, name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO users (display_name) VALUES ($1) RETURNING id',
    [name + ' ' + randomUUID()],
  );
  return result.rows[0].id;
}

/** Creates an outbox event (the notifications FK target) plus one row per age. */
async function insertNotification(
  pool: Pool,
  recipient: string,
  template: string,
  ageMinutes: number,
  read: boolean,
): Promise<void> {
  const eventId = (
    await pool.query<{ id: string }>(
      `INSERT INTO outbox_events
         (event_key, request_hash, event_type, aggregate_type, aggregate_id,
          recipient_ids)
       VALUES ($1, repeat('a', 64), 'order.created', 'order', $2, ARRAY[$3]::uuid[])
       RETURNING id`,
      ['unread-test:' + randomUUID(), randomUUID(), recipient],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO notifications
       (event_id, recipient_user_id, template, data, created_at, read_at)
     VALUES ($1, $2, $3, $4::jsonb, now() - ($5 || ' minutes')::interval,
             CASE WHEN $6 THEN now() ELSE NULL END)`,
    [
      eventId,
      recipient,
      template,
      JSON.stringify({ aggregateType: 'order', aggregateId: randomUUID() }),
      ageMinutes,
      read,
    ],
  );
}
