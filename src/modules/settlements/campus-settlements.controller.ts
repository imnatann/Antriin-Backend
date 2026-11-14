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
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { CampusSettlementsService } from './campus-settlements.service';
import { CampusSettlementQueryDto } from './dto/campus-settlement.dto';

const campusSettlementSchema = {
  type: 'object',
  properties: {
    settlementId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    tenantName: { type: 'string' },
    orderId: { type: 'string', format: 'uuid' },
    amountMinor: { type: 'string', pattern: '^[1-9][0-9]*$' },
    paidOutMinor: { type: 'string', pattern: '^[0-9]+$' },
    currency: { type: 'string', enum: ['IDR'] },
    status: {
      type: 'string',
      enum: ['pending', 'available', 'paid_out', 'voided', 'reversed'],
    },
    releasedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'settlementId',
    'tenantId',
    'tenantName',
    'orderId',
    'amountMinor',
    'paidOutMinor',
    'currency',
    'status',
    'createdAt',
  ],
};

/**
 * Campus settlement monitoring (REQUIREMENTS §3.8.7, design §7).
 *
 * Read-only: a campus manager with campus.payouts.read can watch the
 * settlements of the tenants in their campus. There is deliberately NO campus
 * route that releases, voids or reverses a settlement, and no balance is
 * recomputed here - the campus scope comes from tenants.campus_id server-side,
 * never from the query string or the body.
 */
@ApiTags('Campus settlements')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('campuses/:campusId')
export class CampusSettlementsController {
  constructor(private readonly campusSettlements: CampusSettlementsService) {}

  @Get('settlements')
  @ApiOperation({
    summary:
      'Monitor tenant settlements of one campus (campus.payouts.read, read-only)',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'available', 'paid_out', 'voided', 'reversed'],
  })
  @ApiQuery({ name: 'tenantId', required: false, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({
    description:
      'Cursor-paged settlements of the campus tenants inside the window',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: campusSettlementSchema },
        meta: {
          type: 'object',
          properties: { next_cursor: { type: 'string', nullable: true } },
          required: ['next_cursor'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid/oversized window, status, tenant id, cursor or limit',
  })
  @ApiForbiddenResponse({
    description: 'campus.payouts.read is required for this campus',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query() query: CampusSettlementQueryDto,
  ) {
    const page = await this.campusSettlements.listCampusSettlements(
      principal.userId,
      campusId,
      query,
    );
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }
}
