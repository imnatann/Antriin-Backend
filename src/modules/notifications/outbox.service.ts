import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';

export const DOMAIN_EVENT_TYPES = [
  'order.created',
  'order.status_changed',
  'schedule_proposal.created',
  'schedule_proposal.decided',
  'case.reported',
  'case.decided',
  'review.created',
  'review.reported',
  'review.moderated',
  'refund.status_changed',
  'payout.status_changed',
  'topup.status_changed',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface OutboxInput {
  eventKey: string;
  eventType: DomainEventType;
  aggregateType: string;
  aggregateId: string;
  recipientIds: readonly string[];
}

@Injectable()
export class OutboxService {
  constructor(private readonly database: DatabaseService) {}

  // The caller's transaction owns commit. Only references enter the event payload.
  async append(client: PoolClient, input: OutboxInput): Promise<string> {
    if (
      typeof input.eventKey !== 'string' ||
      !input.eventKey.trim() ||
      input.eventKey.length > 200 ||
      !DOMAIN_EVENT_TYPES.includes(input.eventType) ||
      !/^[a-z_]{1,40}$/.test(input.aggregateType) ||
      !uuidPattern.test(input.aggregateId) ||
      input.recipientIds.length > 100 ||
      !input.recipientIds.every((id) => uuidPattern.test(id))
    ) {
      throw new BadRequestException('Invalid domain event');
    }
    // Domain services must derive recipients from authorized resources inside this
    // transaction, never copy recipient IDs from an HTTP DTO.
    const recipients = [...new Set(input.recipientIds)].sort();
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          eventType: input.eventType,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          recipients,
        }),
      )
      .digest('hex');
    const result = await client.query<{ id: string }>(
      `INSERT INTO outbox_events (event_key, request_hash, event_type, aggregate_type, aggregate_id, recipient_ids)
       VALUES ($1, $2, $3, $4, $5, $6::uuid[]) ON CONFLICT (event_key) DO NOTHING RETURNING id`,
      [
        input.eventKey,
        hash,
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        recipients,
      ],
    );
    if (result.rows[0]) return result.rows[0].id;
    const existing = await client.query<{ id: string; request_hash: string }>(
      'SELECT id, request_hash FROM outbox_events WHERE event_key = $1',
      [input.eventKey],
    );
    if (existing.rows[0]?.request_hash !== hash)
      throw new ConflictException(
        'Domain event key reused with different content',
      );
    return existing.rows[0].id;
  }

  async pending(limit = 100): Promise<{ id: string }[]> {
    const result = await this.database.pool.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE published_at IS NULL AND failed_at IS NULL
       ORDER BY created_at, id LIMIT $1`,
      [Math.min(Math.max(Math.trunc(limit), 1), 100)],
    );
    return result.rows;
  }

  async markPublished(id: string): Promise<void> {
    await this.database.pool.query(
      'UPDATE outbox_events SET published_at = COALESCE(published_at, now()) WHERE id = $1',
      [id],
    );
  }

  async markFailed(id: string): Promise<void> {
    await this.database.pool.query(
      'UPDATE outbox_events SET failed_at = COALESCE(failed_at, now()) WHERE id = $1 AND delivered_at IS NULL',
      [id],
    );
  }

  async deliver(id: string): Promise<void> {
    if (!uuidPattern.test(id))
      throw new BadRequestException('Invalid event id');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        event_type: DomainEventType;
        aggregate_type: string;
        aggregate_id: string;
        recipient_ids: string[];
        delivered_at: Date | null;
        failed_at: Date | null;
      }>('SELECT * FROM outbox_events WHERE id = $1 FOR UPDATE', [id]);
      const event = result.rows[0];
      if (!event) throw new BadRequestException('Domain event not found');
      if (event.delivered_at || event.failed_at) {
        await client.query('COMMIT');
        return;
      }
      if (!DOMAIN_EVENT_TYPES.includes(event.event_type))
        throw new BadRequestException('Unsupported domain event');
      for (const recipientId of event.recipient_ids) {
        await client.query(
          `INSERT INTO notifications (event_id, recipient_user_id, template, data)
           VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (event_id, recipient_user_id) DO NOTHING`,
          [
            id,
            recipientId,
            event.event_type,
            JSON.stringify({
              aggregateType: event.aggregate_type,
              aggregateId: event.aggregate_id,
            }),
          ],
        );
      }
      await client.query(
        'UPDATE outbox_events SET delivered_at = now() WHERE id = $1',
        [id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
