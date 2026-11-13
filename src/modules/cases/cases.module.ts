import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../notifications/outbox.module';
import { RefundsModule } from '../refunds/refunds.module';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';

// Cases are the human decision record; the approved_cancel decision
// delegates the cancellation + pending refund to RefundsService inside the
// same transaction (RefundsModule is imported for that, never the reverse).
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AccessModule,
    AuditModule,
    OutboxModule,
    RefundsModule,
  ],
  controllers: [CasesController],
  providers: [CasesService],
  exports: [CasesService],
})
export class CasesModule {}
