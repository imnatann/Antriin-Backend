import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { uuidPattern } from '../notifications/outbox.service';
import { PAYMENTS_QUEUE_JOB_NAME, PaymentsService } from './payments.service';

/**
 * Queue name for top-up provider-request processing. Root registers this in
 * src/jobs/jobs.module.ts (BullModule.registerQueue) and adds both classes
 * below as providers in src/worker.module.ts, importing PaymentsModule.
 */
export const PAYMENT_REQUESTS_QUEUE = 'payment-requests';

/** A due row waiting longer than this without progress raises an alarm log. */
export const PAYMENT_REQUEST_STALE_ALARM_SECONDS = 120;

/**
 * Polls due payment_request_outbox rows and enqueues one job per row. The
 * jobId embeds the attempt count AND a nonce (row updated_at in epoch
 * microseconds), so it is stable while nothing happened — deduplicating
 * concurrent dispatcher ticks — and fresh after any lease/defer/settle cycle.
 * If an add is deduplicated onto a terminally FAILED job (e.g. the database
 * was down for the whole BullMQ retry window and the row never changed), the
 * stale failed job is removed and the row re-enqueued, so a due row can never
 * stall forever (review P2-01). Rows due for longer than
 * PAYMENT_REQUEST_STALE_ALARM_SECONDS produce a warning log.
 * No PostgreSQL lock is held while talking to Redis.
 */
@Injectable()
export class PaymentRequestDispatcher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PaymentRequestDispatcher.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly payments: PaymentsService,
    @InjectQueue(PAYMENT_REQUESTS_QUEUE) private readonly queue: Queue,
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
        this.logger.warn(
          'Payment request dispatch failed; due rows will retry',
        );
      })
      .finally(() => {
        this.running = undefined;
      });
  }
  async flush(): Promise<void> {
    for (const row of await this.payments.listDuePaymentRequests()) {
      if (row.staleForSeconds >= PAYMENT_REQUEST_STALE_ALARM_SECONDS) {
        this.logger.warn(
          'Payment request row ' +
            row.topupId +
            ' has been due for ' +
            String(row.staleForSeconds) +
            's without completing (attempts=' +
            String(row.attempts) +
            '); investigate worker health',
        );
      }
      const jobId =
        'payment-request-' + row.topupId + '-' + row.attempts + '-' + row.nonce;
      const job = await this.queue.add(
        PAYMENTS_QUEUE_JOB_NAME,
        { topupId: row.topupId },
        { jobId },
      );
      // BullMQ deduplicates an add onto an existing job id, including one
      // that already failed terminally and is retained by removeOnFail.
      // Without this cleanup a row whose processing threw before any state
      // change would never be re-enqueued (review P2-01).
      const state = await job.getState();
      if (state === 'failed') {
        await job.remove();
        await this.queue.add(
          PAYMENTS_QUEUE_JOB_NAME,
          { topupId: row.topupId },
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
 * Worker that drives a single leased provider-request to completion. All
 * retry/backoff/permanent-failure state lives in PostgreSQL (see
 * PaymentsService.processPaymentRequest), so a BullMQ redelivery cannot
 * duplicate financial effects. Unrecoverable job shapes fail fast.
 */
@Processor(PAYMENT_REQUESTS_QUEUE)
export class PaymentRequestProcessor extends WorkerHost {
  constructor(private readonly payments: PaymentsService) {
    super();
  }
  async process(job: Job): Promise<void> {
    const data: unknown = job.data;
    if (
      job.name !== PAYMENTS_QUEUE_JOB_NAME ||
      typeof data !== 'object' ||
      data === null ||
      !('topupId' in data) ||
      typeof data.topupId !== 'string' ||
      !uuidPattern.test(data.topupId)
    ) {
      throw new UnrecoverableError('Invalid payment request job');
    }
    await this.payments.processPaymentRequest(data.topupId);
  }
}
