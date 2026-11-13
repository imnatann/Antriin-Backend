import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { BankAccountsService } from './bank-accounts.service';
import {
  CancelPayoutDto,
  CreateBankAccountDto,
  ListBankAccountsQueryDto,
  ListPayoutsQueryDto,
  RequestPayoutDto,
} from './dto/payout.dto';
import { PayoutsService } from './payouts.service';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

const bankAccountSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    bankCode: { type: 'string' },
    accountNumberMasked: { type: 'string', example: '****1234' },
    accountHolderName: { type: 'string' },
    verificationStatus: {
      type: 'string',
      enum: ['pending', 'verified', 'rejected'],
    },
    verifiedAt: { type: 'string', format: 'date-time', nullable: true },
    status: { type: 'string', enum: ['active', 'disabled'] },
    isDefault: { type: 'boolean' },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'bankCode', 'accountNumberMasked', 'verificationStatus'],
};

const payoutSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    bankAccountId: { type: 'string', format: 'uuid' },
    bankCode: { type: 'string' },
    accountNumberMasked: { type: 'string' },
    accountHolderName: { type: 'string' },
    amountMinor: { type: 'string', pattern: '^[1-9][0-9]*$' },
    currency: { type: 'string', enum: ['IDR'] },
    status: {
      type: 'string',
      enum: ['requested', 'processing', 'succeeded', 'failed', 'cancelled'],
    },
    provider: { type: 'string', enum: ['sandbox'] },
    providerReference: { type: 'string', nullable: true },
    failureCode: { type: 'string', nullable: true },
    lastError: { type: 'string', nullable: true },
    requestedByUserId: { type: 'string', format: 'uuid' },
    requestedAt: { type: 'string', format: 'date-time' },
    processingAt: { type: 'string', format: 'date-time', nullable: true },
    succeededAt: { type: 'string', format: 'date-time', nullable: true },
    failedAt: { type: 'string', format: 'date-time', nullable: true },
    cancelledAt: { type: 'string', format: 'date-time', nullable: true },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'amountMinor', 'currency', 'status'],
};

/**
 * Bank accounts and payouts.
 *
 * Every route is owner-only: AccessService rejects all non-owner roles for
 * tenant.bank_account.manage / tenant.payout.request / tenant.finance.read, so
 * kitchen and pickup staff receive 403 regardless of granted permissions
 * (REQUIREMENTS section 3.8.4). Responses always carry the MASKED account
 * number; the ciphertext, the dedupe hash and the full number never leave the
 * server. The verification route intentionally answers 503 until the
 * verification mechanism is decided (D18 Q4).
 */
