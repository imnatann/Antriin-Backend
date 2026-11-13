import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { ReportingController } from './reporting.controller';
import { ReportingService } from './reporting.service';

// Read-only: no tables of its own, no outbox, no audit. Every figure is
// derived from rows owned by the other slices.
@Module({
  imports: [DatabaseModule, AuthModule, AccessModule],
  controllers: [ReportingController],
  providers: [ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}
