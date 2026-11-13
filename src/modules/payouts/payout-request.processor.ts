import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { uuidPattern } from '../notifications/outbox.service';
import {
  PAYOUTS_QUEUE_JOB_NAME,
  PAYOUTS_QUEUE_NAME,
  PAYOUT_REQUEST_STALE_ALARM_SECONDS,
} from './payouts.constants';
import { PayoutsService } from './payouts.service';

/**
 * Queue name for payout provider-request processing. ROOT registers this in
 * src/jobs/jobs.module.ts (BullModule.registerQueue({ name: PAYOUTS_QUEUE_NAME }))
 * and adds both classes below as providers in src/worker.module.ts, importing
 * PayoutsModule (same pattern as payment-requests / refund-requests).
 * This module never registers the queue itself, so the HTTP app boots without
 * Redis queue wiring.
 */
export const PAYOUT_REQUESTS_QUEUE = PAYOUTS_QUEUE_NAME;

/**
 * Polls due payout_request_outbox rows and enqueues one job per row. The jobId
 * embeds the attempt count AND a nonce (row updated_at in epoch microseconds),
 * so it is stable while nothing happened - deduplicating concurrent dispatcher
 * ticks - and fresh after any lease/defer/settle cycle. If an add dedupes onto
 * a terminally FAILED job, the stale job is removed and the row re-enqueued
 * (payments review P2-01, D17). No PostgreSQL lock is held while talking to
 * Redis.
 */
@Injectable()
export class PayoutRequestDispatcher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PayoutRequestDispatcher.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly payouts: PayoutsService,
    @InjectQueue(PAYOUT_REQUESTS_QUEUE) private readonly queue: Queue,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }

  private tick() {
    if (this.running || this.stopping) return;
    this.running = this.flush()
      .catch(() => {
        this.logger.warn('Payout request dispatch failed; due rows will retry');
      })
      .finally(() => {
        this.running = undefined;
      });
  }

  async flush(): Promise<void> {
    for (const row of await this.payouts.listDuePayoutRequests()) {
      if (row.staleForSeconds >= PAYOUT_REQUEST_STALE_ALARM_SECONDS) {
        this.logger.warn(
          'Payout request row ' +
            row.payoutId +
            ' has been due for ' +
            String(row.staleForSeconds) +
            's without completing (attempts=' +
            String(row.attempts) +
            '); investigate worker health',
        );
      }
      const jobId =
        'payout-request-' + row.payoutId + '-' + row.attempts + '-' + row.nonce;
      const job = await this.queue.add(
        PAYOUTS_QUEUE_JOB_NAME,
        { payoutId: row.payoutId },
        { jobId },
      );
      // A terminally failed job retains its id (removeOnFail); without this
      // cleanup a row that never changed state would never be re-enqueued.
      const state = await job.getState();
      if (state === 'failed') {
        await job.remove();
        await this.queue.add(
          PAYOUTS_QUEUE_JOB_NAME,
          { payoutId: row.payoutId },
          { jobId },
        );
      }
    }
  }

  async beforeApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}

/**
 * Worker that drives a single leased payout request to completion. All
 * retry/backoff/assistance state lives in PostgreSQL (see
 * PayoutsService.processPayoutRequest), so a BullMQ redelivery cannot
 * duplicate financial effects. Unrecoverable job shapes fail fast.
 */
@Processor(PAYOUT_REQUESTS_QUEUE)
export class PayoutRequestProcessor extends WorkerHost {
  constructor(private readonly payouts: PayoutsService) {
    super();
  }

  async process(job: Job): Promise<void> {
    const data: unknown = job.data;
    if (
      job.name !== PAYOUTS_QUEUE_JOB_NAME ||
      typeof data !== 'object' ||
      data === null ||
      !('payoutId' in data) ||
      typeof data.payoutId !== 'string' ||
      !uuidPattern.test(data.payoutId)
    ) {
      throw new UnrecoverableError('Invalid payout request job');
    }
    await this.payouts.processPayoutRequest(data.payoutId);
  }
}
