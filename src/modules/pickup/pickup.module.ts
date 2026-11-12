import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { PickupController } from './pickup.controller';
import { PickupRateLimitGuard } from './pickup-rate-limit.guard';
import { PickupService } from './pickup.service';
import { TenantPickupController } from './tenant-pickup.controller';

/**
 * Pickup slice (KAN-70): credential issuance/rotation, code verification and
 * the one-time handover. Writes only its own tables (pickup_credentials,
 * order_handovers, plus order_events rows for the two credential event types);
 * order state changes go exclusively through the OrdersService contract
 * (D16.6). Authorization uses AccessService (tenant.orders.handover) and
 * AuditService for the immutable trail; the code-attempt rate limit reuses the
 * shared Redis with its own key namespace.
 */
@Module({
  imports: [
    DatabaseModule,
    InfrastructureModule,
    AccessModule,
    AuditModule,
    AuthModule,
    OrdersModule,
  ],
  controllers: [PickupController, TenantPickupController],
  providers: [PickupService, PickupRateLimitGuard],
  exports: [PickupService],
})
export class PickupModule {}
