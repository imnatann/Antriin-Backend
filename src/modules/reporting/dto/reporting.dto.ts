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
import {
  REPORT_EXPORT_FORMATS,
  REPORT_EXPORT_KINDS,
  REPORT_EXPORT_SCHEDULES,
  TRANSACTION_PAGE_LIMIT_MAX,
} from '../reporting.constants';
import type {
  ReportExportFormat,
  ReportExportKind,
  ReportSchedule,
} from '../reporting.constants';

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

/**
 * Request for a stored export or a recurring one.
 *
 * The window is validated by the same rules as the report endpoints (both
 * bounds, from < to, at most 366 days) and is stored at day granularity
 * because report_exports keeps calendar dates, not instants.
 *
 * scheduleHour is required for daily/weekly and rejected for manual: a
 * schedule without an hour, or an hour with no schedule, is a client mistake
 * rather than something to guess at.
 */
export class CreateReportExportDto {
  @ApiProperty({
    enum: REPORT_EXPORT_KINDS,
    description:
      'sales on a tenant, dashboard on a campus; anything else is rejected.',
  })
  @IsIn(REPORT_EXPORT_KINDS)
  kind!: ReportExportKind;

  @ApiProperty({ enum: REPORT_EXPORT_FORMATS })
  @IsIn(REPORT_EXPORT_FORMATS)
  format!: ReportExportFormat;

  @ApiProperty({ description: 'Inclusive lower bound (ISO 8601).' })
  @IsISO8601()
  from!: string;

  @ApiProperty({ description: 'Exclusive upper bound (ISO 8601).' })
  @IsISO8601()
  to!: string;

  @ApiPropertyOptional({
    enum: REPORT_EXPORT_SCHEDULES,
    default: 'manual',
    description:
      'manual asks for one generation now; daily/weekly regenerate it at scheduleHour in the campus timezone.',
  })
  @IsOptional()
  @IsIn(REPORT_EXPORT_SCHEDULES)
  schedule?: ReportSchedule;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 23,
    description:
      'Local hour (campus timezone) of a daily/weekly regeneration. Required for those schedules, not allowed for manual.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  scheduleHour?: number;
}
