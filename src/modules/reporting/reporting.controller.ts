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
import { ReportingService } from './reporting.service';
import { ReportRangeQueryDto } from './dto/reporting.dto';

const statusTotalsSchema = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    count: { type: 'integer' },
    totalMinor: { type: 'string' },
  },
  required: ['status', 'count', 'totalMinor'],
};

const statusCountSchema = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    count: { type: 'integer' },
  },
  required: ['status', 'count'],
};

const salesReportSchema = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    currency: { type: 'string' },
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    orders: { type: 'array', items: statusTotalsSchema },
    refunds: { type: 'array', items: statusTotalsSchema },
  },
  required: ['tenantId', 'currency', 'from', 'to', 'orders', 'refunds'],
};

const campusDashboardSchema = {
  type: 'object',
  properties: {
    campusId: { type: 'string', format: 'uuid' },
    currency: { type: 'string' },
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    tenants: { type: 'array', items: statusCountSchema },
    orders: { type: 'array', items: statusTotalsSchema },
    refunds: { type: 'array', items: statusTotalsSchema },
    payouts: { type: 'array', items: statusTotalsSchema },
    cases: { type: 'array', items: statusCountSchema },
  },
  required: [
    'campusId',
    'currency',
    'from',
    'to',
    'tenants',
    'orders',
    'refunds',
    'payouts',
    'cases',
  ],
};

/**
 * Read-only reporting. Every figure is a count or a sum of an existing column
 * grouped by an existing status: no fee, tax, gross/net or revenue definition
 * is invented here (REQUIREMENTS §3.8.8 leaves those undecided).
 */
@ApiTags('Reporting')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get('tenants/:tenantId/reports/sales')
  @ApiOperation({ summary: 'Tenant sales report (tenant.sales.read)' })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiOkResponse({
    description: 'Order and refund counts/totals per status in the window',
    schema: {
      type: 'object',
      properties: { data: salesReportSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid or oversized date window' })
  @ApiForbiddenResponse({ description: 'tenant.sales.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async sales(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: ReportRangeQueryDto,
  ) {
    const data = await this.reporting.getSalesReport(
      principal.userId,
      tenantId,
      query,
    );
    return { data };
  }

  @Get('campuses/:campusId/dashboard')
  @ApiOperation({
    summary: 'Campus oversight dashboard (campus.transactions.read)',
  })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiOkResponse({
    description:
      'Tenant/order/refund/payout/case counts of one campus in the window; risk queues are not included',
    schema: {
      type: 'object',
      properties: { data: campusDashboardSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid or oversized date window' })
  @ApiForbiddenResponse({ description: 'campus.transactions.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async dashboard(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query() query: ReportRangeQueryDto,
  ) {
    const data = await this.reporting.getCampusDashboard(
      principal.userId,
      campusId,
      query,
    );
    return { data };
  }
}
