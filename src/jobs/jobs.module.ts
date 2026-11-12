import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { PAYMENT_REQUESTS_QUEUE } from '../modules/payments/payment-request.processor';
import { REFUND_REQUESTS_QUEUE } from '../modules/refunds/refund-request.processor';
export const MAINTENANCE_QUEUE = 'maintenance';
export const DOMAIN_EVENTS_QUEUE = 'domain-events';
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
  ],
  exports: [BullModule],
})
export class JobsModule {}
