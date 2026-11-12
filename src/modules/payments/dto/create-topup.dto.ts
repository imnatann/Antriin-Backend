import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * Buyer top-up intent request. Amount is an integer count of IDR minor units
 * (whole rupiah, exponent 0 per pilot policy) transmitted as a decimal string.
 * The client never supplies provider, currency, price or status: those are
 * server-authoritative. Unknown fields are rejected by the global pipe.
 */
export class CreateTopupIntentDto {
  @ApiProperty({
    description:
      'Top-up amount in integer IDR minor units (whole rupiah) as a decimal string.',
    example: '25000',
    pattern: '^(0|[1-9][0-9]*)$',
  })
  @IsString()
  @MaxLength(39)
  @Matches(/^(0|[1-9][0-9]*)$/, {
    message: 'amountMinor must be a non-negative decimal integer string',
  })
  amountMinor!: string;

  @ApiProperty({
    description:
      'Client-generated idempotency key, unique per user; replays return the same intent.',
    example: 'b7f1c9a2-4e5d-4a1b-9c3d-2f8e6a0b1c2d',
    minLength: 8,
    maxLength: 200,
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_.:-]{8,200}$/, {
    message: 'idempotencyKey must be 8-200 chars from [A-Za-z0-9_.:-]',
  })
  idempotencyKey!: string;
}
