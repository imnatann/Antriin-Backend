import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';

/**
 * Public discovery (search + recommendations).
 *
 * DatabaseModule is the only dependency: both endpoints are unauthenticated
 * read-only projections, so there is no actor to resolve and no tenant/campus
 * permission to check - AccessService is intentionally absent. Safety comes
 * from the row filters instead (active campus, non-archived tenant, active or
 * sold_out item of an active category), and nothing here mutates data, so no
 * AuditService is needed either. Any future authenticated or mutating endpoint
 * must add AccessModule/AuditModule and the corresponding checks.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
