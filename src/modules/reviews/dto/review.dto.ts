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
import { MODERATION_ACTIONS, REVIEW_STATUSES } from '../reviews.service';

/** Buyer creates or edits a review; rating 1-5 and a non-empty body. */
export class ReviewBodyDto {
  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}

/** Any authenticated user reports a review to campus moderation. */
export class ReportReviewDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

/** Tenant replies to its own review; a second reply replaces the first. */
export class ReplyReviewDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}

/** Campus moderation decision: keep the review visible or hide it. */
export class DecideReviewDto {
  @ApiProperty({ enum: MODERATION_ACTIONS as unknown as string[] })
  @IsString()
  @IsIn(MODERATION_ACTIONS as unknown as string[])
  action!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class ListReviewsQueryDto {
  @ApiPropertyOptional({ enum: REVIEW_STATUSES as unknown as string[] })
  @IsOptional()
  @IsString()
  @IsIn(REVIEW_STATUSES as unknown as string[])
  status?: string;

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
