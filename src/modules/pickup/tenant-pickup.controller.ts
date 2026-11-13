import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { PickupCodeDto, RevokePickupCredentialDto } from './dto/pickup.dto';
import { PickupRateLimitInterceptor } from './pickup-rate-limit.interceptor';
import {
  issuedPickupCredentialSchema,
  pickupHandoverSchema,
  pickupVerificationSchema,
  revokedPickupCredentialSchema,
} from './pickup.schemas';
import { PickupService } from './pickup.service';

/**
 * Staff pickup operations, all gated by tenant.orders.handover (D16.2) which
 * the service enforces with AccessService.requireTenant inside the mutation
 * transaction. Code-presentation endpoints (verification + handover) carry an
 * extra rate limit against brute force: only FAILED code attempts count, in a
 * per (IP, tenant, actor) Redis bucket (R3-01), fail-closed when Redis is down.
 */
@ApiTags('Pickup')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('tenants/:tenantId')
export class TenantPickupController {
  constructor(private readonly pickup: PickupService) {}

  @Post('orders/:orderId/pickup-credential')
  @HttpCode(201)
  // R3-08: the response carries the plaintext code - never cache it.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Issue (or rotate) the pickup code of a ready_for_pickup order; the plaintext code is returned here and re-displayable only to the owning buyer',
  })
  @ApiCreatedResponse({
    description:
      'Credential issued; any previous active credential was revoked in the same transaction',
    schema: {
      type: 'object',
      properties: { data: issuedPickupCredentialSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({ description: 'Malformed tenant/order id' })
  @ApiConflictResponse({
    description:
      'PICKUP_NOT_READY: the order is not ready_for_pickup; PICKUP_CREDENTIAL_CONSUMED: the order credential was already used (R3-03)',
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.handover is required' })
  @ApiNotFoundResponse({ description: 'Order not found for this tenant' })
  @ApiServiceUnavailableResponse({
    description:
      'pickup_not_configured (AUTH_SECRET/AUTH_ENCRYPTION_KEY missing) or pickup_code_generation_failed',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  issue(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.pickup.issueCredential(principal.userId, tenantId, orderId);
  }

  @Post('orders/:orderId/pickup-credential/revocation')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Revoke the active pickup credential with a reason (audit + order event); a consumed credential cannot be revoked',
  })
  @ApiOkResponse({
    description: 'Credential revoked',
    schema: {
      type: 'object',
      properties: { data: revokedPickupCredentialSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({
    description: 'reason is required (1..500 chars), or malformed ids',
  })
  @ApiConflictResponse({
    description:
      'PICKUP_CREDENTIAL_CONSUMED: the credential was already used at handover',
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.handover is required' })
  @ApiNotFoundResponse({
    description:
      'Order not found for this tenant, or no active credential exists',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  revoke(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() body: RevokePickupCredentialDto,
  ) {
    return this.pickup.revokeCredential(
      principal.userId,
      tenantId,
      orderId,
      body.reason,
    );
  }

  @Post('pickup/verification')
  @HttpCode(200)
  @UseInterceptors(PickupRateLimitInterceptor)
  @ApiOperation({
    summary:
      'Verify a presented pickup code WITHOUT side effects (no event, no audit, no state change)',
  })
  @ApiOkResponse({
    description: 'Code is valid; order summary for the staff screen',
    schema: {
      type: 'object',
      properties: { data: pickupVerificationSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({ description: 'Malformed code shape' })
  @ApiConflictResponse({
    description:
      'PICKUP_CODE_INVALID (unknown code), PICKUP_CREDENTIAL_REVOKED, PICKUP_CREDENTIAL_CONSUMED or PICKUP_ORDER_NOT_ELIGIBLE (terminal order state)',
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.handover is required' })
  @ApiGoneResponse({ description: 'PICKUP_CREDENTIAL_EXPIRED' })
  @ApiNotFoundResponse({
    description: 'The code belongs to an order of another tenant',
  })
  @ApiTooManyRequestsResponse({
    description:
      'pickup_rate_limited after 10 FAILED code attempts per 300s window (IP, tenant, actor); body carries retryAfterSeconds and the retry-after header is set',
  })
  @ApiServiceUnavailableResponse({
    description:
      'pickup_rate_limit_unavailable (Redis down, fail-closed) or pickup_not_configured',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  verify(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: PickupCodeDto,
  ) {
    return this.pickup.verifyCode(principal.userId, tenantId, body.code);
  }

  @Post('pickup/handovers')
  @HttpCode(200)
  @UseInterceptors(PickupRateLimitInterceptor)
  @ApiOperation({
    summary:
      'Hand over the order for a valid pickup code: completes the order via OrdersService, consumes reservation + credential and records order_handovers exactly once',
  })
  @ApiOkResponse({
    description:
      'Handover recorded and order completed; a replay is a consistent 409 with no second effect',
    schema: {
      type: 'object',
      properties: { data: pickupHandoverSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({ description: 'Malformed code shape' })
  @ApiConflictResponse({
    description:
      'PICKUP_CODE_INVALID, PICKUP_CREDENTIAL_REVOKED (incl. lost race vs rotation, R3-11), PICKUP_CREDENTIAL_CONSUMED (replay), PICKUP_ORDER_NOT_ELIGIBLE, ORDER_STATE_CONFLICT (not ready_for_pickup) or PICKUP_HANDOVER_CONFLICT (race)',
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.handover is required' })
  @ApiGoneResponse({ description: 'PICKUP_CREDENTIAL_EXPIRED' })
  @ApiNotFoundResponse({
    description: 'The code belongs to an order of another tenant',
  })
  @ApiTooManyRequestsResponse({
    description:
      'pickup_rate_limited after 10 FAILED code attempts per 300s window (IP, tenant, actor); body carries retryAfterSeconds and the retry-after header is set',
  })
  @ApiServiceUnavailableResponse({
    description:
      'pickup_rate_limit_unavailable (Redis down, fail-closed) or pickup_not_configured',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  handover(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: PickupCodeDto,
  ) {
    return this.pickup.handover(principal.userId, tenantId, body.code);
  }
}
