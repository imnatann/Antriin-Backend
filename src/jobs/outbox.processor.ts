import {
  BadRequestException,
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import {
  OutboxService,
  uuidPattern,
} from '../modules/notifications/outbox.service';
import { DOMAIN_EVENTS_QUEUE } from './jobs.module';

@Injectable()
export class OutboxDispatcher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OutboxDispatcher.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly outbox: OutboxService,
    @InjectQueue(DOMAIN_EVENTS_QUEUE) private readonly queue: Queue,
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
          'Domain event publish failed; pending events will retry',
        );
      })
      .finally(() => {
        this.running = undefined;
      });
  }
  async flush(): Promise<void> {
    for (const event of await this.outbox.pending()) {
      // No PostgreSQL transaction/row lock is held while publishing to Redis.
      await this.queue.add(
        'deliver',
        { eventId: event.id },
        { jobId: `outbox-${event.id}` },
      );
      await this.outbox.markPublished(event.id);
    }
  }
  async beforeApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}

@Processor(DOMAIN_EVENTS_QUEUE)
export class OutboxProcessor extends WorkerHost {
  constructor(private readonly outbox: OutboxService) {
    super();
  }
  async process(job: Job): Promise<void> {
    const data: unknown = job.data;
    if (
      job.name !== 'deliver' ||
      typeof data !== 'object' ||
      data === null ||
      !('eventId' in data) ||
      typeof data.eventId !== 'string' ||
      !uuidPattern.test(data.eventId)
    ) {
      throw new UnrecoverableError('Invalid domain delivery job');
    }
    try {
      await this.outbox.deliver(data.eventId);
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
      ) {
        await this.outbox.markFailed(data.eventId);
      }
      if (error instanceof BadRequestException)
        throw new UnrecoverableError('Domain event permanently rejected');
      throw error;
    }
  }
}
