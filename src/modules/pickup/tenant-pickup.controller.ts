import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { PickupCodeDto, RevokePickupCredentialDto } from './dto/pickup.dto';
import { PickupRateLimitGuard } from './pickup-rate-limit.guard';
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
 * extra per-IP Redis rate limit against brute force.
 */
@ApiTags('Pickup')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('tenants/:tenantId')
export class TenantPickupController {
  constructor(private readonly pickup: PickupService) {}

  @Post('orders/:orderId/pickup-credential')
  @HttpCode(201)
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
  @ApiConflictResponse({
    description: 'PICKUP_NOT_READY: the order is not ready_for_pickup',
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.handover is required' })
  @ApiNotFoundResponse({ description: 'Order not found for this tenant' })
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
  @UseGuards(PickupRateLimitGuard)
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
  @ApiConflictResponse({
    description:
      'PICKUP_CODE_INVALID (unknown code), PICKUP_CREDENTIAL_REVOKED or PICKUP_CREDENTIAL_CONSUMED',
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.handover is required' })
  @ApiGoneResponse({ description: 'PICKUP_CREDENTIAL_EXPIRED' })
  @ApiNotFoundResponse({
    description: 'The code belongs to an order of another tenant',
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
  @UseGuards(PickupRateLimitGuard)
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
  @ApiConflictResponse({
    description:
      'PICKUP_CODE_INVALID, PICKUP_CREDENTIAL_REVOKED, PICKUP_CREDENTIAL_CONSUMED (replay), ORDER_STATE_CONFLICT (not ready_for_pickup) or PICKUP_HANDOVER_CONFLICT (race)',
  })
  @ApiForbiddenResponse({ description: 'tenant.orders.handover is required' })
  @ApiGoneResponse({ description: 'PICKUP_CREDENTIAL_EXPIRED' })
  @ApiNotFoundResponse({
    description: 'The code belongs to an order of another tenant',
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
