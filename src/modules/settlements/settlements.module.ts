import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CasesModule } from '../cases/cases.module';
import { OrdersModule } from '../orders/orders.module';
import { WalletModule } from '../wallet/wallet.module';
import { CampusSettlementsController } from './campus-settlements.controller';
import { CampusSettlementsService } from './campus-settlements.service';
import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';

/**
 * Settlements slice: order payable release (escrow -> tenant payable), the
 * tenant finance summary and the finance transaction feed.
 *
 * forwardRef with CasesModule because the case decision asks settlements for a
 * release while settlements asks cases whether an operational case is open -
 * one cycle, resolved by Nest instead of duplicating the open-case query here.
 *
 * The payout slice consumes SettlementsService.getAvailableBalance, and the
 * pickup/cases slices call the release entry points inside their own
 * transactions; the HTTP controllers of this slice only read.
 *
 * CampusSettlementsService is the campus-scoped read model (campus.payouts.read):
 * it lists settlements of one campus' tenants and never recomputes a balance.
 */
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AccessModule,
    AuditModule,
    WalletModule,
    OrdersModule,
    forwardRef(() => CasesModule),
  ],
  controllers: [SettlementsController, CampusSettlementsController],
  providers: [SettlementsService, CampusSettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
