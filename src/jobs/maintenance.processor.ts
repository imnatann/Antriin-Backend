import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { MAINTENANCE_QUEUE } from './jobs.module';
// Infrastructure probe only. No financial or order processing is implemented yet.
@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  async process(job: Job): Promise<{ status: string }> {
    if (job.name !== 'healthcheck')
      throw new UnrecoverableError('Unsupported maintenance job');
    return { status: 'ok' };
  }
}
