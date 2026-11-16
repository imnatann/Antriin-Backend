import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../notifications/outbox.module';
import { WalletModule } from '../wallet/wallet.module';
import {
  PAYMENTS_PROVIDER_ADAPTER,
  SandboxPaymentsAdapter,
} from './payments.adapter';
import { XenditPaymentsAdapter } from './xendit.adapter';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsWebhookController } from './payments-webhook.controller';
import { XenditWebhookController } from './xendit-webhook.controller';

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
  controllers: [
    PaymentsController,
    PaymentsWebhookController,
    XenditWebhookController,
  ],
  providers: [
    PaymentsService,
    SandboxPaymentsAdapter,
    XenditPaymentsAdapter,
    // The adapter is chosen once, at boot, from PAYMENTS_PROVIDER_MODE. Doing
    // it here (not per request) means a misconfigured mode fails loudly on
    // startup instead of halfway through a buyer's top-up.
    {
      provide: PAYMENTS_PROVIDER_ADAPTER,
      inject: [ConfigService, SandboxPaymentsAdapter, XenditPaymentsAdapter],
      useFactory: (
        config: ConfigService,
        sandbox: SandboxPaymentsAdapter,
        xendit: XenditPaymentsAdapter,
      ) => {
        const mode = config.get<string>('PAYMENTS_PROVIDER_MODE');
        if (mode === 'xendit') return xendit;
        // 'disabled' also resolves to the sandbox stub: it refuses every call
        // itself, and PaymentsService rejects the request before reaching it.
        return sandbox;
      },
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
