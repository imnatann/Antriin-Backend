import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TENANT_PERMISSIONS } from '../access.service';
import type { TenantPermission, TenantStaffRole } from '../access.service';

export class GrantTenantStaffDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  subjectUserId!: string;

  @ApiProperty({ enum: ['kitchen', 'pickup'] })
  @IsIn(['kitchen', 'pickup'])
  role!: TenantStaffRole;

  @ApiProperty({ enum: TENANT_PERMISSIONS, isArray: true })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(TENANT_PERMISSIONS.length)
  @IsIn(TENANT_PERMISSIONS, { each: true })
  permissions!: TenantPermission[];

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class UpdateTenantStaffDto {
  @ApiProperty({ enum: ['kitchen', 'pickup'] })
  @IsIn(['kitchen', 'pickup'])
  role!: TenantStaffRole;

  @ApiProperty({ enum: TENANT_PERMISSIONS, isArray: true })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(TENANT_PERMISSIONS.length)
  @IsIn(TENANT_PERMISSIONS, { each: true })
  permissions!: TenantPermission[];

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class RevokeTenantStaffDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
