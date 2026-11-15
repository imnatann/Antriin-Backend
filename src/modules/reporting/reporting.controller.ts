import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
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
import {
  REPORT_EXPORT_FORMATS,
  REPORT_EXPORT_KINDS,
  REPORT_EXPORT_SCHEDULES,
  REPORT_EXPORT_STATUSES,
  TRANSACTION_PAGE_LIMIT_MAX,
} from './reporting.constants';
import { ReportingService } from './reporting.service';
import type { ReportExportScope } from './reporting.service';
import {
  campusDashboardToCsv,
  csvFilename,
  salesReportToCsv,
} from './reporting.csv';
import {
  campusDashboardToPdf,
  pdfFilename,
  salesReportToPdf,
} from './reporting.pdf';
import {
  CampusTransactionsQueryDto,
  CreateReportExportDto,
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

const reportExportSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    scope: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['tenant', 'campus'] },
        id: { type: 'string', format: 'uuid' },
      },
      required: ['type', 'id'],
    },
    kind: { type: 'string', enum: [...REPORT_EXPORT_KINDS] },
    format: { type: 'string', enum: [...REPORT_EXPORT_FORMATS] },
    from: { type: 'string', nullable: true, example: '2026-01-01' },
    to: { type: 'string', nullable: true, example: '2026-02-01' },
    schedule: { type: 'string', enum: [...REPORT_EXPORT_SCHEDULES] },
    scheduleHour: { type: 'integer', nullable: true, minimum: 0, maximum: 23 },
    status: { type: 'string', enum: [...REPORT_EXPORT_STATUSES] },
    mediaAssetId: {
      type: 'string',
      format: 'uuid',
      nullable: true,
      description:
        'Always null: media storage accepts images only, so a generated report file is not persisted.',
    },
    error: { type: 'string', nullable: true },
    nextRunAt: { type: 'string', nullable: true },
    generatedAt: { type: 'string', nullable: true },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    downloadPath: {
      type: 'string',
      description:
        'On-demand route that renders the file from live data (nothing is stored).',
    },
  },
  required: [
    'id',
    'scope',
    'kind',
    'format',
    'from',
    'to',
    'schedule',
    'scheduleHour',
    'status',
    'mediaAssetId',
    'error',
    'nextRunAt',
    'generatedAt',
    'createdAt',
    'updatedAt',
    'downloadPath',
  ],
};

const reportExportCreatedResponse = {
  type: 'object',
  properties: { data: reportExportSchema },
  required: ['data'],
};

const reportExportListResponse = {
  type: 'object',
  properties: {
    data: { type: 'array', items: reportExportSchema },
    meta: {
      type: 'object',
      properties: {
        truncated: {
          type: 'boolean',
          description: 'True when the list bound was reached.',
        },
      },
      required: ['truncated'],
    },
  },
  required: ['data', 'meta'],
};

