import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { DiscoveryService } from './discovery.service';
import { RecommendationQueryDto, SearchQueryDto } from './dto/discovery.dto';

const searchTenantSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    campusId: { type: 'string', format: 'uuid' },
    campusName: { type: 'string' },
    location: { type: 'string' },
    status: { type: 'string' },
    matchedOn: { type: 'string', enum: ['name', 'location'] },
  },
  required: [
    'id',
    'name',
    'campusId',
    'campusName',
    'location',
    'status',
    'matchedOn',
  ],
};

const searchItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    tenantName: { type: 'string' },
    tenantStatus: { type: 'string' },
    categoryId: { type: 'string', format: 'uuid' },
    categoryName: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    priceMinor: { type: 'string', pattern: '^(0|[1-9][0-9]{0,37})$' },
    currency: { type: 'string', enum: ['IDR'] },
    status: { type: 'string', enum: ['active', 'sold_out'] },
  },
  required: [
    'id',
    'tenantId',
    'tenantName',
    'tenantStatus',
    'categoryId',
    'categoryName',
    'name',
    'description',
    'priceMinor',
    'currency',
    'status',
  ],
};

const recommendationSchema = {
  type: 'object',
  properties: {
    menuItemId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string' },
    priceMinor: { type: 'string', pattern: '^(0|[1-9][0-9]{0,37})$' },
    currency: { type: 'string', enum: ['IDR'] },
    tenantId: { type: 'string', format: 'uuid' },
    tenantName: { type: 'string' },
    tenantStatus: { type: 'string' },
    rating: {
      type: 'object',
      properties: {
        average: { type: 'string', nullable: true, example: '4.50' },
        count: { type: 'integer', minimum: 0 },
      },
      required: ['average', 'count'],
    },
    nextPickupStartsAt: {
      type: 'string',
      nullable: true,
      format: 'date-time',
    },
    score: { type: 'string', example: '0.8125' },
  },
  required: [
    'menuItemId',
    'name',
    'description',
    'priceMinor',
    'currency',
    'tenantId',
    'tenantName',
    'tenantStatus',
    'rating',
    'nextPickupStartsAt',
    'score',
  ],
};

/**
 * Public discovery endpoints. Browsing requires no account (REQUIREMENTS
 * §3.2), so these routes carry no AuthGuard: they only ever project active
 * campuses, non-archived tenants and buyer-visible items.
 */
@ApiTags('Discovery')
@Controller()
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get('search')
  @ApiOperation({
    summary:
      'Public search over tenant name/location and menu item name/description',
    description:
      'Case-insensitive substring search. Only active campuses, non-archived tenants and active/sold_out items of active categories are returned; sold_out items stay visible with status=sold_out so the client can mark them unavailable. No bearer token is required.',
  })
  @ApiOkResponse({
    description: 'Matching tenants (by name) and items (by price then name)',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            tenants: { type: 'array', items: searchTenantSchema },
            items: { type: 'array', items: searchItemSchema },
          },
          required: ['tenants', 'items'],
        },
        meta: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          required: ['query', 'limit'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiBadRequestResponse({
    description:
      'Missing/blank q (SEARCH_QUERY_REQUIRED), invalid campusId or limit',
  })
  search(@Query() query: SearchQueryDto) {
    return this.discovery.search(query);
  }

  @Get('recommendations')
  @ApiOperation({
    summary:
      'Public menu recommendations from open tenants with a free future pickup slot',
    description:
      'Items of open tenants on active campuses that still have an open, future pickup slot with free capacity. rating comes only from visible, non-deleted reviews of the item tenant and is null with count 0 when none exist; score is a documented heuristic (0.6 * normalized rating + 0.4 * next-slot freshness) also explained in meta.criteria. No bearer token is required.',
  })
  @ApiOkResponse({
    description: 'Ranked recommendations with the scoring criteria in meta',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: recommendationSchema },
        meta: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            criteria: {
              type: 'object',
              properties: {
                weights: {
                  type: 'object',
                  properties: {
                    rating: { type: 'number' },
                    nextPickupFreshness: { type: 'number' },
                  },
                  required: ['rating', 'nextPickupFreshness'],
                },
                rating: {
                  type: 'object',
                  properties: {
                    source: { type: 'string' },
                    normalization: { type: 'string' },
                    neutralWhenNoReviews: { type: 'number' },
                  },
                  required: ['source', 'normalization', 'neutralWhenNoReviews'],
                },
                nextPickupFreshness: {
                  type: 'object',
                  properties: {
                    horizonHours: { type: 'number' },
                    formula: { type: 'string' },
                  },
                  required: ['horizonHours', 'formula'],
                },
                score: { type: 'string' },
                candidateLimit: { type: 'integer' },
                order: { type: 'string' },
              },
              required: [
                'weights',
                'rating',
                'nextPickupFreshness',
                'score',
                'candidateLimit',
                'order',
              ],
            },
          },
          required: ['limit', 'criteria'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid campusId/tenantId/budgetMaxMinor/limit',
  })
  recommendations(@Query() query: RecommendationQueryDto) {
    return this.discovery.recommend(query);
  }
}
