import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { CreateTopupIntentDto } from './dto/create-topup.dto';
import { ListTopupsQueryDto } from './dto/list-topups.dto';
import { PaymentsService } from './payments.service';

const intentSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    provider: { type: 'string', enum: ['sandbox'] },
    providerReference: { type: 'string' },
    amountMinor: { type: 'string', pattern: '^[0-9]+$' },
    currency: { type: 'string', enum: ['IDR'] },
    status: {
      type: 'string',
      enum: ['pending', 'succeeded', 'failed', 'expired', 'needs_assistance'],
    },
    statusVersion: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
    succeededAt: { type: 'string', format: 'date-time', nullable: true },
    qrisPayload: { type: 'string', nullable: true },
  },
  required: [
    'id',
    'provider',
    'providerReference',
    'amountMinor',
    'currency',
    'status',
    'statusVersion',
    'createdAt',
    'updatedAt',
  ],
};

/**
 * Buyer-only top-up endpoints. There is intentionally NO route that lets a
 * client credit a balance directly: money only moves through a validated
 * provider webhook into the double-entry ledger.
 */
@ApiTags('Payments')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('me/wallet/topups')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create or idempotently replay a sandbox QRIS top-up intent',
  })
  @ApiCreatedResponse({
    description:
      'Intent and its provider-request outbox row were stored atomically.',
    schema: {
      type: 'object',
      properties: { data: intentSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid amount or idempotency key' })
  @ApiConflictResponse({
    description: 'Idempotency key reused with a different amount',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: CreateTopupIntentDto,
  ) {
    const result = await this.payments.createTopupIntent(
      principal.userId,
      body,
    );
    return { data: { ...result.view, replayed: result.replayed } };
  }

  @Get()
  @ApiOperation({ summary: 'List top-up intents owned by the current buyer' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({
    description: 'Cursor-paged top-up intents scoped to the current user',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: intentSchema },
        meta: {
          type: 'object',
          properties: { next_cursor: { type: 'string', nullable: true } },
          required: ['next_cursor'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid cursor or limit' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: ListTopupsQueryDto,
  ) {
    const page = await this.payments.listTopupsForUser(principal.userId, query);
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one top-up intent owned by the current buyer',
  })
  @ApiOkResponse({
    description: 'The intent owned by the current user',
    schema: {
      type: 'object',
      properties: { data: intentSchema },
      required: ['data'],
    },
  })
  @ApiNotFoundResponse({
    description: 'Intent does not exist or is not owned by the caller',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async detail(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.payments.getTopupForUser(principal.userId, id);
    return { data };
  }
}
