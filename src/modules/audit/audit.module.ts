import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AccessModule } from '../access/access.module';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
@Module({
  imports: [DatabaseModule, AuthModule, AccessModule],
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
