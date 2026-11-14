import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { CampusAccessService } from './campus-access.service';

const memberSchema = {
  type: 'object',
  properties: {
    membershipId: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    displayName: { type: 'string' },
    permissions: { type: 'array', items: { type: 'string' } },
    status: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'membershipId',
    'userId',
    'displayName',
    'permissions',
    'status',
    'createdAt',
    'updatedAt',
  ],
};

/**
 * Campus membership stays a controlled provisioning operation (docs/ACCESS.md):
 * this controller only reads the active members of one campus. There is
 * deliberately no route that grants, changes or revokes campus access.
 */
@ApiTags('Campus access')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('campuses/:campusId')
export class CampusAccessController {
  constructor(private readonly campusAccess: CampusAccessService) {}

  @Get('access')
  @ApiOperation({
    summary: 'List active campus members (campus.access.manage, read-only)',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiOkResponse({
    description: 'Active members of the campus ordered by display name',
    schema: {
      type: 'object',
      properties: { data: { type: 'array', items: memberSchema } },
      required: ['data'],
    },
  })
  @ApiForbiddenResponse({
    description: 'campus.access.manage is required for this campus',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
  ) {
    const data = await this.campusAccess.listMembers(
      principal.userId,
      campusId,
    );
    return { data };
  }
}
