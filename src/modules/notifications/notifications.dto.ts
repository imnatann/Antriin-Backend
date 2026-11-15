import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query filters for GET /v1/me/notifications. `unread=true` narrows the page to
 * rows without readAt; the total unread count is always reported in
 * meta.unreadCount so a badge does not depend on the current filter.
 */
export class NotificationsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cursor?: string;
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'When true the page contains only unread notifications (readAt === null).',
  })
  @IsOptional()
  @Transform(({ value }) => {
    // Query strings arrive as 'true'/'false'; anything else is left for
    // @IsBoolean to reject instead of being coerced into a truthy value.
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  unread?: boolean;
}
