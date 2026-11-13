import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { ReviewsService } from './reviews.service';
import {
  DecideReviewDto,
  ListReviewsQueryDto,
  ReportReviewDto,
  ReplyReviewDto,
  ReviewBodyDto,
} from './dto/review.dto';

const replySchema = {
  type: 'object',
  nullable: true,
  properties: {
    id: { type: 'string', format: 'uuid' },
    body: { type: 'string' },
    authorUserId: { type: 'string', format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const reviewSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    campusId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    buyerId: { type: 'string', format: 'uuid' },
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    body: { type: 'string' },
    status: {
      type: 'string',
      enum: ['visible', 'reported', 'under_review', 'hidden', 'resolved'],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    reply: replySchema,
    openReportCount: { type: 'integer' },
  },
  required: ['id', 'tenantId', 'orderId', 'rating', 'body', 'status'],
};

const publicReviewSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    body: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    reply: replySchema,
  },
  required: ['id', 'tenantId', 'rating', 'body'],
};

const single = {
  type: 'object',
  properties: { data: reviewSchema },
  required: ['data'],
};

const publicListResponse = {
  type: 'object',
  properties: {
    data: { type: 'array', items: publicReviewSchema },
    meta: {
      type: 'object',
      properties: { next_cursor: { type: 'string', nullable: true } },
      required: ['next_cursor'],
    },
  },
  required: ['data', 'meta'],
};

const listResponse = {
  type: 'object',
  properties: {
    data: { type: 'array', items: reviewSchema },
    meta: {
      type: 'object',
      properties: { next_cursor: { type: 'string', nullable: true } },
      required: ['next_cursor'],
    },
  },
  required: ['data', 'meta'],
};

/**
 * Buyer review of a completed order. The order must belong to the caller and
 * the caller must hold a verified campus email for that campus; one review per
 * order, and a deleted review keeps the order un-reviewable.
 */
@ApiTags('Reviews')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post('orders/:orderId/reviews')
  @ApiOperation({
    summary: 'Buyer reviews their own completed order (once per order)',
  })
  @ApiCreatedResponse({ description: 'Review created', schema: single })
  @ApiBadRequestResponse({ description: 'Invalid rating or body' })
  @ApiConflictResponse({
    description: 'Order is not completed, or already has a review',
  })
  @ApiForbiddenResponse({
    description: 'A verified campus email is required',
  })
  @ApiNotFoundResponse({
    description: "Order does not exist or is not the caller's",
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: ReviewBodyDto,
  ) {
    const data = await this.reviews.createReview(
      principal.userId,
      orderId,
      body,
    );
    return { data };
  }

  @Get('me/reviews')
  @ApiOperation({ summary: 'List the authenticated buyer own reviews' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({
    description: 'Cursor-paged own reviews',
    schema: listResponse,
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listMine(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: ListReviewsQueryDto,
  ) {
    const page = await this.reviews.listBuyerReviews(principal.userId, query);
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }

  @Patch('reviews/:reviewId')
  @ApiOperation({ summary: 'Buyer edits their own review' })
  @ApiOkResponse({ description: 'Updated review', schema: single })
  @ApiConflictResponse({
    description: 'The review was hidden by campus moderation',
  })
  @ApiNotFoundResponse({
    description: 'Review does not exist or is not theirs',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async update(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: ReviewBodyDto,
  ) {
    const data = await this.reviews.updateReview(
      principal.userId,
      reviewId,
      body,
    );
    return { data };
  }

  @Delete('reviews/:reviewId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Buyer deletes their own review (soft delete)' })
  @ApiOkResponse({
    description: 'The review is marked deleted; the order stays un-reviewable',
    schema: single,
  })
  @ApiNotFoundResponse({
    description: 'Review does not exist or is not theirs',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async remove(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ) {
    const data = await this.reviews.deleteReview(principal.userId, reviewId);
    return { data };
  }

  @Post('reviews/:reviewId/reports')
  @ApiOperation({ summary: 'Report a review to campus moderation' })
  @ApiCreatedResponse({ description: 'Report recorded', schema: single })
  @ApiConflictResponse({ description: 'This user already reported the review' })
  @ApiNotFoundResponse({ description: 'Review was not found' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async report(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: ReportReviewDto,
  ) {
    const data = await this.reviews.reportReview(
      principal.userId,
      reviewId,
      body,
    );
    return { data };
  }

  @Get('tenants/:tenantId/reviews/manage')
  @ApiOperation({
    summary: 'Tenant reads its own reviews (tenant.reviews.reply)',
  })
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
    description: 'Cursor-paged tenant reviews',
    schema: listResponse,
  })
  @ApiForbiddenResponse({ description: 'tenant.reviews.reply is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async listForTenant(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: ListReviewsQueryDto,
  ) {
    const page = await this.reviews.listTenantReviews(
      principal.userId,
      tenantId,
      query,
    );
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }

  @Post('tenants/:tenantId/reviews/:reviewId/replies')
  @ApiOperation({ summary: 'Tenant replies once to its own review' })
  @ApiCreatedResponse({ description: 'Reply stored (upsert)', schema: single })
  @ApiForbiddenResponse({ description: 'tenant.reviews.reply is required' })
  @ApiNotFoundResponse({ description: 'Review is not this tenant review' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async reply(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: ReplyReviewDto,
  ) {
    const data = await this.reviews.replyToReview(
      principal.userId,
      tenantId,
      reviewId,
      body,
    );
    return { data };
  }

  @Get('campuses/:campusId/moderation/reviews')
  @ApiOperation({
    summary: 'Campus moderation queue (campus.reviews.moderate)',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({
    description: 'Reviews reported or under review in this campus',
    schema: listResponse,
  })
  @ApiForbiddenResponse({ description: 'campus.reviews.moderate is required' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async moderationQueue(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query() query: ListReviewsQueryDto,
  ) {
    const page = await this.reviews.listModerationQueue(
      principal.userId,
      campusId,
      query,
    );
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }

  @Post('campuses/:campusId/moderation/reviews/:reviewId/decision')
  @ApiOperation({
    summary: 'Campus keeps or hides a review with a recorded reason',
  })
  @ApiCreatedResponse({ description: 'Decision recorded', schema: single })
  @ApiForbiddenResponse({ description: 'campus.reviews.moderate is required' })
  @ApiNotFoundResponse({ description: 'Review was not found in this campus' })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async decide(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: DecideReviewDto,
  ) {
    const data = await this.reviews.decideModeration(
      principal.userId,
      campusId,
      reviewId,
      body,
    );
    return { data };
  }
}

/**
 * Public tenant reviews. No account is required, and the response carries no
 * buyer identity: only visible, non-deleted reviews are exposed.
 */
@ApiTags('Reviews')
@Controller()
export class PublicReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('tenants/:tenantId/reviews')
  @ApiOperation({ summary: 'Public list of visible reviews of one tenant' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({
    description:
      'Visible reviews with the tenant reply, newest first; no buyer identity',
    schema: publicListResponse,
  })
  async list(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: ListReviewsQueryDto,
  ) {
    const page = await this.reviews.listPublicReviews(tenantId, query);
    return { data: page.items, meta: { next_cursor: page.nextCursor } };
  }
}
