import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { TENANT_PERMISSIONS } from '../../access/access.service';
import type { TenantPermission } from '../../access/access.service';
import {
  INVITABLE_TENANT_ROLES,
  STAFF_INVITE_MAX_LIMIT,
  STAFF_INVITE_STATES,
} from '../staff-invites.service';

/**
 * Body of POST /tenants/{tenantId}/staff/invites.
 *
 * The invitation names a user id, not an email address: no delivery channel is
 * live yet, so the owner hands the token over and the database only keeps its
 * SHA-256. The role and permission checks that need the actor (may the inviter
 * grant this?) live in the service; the DTO only guarantees the shape.
 */
export class CreateStaffInviteDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: INVITABLE_TENANT_ROLES as unknown as string[] })
  @IsString()
  @IsIn(INVITABLE_TENANT_ROLES as unknown as string[])
  role!: string;

  @ApiProperty({
    enum: TENANT_PERMISSIONS as unknown as string[],
    isArray: true,
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(TENANT_PERMISSIONS.length)
  @IsIn(TENANT_PERMISSIONS as unknown as string[], { each: true })
  permissions!: TenantPermission[];
}

/** Query filter for the invitation list; 'open' means pending or expired. */
export class ListStaffInvitesQueryDto {
  @ApiPropertyOptional({
    enum: STAFF_INVITE_STATES as unknown as string[],
    default: 'open',
  })
  @IsOptional()
  @IsString()
  @IsIn(STAFF_INVITE_STATES as unknown as string[])
  state?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: STAFF_INVITE_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(STAFF_INVITE_MAX_LIMIT)
  limit?: number;
}
