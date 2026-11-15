import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Query parameters for GET /events/stream.
 *
 * Only these two are accepted; the global ValidationPipe rejects anything else,
 * so a client cannot smuggle scope or recipient fields into the connection.
 */
export class EventsStreamQueryDto {
  @ApiPropertyOptional({
    description:
      'Bearer token, for clients that cannot set request headers (EventSource). The same value AuthGuard expects after "Bearer ". Ignored when an Authorization header is present.',
    minLength: 32,
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  access_token?: string;

  @ApiPropertyOptional({
    description:
      'Resume after this notification id instead of starting at the newest one. Takes precedence over the Last-Event-ID header.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  last_event_id?: string;
}
