import { Module } from '@nestjs/common';
import { CoreModule } from './config/core.module';
import { JobsModule } from './jobs/jobs.module';
import { MaintenanceProcessor } from './jobs/maintenance.processor';
import { OutboxModule } from './modules/notifications/outbox.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { OutboxDispatcher, OutboxProcessor } from './jobs/outbox.processor';
import {
  PaymentRequestDispatcher,
  PaymentRequestProcessor,
} from './modules/payments/payment-request.processor';
@Module({
  imports: [CoreModule, JobsModule, OutboxModule, PaymentsModule],
  providers: [
    MaintenanceProcessor,
    OutboxDispatcher,
    OutboxProcessor,
    PaymentRequestDispatcher,
    PaymentRequestProcessor,
  ],
})
export class WorkerModule {}