@ApiTags('Tenant payouts')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('tenants/:tenantId')
export class PayoutsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly bankAccounts: BankAccountsService,
  ) {}

  // -------------------------------------------------------------------------
  // Bank accounts
  // -------------------------------------------------------------------------

  @Get('bank-accounts')
  @ApiOperation({
    summary: 'List tenant payout accounts (masked, owner only)',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'disabled'] })
  @ApiOkResponse({
    description: 'Masked bank accounts of the tenant',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: bankAccountSchema },
      },
      required: ['data'],
    },
  })
  @ApiForbiddenResponse({
    description: 'tenant.bank_account.manage is owner-only',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listBankAccounts(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: ListBankAccountsQueryDto,
  ) {
    const data = await this.bankAccounts.listBankAccounts(
      principal.userId,
      tenantId,
      query,
    );
    return { data };
  }

  @Post('bank-accounts')
  @ApiOperation({
    summary: 'Register a payout account (status pending, verification pending)',
  })
  @ApiCreatedResponse({
    description: 'Masked bank account created',
    schema: {
      type: 'object',
      properties: { data: bankAccountSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid bank code, account number or holder name',
  })
  @ApiConflictResponse({
    description: 'BANK_ACCOUNT_ALREADY_EXISTS (same active account)',
  })
  @ApiForbiddenResponse({
    description: 'tenant.bank_account.manage is owner-only',
  })
  @ApiServiceUnavailableResponse({
    description:
      'BANK_ACCOUNT_ENCRYPTION_DISABLED (AUTH_ENCRYPTION_KEY missing)',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async createBankAccount(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: CreateBankAccountDto,
  ) {
    const data = await this.bankAccounts.createBankAccount(
      principal.userId,
      tenantId,
      body,
    );
    return { data };
  }

  @Post('bank-accounts/:accountId/replace')
  @ApiOperation({
    summary: 'Replace a payout account (new pending row, old row disabled)',
  })
  @ApiCreatedResponse({
    description: 'New masked bank account; the previous one is disabled',
    schema: {
      type: 'object',
      properties: { data: bankAccountSchema },
      required: ['data'],
    },
  })
  @ApiNotFoundResponse({ description: 'Account not found for this tenant' })
  @ApiConflictResponse({ description: 'BANK_ACCOUNT_NOT_ACTIVE' })
  @ApiForbiddenResponse({
    description: 'tenant.bank_account.manage is owner-only',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async replaceBankAccount(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() body: CreateBankAccountDto,
  ) {
    const data = await this.bankAccounts.replaceBankAccount(
      principal.userId,
      tenantId,
      accountId,
      body,
    );
    return { data };
  }

  @Delete('bank-accounts/:accountId')
  @ApiOperation({ summary: 'Disable a payout account (never deleted)' })
  @ApiOkResponse({
    description: 'Account disabled',
    schema: {
      type: 'object',
      properties: { data: bankAccountSchema },
      required: ['data'],
    },
  })
  @ApiNotFoundResponse({ description: 'Account not found for this tenant' })
  @ApiForbiddenResponse({
    description: 'tenant.bank_account.manage is owner-only',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async disableBankAccount(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    const data = await this.bankAccounts.disableBankAccount(
      principal.userId,
      tenantId,
      accountId,
    );
    return { data };
  }

  @Post('bank-accounts/:accountId/verify')
  @ApiOperation({
    summary:
      'Request account verification - DISABLED (503 BANK_ACCOUNT_VERIFICATION_DISABLED)',
  })
  @ApiServiceUnavailableResponse({
    description:
      'BANK_ACCOUNT_VERIFICATION_DISABLED: the verification mechanism is not decided (D18 Q4)',
  })
  @ApiForbiddenResponse({
    description: 'tenant.bank_account.manage is owner-only',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async verifyBankAccount(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    await this.bankAccounts.requestVerification(
      principal.userId,
      tenantId,
      accountId,
    );
  }

  // -------------------------------------------------------------------------
  // Payouts
  // -------------------------------------------------------------------------

  @Post('payouts')
  @ApiOperation({
    summary:
      'Request a payout (owner only; atomic hold from the tenant payable balance)',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8-200 characters: A-Z a-z 0-9 . _ :',
  })
  @ApiCreatedResponse({
    description: 'Payout requested; funds held until the provider resolves',
    schema: {
      type: 'object',
      properties: { data: payoutSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({
    description: 'PAYOUT_AMOUNT_INVALID or PAYOUT_IDEMPOTENCY_KEY_INVALID',
  })
  @ApiConflictResponse({
    description:
      'PAYOUT_AMOUNT_EXCEEDS_AVAILABLE, PAYOUT_ACTIVE_EXISTS, PAYOUT_BANK_ACCOUNT_UNVERIFIED, PAYOUT_IDEMPOTENCY_REUSED',
  })
  @ApiNotFoundResponse({
    description: 'Bank account not found for this tenant',
  })
  @ApiServiceUnavailableResponse({
    description: 'PAYOUT_PROVIDER_DISABLED (production is always disabled)',
  })
  @ApiForbiddenResponse({ description: 'tenant.payout.request is owner-only' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async requestPayout(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: RequestPayoutDto,
  ) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      throw new BadRequestException({
        code: 'PAYOUT_IDEMPOTENCY_KEY_INVALID',
        message: 'The Idempotency-Key header is required for a payout request',
      });
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException({
        code: 'PAYOUT_IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key must be 8-200 characters: A-Z a-z 0-9 . _ :',
      });
    }
    const result = await this.payouts.requestPayout(
      principal.userId,
      tenantId,
      {
        bankAccountId: body.bankAccountId,
        amountMinor: body.amountMinor,
        idempotencyKey,
      },
    );
    return { data: result.payout };
  }

  @Get('payouts')
  @ApiOperation({ summary: 'List tenant payouts (owner only)' })
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
    description: 'Cursor-paged payouts scoped to the tenant',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: payoutSchema },
        meta: {
          type: 'object',
          properties: { next_cursor: { type: 'string', nullable: true } },
          required: ['next_cursor'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiForbiddenResponse({ description: 'tenant.finance.read is owner-only' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listPayouts(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: ListPayoutsQueryDto,
  ) {
    const page = await this.payouts.listTenantPayouts(
      principal.userId,
      tenantId,
      query,
    );
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }

  @Get('payouts/:payoutId')
  @ApiOperation({
    summary: 'Read one payout with its timeline and settlement allocations',
  })
  @ApiOkResponse({
    description: 'Payout detail',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            payout: payoutSchema,
            events: { type: 'array', items: { type: 'object' } },
            allocations: { type: 'array', items: { type: 'object' } },
          },
          required: ['payout', 'events', 'allocations'],
        },
      },
      required: ['data'],
    },
  })
  @ApiNotFoundResponse({ description: 'Payout not found for this tenant' })
  @ApiForbiddenResponse({ description: 'tenant.finance.read is owner-only' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async getPayout(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('payoutId', ParseUUIDPipe) payoutId: string,
  ) {
    const data = await this.payouts.getTenantPayout(
      principal.userId,
      tenantId,
      payoutId,
    );
    return { data };
  }

  @Post('payouts/:payoutId/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel a requested payout (hold released exactly once)',
  })
  @ApiOkResponse({
    description: 'Payout cancelled and the hold returned to payable',
    schema: {
      type: 'object',
      properties: { data: payoutSchema },
      required: ['data'],
    },
  })
  @ApiConflictResponse({
    description: 'PAYOUT_STATE_CONFLICT (only requested may be cancelled)',
  })
  @ApiNotFoundResponse({ description: 'Payout not found for this tenant' })
  @ApiForbiddenResponse({ description: 'tenant.payout.request is owner-only' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async cancelPayout(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('payoutId', ParseUUIDPipe) payoutId: string,
    @Body() body: CancelPayoutDto,
  ) {
    const data = await this.payouts.cancelPayout(
      principal.userId,
      tenantId,
      payoutId,
      body?.reason,
    );
    return { data };
  }
}
