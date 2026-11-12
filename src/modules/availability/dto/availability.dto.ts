import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreatePickupSlotDto {
  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  startsAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  endsAt!: string;

  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  capacity!: number;
}

export class UpdatePickupSlotDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  capacity?: number;

  @ApiPropertyOptional({ enum: ['open', 'closed'] })
  @IsOptional()
  @IsIn(['open', 'closed'])
  status?: 'open' | 'closed';

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class WeeklyHoursDayDto {
  @ApiProperty({
    minimum: 0,
    maximum: 6,
    description: 'Sunday=0 through Saturday=6',
  })
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @ApiProperty()
  @IsBoolean()
  isOpen!: boolean;

  @ApiPropertyOptional({ example: '09:00:00' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  opensAt?: string;

  @ApiPropertyOptional({ example: '17:00:00' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  closesAt?: string;
}

export class ReplaceWeeklyHoursDto {
  @ApiProperty({ type: [WeeklyHoursDayDto], minItems: 7, maxItems: 7 })
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ArrayUnique((day: WeeklyHoursDayDto) => day.weekday)
  @ValidateNested({ each: true })
  @Type(() => WeeklyHoursDayDto)
  days!: WeeklyHoursDayDto[];
}

export class OperatingHourOverrideDto {
  @ApiProperty()
  @IsBoolean()
  isClosed!: boolean;

  @ApiPropertyOptional({ example: '09:00:00' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  opensAt?: string;

  @ApiPropertyOptional({ example: '17:00:00' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  closesAt?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Matches(/^.{0,300}$/)
  reason?: string;
}

export class UpdateTenantAvailabilityStatusDto {
  @ApiProperty({ enum: ['open', 'closed', 'paused'] })
  @IsIn(['open', 'closed', 'paused'])
  status!: 'open' | 'closed' | 'paused';

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  expectedUpdatedAt!: string;
}

export class AvailabilityQueryDto {
  @ApiProperty({ format: 'date', example: '2026-11-12' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;
}
