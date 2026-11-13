import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsString, Matches, MaxLength } from 'class-validator';

export const SANDBOX_PROVIDER_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'expired',
] as const;
export type SandboxProviderStatus = (typeof SANDBOX_PROVIDER_STATUSES)[number];

/**
 * Validated body of a sandbox provider webhook. Signature/timestamp are
 * verified separately over the exact raw bytes before this shape is trusted.
 * occurredAt may be far in the past (late-success reconciliation) and is NOT
 * the authentication timestamp. reference/amount/currency are correlated
 * against the stored intent server-side before any balance moves.
 */
export class SandboxWebhookEventDto {
  @ApiProperty({ description: 'Provider-unique event id (dedupe key).' })
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_.:-]{1,200}$/)
  eventId!: string;

  @ApiProperty({
    description: 'Provider reference correlating to a stored top-up intent.',
  })
  @IsString()
  @MaxLength(160)
  reference!: string;

  @ApiProperty({ enum: SANDBOX_PROVIDER_STATUSES })
  @IsIn(SANDBOX_PROVIDER_STATUSES as unknown as string[])
  status!: SandboxProviderStatus;

  @ApiProperty({ description: 'Settled amount in integer IDR minor units.' })
  @IsString()
  @MaxLength(39)
  @Matches(/^(0|[1-9][0-9]*)$/)
  amountMinor!: string;

  @ApiProperty({ enum: ['IDR'] })
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @ApiProperty({
    description:
      'When the provider says the state occurred; may be historical. ISO-8601.',
  })
  @IsISO8601()
  occurredAt!: string;
}
