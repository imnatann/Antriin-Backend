import { Module } from '@nestjs/common';
import { CoreModule } from './config/core.module';
import { JobsModule } from './jobs/jobs.module';
import { MaintenanceProcessor } from './jobs/maintenance.processor';
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
  providers: [
    MaintenanceProcessor,
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
