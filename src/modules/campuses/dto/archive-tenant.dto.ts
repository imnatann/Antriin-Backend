import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class ArchiveTenantDto {
  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  expectedUpdatedAt!: string;
}
