import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
// D8 (root decision): TenantOperatingHoursService.resolveOperatingWindow is the
// single source of operating-hours truth for slot validation. TenantsModule
// must never import AvailabilityModule (circular dependency guard).
import { TenantsModule } from '../tenants/tenants.module';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
@Module({
  imports: [
    DatabaseModule,
    AccessModule,
    AuthModule,
    AuditModule,
    TenantsModule,
  ],
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
