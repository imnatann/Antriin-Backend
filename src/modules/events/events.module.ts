import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../../database/database.module';
import {
  DEFAULT_EVENTS_STREAM_OPTIONS,
  EVENTS_STREAM_OPTIONS,
} from './events.constants';
import { EventsAuthGuard } from './events-auth.guard';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

/**
 * Server-Sent Events for in-app notifications.
 *
 * AuthModule supplies AuthService for EventsAuthGuard (the guard needs it at
 * boot, which is why it is imported rather than reached for per request).
 * DatabaseModule supplies the pool the stream polls; no AuditService, because
 * opening a read-only stream is not a consequential action.
 */
@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [EventsController],
  providers: [
    EventsService,
    EventsAuthGuard,
    {
      provide: EVENTS_STREAM_OPTIONS,
      useValue: DEFAULT_EVENTS_STREAM_OPTIONS,
    },
  ],
  exports: [EventsService],
})
export class EventsModule {}
