import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
import {
  RISK_CATEGORIES,
  RISK_DECISIONS,
  RISK_REVIEW_STATES,
} from '../risk.service';

/**
 * Queue filter. 'pending' (the default) means "no human decision yet"; a
 * signal only leaves the queue by gaining a decision row, never by a status
 * update, so the filter is derived from the append-only decision table.
 */
export class ListRiskReviewsQueryDto {
  @ApiPropertyOptional({
    enum: RISK_REVIEW_STATES as unknown as string[],
    default: 'pending',
  })
  @IsOptional()
  @IsString()
  @IsIn(RISK_REVIEW_STATES as unknown as string[])
  state?: string;

  @ApiPropertyOptional({ enum: RISK_CATEGORIES as unknown as string[] })
  @IsOptional()
  @IsString()
  @IsIn(RISK_CATEGORIES as unknown as string[])
  category?: string;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor.' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,512}$/)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Human review outcome; the reason is required and audited. */
export class DecideRiskSignalDto {
  @ApiProperty({ enum: RISK_DECISIONS as unknown as string[] })
  @IsString()
  @IsIn(RISK_DECISIONS as unknown as string[])
  decision!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
