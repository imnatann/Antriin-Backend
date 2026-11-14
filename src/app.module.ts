import { Module } from '@nestjs/common';
import { CoreModule } from './config/core.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CampusesModule } from './modules/campuses/campuses.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { AccessModule } from './modules/access/access.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PickupModule } from './modules/pickup/pickup.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RefundsModule } from './modules/refunds/refunds.module';
import { SettlementsModule } from './modules/settlements/settlements.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import { CasesModule } from './modules/cases/cases.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { RiskModule } from './modules/risk/risk.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AuditModule } from './modules/audit/audit.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { ApiGuideModule } from './modules/api-guide/api-guide.module';
@Module({
  imports: [
    CoreModule,
    HealthModule,
    AuthModule,
    UsersModule,
    CampusesModule,
    TenantsModule,
    AccessModule,
    CatalogModule,
    AvailabilityModule,
    OrdersModule,
    PickupModule,
    WalletModule,
    PaymentsModule,
    RefundsModule,
    SettlementsModule,
    PayoutsModule,
    CasesModule,
    ReviewsModule,
    RiskModule,
    DiscoveryModule,
    NotificationsModule,
    AuditModule,
    ReportingModule,
    ApiGuideModule,
  ],
})
export class AppModule {}
