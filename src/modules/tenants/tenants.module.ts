import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TenantOperatingHoursController } from './tenant-operating-hours.controller';
import { TenantOperatingHoursService } from './tenant-operating-hours.service';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

// Root directive (task-3): TenantsModule MUST export TenantOperatingHoursService
// so availability/orders consume resolveOperatingWindow (contract D8) instead of
// querying the operating-hours tables directly. This module must never import
// AvailabilityModule (circular dependency guard).
@Module({
  imports: [DatabaseModule, AccessModule, AuthModule, AuditModule],
  controllers: [TenantsController, TenantOperatingHoursController],
  providers: [
    TenantsService,
    TenantOperatingHoursService,
    TenantProvisioningService,
  ],
  exports: [
    TenantsService,
    TenantOperatingHoursService,
    TenantProvisioningService,
  ],
})
export class TenantsModule {}
