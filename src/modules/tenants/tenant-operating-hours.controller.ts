import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import {
  OperatingHourOverrideDto,
  RemoveOperatingHourOverrideDto,
  ReplaceWeeklyHoursDto,
} from './dto/operating-hours.dto';
import { TenantOperatingHoursService } from './tenant-operating-hours.service';

@ApiTags('Tenant operating hours')
@Controller('tenants/:tenantId/operating-hours')
export class TenantOperatingHoursController {
  constructor(private readonly hours: TenantOperatingHoursService) {}

  @Get()
  @ApiOperation({
    summary:
      'Read the weekly schedule (weekday 0=Sunday..6=Saturday, tenant-local) and upcoming date overrides',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({
    description: 'Weekly hours plus overrides from local today',
  })
  @ApiNotFoundResponse({
    description: 'Tenant missing, archived, or campus inactive',
  })
  list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string) {
    return this.hours.listOperatingHours(tenantId);
  }

  @Put()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Replace the complete weekly schedule (7 weekdays, each exactly once); requires tenant.capacity.manage',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({ description: 'The stored weekly schedule' })
  @ApiBadRequestResponse({
    description:
      'Invalid schedule: missing/duplicate weekday, invalid window, times on closed day, or midnight-crossing window',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  @ApiForbiddenResponse({ description: 'Missing membership or permission' })
  @ApiNotFoundResponse({ description: 'Tenant missing or archived' })
  replace(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: ReplaceWeeklyHoursDto,
  ) {
    return this.hours.replaceOperatingHours(
      principal.userId,
      tenantId,
      dto.days,
      dto.reason,
    );
  }

  @Put('overrides/:localDate')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Set the override for one tenant-local date (unique per date; isClosed XOR times); requires tenant.capacity.manage',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({ name: 'localDate', example: '2026-12-25' })
  @ApiOkResponse({ description: 'The stored override' })
  @ApiBadRequestResponse({
    description: 'Invalid date, past local date, or inconsistent window',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  @ApiForbiddenResponse({ description: 'Missing membership or permission' })
  @ApiNotFoundResponse({ description: 'Tenant missing or archived' })
  setOverride(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('localDate') localDate: string,
    @Body() dto: OperatingHourOverrideDto,
  ) {
    return this.hours.setOverride(principal.userId, tenantId, localDate, dto);
  }

  @Delete('overrides/:localDate')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Remove a date override, restoring the weekly schedule; requires tenant.capacity.manage; reason in body',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({ name: 'localDate', example: '2026-12-25' })
  @ApiOkResponse({ description: 'Override removed' })
  @ApiBadRequestResponse({ description: 'Invalid date or missing reason' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  @ApiForbiddenResponse({ description: 'Missing membership or permission' })
  @ApiNotFoundResponse({ description: 'Tenant or override not found' })
  removeOverride(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('localDate') localDate: string,
    @Body() dto: RemoveOperatingHourOverrideDto,
  ) {
    return this.hours.removeOverride(
      principal.userId,
      tenantId,
      localDate,
      dto.reason,
    );
  }
}
