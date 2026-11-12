import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { uuidPattern } from '../notifications/outbox.service';
import { REFUNDS_QUEUE_JOB_NAME, RefundsService } from './refunds.service';

/**
 * Queue name for refund provider-request processing. Root registers this in
 * src/jobs/jobs.module.ts (BullModule.registerQueue) and adds both classes
 * below as providers in src/worker.module.ts, importing RefundsModule
 * (same pattern as payment-requests).
 */
export const REFUND_REQUESTS_QUEUE = 'refund-requests';

/** A due row waiting longer than this without progress raises an alarm log. */
export const REFUND_REQUEST_STALE_ALARM_SECONDS = 120;

/**
 * Polls due refund_request_outbox rows and enqueues one job per row. The
 * jobId embeds the attempt count AND a nonce (row updated_at in epoch
 * microseconds) so it is stable while nothing happened — deduplicating
 * concurrent dispatcher ticks — and fresh after any lease/defer/settle
 * cycle. If an add dedupes onto a terminally FAILED job, the stale job is
 * removed and the row re-enqueued (payments review P2-01). No PostgreSQL
 * lock is held while talking to Redis.
 */
@Injectable()
export class RefundRequestDispatcher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RefundRequestDispatcher.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly refunds: RefundsService,
    @InjectQueue(REFUND_REQUESTS_QUEUE) private readonly queue: Queue,
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
        this.logger.warn('Refund request dispatch failed; due rows will retry');
      })
      .finally(() => {
        this.running = undefined;
      });
  }
  async flush(): Promise<void> {
    for (const row of await this.refunds.listDueRefundRequests()) {
      if (row.staleForSeconds >= REFUND_REQUEST_STALE_ALARM_SECONDS) {
        this.logger.warn(
          'Refund request row ' +
            row.refundId +
            ' has been due for ' +
            String(row.staleForSeconds) +
            's without completing (attempts=' +
            String(row.attempts) +
            '); investigate worker health',
        );
      }
      const jobId =
        'refund-request-' + row.refundId + '-' + row.attempts + '-' + row.nonce;
      const job = await this.queue.add(
        REFUNDS_QUEUE_JOB_NAME,
        { refundId: row.refundId },
        { jobId },
      );
      // A terminally failed job retains its id (removeOnFail); without this
      // cleanup a row that never changed state would never be re-enqueued.
      const state = await job.getState();
      if (state === 'failed') {
        await job.remove();
        await this.queue.add(
          REFUNDS_QUEUE_JOB_NAME,
          { refundId: row.refundId },
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
 * Worker that drives a single leased refund request to completion. All
 * retry/backoff/assistance state lives in PostgreSQL (see
 * RefundsService.processRefundRequest), so a BullMQ redelivery cannot
 * duplicate financial effects. Unrecoverable job shapes fail fast.
 */
@Processor(REFUND_REQUESTS_QUEUE)
export class RefundRequestProcessor extends WorkerHost {
  constructor(private readonly refunds: RefundsService) {
    super();
  }
  async process(job: Job): Promise<void> {
    const data: unknown = job.data;
    if (
      job.name !== REFUNDS_QUEUE_JOB_NAME ||
      typeof data !== 'object' ||
      data === null ||
      !('refundId' in data) ||
      typeof data.refundId !== 'string' ||
      !uuidPattern.test(data.refundId)
    ) {
      throw new UnrecoverableError('Invalid refund request job');
    }
    await this.refunds.processRefundRequest(data.refundId);
  }
}
