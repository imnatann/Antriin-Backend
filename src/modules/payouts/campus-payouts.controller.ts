import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { ListPayoutsQueryDto } from './dto/payout.dto';
import { PayoutsService } from './payouts.service';

const campusPayoutSchema = {
  type: 'object',
  properties: {
    payoutId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    tenantName: { type: 'string' },
    status: {
      type: 'string',
      enum: ['requested', 'processing', 'succeeded', 'failed', 'cancelled'],
    },
    amountMinor: { type: 'string', pattern: '^[1-9][0-9]*$' },
    currency: { type: 'string', enum: ['IDR'] },
    bankCode: { type: 'string' },
    accountNumberMasked: { type: 'string', example: '****1234' },
    requestedAt: { type: 'string', format: 'date-time' },
    processingAt: { type: 'string', format: 'date-time', nullable: true },
    succeededAt: { type: 'string', format: 'date-time', nullable: true },
    failedAt: { type: 'string', format: 'date-time', nullable: true },
    cancelledAt: { type: 'string', format: 'date-time', nullable: true },
  },
  required: [
    'payoutId',
    'tenantId',
    'tenantName',
    'status',
    'amountMinor',
    'currency',
    'bankCode',
    'accountNumberMasked',
    'requestedAt',
  ],
};

/**
 * Campus payout monitoring (REQUIREMENTS 3.8.7, design section 7).
 *
 * Read-only: a campus manager with campus.payouts.read can watch the payouts of
 * the tenants in their campus, but there is deliberately NO campus route that
 * requests, approves, cancels or retargets a payout. The response always carries
 * the masked account number only, and the campus scope is derived from
 * tenants.campus_id server-side (never from the body).
 */
@ApiTags('Campus payouts')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('campuses/:campusId')
export class CampusPayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get('payouts')
  @ApiOperation({
    summary:
      'Monitor tenant payouts of one campus (campus.payouts.read, read-only, masked)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['requested', 'processing', 'succeeded', 'failed', 'cancelled'],
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
    description: 'Cursor-paged payouts of the campus tenants (masked)',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: campusPayoutSchema },
        meta: {
          type: 'object',
          properties: { next_cursor: { type: 'string', nullable: true } },
          required: ['next_cursor'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid status, cursor or limit' })
  @ApiForbiddenResponse({
    description: 'campus.payouts.read is required for this campus',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query() query: ListPayoutsQueryDto,
  ) {
    const page = await this.payouts.listCampusPayouts(
      principal.userId,
      campusId,
      query,
    );
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }
}
