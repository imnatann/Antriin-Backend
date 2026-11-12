import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import type { OtpChannel } from './auth.constants';

export class CreateOtpChallengeDto {
  @IsIn(['email', 'phone'])
  channel!: OtpChannel;

  @IsString()
  @MaxLength(320)
  destination!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;
}

export class VerifyOtpDto {
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class CreateCampusEmailVerificationDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
