import {
  applyDecorators,
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
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiQuery,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { CatalogService } from './catalog.service';
import {
  ArchiveReasonQueryDto,
  CreateMenuCategoryDto,
  CreateMenuItemDto,
  CreateOptionChoiceDto,
  CreateOptionGroupDto,
  UpdateMenuCategoryDto,
  UpdateMenuItemDto,
  UpdateOptionChoiceDto,
  UpdateOptionGroupDto,
} from './dto/catalog.dto';

const categorySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    sortOrder: { type: 'integer' },
    status: { type: 'string', enum: ['active', 'archived'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'tenantId',
    'name',
    'sortOrder',
    'status',
    'createdAt',
    'updatedAt',
  ],
};

const itemSchema = {
  type: 'object',
  properties: {
    ...categorySchema.properties,
    categoryId: { type: 'string', format: 'uuid' },
    description: { type: 'string' },
    priceMinor: { type: 'string', pattern: '^(0|[1-9][0-9]{0,37})$' },
    currency: { type: 'string', enum: ['IDR'] },
    status: { type: 'string', enum: ['active', 'sold_out', 'archived'] },
    version: { type: 'integer', minimum: 1 },
    imageRef: { type: 'string', nullable: true, maxLength: 500 },
    archivedAt: { type: 'string', format: 'date-time', nullable: true },
  },
  required: [
    'id',
    'tenantId',
    'categoryId',
    'name',
    'description',
    'priceMinor',
    'currency',
    'status',
    'version',
    'imageRef',
    'archivedAt',
    'createdAt',
    'updatedAt',
  ],
};

const groupSchema = {
  type: 'object',
  properties: {
    ...categorySchema.properties,
    menuItemId: { type: 'string', format: 'uuid' },
    minSelections: { type: 'integer' },
    maxSelections: { type: 'integer' },
    version: { type: 'integer', minimum: 1 },
  },
  required: [
    'id',
    'tenantId',
    'menuItemId',
    'name',
    'minSelections',
    'maxSelections',
    'sortOrder',
    'status',
    'version',
    'createdAt',
    'updatedAt',
  ],
};

const choiceSchema = {
  type: 'object',
  properties: {
    ...categorySchema.properties,
    groupId: { type: 'string', format: 'uuid' },
    priceDeltaMinor: { type: 'string', pattern: '^(0|[1-9][0-9]{0,37})$' },
    version: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['active', 'archived'] },
  },
  required: [
    'id',
    'tenantId',
    'groupId',
    'name',
    'priceDeltaMinor',
    'status',
    'version',
    'createdAt',
    'updatedAt',
  ],
};

const envelope = (schema: object) => ({
  type: 'object',
  properties: { data: schema },
  required: ['data'],
});

const WriteErrors = () =>
  applyDecorators(
    ApiBadRequestResponse({ description: 'Payload failed runtime validation' }),
    ApiUnauthorizedResponse({
      description: 'Bearer authentication is required',
    }),
    ApiForbiddenResponse({
      description: 'Caller lacks tenant.menu.manage on this tenant',
    }),
    ApiNotFoundResponse({
      description: 'Resource is not in this tenant scope',
    }),
    ApiConflictResponse({
      description: 'Unique name conflict or optimistic version conflict',
    }),
  );

/**
 * Tenant catalog management. Every mutation re-checks the tenant membership
 * and the granular tenant.menu.manage permission inside the same transaction
 * (AccessService.requireTenant with the transaction client), so revoked staff
 * cannot race a write.
 */
