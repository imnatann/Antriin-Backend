import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { AvailabilityModule } from '../availability/availability.module';
import { CatalogModule } from '../catalog/catalog.module';
import { OutboxModule } from '../notifications/outbox.module';
import { WalletModule } from '../wallet/wallet.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { TenantOrdersController } from './tenant-orders.controller';

/**
 * Orders slice: atomic checkout (quote -> reserve -> wallet debit -> order),
 * tenant fulfilment state machine, schedule proposals and read APIs.
 *
 * Dependencies are read-only contracts owned by other slices (D4):
 * CatalogService.quote, AvailabilityService reservations, WalletService ledger,
 * AuditService and OutboxService. This module never writes their tables
 * directly; it only writes its own (orders, order_*, schedule_proposals).
 */
@Module({
  imports: [
    DatabaseModule,
    AccessModule,
    AuditModule,
    AuthModule,
    AvailabilityModule,
    CatalogModule,
    WalletModule,
    OutboxModule,
  ],
  controllers: [OrdersController, TenantOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
