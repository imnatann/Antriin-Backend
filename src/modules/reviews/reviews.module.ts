import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../notifications/outbox.module';
import {
  PublicReviewsController,
  ReviewsController,
} from './reviews.controller';
import { ReviewsService } from './reviews.service';

// Reviews read orders/tenants directly (no orders module dependency): the
// service only needs the order's buyer, tenant, campus and status.
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AccessModule,
    AuditModule,
    OutboxModule,
  ],
  controllers: [ReviewsController, PublicReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
