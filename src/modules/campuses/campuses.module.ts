import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { CampusProvisioningService } from './campus-provisioning.service';
import { CampusesController } from './campuses.controller';
import { CampusesService } from './campuses.service';

@Module({
  imports: [DatabaseModule, AccessModule, AuditModule],
  controllers: [CampusesController],
  providers: [CampusesService, CampusProvisioningService],
  exports: [CampusesService, CampusProvisioningService],
})
export class CampusesModule {}
