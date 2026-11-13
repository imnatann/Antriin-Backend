import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const TENANT_OPERATIONAL_STATUSES = [
  'open',
  'closed',
  'paused',
] as const;
export type TenantOperationalStatus =
  (typeof TENANT_OPERATIONAL_STATUSES)[number];

/**
 * Shared by the tenant-staff route (PATCH /v1/tenants/:tenantId/status) and
 * the campus-admin route (PUT /v1/campuses/:campusId/tenants/:tenantId/status).
 * `archived` is intentionally not settable here; archiving is a separate
 * audited operation with active-dependency checks.
 */
export class SetTenantStatusDto {
  @ApiProperty({ enum: TENANT_OPERATIONAL_STATUSES })
  @IsIn(TENANT_OPERATIONAL_STATUSES)
  status!: TenantOperationalStatus;

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
