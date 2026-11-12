import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OutboxService } from './outbox.service';
@Module({
  imports: [DatabaseModule],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
