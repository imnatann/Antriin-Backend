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
import { FinanceTransactionQueryDto } from './dto/settlement.dto';
import { SettlementsService } from './settlements.service';

const financeSummarySchema = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    currency: { type: 'string', enum: ['IDR'] },
    paidInMinor: { type: 'string', pattern: '^[0-9]+$' },
    refundedMinor: { type: 'string', pattern: '^[0-9]+$' },
    unfinishedMinor: { type: 'string', pattern: '^[0-9]+$' },
    availableMinor: { type: 'string', pattern: '^-?[0-9]+$' },
    heldMinor: { type: 'string', pattern: '^-?[0-9]+$' },
    paidOutMinor: { type: 'string', pattern: '^[0-9]+$' },
    releasedMinor: { type: 'string', pattern: '^[0-9]+$' },
  },
  required: [
    'tenantId',
    'currency',
    'paidInMinor',
    'refundedMinor',
    'unfinishedMinor',
    'availableMinor',
    'heldMinor',
    'paidOutMinor',
    'releasedMinor',
  ],
};

const financeTransactionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    transactionId: { type: 'string', format: 'uuid' },
    type: {
      type: 'string',
      enum: [
        'settlement_release',
        'payout_hold',
        'payout_settle',
        'payout_release',
        'other',
      ],
    },
    direction: { type: 'string', enum: ['debit', 'credit'] },
    amountMinor: { type: 'string', pattern: '^[1-9][0-9]*$' },
    currency: { type: 'string', enum: ['IDR'] },
    referenceId: { type: 'string', nullable: true },
    occurredAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'transactionId', 'type', 'direction', 'amountMinor'],
};

/**
 * Tenant finance reads (REQUIREMENTS section 3.8.1). Balances are ledger
 * projections of the per-tenant payable/hold system accounts, never a stored
 * column, and only the VERIFIED OWNER reaches them: AccessService rejects
 * every non-owner role for tenant.finance.read, so kitchen/pickup staff get
 * 403 even if a permission was granted by hand.
 */
@ApiTags('Tenant finance')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('tenants/:tenantId/finance')
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Tenant finance summary (tenant.finance.read, owner only)',
  })
  @ApiOkResponse({
    description:
      'Derived summary: paid-in, refunded, unfinished, available, held, paid out',
    schema: {
      type: 'object',
      properties: { data: financeSummarySchema },
      required: ['data'],
    },
  })
  @ApiForbiddenResponse({
    description:
      'tenant.finance.read is required and only the verified owner has it',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async summary(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ) {
    const data = await this.settlements.getFinanceSummary(
      principal.userId,
      tenantId,
    );
    return { data };
  }

  @Get('transactions')
  @ApiOperation({
    summary: 'Ledger feed of the tenant payable/hold accounts',
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
    description: 'Cursor-paged ledger entries scoped to the tenant accounts',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: financeTransactionSchema },
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
  @ApiForbiddenResponse({ description: 'tenant.finance.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async transactions(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: FinanceTransactionQueryDto,
  ) {
    const page = await this.settlements.listFinanceTransactions(
      principal.userId,
      tenantId,
      query,
    );
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }
}
