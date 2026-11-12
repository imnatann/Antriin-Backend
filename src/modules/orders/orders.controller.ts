import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
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
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import {
  BuyerOrderListQueryDto,
  CheckoutDto,
  DecideScheduleProposalDto,
} from './dto/orders.dto';
import { IDEMPOTENCY_KEY_PATTERN } from './orders.constants';
import { OrdersService } from './orders.service';
import {
  orderPageSchema,
  orderViewSchema,
  scheduleProposalSchema,
} from './orders.schemas';

/**
 * Buyer order endpoints. Every query is scoped to the authenticated buyer:
 * another buyer's order is a 404, never a 403 (no existence leak).
 */
@ApiTags('Orders')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Checkout: server-priced, capacity-reserved, wallet-paid order (one transaction)',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Client-generated key (8-200 chars: A-Z a-z 0-9 . _ :). Replaying the same key and payload returns the original order without new effects; the same key with different input is a 409, and a different key for an identical payload is also a 409.',
  })
  @ApiCreatedResponse({
    description: 'Order created (or idempotent replay with meta.replayed=true)',
    schema: {
      type: 'object',
      properties: {
        data: orderViewSchema,
        meta: {
          type: 'object',
          properties: { replayed: { type: 'boolean' } },
          required: ['replayed'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid cart, missing/duplicate Idempotency-Key, or a quote that is no longer orderable',
  })
  @ApiConflictResponse({
    description:
      'Idempotency conflict, slot full/changed, tenant closed, insufficient wallet balance, or unavailable menu item',
  })
  @ApiNotFoundResponse({ description: 'Buyer account not found' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  checkout(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CheckoutDto,
  ) {
    // Transport-level requirement: the header must be present. The service
    // re-validates its shape (length/charset) because it is also reachable
    // outside HTTP (workers, tests).
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'The Idempotency-Key header is required for checkout',
      });
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key must be 8-200 characters: A-Z a-z 0-9 . _ :',
      });
    }
    return this.orders.checkout(principal.userId, idempotencyKey, body);
  }

  @Get()
  @ApiOperation({ summary: 'List the authenticated buyer orders' })
  @ApiOkResponse({
    description: 'Cursor-paged orders scoped to the current buyer',
    schema: orderPageSchema,
  })
  @ApiBadRequestResponse({ description: 'Invalid cursor, status, or limit' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: BuyerOrderListQueryDto,
  ) {
    return this.orders.listBuyerOrders(principal.userId, query);
  }

  @Get(':orderId')
  @ApiOperation({
    summary:
      'Read one buyer order with immutable item/option snapshots and payment',
  })
  @ApiOkResponse({
    description: 'Order detail (404 for orders of another buyer)',
    schema: {
      type: 'object',
      properties: { data: orderViewSchema },
      required: ['data'],
    },
  })
  @ApiNotFoundResponse({ description: 'Order not found for this buyer' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  detail(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.orders.getBuyerOrder(principal.userId, orderId);
  }

  @Post(':orderId/schedule-proposals/:proposalId/decision')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Buyer decides a pending schedule proposal (accept moves the slot; reject/expiry never does)',
  })
  @ApiOkResponse({
    description:
      'Decision recorded (or idempotent replay of the same decision)',
    schema: {
      type: 'object',
      properties: {
        data: scheduleProposalSchema,
        meta: {
          type: 'object',
          properties: { replayed: { type: 'boolean' } },
          required: ['replayed'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid decision value' })
  @ApiConflictResponse({
    description:
      'Proposal expired or already decided differently, order state conflict, or proposed slot no longer bookable',
  })
  @ApiNotFoundResponse({
    description: 'Order or proposal not found for this buyer',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  decideProposal(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Param('proposalId', new ParseUUIDPipe()) proposalId: string,
    @Body() body: DecideScheduleProposalDto,
  ) {
    return this.orders.decideScheduleProposal(
      principal.userId,
      orderId,
      proposalId,
      body.decision,
    );
  }
}
