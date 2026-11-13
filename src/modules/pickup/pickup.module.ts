import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { PickupController } from './pickup.controller';
import { PickupRateLimitInterceptor } from './pickup-rate-limit.interceptor';
import { PickupService } from './pickup.service';
import { TenantPickupController } from './tenant-pickup.controller';

/**
 * Pickup slice (KAN-70): credential issuance/rotation, code verification and
 * the one-time handover. Writes only its own tables (pickup_credentials,
 * order_handovers, plus order_events rows for the two credential event types);
 * order state changes go exclusively through the OrdersService contract
 * (D16.6). Authorization uses AccessService (tenant.orders.handover) and
 * AuditService for the immutable trail; the failed-code-attempt rate limit
 * reuses the shared Redis with its own key namespace (R3-01: only failures
 * count, keyed per IP+tenant+actor).
 */
@Module({
  imports: [
    DatabaseModule,
    InfrastructureModule,
    AccessModule,
    AuditModule,
    AuthModule,
    OrdersModule,
    // The handover transaction calls SettlementsService.releaseAfterHandover
    // (D18 Q2a). forwardRef: settlements reads cases, cases depends on
    // settlements, and pickup is imported by neither.
    forwardRef(() => SettlementsModule),
  ],
  controllers: [PickupController, TenantPickupController],
  providers: [PickupService, PickupRateLimitInterceptor],
  exports: [PickupService],
})
export class PickupModule {}
