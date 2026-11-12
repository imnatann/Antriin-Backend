import { Module } from '@nestjs/common';
import { CoreModule } from './config/core.module';
import { JobsModule } from './jobs/jobs.module';
import { MaintenanceProcessor } from './jobs/maintenance.processor';
import { OutboxModule } from './modules/notifications/outbox.module';
import { OutboxDispatcher, OutboxProcessor } from './jobs/outbox.processor';
@Module({
  imports: [CoreModule, JobsModule, OutboxModule],
  providers: [MaintenanceProcessor, OutboxDispatcher, OutboxProcessor],
})
export class WorkerModule {}
