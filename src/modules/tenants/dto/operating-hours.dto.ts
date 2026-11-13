import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Local wall-clock time, `HH:MM` or `HH:MM:SS`. Windows crossing midnight are
 * rejected in the pilot (opens_at < closes_at CHECK constraint), so late-night
 * canteens spanning midnight are an explicit unsupported case.
 */
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class WeeklyOperatingDayDto {
  @ApiProperty({
    minimum: 0,
    maximum: 6,
    description:
      'Weekday in the tenant/campus timezone, 0=Sunday .. 6=Saturday (JS Date.getDay convention, root decision D12)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @ApiProperty({
    description: 'false means closed all day; times must be omitted',
  })
  @IsBoolean()
  isOpen!: boolean;

  @ApiProperty({
    required: false,
    pattern: 'HH:MM(:SS)?',
    description: 'Required when isOpen=true; must be earlier than closesAt',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_TIME_PATTERN)
  opensAt?: string;

  @ApiProperty({
    required: false,
    pattern: 'HH:MM(:SS)?',
    description: 'Required when isOpen=true; must be later than opensAt',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_TIME_PATTERN)
  closesAt?: string;
}

export class ReplaceWeeklyHoursDto {
  @ApiProperty({
    type: [WeeklyOperatingDayDto],
    minItems: 7,
    maxItems: 7,
    description: 'The complete weekly schedule: each weekday 0..6 exactly once',
  })
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => WeeklyOperatingDayDto)
  days!: WeeklyOperatingDayDto[];

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description: 'Reason recorded in the immutable audit trail',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class OperatingHourOverrideDto {
  @ApiProperty({
    description:
      'true closes the tenant for the whole local date (times must be omitted); false replaces the weekly window with opensAt/closesAt',
  })
  @IsBoolean()
  isClosed!: boolean;

  @ApiProperty({ required: false, pattern: 'HH:MM(:SS)?' })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_TIME_PATTERN)
  opensAt?: string;

  @ApiProperty({ required: false, pattern: 'HH:MM(:SS)?' })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_TIME_PATTERN)
  closesAt?: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 300,
    description:
      'Public note stored on the override (e.g. holiday name) and reused as the audit reason',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
}

export class RemoveOperatingHourOverrideDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description: 'Reason recorded in the immutable audit trail',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
