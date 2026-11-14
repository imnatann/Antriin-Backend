import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Hostname input shape: letters, digits, dots and hyphens, at least one dot.
 * Case and surrounding whitespace are allowed here because the service trims
 * and lowercases before validating the final hostname (the database enforces
 * lowercase domains).
 */
export const EMAIL_DOMAIN_INPUT_PATTERN =
  /^\s*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\s*$/;

/** Registers a campus email domain; a new domain is never pre-verified. */
export class CreateCampusEmailDomainDto {
  @ApiProperty({
    description: 'Campus email domain (trimmed and lowercased by the server).',
    example: 'student.ac.id',
    maxLength: 253,
  })
  @IsString()
  @MaxLength(255)
  @Matches(EMAIL_DOMAIN_INPUT_PATTERN, {
    message: 'domain must be a valid email domain such as student.ac.id',
  })
  domain!: string;

  @ApiProperty({
    description: 'Why this domain is registered (audited).',
    minLength: 1,
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

/**
 * Records that a campus manager verified ownership of the domain OUTSIDE the
 * system. No DNS check runs; the attestation and its reason are audited.
 */
export class VerifyCampusEmailDomainDto {
  @ApiProperty({
    description: 'How ownership of the domain was verified (audited).',
    minLength: 1,
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

/** Activates or deactivates a domain; deactivation stops auth immediately. */
export class UpdateCampusEmailDomainDto {
  @ApiPropertyOptional({
    description: 'Whether auth may accept addresses on this domain.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({
    description: 'Why the domain is being changed (audited).',
    minLength: 1,
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

/** Hard-deletes a domain; the audit row keeps the domain name and reason. */
export class DeleteCampusEmailDomainDto {
  @ApiProperty({
    description: 'Why the domain is removed (audited).',
    minLength: 1,
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
