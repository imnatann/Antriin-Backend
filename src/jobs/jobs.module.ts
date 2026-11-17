import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../modules/audit/audit.module';
import { AuthModule } from '../modules/auth/auth.module';
import { PAYMENT_REQUESTS_QUEUE } from '../modules/payments/payment-request.processor';
import { REFUND_REQUESTS_QUEUE } from '../modules/refunds/refund-request.processor';
import { PAYOUT_REQUESTS_QUEUE } from '../modules/payouts/payout-request.processor';
import { ReportingModule } from '../modules/reporting/reporting.module';
import { RiskDetectorsModule } from '../modules/risk/risk-detectors.module';
import { MaintenanceProcessor } from './maintenance.processor';
import { MaintenanceScheduler } from './maintenance.scheduler';
import { SweepMediaTombstonesJob } from './media-tombstone-sweep.job';
import { PurgeOrderIdempotencyJob } from './order-idempotency-purge.job';
import { DeliverOtpDeliveriesJob } from './otp-delivery-dispatch.job';
import { DOMAIN_EVENTS_QUEUE, MAINTENANCE_QUEUE } from './queue-names';
import { RiskDetectorJob } from './risk-detector.job';
import { ReportExportJob } from './report-export.job';
import { ExpireTopupIntentsJob } from './topup-expiry.job';

// Queue names live in queue-names.ts so processors can name their queue without
// importing this module (which imports them). Re-exported here because the
// worker wiring historically imported them from this file.
export { DOMAIN_EVENTS_QUEUE, MAINTENANCE_QUEUE } from './queue-names';

/**
 * Queue configuration plus the worker-only scheduled maintenance work.
 *
 * JobsModule is imported by WorkerModule, never by the HTTP application, so the
 * API does not need Redis to boot. The maintenance jobs (top-up expiry,
 * idempotency retention, media tombstones, the risk detectors and due report
 * exports) are provided here and their repeatable schedules are registered by
 * MaintenanceScheduler when the worker starts.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 100,
          removeOnFail: 1000,
        },
      }),
    }),
    BullModule.registerQueue({ name: MAINTENANCE_QUEUE }),
    BullModule.registerQueue({ name: DOMAIN_EVENTS_QUEUE }),
    BullModule.registerQueue({ name: PAYMENT_REQUESTS_QUEUE }),
    BullModule.registerQueue({ name: REFUND_REQUESTS_QUEUE }),
    BullModule.registerQueue({ name: PAYOUT_REQUESTS_QUEUE }),
    DatabaseModule,
    AuditModule,
    RiskDetectorsModule,
    // ReportExportJob calls ReportingService.runDueExports(); the module
    // exports that service, so the worker resolves it without the HTTP layer.
    ReportingModule,
    // DeliverOtpDeliveriesJob retries deferred OTP deliveries through
    // AuthService.drainOtpDeliveries(), which the module exports.
    AuthModule,
  ],
  providers: [
    ExpireTopupIntentsJob,
    PurgeOrderIdempotencyJob,
    SweepMediaTombstonesJob,
    RiskDetectorJob,
    ReportExportJob,
    DeliverOtpDeliveriesJob,
    MaintenanceProcessor,
    MaintenanceScheduler,
  ],
  exports: [BullModule],
})
export class JobsModule {}
