import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Money travels as an integer minor-unit decimal string (IDR exponent 0 per
 * docs/PILOT-POLICY.md); the same 38-digit bound as the catalog DTOs.
 */
const MINOR_PATTERN = /^(0|[1-9][0-9]{0,37})$/;

export class SearchQueryDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 100,
    description:
      'Search term matched case-insensitively against tenant name/location and menu item name/description. Required at runtime: a missing or blank term is rejected with SEARCH_QUERY_REQUIRED.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restrict the search to one active campus',
  })
  @IsOptional()
  @IsUUID()
  campusId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class RecommendationQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restrict recommendations to one active campus',
  })
  @IsOptional()
  @IsUUID()
  campusId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restrict recommendations to one tenant',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({
    pattern: '^(0|[1-9][0-9]{0,37})$',
    description:
      'Maximum item price in minor units (integer decimal string); items above it are excluded',
  })
  @IsOptional()
  @Matches(MINOR_PATTERN, {
    message: 'budgetMaxMinor must be a non-negative integer decimal string',
  })
  budgetMaxMinor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
