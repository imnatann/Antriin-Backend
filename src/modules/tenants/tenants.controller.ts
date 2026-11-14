import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { ArchiveTenantDto } from './dto/archive-tenant.dto';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { ListTenantsQueryDto } from './dto/list-tenants-query.dto';
import { ProvisionTenantOwnerDto } from './dto/provision-tenant-owner.dto';
import { SetTenantStatusDto } from './dto/set-tenant-status.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantsService } from './tenants.service';

const TENANT_PRESENTATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    campusId: { type: 'string', format: 'uuid' },
    campusName: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    contact: { type: 'string' },
    pickupInstructions: { type: 'string' },
    location: { type: 'string' },
    status: { type: 'string', enum: ['open', 'closed', 'paused'] },
    timezone: { type: 'string' },
  },
  required: [
    'id',
    'campusId',
    'name',
    'description',
    'contact',
    'pickupInstructions',
    'location',
    'status',
    'timezone',
  ],
};

const TENANT_SETTINGS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    campusId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string' },
    contact: { type: 'string' },
    pickupInstructions: { type: 'string' },
    location: { type: 'string' },
    status: { type: 'string', enum: ['open', 'closed', 'paused'] },
    timezone: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'campusId',
    'name',
    'description',
    'contact',
    'pickupInstructions',
    'location',
    'status',
    'timezone',
    'createdAt',
    'updatedAt',
  ],
};

