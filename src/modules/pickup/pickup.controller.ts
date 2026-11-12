import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { buyerPickupCredentialSchema } from './pickup.schemas';
import { PickupService } from './pickup.service';

/**
 * Buyer pickup endpoints, scoped to the authenticated buyer: another buyer's
 * order or credential is a 404, never a 403 (no existence leak).
 */
@ApiTags('Pickup')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('orders')
export class PickupController {
  constructor(private readonly pickup: PickupService) {}

  @Get(':orderId/pickup-credential')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      "Read the buyer's own active pickup code (re-display decision: readable by the owner while active; decrypted server-side, never stored in plaintext, never logged)",
  })
  @ApiOkResponse({
    description: 'Active credential of the authenticated buyer for this order',
    schema: {
      type: 'object',
      properties: { data: buyerPickupCredentialSchema },
      required: ['data'],
    },
  })
  @ApiNotFoundResponse({
    description:
      'Order not found for this buyer, or no active credential (not issued / revoked / consumed)',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  getCredential(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.pickup.getBuyerCredential(principal.userId, orderId);
  }
}
