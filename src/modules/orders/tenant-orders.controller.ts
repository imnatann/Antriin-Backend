import {
  Body,
  Controller,
  Get,
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
  CreateScheduleProposalDto,
  DeclineOrderDto,
  TenantOrderListQueryDto,
  TenantOrderTransitionDto,
} from './dto/orders.dto';
import { OrdersService } from './orders.service';
import {
  orderEventListSchema,
  orderPageSchema,
  orderViewSchema,
  scheduleProposalSchema,
} from './orders.schemas';

/**
 * Tenant order operations. Permissions are enforced in the service with
 * AccessService.requireTenant inside the same transaction as the mutation
 * (docs/reviews/wave1-decisions.md D10):
 * - confirm / decline -> tenant.orders.accept
 * - prepare           -> tenant.orders.prepare
 * - ready             -> tenant.orders.prepare OR tenant.orders.accept
 * - read/list         -> tenant.orders.read
 * - schedule proposal -> tenant.orders.accept
 */
@ApiTags('Tenant orders')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('tenants/:tenantId/orders')
export class TenantOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({ summary: 'List the tenant order queue' })
  @ApiOkResponse({
    description: 'Cursor-paged orders scoped to one tenant',
    schema: orderPageSchema,
  })
  @ApiBadRequestResponse({ description: 'Invalid cursor, status, or limit' })
  @ApiForbiddenResponse({ description: 'tenant.orders.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query() query: TenantOrderListQueryDto,
  ) {
    return this.orders.listTenantOrders(principal.userId, tenantId, query);
  }

  @Get(':orderId')
  @ApiOperation({
    summary: 'Read one tenant order with snapshots, payment and proposal',
  })
  @ApiOkResponse({
    description: 'Order detail scoped to the tenant',
    schema: {
      type: 'object',
      properties: { data: orderViewSchema },
      required: ['data'],
    },
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.read is required' })
  @ApiNotFoundResponse({ description: 'Order not found for this tenant' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  detail(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.orders.getTenantOrder(principal.userId, tenantId, orderId);
  }

  @Get(':orderId/events')
  @ApiOperation({
    summary: 'Read one tenant order lifecycle timeline (tenant.orders.read)',
  })
  @ApiOkResponse({
    description:
      'Immutable order events ordered by (occurredAt, version) ascending; 404 when the order belongs to another tenant',
    schema: orderEventListSchema,
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.read is required' })
  @ApiNotFoundResponse({ description: 'Order not found for this tenant' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  events(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.orders.listTenantOrderEvents(
      principal.userId,
      tenantId,
      orderId,
    );
  }

  @Post(':orderId/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirm a paid order (paid_awaiting_tenant -> confirmed)',
  })
  @ApiOkResponse({ description: 'Order confirmed (idempotent replay allowed)' })
  @ApiConflictResponse({
    description: 'Illegal transition for the order state',
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.accept is required' })
  @ApiNotFoundResponse({ description: 'Order not found for this tenant' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  confirm(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() body: TenantOrderTransitionDto,
  ) {
    return this.orders.tenantTransition(
      principal.userId,
      tenantId,
      orderId,
      'confirm',
      body,
    );
  }

  @Post(':orderId/decline')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Decline a paid order: releases the slot and records the refund obligation (no automatic wallet credit)',
  })
  @ApiOkResponse({ description: 'Order declined (idempotent replay allowed)' })
  @ApiBadRequestResponse({ description: 'reason is required' })
  @ApiConflictResponse({
    description: 'Illegal transition for the order state',
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.accept is required' })
  @ApiNotFoundResponse({ description: 'Order not found for this tenant' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  decline(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() body: DeclineOrderDto,
  ) {
    return this.orders.tenantTransition(
      principal.userId,
      tenantId,
      orderId,
      'decline',
      body,
    );
  }

  @Post(':orderId/prepare')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Start preparation (confirmed -> preparing); gated by ORDER_PREPARATION_LEAD_SECONDS',
  })
  @ApiOkResponse({
    description: 'Preparation started (idempotent replay allowed)',
  })
  @ApiConflictResponse({
    description:
      'Illegal transition, or preparation attempted earlier than the configured lead time',
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.prepare is required' })
  @ApiNotFoundResponse({ description: 'Order not found for this tenant' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  prepare(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() body: TenantOrderTransitionDto,
  ) {
    return this.orders.tenantTransition(
      principal.userId,
      tenantId,
      orderId,
      'prepare',
      body,
    );
  }

  @Post(':orderId/ready')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Mark ready for pickup (preparing -> ready_for_pickup); accepts tenant.orders.prepare or tenant.orders.accept',
  })
  @ApiOkResponse({ description: 'Order ready (idempotent replay allowed)' })
  @ApiConflictResponse({
    description: 'Illegal transition for the order state',
  })
  @ApiForbiddenResponse({
    description: 'tenant.orders.prepare or tenant.orders.accept is required',
  })
  @ApiNotFoundResponse({ description: 'Order not found for this tenant' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  ready(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() body: TenantOrderTransitionDto,
  ) {
    return this.orders.tenantTransition(
      principal.userId,
      tenantId,
      orderId,
      'ready',
      body,
    );
  }

  @Post(':orderId/schedule-proposals')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Propose a new pickup slot (pending_buyer; expires without automatic acceptance)',
  })
  @ApiCreatedResponse({
    description: 'Proposal created and sent to the buyer',
    schema: {
      type: 'object',
      properties: { data: scheduleProposalSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid slot id, missing reason, or same as current slot',
  })
  @ApiConflictResponse({
    description:
      'A pending proposal already exists, the slot is not bookable, or the order is not in a pre-production state',
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.accept is required' })
  @ApiNotFoundResponse({ description: 'Order not found for this tenant' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  proposeSchedule(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() body: CreateScheduleProposalDto,
  ) {
    return this.orders.createScheduleProposal(
      principal.userId,
      tenantId,
      orderId,
      body,
    );
  }
}
