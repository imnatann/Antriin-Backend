import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { UsersService } from './users.service';
import {
  CloseAccountDto,
  RegisterDeviceDto,
  UpdateNotificationPreferencesDto,
  UpdateProfileDto,
} from './dto/me.dto';

const phoneSchema = {
  type: 'object',
  properties: {
    masked: { type: 'string', nullable: true },
    verified: { type: 'boolean' },
  },
  required: ['masked', 'verified'],
};

const campusEmailSchema = {
  type: 'object',
  properties: {
    verified: { type: 'boolean' },
    campusId: { type: 'string', format: 'uuid', nullable: true },
    campusName: { type: 'string', nullable: true },
  },
  required: ['verified', 'campusId', 'campusName'],
};

const walletSchema = {
  type: 'object',
  nullable: true,
  properties: {
    currency: { type: 'string', enum: ['IDR'] },
    availableMinor: { type: 'string' },
  },
  required: ['currency', 'availableMinor'],
};

const tenantSchema = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    tenantName: { type: 'string' },
    tenantStatus: { type: 'string' },
    campusId: { type: 'string', format: 'uuid' },
    campusName: { type: 'string' },
    role: { type: 'string', enum: ['owner', 'kitchen', 'pickup'] },
    permissions: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'tenantId',
    'tenantName',
    'tenantStatus',
    'campusId',
    'campusName',
    'role',
    'permissions',
  ],
};

const campusSchema = {
  type: 'object',
  properties: {
    campusId: { type: 'string', format: 'uuid' },
    campusName: { type: 'string' },
    permissions: { type: 'array', items: { type: 'string' } },
  },
  required: ['campusId', 'campusName', 'permissions'],
};

const meProfileSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    displayName: { type: 'string' },
    status: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    phone: phoneSchema,
    campusEmail: campusEmailSchema,
    wallet: walletSchema,
    tenants: { type: 'array', items: tenantSchema },
    campuses: { type: 'array', items: campusSchema },
  },
  required: [
    'id',
    'displayName',
    'status',
    'createdAt',
    'updatedAt',
    'phone',
    'campusEmail',
    'wallet',
    'tenants',
    'campuses',
  ],
};

const preferencesSchema = {
  type: 'object',
  properties: {
    orderUpdates: { type: 'boolean' },
    reviewReplies: { type: 'boolean' },
    caseUpdates: { type: 'boolean' },
    pushEnabled: { type: 'boolean' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
  required: [
    'orderUpdates',
    'reviewReplies',
    'caseUpdates',
    'pushEnabled',
    'updatedAt',
  ],
};

const deviceSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    platform: { type: 'string', enum: ['ios', 'android', 'web'] },
    label: { type: 'string' },
    lastSeenAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'platform', 'label', 'lastSeenAt', 'createdAt', 'updatedAt'],
};

const retentionEntrySchema = {
  type: 'object',
  properties: {
    entity: { type: 'string' },
    count: { type: 'integer' },
    reason: { type: 'string' },
  },
  required: ['entity', 'reason'],
};

const closureSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['closed'] },
    displayName: {
      type: 'string',
      description: 'The pseudonymised name the closed account now carries',
    },
    closedAt: { type: 'string', format: 'date-time' },
    requestId: { type: 'string', format: 'uuid' },
    revokedSessions: {
      type: 'integer',
      description: 'Sessions revoked by this call; 0 when it was idempotent',
    },
    retained: {
      type: 'object',
      additionalProperties: true,
      description:
        'account_deletion_requests.retained_summary: what was kept and why',
    },
  },
  required: [
    'status',
    'displayName',
    'closedAt',
    'requestId',
    'revokedSessions',
    'retained',
  ],
};

const exportSchema = {
  type: 'object',
  properties: {
    exportedAt: { type: 'string', format: 'date-time' },
    profile: {
      type: 'object',
      additionalProperties: true,
      description: 'Profile with the phone number masked',
    },
    orders: {
      type: 'object',
      additionalProperties: true,
      description:
        'Order count by status and the total per currency, minor units',
    },
    wallet: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          currency: { type: 'string' },
          availableMinor: { type: 'string' },
        },
        required: ['currency', 'availableMinor'],
      },
    },
    transactions: {
      type: 'object',
      additionalProperties: true,
      description: 'Bounded ledger transaction list with a truncated flag',
    },
    reviews: { type: 'object', additionalProperties: true },
    notifications: {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        unread: { type: 'integer' },
      },
      required: ['count', 'unread'],
    },
  },
  required: [
    'exportedAt',
    'profile',
    'orders',
    'wallet',
    'transactions',
    'reviews',
    'notifications',
  ],
};

const closureResponse = {
  type: 'object',
  properties: {
    data: {
      ...closureSchema,
      properties: {
        ...closureSchema.properties,
        retained: {
          ...closureSchema.properties.retained,
          properties: {
            policy: { type: 'string' },
            closedBy: { type: 'string' },
            pseudonymised: { type: 'array', items: { type: 'string' } },
            revoked: {
              type: 'object',
              properties: {
                sessions: { type: 'integer' },
                devices: { type: 'integer' },
              },
              required: ['sessions', 'devices'],
            },
            retained: { type: 'array', items: retentionEntrySchema },
          },
        },
      },
    },
  },
  required: ['data'],
};

