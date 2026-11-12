import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreatePickupSlotDto {
  @ApiProperty({
    format: 'date-time',
    description: 'Slot start (UTC instant); must be in the future',
  })
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/,
    { message: 'startsAt must be an ISO-8601 timestamp' },
  )
  startsAt!: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Slot end (UTC instant); must be after startsAt, same tenant local day',
  })
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/,
    { message: 'endsAt must be an ISO-8601 timestamp' },
  )
  endsAt!: string;

  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  capacity!: number;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 300,
    description:
      'Optional actor reason recorded in the audit trail (slot.created)',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason?: string;
}

export class UpdatePickupSlotDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  capacity?: number;

  @ApiPropertyOptional({
    enum: ['open', 'closed'],
    description:
      'Close or reopen the slot; status only changes through this authorized action',
  })
  @IsOptional()
  @IsIn(['open', 'closed'])
  status?: 'open' | 'closed';

  @ApiProperty({
    minimum: 1,
    description:
      'Optimistic concurrency token read from a previous slot response (D7: version is the pickup_slots concurrency field)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 300,
    description:
      'REQUIRED (1-300 chars) when closing the slot or reducing capacity; recorded in the audit trail with the session actor',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason?: string;
}

export class AvailabilityQueryDto {
  @ApiPropertyOptional({
    format: 'date',
    example: '2026-11-13',
    description:
      "Single tenant-local date shorthand; mutually exclusive with 'from'/'to'",
  })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: 'date must use YYYY-MM-DD format' })
  date?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-11-13',
    description: "Range start (tenant-local date); requires 'to'",
  })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: 'from must use YYYY-MM-DD format' })
  from?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-11-20',
    description:
      "Range end inclusive (tenant-local date); requires 'from'; max 31 days",
  })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: 'to must use YYYY-MM-DD format' })
  to?: string;
}

export class SlotRangeQueryDto {
  @ApiProperty({
    format: 'date',
    example: '2026-11-13',
    description: 'Range start (tenant-local date)',
  })
  @Matches(LOCAL_DATE, { message: 'from must use YYYY-MM-DD format' })
  from!: string;

  @ApiProperty({
    format: 'date',
    example: '2026-11-20',
    description: 'Range end inclusive (tenant-local date); max 92 days',
  })
  @Matches(LOCAL_DATE, { message: 'to must use YYYY-MM-DD format' })
  to!: string;
}
