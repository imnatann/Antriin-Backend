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

/**
 * Polls due payment_request_outbox rows and enqueues one job per row. The
 * jobId embeds the stored attempt count so a deferred row is re-enqueued on a
 * fresh id after backoff while concurrent duplicates of the same attempt are
 * deduplicated by BullMQ. No PostgreSQL lock is held while talking to Redis.
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
      await this.queue.add(
        PAYMENTS_QUEUE_JOB_NAME,
        { topupId: row.topupId },
        { jobId: 'payment-request-' + row.topupId + '-' + row.attempts },
      );
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
