import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import {
  EXPIRE_TOPUP_INTENTS_JOB,
  TOPUP_EXPIRY_ACTOR_SERVICE,
  TOPUP_EXPIRY_BATCH_SIZE,
  TOPUP_EXPIRY_MAX_BATCHES,
} from './maintenance-jobs.constants';

export type TopupExpirySummary = {
  job: typeof EXPIRE_TOPUP_INTENTS_JOB;
  expired: number;
  batches: number;
  /** True when the pass stopped at the batch cap with work still due. */
  capped: boolean;
};

type ExpiredRow = {
  id: string;
  user_id: string;
  provider: string;
  amount_minor: string;
  currency: string;
};

/**
 * Moves pending top-up intents past their expires_at to 'expired'
 * (REQUIREMENTS §4 top-up lifecycle: 'pending' -> 'expired').
 *
 * Only rows in status 'pending' are touched. The brief also names a 'created'
 * status, but this schema has none (schema 0007 defaults new intents straight
 * to 'pending' and its CHECK allows only pending/succeeded/failed/expired/
 * needs_assistance), so 'pending' is the only pre-settlement status that can
 * expire. The conditional UPDATE plus the status guard make a re-run a no-op: a
 * second pass finds nothing due and reports zero. The ownership wallet is never
 * touched and no money moves - expiring an intent only stops it from being
 * payable later.
 *
 * The transition is written with an audit row in the same transaction, matching
 * how the provider webhook records the same state change (actor: service).
 *
 * A pass is bounded by TOPUP_EXPIRY_BATCH_SIZE rows per statement and
 * TOPUP_EXPIRY_MAX_BATCHES statements, so a large backlog is drained over
 * several scheduled runs instead of holding one long transaction.
 */
@Injectable()
export class ExpireTopupIntentsJob {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async run(): Promise<TopupExpirySummary> {
    let expired = 0;
    let batches = 0;
    let lastBatchSize = 0;
    while (batches < TOPUP_EXPIRY_MAX_BATCHES) {
      lastBatchSize = await this.expireBatch();
      batches += 1;
      expired += lastBatchSize;
      if (lastBatchSize < TOPUP_EXPIRY_BATCH_SIZE) break;
    }
    return {
      job: EXPIRE_TOPUP_INTENTS_JOB,
      expired,
      batches,
      capped:
        batches === TOPUP_EXPIRY_MAX_BATCHES &&
        lastBatchSize === TOPUP_EXPIRY_BATCH_SIZE,
    };
  }

  /** One bounded, atomic batch: status transition + audit rows. */
  private async expireBatch(): Promise<number> {
    const client = await this.database.pool.connect();
    try {
      await client.query('begin');
      // FOR UPDATE SKIP LOCKED means two worker instances never expire the same
      // intent twice; the 'pending' predicate makes an already-expired row
      // invisible to the next pass.
      const result = await client.query<ExpiredRow>(
        `with due as (
           select id
             from topup_intents
            where status = 'pending'
              and expires_at is not null
              and expires_at <= now()
            order by expires_at, id
            limit $1
            for update skip locked
         )
         update topup_intents t
            set status = 'expired',
                status_version = t.status_version + 1,
                updated_at = now()
           from due
          where t.id = due.id
         returning t.id::text as id,
                   t.user_id::text as user_id,
                   t.provider,
                   t.amount_minor::text as amount_minor,
                   t.currency`,
        [TOPUP_EXPIRY_BATCH_SIZE],
      );
      for (const row of result.rows) {
        await this.audit.append(client, {
          actor: { service: TOPUP_EXPIRY_ACTOR_SERVICE },
          scopeType: 'user',
          scopeId: row.user_id,
          action: 'topup.expired',
          targetType: 'topup_intent',
          targetId: row.id,
          reason:
            'Pending top-up intent passed its expires_at; the scheduled expiry sweep moved it to expired',
          metadata: {
            provider: row.provider,
            amountMinor: row.amount_minor,
            currency: row.currency,
          },
        });
      }
      await client.query('commit');
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
