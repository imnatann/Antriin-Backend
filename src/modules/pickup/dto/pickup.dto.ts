import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  MAX_PICKUP_REASON_LENGTH,
  PICKUP_CODE_INPUT_PATTERN,
} from '../pickup.constants';

/**
 * Presented pickup code. The server never trusts its shape beyond transport
 * sanity: it is normalized (upper-cased, separators stripped) and matched by
 * HMAC hash, so an unknown code fails closed with PICKUP_CODE_INVALID.
 */
export class PickupCodeDto {
  @ApiProperty({
    minLength: 4,
    maxLength: 32,
    example: 'K7XQ-2M9P',
    description:
      'Pickup code as shown to the buyer; case-insensitive, spaces/dashes allowed.',
  })
  @IsString()
  @Matches(PICKUP_CODE_INPUT_PATTERN, {
    message:
      'code must be 4-32 alphanumeric characters (spaces/dashes allowed)',
  })
  code!: string;
}

/**
 * Explicit credential revocation. The reason is mandatory: it lands in the
 * immutable audit trail and in order_events (pickup_credential.revoked).
 */
export class RevokePickupCredentialDto {
  @ApiProperty({
    minLength: 1,
    maxLength: MAX_PICKUP_REASON_LENGTH,
    description: 'Why the credential is revoked (audit + order event).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PICKUP_REASON_LENGTH)
  reason!: string;
}