const exportResponse = {
  type: 'object',
  properties: { data: exportSchema },
  required: ['data'],
};

const meResponse = {
  type: 'object',
  properties: { data: meProfileSchema },
  required: ['data'],
};

const preferencesResponse = {
  type: 'object',
  properties: { data: preferencesSchema },
  required: ['data'],
};

const deviceResponse = {
  type: 'object',
  properties: { data: deviceSchema },
  required: ['data'],
};

const devicesResponse = {
  type: 'object',
  properties: { data: { type: 'array', items: deviceSchema } },
  required: ['data'],
};

/**
 * The authenticated account's own profile. Every route acts on the session
 * user only: no path or body field can name another account, so a client cannot
 * read or edit someone else's profile, preferences or devices.
 */
@ApiTags('Me')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Read the authenticated account profile' })
  @ApiOkResponse({
    description:
      'Profile with masked phone, campus email, wallet, tenant and campus memberships',
    schema: meResponse,
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async getProfile(@CurrentUser() principal: AuthenticatedPrincipal) {
    const data = await this.users.getProfile(principal.userId);
    return { data };
  }

  @Patch('me')
  @ApiOperation({ summary: 'Rename the authenticated account profile' })
  @ApiOkResponse({
    description: 'The updated profile, in the same shape as GET /me',
    schema: meResponse,
  })
  @ApiBadRequestResponse({
    description: 'displayName is empty after trimming or longer than 200',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async updateProfile(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: UpdateProfileDto,
  ) {
    const data = await this.users.updateProfile(principal.userId, body);
    return { data };
  }

  @Get('me/notification-preferences')
  @ApiOperation({
    summary: 'Read the notification switches (defaults are not persisted)',
  })
  @ApiOkResponse({
    description:
      'Stored switches, or the documented defaults with updatedAt null',
    schema: preferencesResponse,
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async getNotificationPreferences(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    const data = await this.users.getNotificationPreferences(principal.userId);
    return { data };
  }

  @Patch('me/notification-preferences')
  @ApiOperation({ summary: 'Update some or all notification switches' })
  @ApiOkResponse({
    description: 'The complete switch set after the update',
    schema: preferencesResponse,
  })
  @ApiBadRequestResponse({
    description: 'No switch provided, or a switch is not a boolean',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async updateNotificationPreferences(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: UpdateNotificationPreferencesDto,
  ) {
    const data = await this.users.updateNotificationPreferences(
      principal.userId,
      body,
    );
    return { data };
  }

  @Get('me/devices')
  @ApiOperation({ summary: 'List the caller active notification devices' })
  @ApiOkResponse({
    description: 'Active devices, most recently seen first; no token or hash',
    schema: devicesResponse,
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listDevices(@CurrentUser() principal: AuthenticatedPrincipal) {
    const data = await this.users.listDevices(principal.userId);
    return { data };
  }

  @Post('me/devices')
  @ApiOperation({
    summary: 'Register this device; the token is stored only as a hash',
  })
  @ApiCreatedResponse({
    description: 'Registered device (idempotent for the same token)',
    schema: deviceResponse,
  })
  @ApiBadRequestResponse({
    description: 'Invalid platform, token or label',
  })
  @ApiConflictResponse({
    description: 'The token is already registered to another account',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async registerDevice(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: RegisterDeviceDto,
  ) {
    const data = await this.users.registerDevice(principal.userId, body);
    return { data };
  }

  @Post('me/deletion')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Close the authenticated account; identity is pseudonymised, financial history is kept',
  })
  @ApiOkResponse({
    description:
      'Closure record with the retained summary; replaying it returns the same record',
    schema: closureResponse,
  })
  @ApiBadRequestResponse({
    description: 'reason is empty or longer than 500 characters',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async closeAccount(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: CloseAccountDto,
  ) {
    const data = await this.users.closeAccount(principal.userId, {
      reason: body?.reason,
    });
    return { data };
  }

  @Get('me/export')
  @ApiOperation({
    summary: 'Export the caller own data as JSON (no secrets)',
  })
  @ApiOkResponse({
    description:
      'Profile, order summary, wallet balance, ledger transactions, reviews and notification counts',
    schema: exportResponse,
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async exportAccount(@CurrentUser() principal: AuthenticatedPrincipal) {
    const data = await this.users.exportAccount(principal.userId);
    return { data };
  }

  @Delete('me/devices/:deviceId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke one of the caller own devices (soft delete)',
  })
  @ApiNoContentResponse({ description: 'Device revoked' })
  @ApiNotFoundResponse({
    description: 'Device does not exist, is already revoked or is not theirs',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async revokeDevice(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
  ): Promise<void> {
    await this.users.revokeDevice(principal.userId, deviceId);
  }
}
