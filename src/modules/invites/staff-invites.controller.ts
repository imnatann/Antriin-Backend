import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import {
  CreateStaffInviteDto,
  ListStaffInvitesQueryDto,
} from './dto/staff-invite.dto';
import { StaffInvitesService } from './staff-invites.service';
import type { StaffInviteState } from './staff-invites.service';

const inviteSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    invitedUserId: { type: 'string', format: 'uuid' },
    invitedBy: { type: 'string', format: 'uuid' },
    role: { type: 'string', enum: ['kitchen', 'pickup'] },
    permissions: { type: 'array', items: { type: 'string' } },
    status: {
      type: 'string',
      enum: ['pending', 'expired', 'accepted', 'revoked'],
    },
    expiresAt: { type: 'string', format: 'date-time' },
    acceptedAt: { type: 'string', format: 'date-time', nullable: true },
    revokedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'tenantId',
    'invitedUserId',
    'invitedBy',
    'role',
    'permissions',
    'status',
    'expiresAt',
    'acceptedAt',
    'revokedAt',
    'createdAt',
  ],
};

const createdInviteSchema = {
  type: 'object',
  properties: {
    ...inviteSchema.properties,
    token: {
      type: 'string',
      description:
        'One-time redemption token. Returned only here; the database stores its SHA-256.',
    },
  },
  required: [...inviteSchema.required, 'token'],
};

const inviteResponse = {
  type: 'object',
  properties: { data: inviteSchema },
  required: ['data'],
};

const createdInviteResponse = {
  type: 'object',
  properties: { data: createdInviteSchema },
  required: ['data'],
};

const inviteListResponse = {
  type: 'object',
  properties: {
    data: { type: 'array', items: inviteSchema },
    meta: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    },
  },
  required: ['data', 'meta'],
};

/**
 * Staff invitation management. A verified tenant owner (the only role that
 * holds tenant.staff.manage) issues and revokes invitations; every route is
 * scoped to the tenant in the path and re-checks the permission in the service.
 */
@ApiTags('Tenant staff invites')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('tenants/:tenantId/staff/invites')
export class StaffInvitesController {
  constructor(private readonly invites: StaffInvitesService) {}

  @Post()
  @ApiOperation({
    summary: 'Invite a user to the tenant staff with a staff role',
  })
  @ApiCreatedResponse({
    description:
      'The invitation plus the one-time token; the token is not retrievable again',
    schema: createdInviteResponse,
  })
  @ApiBadRequestResponse({
    description: 'Unknown role, unknown permission or invalid user id',
  })
  @ApiForbiddenResponse({
    description:
      'Missing tenant.staff.manage, or the inviter does not hold the permissions',
  })
  @ApiConflictResponse({
    description: 'The user is already staff or already has a pending invite',
  })
  @ApiNotFoundResponse({ description: 'No active user with that id' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: CreateStaffInviteDto,
  ) {
    const data = await this.invites.createInvite(principal.userId, tenantId, {
      userId: body.userId,
      role: body.role,
      permissions: body.permissions,
    });
    return { data };
  }

  @Get()
  @ApiOperation({
    summary:
      'List invitations; open (pending/expired) by default, never tokens',
  })
  @ApiOkResponse({ description: 'Invitations', schema: inviteListResponse })
  @ApiBadRequestResponse({ description: 'Invalid state or limit' })
  @ApiForbiddenResponse({ description: 'Missing tenant.staff.manage' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: ListStaffInvitesQueryDto,
  ) {
    const result = await this.invites.listInvites(principal.userId, tenantId, {
      state: query.state as StaffInviteState | undefined,
      limit: query.limit,
    });
    return { data: result.items, meta: result.meta };
  }

  @Delete(':inviteId')
  @ApiOperation({ summary: 'Revoke a still-open invitation' })
  @ApiOkResponse({
    description: 'The invitation after revocation (idempotent)',
    schema: inviteResponse,
  })
  @ApiConflictResponse({
    description: 'The invitation was already accepted',
  })
  @ApiNotFoundResponse({
    description: 'Invitation does not exist or belongs to another tenant',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async revoke(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ) {
    const data = await this.invites.revokeInvite(
      principal.userId,
      tenantId,
      inviteId,
    );
    return { data };
  }
}
