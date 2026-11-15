import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { StaffInvitesService } from './staff-invites.service';

const acceptedSchema = {
  type: 'object',
  properties: {
    inviteId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    membershipId: { type: 'string', format: 'uuid' },
    role: { type: 'string', enum: ['kitchen', 'pickup'] },
    permissions: { type: 'array', items: { type: 'string' } },
    acceptedAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'inviteId',
    'tenantId',
    'membershipId',
    'role',
    'permissions',
    'acceptedAt',
  ],
};

const acceptedResponse = {
  type: 'object',
  properties: { data: acceptedSchema },
  required: ['data'],
};

/**
 * Redemption of a staff invitation. The token is the credential, but the caller
 * must still be authenticated: the invitation names the user it was issued to,
 * so a forwarded token cannot be redeemed by somebody else.
 */
@ApiTags('Tenant staff invites')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('tenant-invites')
export class StaffInviteAcceptanceController {
  constructor(private readonly invites: StaffInvitesService) {}

  @Post(':token/accept')
  @ApiOperation({
    summary: 'Redeem an invitation token for the authenticated invitee',
  })
  @ApiCreatedResponse({
    description: 'The membership created by the invitation',
    schema: acceptedResponse,
  })
  @ApiConflictResponse({
    description:
      'INVITE_EXPIRED, INVITE_REVOKED, INVITE_ALREADY_ACCEPTED, INVITE_TENANT_UNAVAILABLE or INVITE_MEMBERSHIP_CONFLICT',
  })
  @ApiForbiddenResponse({
    description: 'INVITE_USER_MISMATCH: the token belongs to another account',
  })
  @ApiNotFoundResponse({ description: 'INVITE_NOT_FOUND: unknown token' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async accept(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('token') token: string,
  ) {
    const data = await this.invites.acceptInvite(principal.userId, token);
    return { data };
  }
}
