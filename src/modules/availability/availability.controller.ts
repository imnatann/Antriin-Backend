import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import { AvailabilityService } from './availability.service';
import {
  AvailabilityQueryDto,
  CreatePickupSlotDto,
  SlotRangeQueryDto,
  UpdatePickupSlotDto,
} from './dto/availability.dto';

@ApiTags('Tenant availability')
@Controller()
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('tenants/:tenantId/availability')
  @ApiOperation({
    summary:
      'List bookable pickup slots (open, future, remaining capacity) for a tenant local-date range',
  })
  @ApiOkResponse({
    description:
      'Available slots with remainingCapacity and version for quoting; empty when the tenant is paused/closed',
  })
  @ApiBadRequestResponse({
    description:
      "Invalid tenantId, invalid local date, mixed 'date' with 'from'/'to', reversed or too large range (> 31 days)",
  })
  @ApiNotFoundResponse({
    description: 'Tenant not found, archived, or campus inactive',
  })
  list(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.availability.listAvailability(tenantId, query);
  }

  @Get('tenants/:tenantId/availability/slots')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Tenant staff: list every slot (open/closed/full) in a local-date range with capacity counters',
  })
  @ApiOkResponse({
    description: 'Managed slot list in the tenant timezone',
  })
  @ApiBadRequestResponse({
    description: 'Invalid tenantId, missing/malformed from-to, range > 92 days',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiForbiddenResponse({
    description: 'Missing tenant.capacity.manage permission',
  })
  @ApiNotFoundResponse({
    description: 'Tenant not found, archived, or campus inactive',
  })
  listManaged(
    @CurrentUser() principal: { userId: string; sessionId: string },
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query() query: SlotRangeQueryDto,
  ) {
    return this.availability.listManagedSlots(
      principal.userId,
      tenantId,
      query,
    );
  }

  @Post('tenants/:tenantId/availability/slots')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Tenant staff: create a pickup slot (open window within operating hours, unique per tenant)',
    description:
      'The window only has to end in the future, so a slot that has just started can still be created: at 21:01 a 21:00-21:30 slot is accepted because pickup stays open until 21:30. A window that has fully ended is refused.',
  })
  @ApiOkResponse({ description: 'Slot created with version 1' })
  @ApiBadRequestResponse({
    description:
      'Malformed/non-ISO timestamps, endsAt <= startsAt, window already ended, capacity outside 1..2147483647, reason > 300 chars, slot outside operating hours, unknown body fields',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiForbiddenResponse({
    description: 'Missing tenant.capacity.manage permission',
  })
  @ApiNotFoundResponse({
    description: 'Tenant not found, archived, or campus inactive',
  })
  @ApiConflictResponse({
    description: 'A slot with the same tenant window already exists',
  })
  createSlot(
    @CurrentUser() principal: { userId: string; sessionId: string },
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: CreatePickupSlotDto,
  ) {
    return this.availability.createSlot(principal.userId, tenantId, dto);
  }

  @Patch('tenants/:tenantId/availability/slots/:slotId')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Tenant staff: update slot capacity, open/close it, and/or move its window (optimistic concurrency via expectedVersion)',
    description:
      'startsAt/endsAt reschedule the window; each falls back to the stored value, so sending only one keeps the other. A slot with reserved orders cannot be rescheduled, because that would silently change what a buyer was promised - use a schedule proposal instead. Every change bumps version and is audited.',
  })
  @ApiOkResponse({ description: 'Updated slot with bumped version' })
  @ApiBadRequestResponse({
    description:
      'Malformed slotId, nothing to change, capacity outside 1..2147483647, invalid status or timestamps, endsAt <= startsAt, invalid expectedVersion, or missing/overlong reason (reason is required to close a slot or reduce capacity)',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiForbiddenResponse({
    description: 'Missing tenant.capacity.manage permission',
  })
  @ApiNotFoundResponse({
    description: 'Slot not found within this tenant, or tenant not found',
  })
  @ApiConflictResponse({
    description:
      'Version conflict, capacity below reserved orders, reschedule refused (SLOT_HAS_RESERVATIONS, new window already ended, outside operating hours, or collides with another window), or reopen rejected (window already ended)',
  })
  updateSlot(
    @CurrentUser() principal: { userId: string; sessionId: string },
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('slotId', new ParseUUIDPipe()) slotId: string,
    @Body() dto: UpdatePickupSlotDto,
  ) {
    return this.availability.updateSlot(
      principal.userId,
      tenantId,
      slotId,
      dto,
    );
  }
}
