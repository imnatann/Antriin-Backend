import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
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
import { CasesService } from './cases.service';
import {
  DecideCaseDto,
  ListCasesQueryDto,
  OpenBuyerCaseDto,
  OpenCampusCaseDto,
  OpenTenantCaseDto,
} from './dto/case.dto';

const caseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    campusId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid', nullable: true },
    buyerId: { type: 'string', format: 'uuid', nullable: true },
    openedByUserId: { type: 'string', format: 'uuid' },
    category: {
      type: 'string',
      enum: [
        'order_issue',
        'no_show',
        'quality',
        'payment',
        'schedule',
        'other',
      ],
    },
    status: {
      type: 'string',
      enum: [
        'reported',
        'under_review',
        'awaiting_information',
        'approved_cancel',
        'declined',
        'resolved',
      ],
    },
    subject: { type: 'string' },
    details: { type: 'string' },
    decisionReason: { type: 'string', nullable: true },
    decidedByUserId: { type: 'string', format: 'uuid', nullable: true },
    decidedAt: { type: 'string', format: 'date-time', nullable: true },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'campusId', 'tenantId', 'category', 'status', 'subject'],
};

const listResponse = {
  type: 'object',
  properties: {
    data: { type: 'array', items: caseSchema },
    meta: {
      type: 'object',
      properties: { next_cursor: { type: 'string', nullable: true } },
      required: ['next_cursor'],
    },
  },
  required: ['data', 'meta'],
};

/**
 * Operational cases. Opening a case is available to the buyer of an order,
 * tenant staff (tenant.incidents.report) and campus staff
 * (campus.cases.read). Status transitions and decisions are campus-only
 * (campus.cases.decide); 'approved_cancel' additionally requires
 * campus.refunds.initiate and a pre-handover order. A case is never an
 * automatic sanction and never moves money by itself.
 */
