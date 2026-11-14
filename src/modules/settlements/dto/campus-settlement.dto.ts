import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { SETTLEMENT_STATUS_FILTERS } from '../campus-settlements.service';

/**
 * Campus settlement monitoring query: a mandatory half-open [from, to) window
 * (capped at 366 days by the service), optional status/tenant filters and
 * opaque cursor paging. Money and campus scope are never client input.
 */
export class CampusSettlementQueryDto {
  @ApiProperty({ description: 'Inclusive lower bound (ISO 8601).' })
  @IsISO8601()
  from!: string;

  @ApiProperty({ description: 'Exclusive upper bound (ISO 8601).' })
  @IsISO8601()
  to!: string;

  @ApiPropertyOptional({ enum: SETTLEMENT_STATUS_FILTERS })
  @IsOptional()
  @IsString()
  @IsIn(SETTLEMENT_STATUS_FILTERS as unknown as string[])
  status?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restrict to one tenant of the campus.',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

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
