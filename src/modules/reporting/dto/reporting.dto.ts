import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601 } from 'class-validator';

/** Half-open [from, to) report window; both bounds are required. */
export class ReportRangeQueryDto {
  @ApiProperty({ description: 'Inclusive lower bound (ISO 8601).' })
  @IsISO8601()
  from!: string;

  @ApiProperty({ description: 'Exclusive upper bound (ISO 8601).' })
  @IsISO8601()
  to!: string;
}
