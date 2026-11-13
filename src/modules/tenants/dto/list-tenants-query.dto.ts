import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const TENANT_STATUS_FILTERS = [
  'open',
  'closed',
  'paused',
  'any',
] as const;

export class ListTenantsQueryDto {
  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  campusId?: string;

  @ApiProperty({
    required: false,
    enum: TENANT_STATUS_FILTERS,
    default: 'any',
    description:
      'Filter non-archived tenants; archived tenants are never exposed publicly',
  })
  @IsOptional()
  @IsIn(TENANT_STATUS_FILTERS)
  status?: (typeof TENANT_STATUS_FILTERS)[number];

  @ApiProperty({
    required: false,
    maxLength: 200,
    description: 'Case-insensitive substring match on the tenant name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
