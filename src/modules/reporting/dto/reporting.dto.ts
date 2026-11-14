import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ORDER_STATUSES } from '../../orders/orders.constants';
import type { OrderStatus } from '../../orders/orders.constants';
import { TRANSACTION_PAGE_LIMIT_MAX } from '../reporting.constants';

/** Half-open [from, to) report window; both bounds are required. */
export class ReportRangeQueryDto {
  @ApiProperty({ description: 'Inclusive lower bound (ISO 8601).' })
  @IsISO8601()
  from!: string;

  @ApiProperty({ description: 'Exclusive upper bound (ISO 8601).' })
  @IsISO8601()
  to!: string;
}

/**
 * Campus transaction monitoring query: the required window plus optional
 * filters and cursor pagination. The filters only narrow the caller's campus
 * scope; the service re-checks that a tenant belongs to the campus.
 */
export class CampusTransactionsQueryDto extends ReportRangeQueryDto {
  @ApiPropertyOptional({
    enum: ORDER_STATUSES,
    description: 'Only orders in this status.',
  })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only orders of this tenant (must belong to the campus).',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({
    description: 'Opaque cursor from meta.next_cursor of the previous page.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,512}$/)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: TRANSACTION_PAGE_LIMIT_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TRANSACTION_PAGE_LIMIT_MAX)
  limit?: number;
}
