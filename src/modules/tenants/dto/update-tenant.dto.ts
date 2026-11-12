import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateTenantDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  location!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description: 'Managerial reason recorded in the immutable audit trail',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Microsecond-precise ISO updatedAt exactly as returned by the previous mutation response (convention D7); a mismatch returns 409',
  })
  @IsDateString()
  expectedUpdatedAt!: string;
}
