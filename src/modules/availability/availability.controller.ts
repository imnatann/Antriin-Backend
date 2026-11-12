import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import { AvailabilityService } from './availability.service';
import {
  AvailabilityQueryDto,
  CreatePickupSlotDto,
  OperatingHourOverrideDto,
  ReplaceWeeklyHoursDto,
  UpdatePickupSlotDto,
  UpdateTenantAvailabilityStatusDto,
} from './dto/availability.dto';

@ApiTags('Tenant availability')
@Controller()
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('tenants/:tenantId/availability')
  @ApiOperation({ summary: 'List available pickup slots for a local date' })
  list(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.availability.listAvailability(tenantId, query.date);
  }

  @Get('tenants/:tenantId/operating-hours')
  @ApiOperation({
    summary: 'Read weekly operating hours and upcoming overrides',
  })
  listHours(@Param('tenantId', new ParseUUIDPipe()) tenantId: string) {
    return this.availability.listOperatingHours(tenantId);
  }

  @Put('tenants/:tenantId/operating-hours')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Replace the complete local weekly schedule' })
  replaceHours(
    @CurrentUser() principal: { userId: string; sessionId: string },
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: ReplaceWeeklyHoursDto,
  ) {
    return this.availability.replaceOperatingHours(
      principal.userId,
      tenantId,
      dto.days,
    );
  }

  @Put('tenants/:tenantId/operating-hours/overrides/:localDate')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set a local-date opening exception' })
  setOverride(
    @CurrentUser() principal: { userId: string; sessionId: string },
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('localDate') localDate: string,
    @Body() dto: OperatingHourOverrideDto,
  ) {
    return this.availability.setOperatingHourOverride(
      principal.userId,
      tenantId,
      localDate,
      dto,
    );
  }

  @Delete('tenants/:tenantId/operating-hours/overrides/:localDate')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a local-date opening exception' })
  removeOverride(
    @CurrentUser() principal: { userId: string; sessionId: string },
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('localDate') localDate: string,
  ) {
    return this.availability.removeOperatingHourOverride(
      principal.userId,
      tenantId,
      localDate,
    );
  }

  @Post('tenants/:tenantId/availability/slots')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a finite UTC pickup slot' })
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
  @ApiOperation({ summary: 'Update slot capacity or availability state' })
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

  @Patch('tenants/:tenantId/availability/status')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Open, close, or pause tenant order intake' })
  updateStatus(
    @CurrentUser() principal: { userId: string; sessionId: string },
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: UpdateTenantAvailabilityStatusDto,
  ) {
    return this.availability.updateTenantStatus(
      principal.userId,
      tenantId,
      dto,
    );
  }
}
