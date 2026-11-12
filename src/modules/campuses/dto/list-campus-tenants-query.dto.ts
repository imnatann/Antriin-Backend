import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const CAMPUS_TENANT_STATUS_FILTERS = [
  'open',
  'closed',
  'paused',
  'any',
] as const;

export class ListCampusTenantsQueryDto {
  @ApiProperty({
    required: false,
    enum: CAMPUS_TENANT_STATUS_FILTERS,
    default: 'open',
    description:
      'Tenant status filter; archived tenants are never exposed publicly',
  })
  @IsOptional()
  @IsIn(CAMPUS_TENANT_STATUS_FILTERS)
  status?: (typeof CAMPUS_TENANT_STATUS_FILTERS)[number];

  @ApiProperty({ required: false, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
