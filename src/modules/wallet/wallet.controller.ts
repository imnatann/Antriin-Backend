import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import {
  WalletBalanceQueryDto,
  WalletTransactionsQueryDto,
} from './wallet-query.dto';
import { WalletService } from './wallet.service';

@ApiTags('Wallet')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('me/wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  @ApiOperation({ summary: 'Read the authenticated user wallet balances' })
  @ApiQuery({
    name: 'currency',
    required: false,
    type: String,
    enum: ['IDR'],
  })
  @ApiOkResponse({
    description: 'Wallet balances scoped to the current user',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              currency: { type: 'string', enum: ['IDR'] },
              balanceMinor: { type: 'string', pattern: '^[0-9]+$' },
            },
            required: ['currency', 'balanceMinor'],
          },
        },
      },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid wallet query' })
  @ApiNotFoundResponse({ description: 'Authenticated user does not exist' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async getBalance(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: WalletBalanceQueryDto,
  ) {
    const data = await this.wallet.getBalance(
      principal.userId,
      query.currency ?? 'IDR',
    );
    return {
      data: data.map(({ currency, balanceMinor }) => ({
        currency,
        balanceMinor,
      })),
    };
  }

  @Get('transactions')
  @ApiOperation({ summary: 'List the authenticated user wallet transactions' })
  @ApiQuery({
    name: 'currency',
    required: false,
    type: String,
    enum: ['IDR'],
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
    description: 'Cursor-paged transactions for the current user',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              currency: { type: 'string', enum: ['IDR'] },
              direction: { type: 'string', enum: ['debit', 'credit'] },
              amountMinor: { type: 'string', pattern: '^[1-9][0-9]*$' },
              createdAt: { type: 'string', format: 'date-time' },
            },
            required: [
              'id',
              'currency',
              'direction',
              'amountMinor',
              'createdAt',
            ],
          },
        },
        meta: {
          type: 'object',
          properties: { next_cursor: { type: 'string', nullable: true } },
          required: ['next_cursor'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid cursor, currency, or limit' })
  @ApiNotFoundResponse({ description: 'Authenticated user does not exist' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listTransactions(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: WalletTransactionsQueryDto,
  ) {
    const page = await this.wallet.listTransactions(principal.userId, query);
    return {
      data: page.items,
      meta: { next_cursor: page.nextCursor },
    };
  }
}
