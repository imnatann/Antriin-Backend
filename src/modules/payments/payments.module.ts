import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../notifications/outbox.module';
import { WalletModule } from '../wallet/wallet.module';
import {
  PAYMENTS_PROVIDER_ADAPTER,
  SandboxPaymentsAdapter,
} from './payments.adapter';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsWebhookController } from './payments-webhook.controller';

// Business rules live in PaymentsService. The BullMQ dispatcher/processor
// (PaymentRequestDispatcher, PaymentRequestProcessor) are wired by root in
// src/jobs + src/worker.module.ts; they are intentionally NOT providers here
// so the HTTP app does not require the queue to boot.
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    WalletModule,
    AuditModule,
    OutboxModule,
  ],
  controllers: [PaymentsController, PaymentsWebhookController],
  providers: [
    PaymentsService,
    { provide: PAYMENTS_PROVIDER_ADAPTER, useClass: SandboxPaymentsAdapter },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
