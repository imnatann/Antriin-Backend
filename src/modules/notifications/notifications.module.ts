import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../../database/database.module';
import { OutboxModule } from './outbox.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
@Module({
  imports: [AuthModule, DatabaseModule, OutboxModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService, OutboxModule],
})
export class NotificationsModule {}
