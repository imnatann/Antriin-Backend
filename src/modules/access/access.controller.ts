import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import { AccessService } from './access.service';
import {
  GrantTenantStaffDto,
  RevokeTenantStaffDto,
  UpdateTenantStaffDto,
} from './dto/tenant-staff.dto';

interface AuthenticatedPrincipal {
  userId: string;
  sessionId: string;
}

@ApiTags('Tenant staff access')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('tenants/:tenantId/staff')
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get()
  @ApiOperation({ summary: 'List tenant staff visible to a verified owner' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
  ) {
    return {
      data: await this.access.listTenantStaff(principal.userId, tenantId),
    };
  }

  @Post()
  @ApiOperation({ summary: 'Grant a tenant staff membership' })
  async grant(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: GrantTenantStaffDto,
  ) {
    const result = await this.access.grantTenantMembership({
      actorUserId: principal.userId,
      tenantId,
      subjectUserId: dto.subjectUserId,
      role: dto.role,
      permissions: dto.permissions,
      reason: dto.reason,
    });
    return {
      data: {
        userId: dto.subjectUserId,
        membershipId: result.membershipId,
        role: dto.role,
        permissions: dto.permissions,
        status: 'active',
      },
    };
  }

  @Put(':subjectUserId')
  @ApiOperation({ summary: 'Update a tenant staff role and permissions' })
  async update(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('subjectUserId', new ParseUUIDPipe()) subjectUserId: string,
    @Body() dto: UpdateTenantStaffDto,
  ) {
    const result = await this.access.grantTenantMembership({
      actorUserId: principal.userId,
      tenantId,
      subjectUserId,
      role: dto.role,
      permissions: dto.permissions,
      reason: dto.reason,
    });
    return {
      data: {
        userId: subjectUserId,
        membershipId: result.membershipId,
        role: dto.role,
        permissions: dto.permissions,
        status: 'active',
      },
    };
  }

  @Delete(':subjectUserId')
  @ApiOperation({ summary: 'Revoke a tenant staff membership immediately' })
  async revoke(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('subjectUserId', new ParseUUIDPipe()) subjectUserId: string,
    @Body() dto: RevokeTenantStaffDto,
  ) {
    await this.access.revokeTenantMembership({
      actorUserId: principal.userId,
      tenantId,
      subjectUserId,
      reason: dto.reason,
    });
    return { data: { userId: subjectUserId, status: 'revoked' } };
  }
}
