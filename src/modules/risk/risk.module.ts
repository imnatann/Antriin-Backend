import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';

// Risk/AI review queue. Signals and decisions are append-only, so this module
// owns no status column and no outbox event: it reads evidence and records
// human decisions with an audit row in the same transaction.
@Module({
  imports: [DatabaseModule, AuthModule, AccessModule, AuditModule],
  controllers: [RiskController],
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
