import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { RiskService, RISK_CATEGORIES, RISK_DECISIONS } from './risk.service';
import { DecideRiskSignalDto, ListRiskReviewsQueryDto } from './dto/risk.dto';

const decisionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    decision: { type: 'string', enum: [...RISK_DECISIONS] },
    reason: { type: 'string' },
    decidedAt: { type: 'string', format: 'date-time' },
    actorUserId: { type: 'string', format: 'uuid' },
  },
  required: ['id', 'decision', 'reason', 'decidedAt', 'actorUserId'],
};

const signalProperties = {
  id: { type: 'string', format: 'uuid' },
  campusId: { type: 'string', format: 'uuid' },
  tenantId: { type: 'string', format: 'uuid', nullable: true },
  subjectType: {
    type: 'string',
    enum: ['tenant', 'buyer', 'order'],
  },
  subjectId: { type: 'string', format: 'uuid' },
  category: { type: 'string', enum: [...RISK_CATEGORIES] },
  score: {
    type: 'string',
    description: 'Detector score 0..1 as a decimal string; never a sanction.',
  },
  modelVersion: { type: 'string' },
  explanation: { type: 'string' },
  evidence: { type: 'object', additionalProperties: true },
  occurredAt: { type: 'string', format: 'date-time' },
  decision: { ...decisionSchema, nullable: true },
};

const signalSchema = {
  type: 'object',
  properties: signalProperties,
  required: [
    'id',
    'campusId',
    'subjectType',
    'subjectId',
    'category',
    'score',
    'modelVersion',
    'explanation',
    'evidence',
    'occurredAt',
    'decision',
  ],
};

const signalDetailSchema = {
  type: 'object',
  properties: {
    ...signalProperties,
    decisions: { type: 'array', items: decisionSchema },
  },
  required: [...signalSchema.required, 'decisions'],
};

const listResponse = {
  type: 'object',
  properties: {
    data: { type: 'array', items: signalSchema },
    meta: {
      type: 'object',
      properties: { next_cursor: { type: 'string', nullable: true } },
      required: ['next_cursor'],
    },
  },
  required: ['data', 'meta'],
};

const detailResponse = {
  type: 'object',
  properties: { data: signalDetailSchema },
  required: ['data'],
};

const decisionResponse = {
  type: 'object',
  properties: { data: decisionSchema },
  required: ['data'],
};

/**
 * Campus risk/AI review queue (REQUIREMENTS §3.10.4-6).
 *
 * A signal is evidence, not a sanction: these endpoints only list immutable
 * signals and append human decisions. Nothing here blocks an account, hides a
 * review, moves money or turns a score into an automatic punishment.
 */
@ApiTags('Risk')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class RiskController {
  constructor(private readonly risk: RiskService) {}

  @Get('campuses/:campusId/risk-reviews')
  @ApiOperation({ summary: 'Campus risk signal queue (campus.risk.read)' })
  @ApiQuery({
    name: 'state',
    required: false,
    enum: ['pending', 'decided', 'all'],
    description: 'Default pending: signals without a human decision.',
  })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({
    description: 'Cursor-paged signals of this campus, newest first',
    schema: listResponse,
  })
  @ApiBadRequestResponse({
    description: 'Invalid state, category, cursor or limit',
  })
  @ApiForbiddenResponse({ description: 'campus.risk.read is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query() query: ListRiskReviewsQueryDto,
  ) {
    const page = await this.risk.listRiskReviews(
      principal.userId,
      campusId,
      query,
    );
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }

  @Get('campuses/:campusId/risk-reviews/:signalId')
  @ApiOperation({
    summary:
      'One risk signal with its full decision history (campus.risk.read)',
  })
  @ApiOkResponse({
    description: 'Signal detail plus every decision, newest first',
    schema: detailResponse,
  })
  @ApiForbiddenResponse({ description: 'campus.risk.read is required' })
  @ApiNotFoundResponse({ description: 'Signal is not in this campus' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async detail(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Param('signalId', ParseUUIDPipe) signalId: string,
  ) {
    const data = await this.risk.getRiskSignal(
      principal.userId,
      campusId,
      signalId,
    );
    return { data };
  }

  @Post('campuses/:campusId/risk-reviews/:signalId/decision')
  @ApiOperation({
    summary: 'Record a human decision on one signal (campus.ai_reviews.decide)',
  })
  @ApiCreatedResponse({
    description: 'Decision appended; earlier decisions are kept',
    schema: decisionResponse,
  })
  @ApiBadRequestResponse({ description: 'Invalid decision or reason' })
  @ApiForbiddenResponse({
    description: 'campus.ai_reviews.decide is required',
  })
  @ApiNotFoundResponse({ description: 'Signal is not in this campus' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async decide(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Param('signalId', ParseUUIDPipe) signalId: string,
    @Body() body: DecideRiskSignalDto,
  ) {
    const data = await this.risk.decideRiskSignal(
      principal.userId,
      campusId,
      signalId,
      body,
    );
    return { data };
  }
}
