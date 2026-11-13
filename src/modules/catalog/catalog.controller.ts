import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CatalogService } from './catalog.service';
import { MenuQueryDto } from './dto/catalog.dto';

const buyerItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string' },
    priceMinor: { type: 'string', pattern: '^(0|[1-9][0-9]{0,37})$' },
    currency: { type: 'string', enum: ['IDR'] },
    status: { type: 'string', enum: ['active', 'sold_out'] },
    version: { type: 'integer', minimum: 1 },
    imageRef: { type: 'string', nullable: true, maxLength: 500 },
    optionGroups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          minSelections: { type: 'integer' },
          maxSelections: { type: 'integer' },
          sortOrder: { type: 'integer' },
          version: { type: 'integer' },
          choices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                priceDeltaMinor: { type: 'string', pattern: '^[0-9]+$' },
                version: { type: 'integer' },
              },
              required: ['id', 'name', 'priceDeltaMinor', 'version'],
            },
          },
        },
        required: [
          'id',
          'name',
          'minSelections',
          'maxSelections',
          'sortOrder',
          'version',
          'choices',
        ],
      },
    },
  },
  required: [
    'id',
    'name',
    'description',
    'priceMinor',
    'currency',
    'status',
    'version',
    'imageRef',
    'optionGroups',
  ],
};

/**
 * Buyer discovery endpoints. Public by design (requirement 3.2: browsing the
 * menu does not require an account); every query is tenant/campus scoped and
 * archived catalog rows are never exposed.
 */
@ApiTags('Catalog')
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('tenants/:tenantId/menu')
  @ApiOperation({
    summary: 'List active categories, menu items and options of one tenant',
  })
  @ApiOkResponse({
    description:
      'Nested category listing; only buyer-visible statuses (active, sold_out)',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', format: 'uuid' },
            campusId: { type: 'string', format: 'uuid' },
            timezone: { type: 'string' },
            categories: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                  sortOrder: { type: 'integer' },
                  items: { type: 'array', items: buyerItemSchema },
                },
                required: ['id', 'name', 'sortOrder', 'items'],
              },
            },
          },
          required: ['tenantId', 'campusId', 'timezone', 'categories'],
        },
        meta: {
          type: 'object',
          properties: { truncated: { type: 'boolean' } },
          required: ['truncated'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid tenant id, filter, or search',
  })
  @ApiNotFoundResponse({
    description:
      'Tenant does not exist, is archived, or its campus is inactive',
  })
  listMenu(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query() query: MenuQueryDto,
  ) {
    return this.catalog.listMenu(tenantId, query);
  }

  @Get('tenants/:tenantId/menu/items/:itemId')
  @ApiOperation({
    summary: 'Read one buyer-visible menu item with its active options',
  })
  @ApiOkResponse({
    description: 'Menu item detail including category and option groups',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', format: 'uuid' },
            campusId: { type: 'string', format: 'uuid' },
            timezone: { type: 'string' },
            item: {
              allOf: [buyerItemSchema],
              type: 'object',
              properties: {
                ...buyerItemSchema.properties,
                categoryId: { type: 'string', format: 'uuid' },
                categoryName: { type: 'string' },
              },
            },
          },
          required: ['tenantId', 'campusId', 'timezone', 'item'],
        },
      },
      required: ['data'],
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid tenant or item id' })
  @ApiNotFoundResponse({
    description:
      'Item does not exist, is archived, or belongs to another tenant scope',
  })
  getMenuItem(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
  ) {
    return this.catalog.getMenuItem(tenantId, itemId);
  }
}