@ApiTags('Cases')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Post('orders/:orderId/cases')
  @ApiOperation({ summary: 'Buyer opens a case about their own order' })
  @ApiCreatedResponse({
    description: 'Case recorded for campus review',
    schema: {
      type: 'object',
      properties: { data: caseSchema },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid category/subject/details' })
  @ApiNotFoundResponse({
    description: "Order does not exist or is not the caller's",
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async openBuyer(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: OpenBuyerCaseDto,
  ) {
    const data = await this.cases.openBuyerCase(
      principal.userId,
      orderId,
      body,
    );
    return { data };
  }

  @Get('me/cases')
  @ApiOperation({ summary: 'List cases of the authenticated buyer' })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({
    description: 'Cursor-paged cases scoped to the buyer',
    schema: listResponse,
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listBuyer(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: ListCasesQueryDto,
  ) {
    const page = await this.cases.listBuyerCases(principal.userId, query);
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }

  @Get('me/cases/:caseId')
  @ApiOperation({ summary: 'Read one case of the authenticated buyer' })
  @ApiOkResponse({
    description: 'The case linked to the buyer',
    schema: {
      type: 'object',
      properties: { data: caseSchema },
      required: ['data'],
    },
  })
  @ApiNotFoundResponse({
    description: "Case does not exist or is not the caller's",
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async getBuyer(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    const data = await this.cases.getBuyerCase(principal.userId, caseId);
    return { data };
  }

  @Post('tenants/:tenantId/cases')
  @ApiOperation({
    summary: 'Tenant staff opens a case (tenant.incidents.report)',
  })
  @ApiCreatedResponse({
    description: 'Case recorded for campus review',
    schema: {
      type: 'object',
      properties: { data: caseSchema },
      required: ['data'],
    },
  })
  @ApiForbiddenResponse({
    description: 'Missing tenant.incidents.report permission',
  })
  @ApiNotFoundResponse({ description: 'Tenant/order not found for this scope' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async openTenant(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: OpenTenantCaseDto,
  ) {
    const data = await this.cases.openTenantCase(
      principal.userId,
      tenantId,
      body,
    );
    return { data };
  }

  @Get('tenants/:tenantId/cases')
  @ApiOperation({ summary: 'List cases of a tenant (tenant.orders.read)' })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({
    description: 'Cursor-paged cases scoped to the tenant',
    schema: listResponse,
  })
  @ApiForbiddenResponse({
    description: 'Missing tenant.orders.read permission',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listTenant(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: ListCasesQueryDto,
  ) {
    const page = await this.cases.listTenantCases(
      principal.userId,
      tenantId,
      query,
    );
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }

  @Get('tenants/:tenantId/cases/:caseId')
  @ApiOperation({ summary: 'Read one case of a tenant (tenant.orders.read)' })
  @ApiOkResponse({
    description: 'The case scoped to the tenant',
    schema: {
      type: 'object',
      properties: { data: caseSchema },
      required: ['data'],
    },
  })
  @ApiForbiddenResponse({
    description: 'Missing tenant.orders.read permission',
  })
  @ApiNotFoundResponse({ description: 'Case not found for this tenant' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async getTenant(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    const data = await this.cases.getTenantCase(
      principal.userId,
      tenantId,
      caseId,
    );
    return { data };
  }

  @Post('campuses/:campusId/cases')
  @ApiOperation({ summary: 'Campus staff opens a case (campus.cases.read)' })
  @ApiCreatedResponse({
    description: 'Case recorded',
    schema: {
      type: 'object',
      properties: { data: caseSchema },
      required: ['data'],
    },
  })
  @ApiForbiddenResponse({ description: 'Missing campus.cases.read permission' })
  @ApiNotFoundResponse({
    description: 'Tenant/order not found for this campus',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async openCampus(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Body() body: OpenCampusCaseDto,
  ) {
    const data = await this.cases.openCampusCase(
      principal.userId,
      campusId,
      body,
    );
    return { data };
  }

  @Get('campuses/:campusId/cases')
  @ApiOperation({ summary: 'List cases of a campus (campus.cases.read)' })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({
    description: 'Cursor-paged cases scoped to the campus',
    schema: listResponse,
  })
  @ApiForbiddenResponse({ description: 'Missing campus.cases.read permission' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listCampus(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query() query: ListCasesQueryDto,
  ) {
    const page = await this.cases.listCampusCases(
      principal.userId,
      campusId,
      query,
    );
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }

  @Get('campuses/:campusId/cases/:caseId')
  @ApiOperation({ summary: 'Read one case of a campus (campus.cases.read)' })
  @ApiOkResponse({
    description: 'The case scoped to the campus',
    schema: {
      type: 'object',
      properties: { data: caseSchema },
      required: ['data'],
    },
  })
  @ApiForbiddenResponse({ description: 'Missing campus.cases.read permission' })
  @ApiNotFoundResponse({ description: 'Case not found for this campus' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async getCampus(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    const data = await this.cases.getCampusCase(
      principal.userId,
      campusId,
      caseId,
    );
    return { data };
  }

  @Post('campuses/:campusId/cases/:caseId/decision')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Campus-manager decision on a case (campus.cases.decide; approved_cancel also requires campus.refunds.initiate)',
  })
  @ApiOkResponse({
    description:
      'Case transitioned. For approved_cancel the order is cancelled and data.refund holds the pending refund',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            case: caseSchema,
            refund: { type: 'object', nullable: true },
          },
          required: ['case'],
        },
      },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({
    description:
      'CASE_STATUS_INVALID, CASE_REASON_REQUIRED or CASE_ORDER_REQUIRED',
  })
  @ApiForbiddenResponse({
    description:
      'Missing campus.cases.decide (or campus.refunds.initiate for approved_cancel)',
  })
  @ApiNotFoundResponse({ description: 'Case not found for this campus' })
  @ApiConflictResponse({
    description:
      'CASE_ALREADY_DECIDED, ORDER_CANCEL_CONFLICT (post-handover/terminal order) or REFUND_ALREADY_EXISTS',
  })
  @ApiServiceUnavailableResponse({
    description:
      'REFUNDS_PROVIDER_DISABLED: approved_cancel requires an active refund provider and the whole decision is rolled back while it is disabled (always in production)',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async decide(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() body: DecideCaseDto,
  ) {
    const result = await this.cases.decideCase(
      principal.userId,
      campusId,
      caseId,
      body,
    );
    return { data: result };
  }
}