const exportRequestBodyDoc =
  'kind must match the scope (sales on a tenant, dashboard on a campus). ' +
  'from/to are the same half-open window as the report routes and are stored as calendar dates. ' +
  'schedule defaults to manual, which asks for one generation; daily/weekly require scheduleHour (0..23, campus timezone).';

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

  @Get('tenants/:tenantId/reports/sales.pdf')
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary: 'Tenant sales report as a PDF attachment (tenant.sales.read)',
    description:
      'Rendered from the same figures as the JSON and CSV routes, so the PDF cannot disagree with them. The numbers are counts and sums of existing columns; no revenue, fee or tax definition is invented.',
  })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiOkResponse({
    description: 'The report as application/pdf',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid or oversized date window' })
  @ApiForbiddenResponse({ description: 'tenant.sales.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async salesPdf(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: ReportRangeQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const report = await this.reporting.getSalesReport(
      principal.userId,
      tenantId,
      query,
    );
    sendPdf(
      reply,
      pdfFilename('tenant-sales', report),
      await salesReportToPdf(report),
    );
  }

  @Post('tenants/:tenantId/reports/exports')
  @ApiOperation({
    summary: 'Request or schedule a tenant sales export (tenant.sales.read)',
    description: exportRequestBodyDoc,
  })
  @ApiCreatedResponse({
    description: 'The stored export request',
    schema: reportExportCreatedResponse,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid window (REPORT_RANGE_*, REPORT_EXPORT_RANGE_INVALID), kind (REPORT_EXPORT_KIND_*), format (REPORT_EXPORT_FORMAT_INVALID) or schedule (REPORT_EXPORT_SCHEDULE_*)',
  })
  @ApiForbiddenResponse({ description: 'tenant.sales.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async createTenantExport(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: CreateReportExportDto,
  ) {
    const data = await this.reporting.createExport(
      principal.userId,
      tenantScope(tenantId),
      body,
    );
    return { data };
  }

  @Get('tenants/:tenantId/reports/exports')
  @ApiOperation({
    summary:
      'List the tenant sales exports and their status (tenant.sales.read)',
    description:
      'Newest first. Every actor who may read the sales report sees the whole scope, so a schedule created by one staff member is discoverable instead of being duplicated.',
  })
  @ApiOkResponse({
    description: 'Export rows of the tenant',
    schema: reportExportListResponse,
  })
  @ApiForbiddenResponse({ description: 'tenant.sales.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listTenantExports(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ) {
    const page = await this.reporting.listExports(
      principal.userId,
      tenantScope(tenantId),
    );
    return { data: page.items, meta: { truncated: page.truncated } };
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

  @Get('campuses/:campusId/reports/dashboard.pdf')
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary:
      'Campus oversight dashboard as a PDF attachment (campus.transactions.read)',
    description:
      'Rendered from the same figures as the JSON and CSV routes. Risk/AI review queues are not included: they belong to the risk slice.',
  })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiOkResponse({
    description: 'The dashboard as application/pdf',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid or oversized date window' })
  @ApiForbiddenResponse({ description: 'campus.transactions.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async dashboardPdf(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query() query: ReportRangeQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const dashboard = await this.reporting.getCampusDashboard(
      principal.userId,
      campusId,
      query,
    );
    sendPdf(
      reply,
      pdfFilename('campus-dashboard', dashboard),
      await campusDashboardToPdf(dashboard),
    );
  }

  @Post('campuses/:campusId/reports/exports')
  @ApiOperation({
    summary:
      'Request or schedule a campus dashboard export (campus.transactions.read)',
    description: exportRequestBodyDoc,
  })
  @ApiCreatedResponse({
    description: 'The stored export request',
    schema: reportExportCreatedResponse,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid window (REPORT_RANGE_*, REPORT_EXPORT_RANGE_INVALID), kind (REPORT_EXPORT_KIND_*), format (REPORT_EXPORT_FORMAT_INVALID) or schedule (REPORT_EXPORT_SCHEDULE_*)',
  })
  @ApiForbiddenResponse({ description: 'campus.transactions.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async createCampusExport(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Body() body: CreateReportExportDto,
  ) {
    const data = await this.reporting.createExport(
      principal.userId,
      campusScope(campusId),
      body,
    );
    return { data };
  }

  @Get('campuses/:campusId/reports/exports')
  @ApiOperation({
    summary:
      'List the campus dashboard exports and their status (campus.transactions.read)',
  })
  @ApiOkResponse({
    description: 'Export rows of the campus',
    schema: reportExportListResponse,
  })
  @ApiForbiddenResponse({ description: 'campus.transactions.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listCampusExports(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
  ) {
    const page = await this.reporting.listExports(
      principal.userId,
      campusScope(campusId),
    );
    return { data: page.items, meta: { truncated: page.truncated } };
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

function tenantScope(tenantId: string): ReportExportScope {
  return { type: 'tenant', id: tenantId };
}

function campusScope(campusId: string): ReportExportScope {
  return { type: 'campus', id: campusId };
}

/**
 * Writes the PDF bytes directly to the reply: the body is binary, so it must
 * not pass through Nest's serializer. nosniff is set for the same reason the
 * media download sets it - the content type is authoritative here.
 */
function sendPdf(reply: FastifyReply, filename: string, body: Buffer): void {
  reply
    .header('content-type', 'application/pdf')
    .header('content-length', String(body.length))
    .header('content-disposition', 'attachment; filename="' + filename + '"')
    .header('x-content-type-options', 'nosniff')
    .send(body);
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