@ApiTags('Catalog admin')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class CatalogAdminController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('tenants/:tenantId/menu/manage')
  @ApiOperation({
    summary: 'List the full tenant catalog including archived rows',
  })
  @ApiOkResponse({
    description: 'Flat tenant-scoped collections for management views',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            tenantId: { type: 'string', format: 'uuid' },
            categories: { type: 'array', items: categorySchema },
            items: { type: 'array', items: itemSchema },
            optionGroups: { type: 'array', items: groupSchema },
            optionChoices: { type: 'array', items: choiceSchema },
          },
          required: [
            'tenantId',
            'categories',
            'items',
            'optionGroups',
            'optionChoices',
          ],
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
  @WriteErrors()
  listAdminMenu(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
  ) {
    return this.catalog.listAdminMenu(principal.userId, tenantId);
  }

  @Post('tenants/:tenantId/menu/categories')
  @ApiOperation({ summary: 'Create a menu category' })
  @ApiCreatedResponse({
    description: 'Category created',
    schema: envelope(categorySchema),
  })
  @WriteErrors()
  createCategory(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: CreateMenuCategoryDto,
  ) {
    return this.catalog.createCategory(principal.userId, tenantId, dto);
  }

  @Patch('tenants/:tenantId/menu/categories/:categoryId')
  @ApiOperation({
    summary: 'Rename, reorder, or change the status of a category',
  })
  @ApiOkResponse({
    description: 'Category updated',
    schema: envelope(categorySchema),
  })
  @WriteErrors()
  updateCategory(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('categoryId', new ParseUUIDPipe()) categoryId: string,
    @Body() dto: UpdateMenuCategoryDto,
  ) {
    return this.catalog.updateCategory(
      principal.userId,
      tenantId,
      categoryId,
      dto,
    );
  }

  @Delete('tenants/:tenantId/menu/categories/:categoryId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Archive a category (soft delete; never removes rows)',
  })
  @ApiOkResponse({
    description: 'Category archived',
    schema: envelope(categorySchema),
  })
  @ApiQuery({
    name: 'reason',
    required: true,
    type: String,
    maxLength: 300,
    description: 'Audit reason for archiving (1..300 characters)',
  })
  @WriteErrors()
  archiveCategory(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('categoryId', new ParseUUIDPipe()) categoryId: string,
    @Query() query: ArchiveReasonQueryDto,
  ) {
    return this.catalog.archiveCategory(
      principal.userId,
      tenantId,
      categoryId,
      query.reason,
    );
  }

  @Post('tenants/:tenantId/menu/items')
  @ApiOperation({
    summary: 'Create a menu item with an integer minor-unit price',
  })
  @ApiCreatedResponse({
    description: 'Menu item created',
    schema: envelope(itemSchema),
  })
  @WriteErrors()
  createMenuItem(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.catalog.createMenuItem(principal.userId, tenantId, dto);
  }

  @Patch('tenants/:tenantId/menu/items/:itemId')
  @ApiOperation({
    summary: 'Update a menu item; bumps version (optimistic concurrency)',
  })
  @ApiOkResponse({
    description: 'Menu item updated',
    schema: envelope(itemSchema),
  })
  @WriteErrors()
  updateMenuItem(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.catalog.updateMenuItem(principal.userId, tenantId, itemId, dto);
  }

  @Delete('tenants/:tenantId/menu/items/:itemId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Archive a menu item (soft delete; never removes rows)',
  })
  @ApiOkResponse({
    description: 'Menu item archived',
    schema: envelope(itemSchema),
  })
  @ApiQuery({
    name: 'reason',
    required: true,
    type: String,
    maxLength: 300,
    description: 'Audit reason for archiving (1..300 characters)',
  })
  @WriteErrors()
  archiveMenuItem(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Query() query: ArchiveReasonQueryDto,
  ) {
    return this.catalog.archiveMenuItem(
      principal.userId,
      tenantId,
      itemId,
      query.reason,
    );
  }

  @Post('tenants/:tenantId/menu/items/:itemId/option-groups')
  @ApiOperation({ summary: 'Create an option group on a menu item' })
  @ApiCreatedResponse({
    description: 'Option group created',
    schema: envelope(groupSchema),
  })
  @WriteErrors()
  createOptionGroup(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: CreateOptionGroupDto,
  ) {
    return this.catalog.createOptionGroup(
      principal.userId,
      tenantId,
      itemId,
      dto,
    );
  }

  @Patch('tenants/:tenantId/menu/option-groups/:groupId')
  @ApiOperation({
    summary: 'Update an option group; bumps group and parent item versions',
  })
  @ApiOkResponse({
    description: 'Option group updated',
    schema: envelope(groupSchema),
  })
  @WriteErrors()
  updateOptionGroup(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Body() dto: UpdateOptionGroupDto,
  ) {
    return this.catalog.updateOptionGroup(
      principal.userId,
      tenantId,
      groupId,
      dto,
    );
  }

  @Delete('tenants/:tenantId/menu/option-groups/:groupId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive an option group (soft delete)' })
  @ApiOkResponse({
    description: 'Option group archived',
    schema: envelope(groupSchema),
  })
  @ApiQuery({
    name: 'reason',
    required: true,
    type: String,
    maxLength: 300,
    description: 'Audit reason for archiving (1..300 characters)',
  })
  @WriteErrors()
  archiveOptionGroup(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Query() query: ArchiveReasonQueryDto,
  ) {
    return this.catalog.archiveOptionGroup(
      principal.userId,
      tenantId,
      groupId,
      query.reason,
    );
  }

  @Post('tenants/:tenantId/menu/option-groups/:groupId/choices')
  @ApiOperation({
    summary: 'Create an option choice with a non-negative price delta',
  })
  @ApiCreatedResponse({
    description: 'Option choice created',
    schema: envelope(choiceSchema),
  })
  @WriteErrors()
  createOptionChoice(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Body() dto: CreateOptionChoiceDto,
  ) {
    return this.catalog.createOptionChoice(
      principal.userId,
      tenantId,
      groupId,
      dto,
    );
  }

  @Patch('tenants/:tenantId/menu/choices/:choiceId')
  @ApiOperation({
    summary: 'Update an option choice; bumps choice, group and item versions',
  })
  @ApiOkResponse({
    description: 'Option choice updated',
    schema: envelope(choiceSchema),
  })
  @WriteErrors()
  updateOptionChoice(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('choiceId', new ParseUUIDPipe()) choiceId: string,
    @Body() dto: UpdateOptionChoiceDto,
  ) {
    return this.catalog.updateOptionChoice(
      principal.userId,
      tenantId,
      choiceId,
      dto,
    );
  }

  @Delete('tenants/:tenantId/menu/choices/:choiceId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive an option choice (soft delete)' })
  @ApiOkResponse({
    description: 'Option choice archived',
    schema: envelope(choiceSchema),
  })
  @ApiQuery({
    name: 'reason',
    required: true,
    type: String,
    maxLength: 300,
    description: 'Audit reason for archiving (1..300 characters)',
  })
  @WriteErrors()
  archiveOptionChoice(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('choiceId', new ParseUUIDPipe()) choiceId: string,
    @Query() query: ArchiveReasonQueryDto,
  ) {
    return this.catalog.archiveOptionChoice(
      principal.userId,
      tenantId,
      choiceId,
      query.reason,
    );
  }
}
