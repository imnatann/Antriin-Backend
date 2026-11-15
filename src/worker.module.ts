import { Module } from '@nestjs/common';
import { CoreModule } from './config/core.module';
import { JobsModule } from './jobs/jobs.module';
import { OutboxModule } from './modules/notifications/outbox.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RefundsModule } from './modules/refunds/refunds.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import {
  PayoutRequestDispatcher,
  PayoutRequestProcessor,
} from './modules/payouts/payout-request.processor';
import {
  RefundRequestDispatcher,
  RefundRequestProcessor,
} from './modules/refunds/refund-request.processor';
import { OutboxDispatcher, OutboxProcessor } from './jobs/outbox.processor';
import {
  PaymentRequestDispatcher,
  PaymentRequestProcessor,
} from './modules/payments/payment-request.processor';
@Module({
  imports: [
    CoreModule,
    JobsModule,
    OutboxModule,
    PaymentsModule,
    RefundsModule,
    PayoutsModule,
  ],
  // MaintenanceProcessor (healthcheck + the scheduled maintenance sweepers and
  // risk detectors) is provided by JobsModule, which also owns the queue
  // registration and their database/audit dependencies.
  providers: [
    OutboxDispatcher,
    OutboxProcessor,
    PaymentRequestDispatcher,
    PaymentRequestProcessor,
    RefundRequestDispatcher,
    RefundRequestProcessor,
    PayoutRequestDispatcher,
    PayoutRequestProcessor,
  ],
})
export class WorkerModule {}
