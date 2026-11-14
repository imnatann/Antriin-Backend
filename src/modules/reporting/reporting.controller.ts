import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { ORDER_STATUSES } from '../orders/orders.constants';
import { TRANSACTION_PAGE_LIMIT_MAX } from './reporting.constants';
import { ReportingService } from './reporting.service';
import {
  campusDashboardToCsv,
  csvFilename,
  salesReportToCsv,
} from './reporting.csv';
import {
  CampusTransactionsQueryDto,
  ReportRangeQueryDto,
} from './dto/reporting.dto';

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

const campusTransactionSchema = {
  type: 'object',
  properties: {
    orderId: { type: 'string', format: 'uuid' },
    orderNumber: { type: 'string', nullable: true },
    tenantId: { type: 'string', format: 'uuid' },
    tenantName: { type: 'string' },
    buyerDisplayName: { type: 'string' },
    status: { type: 'string', enum: [...ORDER_STATUSES] },
    currency: { type: 'string', enum: ['IDR'] },
    totalMinor: { type: 'string', pattern: '^[0-9]{1,38}$' },
    pickupStartsAt: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: [
    'orderId',
    'orderNumber',
    'tenantId',
    'tenantName',
    'buyerDisplayName',
    'status',
    'currency',
    'totalMinor',
    'pickupStartsAt',
    'createdAt',
    'updatedAt',
  ],
};

const csvColumnsDescription =
  'Columns: section,status,count,total_minor,currency. total_minor is empty for sections without money.';

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

  @Get('tenants/:tenantId/reports/sales.csv')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Tenant sales report as a CSV attachment (tenant.sales.read)',
  })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiOkResponse({
    description: csvColumnsDescription,
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: 'Invalid or oversized date window' })
  @ApiForbiddenResponse({ description: 'tenant.sales.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async salesCsv(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: ReportRangeQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const report = await this.reporting.getSalesReport(
      principal.userId,
      tenantId,
      query,
    );
    return sendCsv(
      reply,
      csvFilename('tenant-sales', report),
      salesReportToCsv(report),
    );
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

  @Get('campuses/:campusId/dashboard.csv')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary:
      'Campus oversight dashboard as a CSV attachment (campus.transactions.read)',
  })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiOkResponse({
    description: csvColumnsDescription,
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: 'Invalid or oversized date window' })
  @ApiForbiddenResponse({ description: 'campus.transactions.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async dashboardCsv(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query() query: ReportRangeQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const dashboard = await this.reporting.getCampusDashboard(
      principal.userId,
      campusId,
      query,
    );
    return sendCsv(
      reply,
      csvFilename('campus-dashboard', dashboard),
      campusDashboardToCsv(dashboard),
    );
  }

  @Get('campuses/:campusId/transactions')
  @ApiOperation({
    summary: 'List the orders of one campus (campus.transactions.read)',
  })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ORDER_STATUSES })
  @ApiQuery({
    name: 'tenantId',
    required: false,
    type: String,
    description: 'Must belong to the campus (403 otherwise).',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: TRANSACTION_PAGE_LIMIT_MAX,
  })
  @ApiOkResponse({
    description: 'Cursor-paged orders of the campus, newest first',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: campusTransactionSchema },
        meta: {
          type: 'object',
          properties: { next_cursor: { type: 'string', nullable: true } },
          required: ['next_cursor'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid window, unknown status, cursor or limit',
  })
  @ApiForbiddenResponse({
    description:
      'campus.transactions.read is required, or tenantId is outside the campus',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async transactions(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query() query: CampusTransactionsQueryDto,
  ) {
    const page = await this.reporting.listCampusTransactions(
      principal.userId,
      campusId,
      query,
    );
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }
}

/**
 * Sets the download headers on the Fastify reply and hands the body back to
 * Nest. The filename is built from literals and the normalized window only, so
 * no client input reaches Content-Disposition.
 */
function sendCsv(reply: FastifyReply, filename: string, body: string): string {
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header(
    'content-disposition',
    'attachment; filename="' + filename + '"',
  );
  return body;
}
