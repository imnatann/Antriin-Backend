import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Owner-managed public stall profile (name, description, contact, pickup
 * instructions, location). Every profile field is optional so a caller may
 * patch a single value; the service rejects a body that carries none of them
 * with TENANT_SETTINGS_EMPTY. `reason` and `expectedUpdatedAt` are always
 * required: the first feeds the immutable audit trail, the second implements
 * optimistic concurrency (convention D7).
 */
export class UpdateTenantSettingsDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiProperty({
    required: false,
    minLength: 0,
    maxLength: 2000,
    description: 'Public stall description; an empty string clears it',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    required: false,
    minLength: 0,
    maxLength: 200,
    description: 'Public contact of the stall; an empty string clears it',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contact?: string;

  @ApiProperty({
    required: false,
    minLength: 0,
    maxLength: 1000,
    description: 'Pickup instructions shown to buyers; empty string clears it',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  pickupInstructions?: string;

  @ApiProperty({ required: false, minLength: 1, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  location?: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description: 'Reason recorded in the immutable audit trail',
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
