import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Queue, Worker, type Job } from 'bullmq';
import { DatabaseService } from '../src/database/database.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import {
  OutboxDispatcher,
  OutboxProcessor,
} from '../src/jobs/outbox.processor';

describe(
  'Transactional outbox and scoped notifications PostgreSQL',
  { skip: !process.env.TEST_DATABASE_URL },
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const db = { pool } as DatabaseService;
    const outbox = new OutboxService(db);
    const notifications = new NotificationsService(db);
    const buyer = randomUUID();
    const otherBuyer = randomUUID();
    before(async () => {
      await pool.query(
        "INSERT INTO users (id, display_name) VALUES ($1, 'Outbox buyer'), ($2, 'Other outbox buyer')",
        [buyer, otherBuyer],
      );
    });
    after(async () => {
      await pool.end();
    });
    async function append(recipient = buyer) {
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        const id = await outbox.append(tx, {
          eventKey: randomUUID(),
          eventType: 'order.created',
          aggregateType: 'order',
          aggregateId: randomUUID(),
          recipientIds: [recipient, recipient],
        });
        await tx.query('COMMIT');
        return id;
      } finally {
        tx.release();
      }
    }
    it('rolls event creation back with its domain transaction', async () => {
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        const id = await outbox.append(tx, {
          eventKey: randomUUID(),
          eventType: 'order.created',
          aggregateType: 'order',
          aggregateId: randomUUID(),
          recipientIds: [buyer],
        });

        await tx.query('ROLLBACK');
        const persisted = await pool.query(
          'SELECT id FROM outbox_events WHERE id = $1',
          [id],
        );
        assert.equal(persisted.rowCount, 0);
      } finally {
        tx.release();
      }
    });
    it('reuses one business event across retries and rejects changed content', async () => {
      const input = {
        eventKey: `test:${randomUUID()}`,
        eventType: 'order.created' as const,
        aggregateType: 'order',
        aggregateId: randomUUID(),
        recipientIds: [buyer],
      };
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        const first = await outbox.append(tx, input);
        await tx.query('COMMIT');
        await tx.query('BEGIN');
        assert.equal(await outbox.append(tx, input), first);
        await assert.rejects(
          outbox.append(tx, { ...input, recipientIds: [otherBuyer] }),
          /key reused/,
        );
        await tx.query('ROLLBACK');
        await assert.rejects(
          pool.query(
            'UPDATE outbox_events SET recipient_ids = $1 WHERE id = $2',
            [[otherBuyer], first],
          ),
          /content is immutable/,
        );
      } finally {
        tx.release();
      }
    });
    it('preserves events on publish failure and deduplicates concurrent delivery', async () => {
      const id = await append();
      const brokenQueue = {
        add: async () => {
          throw new Error('redis unavailable');
        },
      } as unknown as Queue;
      await assert.rejects(
        new OutboxDispatcher(outbox, brokenQueue).flush(),
        /redis unavailable/,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT published_at FROM outbox_events WHERE id = $1',
            [id],
          )
        ).rows[0].published_at,
        null,
      );
      await Promise.all([
        outbox.deliver(id),
        outbox.deliver(id),
        outbox.deliver(id),
      ]);
      assert.equal(
        (
          await pool.query(
            'SELECT id FROM notifications WHERE event_id = $1 AND recipient_user_id = $2',
            [id, buyer],
          )
        ).rowCount,
        1,
      );
    });
    it('limits list/read/cursor to the recipient and makes read retries safe', async () => {
      const event = await append(otherBuyer);
      await outbox.deliver(event);
      const page = await notifications.list(otherBuyer);
      const id = page.data.find((n) => n.data.aggregateId)?.id;
      assert.ok(id);
      await assert.rejects(
        notifications.markRead(buyer, id),
        /Notification not found/,
      );
      await assert.rejects(
        notifications.list(buyer, 20, id),
        /Invalid notification cursor/,
      );
      await notifications.markRead(otherBuyer, id);
      const first = (await notifications.list(otherBuyer)).data[0].readAt;
      await notifications.markRead(otherBuyer, id);
      assert.equal(
        (await notifications.list(otherBuyer)).data[0].readAt,
        first,
      );
    });
    it('paginates tied microsecond timestamps without losing or duplicating records', async () => {
      const recipient = randomUUID();
      await pool.query(
        "INSERT INTO users (id, display_name) VALUES ($1, 'Cursor buyer')",
        [recipient],
      );
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        for (let i = 0; i < 5; i++) {
          const event = await outbox.append(tx, {
            eventKey: randomUUID(),
            eventType: 'order.created',
            aggregateType: 'order',
            aggregateId: randomUUID(),
            recipientIds: [recipient],
          });
          await tx.query(
            `INSERT INTO notifications (event_id, recipient_user_id, template, data, created_at)
          VALUES ($1,$2,'order.created','{}'::jsonb,'2026-11-12T01:00:00.123456Z')`,
            [event, recipient],
          );
        }
        await tx.query('COMMIT');
      } finally {
        tx.release();
      }
      const seen = [];
      let cursor: string | undefined;
      do {
        const page = await notifications.list(recipient, 2, cursor);
        seen.push(...page.data.map((n) => n.id));
        cursor = page.meta.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(seen.length, 5);
      assert.equal(new Set(seen).size, 5);
    });
    it(
      'roundtrips a durable event through real Redis/BullMQ',
      { skip: !process.env.TEST_REDIS_PORT },
      async () => {
        const connection = {
          host: '127.0.0.1',
          port: Number(process.env.TEST_REDIS_PORT),
          maxRetriesPerRequest: null,
        };
        const name = `outbox-test-${randomUUID()}`;
        const queue = new Queue(name, { connection });
        const processor = new OutboxProcessor(outbox);
        const worker = new Worker(name, (job: Job) => processor.process(job), {
          connection,
        });
        try {
          await worker.waitUntilReady();
          const id = await append();
          await queue.add(
            'deliver',
            { eventId: id },
            { jobId: `outbox-${id}`, attempts: 3 },
          );
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const row = await pool.query(
              'SELECT delivered_at FROM outbox_events WHERE id = $1',
              [id],
            );
            if (row.rows[0].delivered_at) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.equal(
            (
              await pool.query(
                'SELECT id FROM notifications WHERE event_id = $1',
                [id],
              )
            ).rowCount,
            1,
          );
        } finally {
          await worker.close();
          await queue.obliterate({ force: true });
          await queue.close();
        }
      },
    );
  },
);
