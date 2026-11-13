import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Money travels as an integer minor-unit decimal string (IDR exponent 0 per
 * docs/PILOT-POLICY.md). The database check constraints additionally require
 * value < 1e38; this pattern enforces the same 38-digit bound.
 */
export const MINOR_PATTERN = /^(0|[1-9][0-9]{0,37})$/;
const MINOR_MESSAGE = 'must be a non-negative integer decimal string';

export class CreateMenuCategoryDto {
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'Makanan Berat' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 2147483647 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class UpdateMenuCategoryDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 2147483647 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;

  @ApiPropertyOptional({ enum: ['active', 'archived'] })
  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 300,
    description:
      'Required when this update archives or restores the category; recorded in the immutable audit log with the session actor.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason?: string;
}

export class CreateMenuItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ minLength: 1, maxLength: 160, example: 'Nasi Ayam Sambal' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    description: `Integer minor units (IDR) as a decimal string. ${MINOR_MESSAGE}.`,
    example: '15000',
    pattern: '^(0|[1-9][0-9]{0,37})$',
  })
  @Matches(MINOR_PATTERN, { message: `priceMinor ${MINOR_MESSAGE}` })
  priceMinor!: string;

  @ApiPropertyOptional({ enum: ['active', 'sold_out'] })
  @IsOptional()
  @IsIn(['active', 'sold_out'])
  status?: 'active' | 'sold_out';

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Opaque image reference (media pipeline owned elsewhere). Send an empty string to clear it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageRef?: string;
}

export class UpdateMenuItemDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 160 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    description: `Integer minor units (IDR) as a decimal string. ${MINOR_MESSAGE}.`,
    example: '16000',
    pattern: '^(0|[1-9][0-9]{0,37})$',
  })
  @IsOptional()
  @Matches(MINOR_PATTERN, { message: `priceMinor ${MINOR_MESSAGE}` })
  priceMinor?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: ['active', 'sold_out', 'archived'] })
  @IsOptional()
  @IsIn(['active', 'sold_out', 'archived'])
  status?: 'active' | 'sold_out' | 'archived';

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Opaque image reference (media pipeline owned elsewhere). Send an empty string to clear it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageRef?: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 300,
    description:
      'Required when this update changes priceMinor or status; recorded in the immutable audit log with the session actor.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason?: string;

  @ApiProperty({ minimum: 1, description: 'Optimistic concurrency guard' })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class CreateOptionGroupDto {
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'Tingkat Sambal' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  minSelections?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxSelections?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 2147483647 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class UpdateOptionGroupDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  minSelections?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxSelections?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 2147483647 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;

  @ApiPropertyOptional({ enum: ['active', 'archived'] })
  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 300,
    description:
      'Required when this update archives or restores the option group; recorded in the immutable audit log with the session actor.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason?: string;

  @ApiProperty({ minimum: 1, description: 'Optimistic concurrency guard' })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class CreateOptionChoiceDto {
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'Sambal Ekstra' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description: `Integer minor units (IDR) as a decimal string. ${MINOR_MESSAGE}.`,
    example: '2000',
    pattern: '^(0|[1-9][0-9]{0,37})$',
  })
  @IsOptional()
  @Matches(MINOR_PATTERN, { message: `priceDeltaMinor ${MINOR_MESSAGE}` })
  priceDeltaMinor?: string;
}

export class UpdateOptionChoiceDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: `Integer minor units (IDR) as a decimal string. ${MINOR_MESSAGE}.`,
    example: '2500',
    pattern: '^(0|[1-9][0-9]{0,37})$',
  })
  @IsOptional()
  @Matches(MINOR_PATTERN, { message: `priceDeltaMinor ${MINOR_MESSAGE}` })
  priceDeltaMinor?: string;

  @ApiPropertyOptional({ enum: ['active', 'archived'] })
  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 300,
    description:
      'Required when this update changes priceDeltaMinor or status; recorded in the immutable audit log with the session actor.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason?: string;

  @ApiProperty({ minimum: 1, description: 'Optimistic concurrency guard' })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class ArchiveReasonQueryDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 300,
    description:
      'Why the resource is archived. Recorded in the immutable audit log with the session actor.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
}

export class MenuQueryDto {
  @ApiPropertyOptional({
    enum: ['active', 'sold_out'],
    description:
      'Narrow the listing to one buyer-visible status. Archived items are never exposed.',
  })
  @IsOptional()
  @IsIn(['active', 'sold_out'])
  status?: 'active' | 'sold_out';

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Case-insensitive substring match on the item name',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
