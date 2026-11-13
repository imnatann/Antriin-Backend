import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
import { CASE_CATEGORIES, CASE_STATUSES } from '../cases.service';

export const CASE_DECISION_TARGETS = [
  'under_review',
  'awaiting_information',
  'approved_cancel',
  'declined',
  'resolved',
] as const;

class CaseBodyBase {
  @ApiProperty({ enum: CASE_CATEGORIES as unknown as string[] })
  @IsString()
  @IsIn(CASE_CATEGORIES as unknown as string[])
  category!: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject!: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  details?: string;
}

/** Buyer opens a case about their own order (path supplies the order). */
export class OpenBuyerCaseDto extends CaseBodyBase {}

/** Tenant staff opens a case; the order (when given) must be the tenant's. */
export class OpenTenantCaseDto extends CaseBodyBase {
  @ApiPropertyOptional({ description: 'Related order of this tenant.' })
  @IsOptional()
  @IsUUID()
  orderId?: string;
}

/** Campus staff opens a case; tenant must belong to the path campus. */
export class OpenCampusCaseDto extends CaseBodyBase {
  @ApiProperty({ description: 'Tenant the case concerns.' })
  @IsUUID()
  tenantId!: string;

  @ApiPropertyOptional({ description: 'Related order of that tenant.' })
  @IsOptional()
  @IsUUID()
  orderId?: string;
}

/**
 * Campus-manager status transition. The reason is required for every
 * transition and is stored on the decision (audit trail). approved_cancel
 * additionally requires campus.refunds.initiate and an order-linked case.
 */
export class DecideCaseDto {
  @ApiProperty({ enum: CASE_DECISION_TARGETS as unknown as string[] })
  @IsString()
  @IsIn(CASE_DECISION_TARGETS as unknown as string[])
  status!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class ListCasesQueryDto {
  @ApiPropertyOptional({ enum: CASE_STATUSES as unknown as string[] })
  @IsOptional()
  @IsString()
  @IsIn(CASE_STATUSES as unknown as string[])
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
