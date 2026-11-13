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

export const REFUND_STATUS_FILTERS = [
  'requested',
  'under_review',
  'submitted',
  'processing',
  'succeeded',
  'failed',
  'needs_assistance',
] as const;

/**
 * Campus-manager cancellation decision. The client never supplies an amount,
 * currency, buyer or status: the refund is always the FULL captured payment
 * of the order, derived server-side (pilot: full refund only).
 */
export class InitiateRefundDto {
  @ApiProperty({ description: 'Order to cancel and refund (full amount).' })
  @IsUUID()
  orderId!: string;

  @ApiProperty({
    description: 'Manager decision reason (required, audited).',
    minLength: 1,
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description: 'Optional related operational case.',
  })
  @IsOptional()
  @IsUUID()
  caseId?: string;
}

export class ListRefundsQueryDto {
  @ApiPropertyOptional({ enum: REFUND_STATUS_FILTERS })
  @IsOptional()
  @IsString()
  @IsIn(REFUND_STATUS_FILTERS as unknown as string[])
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
