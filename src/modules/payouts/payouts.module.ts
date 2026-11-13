import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../notifications/outbox.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { WalletModule } from '../wallet/wallet.module';
import { BankAccountsService } from './bank-accounts.service';
import { CampusPayoutsController } from './campus-payouts.controller';
import {
  PAYOUTS_PROVIDER_ADAPTER,
  SandboxPayoutAdapter,
} from './payout.adapter';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';

/**
 * Payouts slice: bank accounts (encrypted + masked), payout requests with an
 * atomic hold, and processor-driven sandbox settlement.
 *
 * The BullMQ dispatcher/processor (PayoutRequestDispatcher,
 * PayoutRequestProcessor in payout-request.processor.ts, queue
 * 'payout-requests') are wired by ROOT in src/jobs + src/worker.module.ts and
 * are intentionally not providers here, so the HTTP app boots without a queue
 * (same pattern as refunds).
 *
 * All money movement goes through WalletService inside the caller's
 * transaction; the provider adapter is called by the processor only, outside
 * any transaction or row lock.
 *
 * CampusPayoutsController adds the read-only campus monitoring route
 * (campus.payouts.read) from REQUIREMENTS 3.8.7; it never mutates a payout.
 */
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AccessModule,
    AuditModule,
    OutboxModule,
    WalletModule,
    SettlementsModule,
  ],
  controllers: [PayoutsController, CampusPayoutsController],
  providers: [
    PayoutsService,
    BankAccountsService,
    { provide: PAYOUTS_PROVIDER_ADAPTER, useClass: SandboxPayoutAdapter },
  ],
  exports: [PayoutsService, BankAccountsService],
})
export class PayoutsModule {}
