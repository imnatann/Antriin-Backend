import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DEVICE_PLATFORMS } from '../users.service';

/** The account owner renames their own profile; whitespace is trimmed first. */
export class UpdateProfileDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName!: string;
}

/**
 * Partial update of the server-side notification switches. Omitted fields keep
 * their stored value (or the documented default when no row exists yet).
 */
export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  orderUpdates?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  reviewReplies?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  caseUpdates?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;
}

/** Registers this device for notifications; the raw token is never stored. */
export class RegisterDeviceDto {
  @ApiProperty({ enum: DEVICE_PLATFORMS as unknown as string[] })
  @IsString()
  @IsIn(DEVICE_PLATFORMS as unknown as string[])
  platform!: string;

  @ApiProperty({
    minLength: 8,
    maxLength: 512,
    description: 'Push token; stored only as its SHA-256 hash',
  })
  @IsString()
  @Length(8, 512)
  token!: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}
