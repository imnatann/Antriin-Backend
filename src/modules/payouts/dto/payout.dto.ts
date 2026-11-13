import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const BANK_CODE_VALUES = [
  'BCA',
  'BNI',
  'BRI',
  'BSI',
  'MANDIRI',
  'PERMATA',
  'CIMB',
  'BTN',
  'DANAMON',
  'JAGO',
  'BJB',
  'MEGA',
  'OCBC',
  'PANIN',
  'BTPN',
  'SEABANK',
] as const;

export const PAYOUT_STATUS_FILTERS = [
  'requested',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
] as const;

/**
 * Bank account registration. The client supplies the destination data; the
 * server derives tenant, owner, verification status and masking - never from
 * the body.
 */
export class CreateBankAccountDto {
  @ApiProperty({ enum: BANK_CODE_VALUES, description: 'Registered bank code.' })
  @IsString()
  @IsIn(BANK_CODE_VALUES as unknown as string[])
  bankCode!: string;

  @ApiProperty({
    description: 'Account number (digits, spaces/dashes are stripped).',
    example: '1234567890',
  })
  @IsString()
  @Matches(/^[0-9][0-9 -]{4,24}[0-9]$/)
  accountNumber!: string;

  @ApiProperty({ description: 'Name on the account.', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  accountHolderName!: string;

  @ApiPropertyOptional({
    description: 'Make this the default account (defaults to true when none).',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** Payout request. Amounts are integer minor units as decimal strings. */
export class RequestPayoutDto {
  @ApiProperty({ description: 'Verified destination bank account.' })
  @IsString()
  @Matches(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  bankAccountId!: string;

  @ApiProperty({
    description: 'Integer minor units as a decimal string; > 0.',
    example: '50000',
    pattern: '^[1-9][0-9]*$',
  })
  @IsString()
  @Matches(/^[1-9][0-9]{0,37}$/)
  amountMinor!: string;
}

export class CancelPayoutDto {
  @ApiPropertyOptional({ description: 'Cancellation reason (audited).' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;
}

export class ListPayoutsQueryDto {
  @ApiPropertyOptional({ enum: PAYOUT_STATUS_FILTERS })
  @IsOptional()
  @IsString()
  @IsIn(PAYOUT_STATUS_FILTERS as unknown as string[])
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

export class ListBankAccountsQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'disabled'] })
  @IsOptional()
  @IsString()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';
}
