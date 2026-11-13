import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../notifications/outbox.module';
import { OrdersModule } from '../orders/orders.module';
import { WalletModule } from '../wallet/wallet.module';
import {
  REFUNDS_PROVIDER_ADAPTER,
  SandboxRefundAdapter,
} from './refund.adapter';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

// Business rules live in RefundsService. The BullMQ dispatcher/processor
// (RefundRequestDispatcher, RefundRequestProcessor in
// refund-request.processor.ts, queue 'refund-requests') are wired by root in
// src/jobs + src/worker.module.ts; they are intentionally NOT providers here
// so the HTTP app boots without the queue.
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AccessModule,
    WalletModule,
    AuditModule,
    OutboxModule,
    OrdersModule,
  ],
  controllers: [RefundsController],
  providers: [
    RefundsService,
    { provide: REFUNDS_PROVIDER_ADAPTER, useClass: SandboxRefundAdapter },
  ],
  exports: [RefundsService],
})
export class RefundsModule {}
