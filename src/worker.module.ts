import { Module } from '@nestjs/common';
import { CoreModule } from './config/core.module';
import { JobsModule } from './jobs/jobs.module';
import { MaintenanceProcessor } from './jobs/maintenance.processor';
@Module({
  imports: [CoreModule, JobsModule],
  providers: [MaintenanceProcessor],
})
export class WorkerModule {}
