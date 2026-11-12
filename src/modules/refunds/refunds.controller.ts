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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { InitiateRefundDto, ListRefundsQueryDto } from './dto/refund.dto';
import { RefundsService } from './refunds.service';

const refundSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    campusId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    orderPaymentId: { type: 'string', format: 'uuid', nullable: true },
    caseId: { type: 'string', format: 'uuid', nullable: true },
    buyerId: { type: 'string', format: 'uuid' },
    amountMinor: { type: 'string', pattern: '^[1-9][0-9]*$' },
    currency: { type: 'string', enum: ['IDR'] },
    status: {
      type: 'string',
      enum: [
        'requested',
        'under_review',
        'submitted',
        'processing',
        'succeeded',
        'failed',
        'needs_assistance',
      ],
    },
    provider: { type: 'string', enum: ['sandbox'] },
    providerReference: { type: 'string', nullable: true },
    reason: { type: 'string' },
    requestedAt: { type: 'string', format: 'date-time' },
    submittedAt: { type: 'string', format: 'date-time', nullable: true },
    succeededAt: { type: 'string', format: 'date-time', nullable: true },
    failedAt: { type: 'string', format: 'date-time', nullable: true },
    lastError: { type: 'string', nullable: true },
    attemptCount: { type: 'integer' },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'orderId', 'buyerId', 'amountMinor', 'currency', 'status'],
};

/**
 * Refund endpoints. Money never moves through these routes: a refund is
 * created as 'requested' by a campus-manager decision and credited to the
 * buyer wallet only by the processor after confirmed sandbox-provider
 * success (exactly once, via the double-entry ledger).
 */
@ApiTags('Refunds')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get('orders/:orderId/refund')
  @ApiOperation({
    summary: 'Read the refund of one of the authenticated buyer orders',
  })
  @ApiOkResponse({
    description: 'Latest refund for the order, or data:null when none exists',
    schema: {
      type: 'object',
      properties: { data: { oneOf: [refundSchema, { type: 'null' }] } },
      required: ['data'],
    },
  })
  @ApiNotFoundResponse({
    description: 'Order does not exist or is not owned by the caller',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async forBuyerOrder(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    const data = await this.refunds.getRefundForOrder(
      principal.userId,
      orderId,
    );
    return { data };
  }

  @Post('campuses/:campusId/refunds')
  @ApiOperation({
    summary:
      'Campus-manager cancellation decision: cancel the order and create a pending full refund (campus.refunds.initiate)',
  })
  @ApiCreatedResponse({
    description:
      'Order cancelled, reservation released, refund pending; no wallet credit yet',
    schema: {
      type: 'object',
      properties: { data: refundSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid ids or missing reason' })
  @ApiForbiddenResponse({
    description: 'Missing campus.refunds.initiate permission',
  })
  @ApiNotFoundResponse({ description: 'Order/case not found for this campus' })
  @ApiConflictResponse({
    description:
      'ORDER_CANCEL_CONFLICT (completed/cancelled/declined), REFUND_ALREADY_EXISTS (one live refund per order), or ORDER_PAYMENT_NOT_REFUNDABLE',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async initiate(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Body() body: InitiateRefundDto,
  ) {
    const data = await this.refunds.initiateCancellationRefund({
      actorUserId: principal.userId,
      campusId,
      orderId: body.orderId,
      reason: body.reason,
      caseId: body.caseId ?? null,
    });
    return { data };
  }

  @Get('campuses/:campusId/refunds')
  @ApiOperation({
    summary: 'List refunds of a campus (campus.transactions.read)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [
      'requested',
      'under_review',
      'submitted',
      'processing',
      'succeeded',
      'failed',
      'needs_assistance',
    ],
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({
    description: 'Cursor-paged refunds scoped to the campus',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: refundSchema },
        meta: {
          type: 'object',
          properties: { next_cursor: { type: 'string', nullable: true } },
          required: ['next_cursor'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiForbiddenResponse({
    description: 'Missing campus.transactions.read permission',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listForCampus(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query() query: ListRefundsQueryDto,
  ) {
    const page = await this.refunds.listCampusRefunds(
      principal.userId,
      campusId,
      query,
    );
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }
}
