import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  IDEMPOTENCY_PURGE_BATCH_SIZE,
  IDEMPOTENCY_PURGE_MAX_BATCHES,
  PURGE_ORDER_IDEMPOTENCY_JOB,
} from './maintenance-jobs.constants';

export type OrderIdempotencyPurgeSummary = {
  job: typeof PURGE_ORDER_IDEMPOTENCY_JOB;
  purged: number;
  batches: number;
  /** True when the pass stopped at the batch cap with work still due. */
  capped: boolean;
};

/**
 * Deletes order idempotency replay records whose expires_at has passed.
 *
 * Checkout writes expires_at = now() + IDEMPOTENCY_RETENTION_DAYS
 * (src/modules/orders/orders.constants.ts), so the retention decision lives in
 * the orders slice and this job only enforces it. A row whose expires_at is
 * NULL deliberately opts out of expiry and is never deleted.
 *
 * Deleting the row only removes a replay answer for a request key that will
 * never be re-sent after the retention window; it does not touch the order, the
 * ledger or any wallet. A re-run finds nothing due and reports zero.
 */
@Injectable()
export class PurgeOrderIdempotencyJob {
  constructor(private readonly database: DatabaseService) {}

  async run(): Promise<OrderIdempotencyPurgeSummary> {
    let purged = 0;
    let batches = 0;
    let lastBatchSize = 0;
    while (batches < IDEMPOTENCY_PURGE_MAX_BATCHES) {
      lastBatchSize = await this.purgeBatch();
      batches += 1;
      purged += lastBatchSize;
      if (lastBatchSize < IDEMPOTENCY_PURGE_BATCH_SIZE) break;
    }
    return {
      job: PURGE_ORDER_IDEMPOTENCY_JOB,
      purged,
      batches,
      capped:
        batches === IDEMPOTENCY_PURGE_MAX_BATCHES &&
        lastBatchSize === IDEMPOTENCY_PURGE_BATCH_SIZE,
    };
  }

  private async purgeBatch(): Promise<number> {
    // The CTE is the only way to bound a DELETE: pick at most one batch of due
    // ids, locking them so concurrent workers do not contend on the same rows.
    const result = await this.database.pool.query(
      `with due as (
         select id
           from order_request_idempotency
          where expires_at is not null
            and expires_at <= now()
          order by expires_at, id
          limit $1
          for update skip locked
       )
       delete from order_request_idempotency o
        using due
        where o.id = due.id
       returning o.id`,
      [IDEMPOTENCY_PURGE_BATCH_SIZE],
    );
    return result.rowCount ?? 0;
  }
}