@ApiTags('Tenants')
@Controller()
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly provisioning: TenantProvisioningService,
  ) {}

  // ------------------------------------------------------------- public

  @Get('tenants')
  @ApiOperation({
    summary:
      'List non-archived tenants of active campuses with optional filters',
  })
  @ApiOkResponse({ description: 'Public tenant list' })
  @ApiBadRequestResponse({ description: 'Invalid query parameters' })
  list(@Query() query: ListTenantsQueryDto) {
    return this.tenants.list(query);
  }

  @Get('tenants/:tenantId')
  @ApiOperation({
    summary:
      'Get one non-archived tenant with its campus timezone; archived tenants return 404',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({
    description: 'Public tenant details',
    schema: {
      type: 'object',
      properties: { data: TENANT_PRESENTATION_SCHEMA },
      required: ['data'],
    },
  })
  @ApiNotFoundResponse({
    description: 'Tenant missing, archived, or campus inactive',
  })
  get(@Param('tenantId', new ParseUUIDPipe()) tenantId: string) {
    return this.tenants.get(tenantId);
  }

  // ------------------------------------------------- tenant staff status

  @Patch('tenants/:tenantId/status')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Tenant staff transition: paused requires tenant.orders.pause, open/closed require tenant.capacity.manage',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({ description: 'New status with microsecond updatedAt (D7)' })
  @ApiBadRequestResponse({ description: 'Invalid status or payload' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  @ApiForbiddenResponse({
    description: 'Missing membership/permission or tenant archived',
  })
  @ApiConflictResponse({ description: 'expectedUpdatedAt mismatch (409)' })
  setStatusByStaff(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: SetTenantStatusDto,
  ) {
    return this.tenants.setStatusByStaff(principal.userId, tenantId, dto);
  }

  // ---------------------------------------------------- tenant settings

  @Patch('tenants/:tenantId/settings')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Update the public stall profile (name, description, contact, pickup instructions, location); requires tenant.settings.manage',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({
    description:
      'Updated stall profile with microsecond createdAt/updatedAt (D7)',
    schema: {
      type: 'object',
      properties: { data: TENANT_SETTINGS_SCHEMA },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid payload, or no profile field supplied (TENANT_SETTINGS_EMPTY)',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  @ApiForbiddenResponse({ description: 'Missing tenant.settings.manage' })
  @ApiNotFoundResponse({ description: 'Tenant missing or archived' })
  @ApiConflictResponse({
    description: 'expectedUpdatedAt mismatch (TENANT_VERSION_CONFLICT)',
  })
  updateSettings(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: UpdateTenantSettingsDto,
  ) {
    return this.tenants.updateSettings(principal.userId, tenantId, dto);
  }

  // ------------------------------------------------------ campus admin

  @Post('campuses/:campusId/tenants')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Create a tenant (status closed) in an authorized campus; requires campus.tenants.manage',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Created tenant with updatedAt (D7)' })
  @ApiBadRequestResponse({ description: 'Invalid payload' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  @ApiForbiddenResponse({ description: 'Missing campus membership/permission' })
  create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', new ParseUUIDPipe()) campusId: string,
    @Body() dto: CreateTenantDto,
  ) {
    return this.tenants.create(principal.userId, campusId, dto);
  }

  @Patch('campuses/:campusId/tenants/:tenantId')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Update tenant name/location with optimistic concurrency; requires campus.tenants.manage',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({ description: 'Updated tenant with new updatedAt (D7)' })
  @ApiBadRequestResponse({ description: 'Invalid payload' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  @ApiForbiddenResponse({ description: 'Missing campus membership/permission' })
  @ApiNotFoundResponse({
    description: 'Tenant missing, archived, or bound to another campus',
  })
  @ApiConflictResponse({ description: 'expectedUpdatedAt mismatch (409)' })
  update(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', new ParseUUIDPipe()) campusId: string,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.tenants.update(principal.userId, campusId, tenantId, dto);
  }

  @Put('campuses/:campusId/tenants/:tenantId/status')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Campus-admin oversight transition (open/closed/paused); requires campus.tenants.manage',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({ description: 'New status with microsecond updatedAt (D7)' })
  @ApiBadRequestResponse({ description: 'Invalid status or payload' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  @ApiForbiddenResponse({ description: 'Missing campus membership/permission' })
  @ApiNotFoundResponse({
    description: 'Tenant missing, archived, or bound to another campus',
  })
  @ApiConflictResponse({ description: 'expectedUpdatedAt mismatch (409)' })
  setStatusByCampusAdmin(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', new ParseUUIDPipe()) campusId: string,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: SetTenantStatusDto,
  ) {
    return this.tenants.setStatusByCampusAdmin(
      principal.userId,
      campusId,
      tenantId,
      dto,
    );
  }

  @Delete('campuses/:campusId/tenants/:tenantId')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Archive a tenant without deleting history; refused while active orders, pending proposals, reservations, or open future slots exist; requires campus.tenants.manage',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({ description: 'Tenant archived' })
  @ApiBadRequestResponse({ description: 'Invalid payload' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  @ApiForbiddenResponse({ description: 'Missing campus membership/permission' })
  @ApiNotFoundResponse({
    description: 'Tenant missing, archived, or bound to another campus',
  })
  @ApiConflictResponse({
    description:
      'Active dependencies block archiving, or expectedUpdatedAt mismatch',
  })
  archive(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', new ParseUUIDPipe()) campusId: string,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: ArchiveTenantDto,
  ) {
    return this.tenants.archive(principal.userId, campusId, tenantId, dto);
  }

  @Post('campuses/:campusId/tenants/:tenantId/owner')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Provision the FIRST verified tenant owner (controlled bootstrap); requires campus.access.manage; 409 when an active owner already exists',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiCreatedResponse({
    description: 'Owner membership provisioned with audit trail',
  })
  @ApiBadRequestResponse({ description: 'Invalid payload' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  @ApiForbiddenResponse({
    description:
      'Missing campus.access.manage, self-provisioning, or inactive target user',
  })
  @ApiNotFoundResponse({
    description: 'Tenant missing/archived/other campus, or target user missing',
  })
  @ApiConflictResponse({ description: 'Tenant already has an active owner' })
  provisionOwner(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', new ParseUUIDPipe()) campusId: string,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: ProvisionTenantOwnerDto,
  ) {
    return this.provisioning.provisionTenantOwner(
      principal.userId,
      campusId,
      tenantId,
      dto,
    );
  }
}
