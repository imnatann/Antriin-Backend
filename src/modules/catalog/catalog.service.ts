import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { AvailabilityService } from '../availability/availability.service';

export interface QuoteItemInput {
  menuItemId: string;
  quantity: number;
  optionIds: readonly string[];
}

export interface QuoteOptionSnapshot {
  id: string;
  groupId: string;
  groupName: string;
  name: string;
  priceDeltaMinor: string;
  groupVersion: number;
  optionVersion: number;
}

export interface QuoteLineSnapshot {
  menuItemId: string;
  categoryId: string;
  categoryName: string;
  name: string;
  description: string;
  basePriceMinor: string;
  unitPriceMinor: string;
  quantity: number;
  menuVersion: number;
  options: QuoteOptionSnapshot[];
}

export interface OrderQuote {
  quoteHash: string;
  tenant: {
    id: string;
    campusId: string;
    name: string;
    timezone: string;
  };
  slot: {
    id: string;
    startsAt: string;
    endsAt: string;
    version: number;
  };
  items: QuoteLineSnapshot[];
  subtotalMinor: string;
  totalMinor: string;
  currency: 'IDR';
}

export interface CategoryView {
  id: string;
  tenantId: string;
  name: string;
  sortOrder: number;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface MenuItemView {
  id: string;
  tenantId: string;
  categoryId: string;
  name: string;
  description: string;
  priceMinor: string;
  currency: 'IDR';
  status: 'active' | 'sold_out' | 'archived';
  version: number;
  imageRef: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OptionGroupView {
  id: string;
  tenantId: string;
  menuItemId: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  sortOrder: number;
  status: 'active' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface OptionChoiceView {
  id: string;
  tenantId: string;
  groupId: string;
  name: string;
  priceDeltaMinor: string;
  status: 'active' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BuyerOptionGroupView {
  id: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  sortOrder: number;
  version: number;
  choices: {
    id: string;
    name: string;
    priceDeltaMinor: string;
    version: number;
  }[];
}

export interface BuyerMenuItemView {
  id: string;
  name: string;
  description: string;
  priceMinor: string;
  currency: 'IDR';
  status: 'active' | 'sold_out';
  version: number;
  imageRef: string | null;
  optionGroups: BuyerOptionGroupView[];
}

export interface BuyerCategoryView {
  id: string;
  name: string;
  sortOrder: number;
  items: BuyerMenuItemView[];
}

export interface MenuListQuery {
  status?: 'active' | 'sold_out';
  search?: string;
  categoryId?: string;
}

export interface CreateCategoryInput {
  name: string;
  sortOrder?: number;
}

export interface UpdateCategoryInput {
  name?: string;
  sortOrder?: number;
  status?: 'active' | 'archived';
  reason?: string;
}

export interface CreateMenuItemInput {
  categoryId: string;
  name: string;
  description?: string;
  priceMinor: string;
  status?: 'active' | 'sold_out';
  imageRef?: string;
}

export interface UpdateMenuItemInput {
  name?: string;
  description?: string;
  priceMinor?: string;
  categoryId?: string;
  status?: 'active' | 'sold_out' | 'archived';
  imageRef?: string;
  /** Required (1..300 chars) whenever the update changes price or status. */
  reason?: string;
  expectedVersion: number;
}

export interface CreateOptionGroupInput {
  name: string;
  minSelections?: number;
  maxSelections?: number;
  sortOrder?: number;
}

export interface UpdateOptionGroupInput {
  name?: string;
  minSelections?: number;
  maxSelections?: number;
  sortOrder?: number;
  status?: 'active' | 'archived';
  reason?: string;
  expectedVersion: number;
}

export interface CreateOptionChoiceInput {
  name: string;
  priceDeltaMinor?: string;
}

export interface UpdateOptionChoiceInput {
  name?: string;
  priceDeltaMinor?: string;
  status?: 'active' | 'archived';
  reason?: string;
  expectedVersion: number;
}

type CatalogAuditTarget =
  'menu_category' | 'menu_item' | 'menu_option_group' | 'menu_option_choice';

interface CatalogAuditEvent {
  action: string;
  metadata?: Record<string, unknown>;
}

interface PlannedAudit {
  reason: string;
  events: CatalogAuditEvent[];
}

interface CatalogItemRow {
  id: string;
  category_id: string;
  category_name: string;
  name: string;
  description: string;
  price_minor: string;
  version: number;
}

interface OptionGroupRow {
  id: string;
  menu_item_id: string;
  name: string;
  min_selections: number;
  max_selections: number;
  version: number;
}

interface OptionChoiceRow {
  id: string;
  group_id: string;
  group_name: string;
  menu_item_id: string;
  name: string;
  price_delta_minor: string;
  group_version: number;
  option_version: number;
}

interface CategoryDbRow {
  id: string;
  tenant_id: string;
  name: string;
  sort_order: number;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

interface MenuItemDbRow {
  id: string;
  tenant_id: string;
  category_id: string;
  name: string;
  description: string;
  price_minor: string;
  currency: string;
  status: 'active' | 'sold_out' | 'archived';
  version: number;
  image_ref: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OptionGroupDbRow {
  id: string;
  tenant_id: string;
  menu_item_id: string;
  name: string;
  min_selections: number;
  max_selections: number;
  sort_order: number;
  status: 'active' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
}

interface OptionChoiceDbRow {
  id: string;
  tenant_id: string;
  group_id: string;
  name: string;
  price_delta_minor: string;
  status: 'active' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
}

// D7 convention: return microsecond-precision UTC timestamps straight from
// PostgreSQL; never round-trip them through JS Date (millisecond precision).
const TS_SELECT = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;
// menu_items projection shared by every admin read/write RETURNING clause.
const ITEM_SELECT = `id, tenant_id, category_id, name, description,
       price_minor::text, currency, status, version, image_ref,
       to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS archived_at,
       ${TS_SELECT}`;

const MAX_MINOR = 10n ** 38n - 1n;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MINOR_INPUT_PATTERN = /^(0|[1-9][0-9]{0,37})$/;
const CATEGORY_STATUSES = ['active', 'archived'] as const;
const ITEM_STATUSES = ['active', 'sold_out', 'archived'] as const;
const BUYER_ITEM_STATUSES = ['active', 'sold_out'] as const;
const MAX_SELECTIONS_LIMIT = 50;
// Pilot operational bound for a single quote line (DB bound is looser: 1..999).
// Product can change this without a migration; see docs/modules/catalog.md.
const MAX_QUOTE_LINE_QUANTITY = 200;
const MAX_DISCOVERY_ITEMS = 200;
const MAX_ADMIN_ROWS = 500;

@Injectable()
export class CatalogService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly availability: AvailabilityService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Build the server-side price snapshot used by checkout. ADVISORY and
   * read-only: it never reserves slot capacity, never moves money and never
   * locks the pickup_slots row (assertBookableSlot mode 'none'), so a
   * concurrent reserveForCheckout (FOR UPDATE) can never deadlock against a
   * quote. The quote does not guarantee price or slot availability; final
   * validation authority is reserveForCheckout inside the checkout
   * transaction (D15 order: INSERT orders -> reserve -> debit).
   *
   * The returned quoteHash is a sha256 over the canonicalized snapshot (lines
   * sorted by menu item id, options sorted by group/choice id), so equivalent
   * carts hash identically while any quantity/option/price/version change
   * differs.
   */
  async quote(
    client: PoolClient,
    tenantId: string,
    slotId: string,
    items: readonly QuoteItemInput[],
  ): Promise<OrderQuote> {
    this.validateQuoteInput(tenantId, slotId, items);
    // Root decision (deadlock fix): quote must NOT lock the slot row. Mode
    // 'none' validates status/capacity/operating hours with a plain SELECT;
    // FOR UPDATE authority lives in AvailabilityService.reserveForCheckout.
    const slot = await this.availability.assertBookableSlot(
      client,
      tenantId,
      slotId,
      'none',
    );
    const tenantResult = await client.query<{
      id: string;
      campus_id: string;
      name: string;
      timezone: string;
    }>(
      `SELECT t.id, t.campus_id, t.name, c.timezone
         FROM tenants t JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND t.status = 'open' AND c.status = 'active'
        FOR SHARE OF t, c`,
      [tenantId],
    );
    const tenant = tenantResult.rows[0];
    if (!tenant) throw new ConflictException('Tenant is not accepting orders');

    const itemIds = items.map((item) => item.menuItemId);
    const itemResult = await client.query<CatalogItemRow>(
      `SELECT mi.id, mi.category_id, cat.name AS category_name, mi.name,
              mi.description, mi.price_minor::text, mi.version
         FROM menu_items mi
         JOIN menu_categories cat
           ON cat.tenant_id = mi.tenant_id AND cat.id = mi.category_id
        WHERE mi.tenant_id = $1 AND mi.id = ANY($2::uuid[])
          AND mi.status = 'active' AND cat.status = 'active'
        ORDER BY mi.id
        FOR SHARE OF mi, cat`,
      [tenantId, itemIds],
    );
    if (itemResult.rows.length !== itemIds.length) {
      throw new ConflictException('One or more menu items are unavailable');
    }
    const itemById = new Map(itemResult.rows.map((row) => [row.id, row]));

    const groupResult = await client.query<OptionGroupRow>(
      `SELECT id, menu_item_id, name, min_selections, max_selections, version
         FROM menu_option_groups
        WHERE tenant_id = $1 AND menu_item_id = ANY($2::uuid[])
          AND status = 'active'
        ORDER BY menu_item_id, sort_order, id
        FOR SHARE`,
      [tenantId, itemIds],
    );
    const groupsByItem = new Map<string, OptionGroupRow[]>();
    for (const group of groupResult.rows) {
      const groups = groupsByItem.get(group.menu_item_id) ?? [];
      groups.push(group);
      groupsByItem.set(group.menu_item_id, groups);
    }
    const groupIds = groupResult.rows.map((group) => group.id);
    const choiceResult = groupIds.length
      ? await client.query<OptionChoiceRow>(
          `SELECT choice.id, choice.group_id, grp.name AS group_name,
                  grp.menu_item_id, choice.name, choice.price_delta_minor::text,
                  grp.version AS group_version, choice.version AS option_version
             FROM menu_option_choices choice
             JOIN menu_option_groups grp
               ON grp.tenant_id = choice.tenant_id AND grp.id = choice.group_id
            WHERE choice.tenant_id = $1 AND choice.group_id = ANY($2::uuid[])
              AND choice.status = 'active' AND grp.status = 'active'
            ORDER BY choice.group_id, choice.id
            FOR SHARE OF choice, grp`,
          [tenantId, groupIds],
        )
      : { rows: [] as OptionChoiceRow[] };
    const choicesById = new Map(choiceResult.rows.map((row) => [row.id, row]));

    const lines: QuoteLineSnapshot[] = [];
    let subtotal = 0n;
    for (const requested of items) {
      const item = itemById.get(requested.menuItemId);
      if (!item)
        throw new ConflictException('One or more menu items are unavailable');
      const groups = groupsByItem.get(item.id) ?? [];
      const groupIdsForItem = new Set(groups.map((group) => group.id));
      const selected = requested.optionIds.map((id) => choicesById.get(id));
      if (
        selected.some(
          (choice) =>
            !choice ||
            choice.menu_item_id !== item.id ||
            !groupIdsForItem.has(choice.group_id),
        )
      ) {
        throw new BadRequestException(
          'Option is invalid for the selected menu item',
        );
      }
      const selectedByGroup = new Map<string, OptionChoiceRow[]>();
      for (const choice of selected as OptionChoiceRow[]) {
        const groupChoices = selectedByGroup.get(choice.group_id) ?? [];
        groupChoices.push(choice);
        selectedByGroup.set(choice.group_id, groupChoices);
      }
      for (const group of groups) {
        const count = selectedByGroup.get(group.id)?.length ?? 0;
        if (count < group.min_selections || count > group.max_selections) {
          throw new BadRequestException(
            `Select valid options for ${group.name}`,
          );
        }
      }

      const basePrice = this.parseMinor(item.price_minor);
      const options = (selected as OptionChoiceRow[])
        .map((choice) => ({
          id: choice.id,
          groupId: choice.group_id,
          groupName: choice.group_name,
          name: choice.name,
          priceDeltaMinor: this.normalizeMinor(choice.price_delta_minor),
          groupVersion: choice.group_version,
          optionVersion: choice.option_version,
        }))
        .sort(
          (a, b) =>
            a.groupId.localeCompare(b.groupId) || a.id.localeCompare(b.id),
        );
      const unitPrice =
        basePrice +
        options.reduce(
          (sum, option) => sum + BigInt(option.priceDeltaMinor),
          0n,
        );
      const lineTotal = unitPrice * BigInt(requested.quantity);
      if (lineTotal > MAX_MINOR || subtotal + lineTotal > MAX_MINOR) {
        throw new BadRequestException(
          'Quoted total exceeds the supported amount range',
        );
      }
      subtotal += lineTotal;
      lines.push({
        menuItemId: item.id,
        categoryId: item.category_id,
        categoryName: item.category_name,
        name: item.name,
        description: item.description,
        basePriceMinor: this.normalizeMinor(item.price_minor),
        unitPriceMinor: unitPrice.toString(),
        quantity: requested.quantity,
        menuVersion: item.version,
        options,
      });
    }

    if (subtotal === 0n) {
      // Root decision (wave1 D12): zero-total orders are rejected in the pilot.
      throw new BadRequestException('Quote total must be greater than zero');
    }

    const snapshot = {
      tenant: {
        id: tenant.id,
        campusId: tenant.campus_id,
        name: tenant.name,
        timezone: tenant.timezone,
      },
      slot: {
        id: slot.slotId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        version: slot.version,
      },
      items: lines,
      subtotalMinor: subtotal.toString(),
      totalMinor: subtotal.toString(),
      currency: 'IDR' as const,
    };
    const quoteHash = createHash('sha256')
      .update(
        JSON.stringify({
          ...snapshot,
          items: [...lines].sort((a, b) =>
            a.menuItemId.localeCompare(b.menuItemId),
          ),
        }),
      )
      .digest('hex');
    return { quoteHash, ...snapshot };
  }

  // ---------------------------------------------------------------------------
  // Buyer discovery (read-only, never leaks other tenants or archived rows)
  // ---------------------------------------------------------------------------

  async listMenu(tenantId: string, query: MenuListQuery = {}) {
    this.assertUuid(tenantId, 'tenantId');
    const statuses = this.normalizeBuyerStatuses(query.status);
    const search = this.normalizeSearch(query.search);
    if (query.categoryId !== undefined)
      this.assertUuid(query.categoryId, 'categoryId');
    const tenant = await this.requireVisibleTenant(tenantId);

    const items = await this.database.pool.query<{
      id: string;
      category_id: string;
      name: string;
      description: string;
      price_minor: string;
      currency: string;
      status: 'active' | 'sold_out';
      version: number;
      image_ref: string | null;
    }>(
      `SELECT mi.id, mi.category_id, mi.name, mi.description,
              mi.price_minor::text, mi.currency, mi.status, mi.version,
              mi.image_ref
         FROM menu_items mi
         JOIN menu_categories cat
           ON cat.tenant_id = mi.tenant_id AND cat.id = mi.category_id
        WHERE mi.tenant_id = $1
          AND mi.status = ANY($2::varchar[])
          AND cat.status = 'active'
          AND ($3::uuid IS NULL OR mi.category_id = $3)
          AND ($4::text IS NULL OR mi.name ILIKE '%' || $4 || '%')
        ORDER BY mi.name, mi.id
        LIMIT $5`,
      [
        tenantId,
        statuses,
        query.categoryId ?? null,
        search,
        MAX_DISCOVERY_ITEMS + 1,
      ],
    );
    const truncated = items.rows.length > MAX_DISCOVERY_ITEMS;
    const rows = truncated
      ? items.rows.slice(0, MAX_DISCOVERY_ITEMS)
      : items.rows;
    const itemIds = rows.map((row) => row.id);
    const groups = itemIds.length
      ? await this.database.pool.query<{
          id: string;
          menu_item_id: string;
          name: string;
          min_selections: number;
          max_selections: number;
          sort_order: number;
          version: number;
        }>(
          `SELECT id, menu_item_id, name, min_selections, max_selections,
                  sort_order, version
             FROM menu_option_groups
            WHERE tenant_id = $1 AND menu_item_id = ANY($2::uuid[])
              AND status = 'active'
            ORDER BY menu_item_id, sort_order, id`,
          [tenantId, itemIds],
        )
      : { rows: [] as never[] };
    const groupIds = groups.rows.map((row: { id: string }) => row.id);
    const choices = groupIds.length
      ? await this.database.pool.query<{
          id: string;
          group_id: string;
          name: string;
          price_delta_minor: string;
          version: number;
        }>(
          `SELECT id, group_id, name, price_delta_minor::text, version
             FROM menu_option_choices
            WHERE tenant_id = $1 AND group_id = ANY($2::uuid[])
              AND status = 'active'
            ORDER BY group_id, id`,
          [tenantId, groupIds],
        )
      : { rows: [] as never[] };

    const choicesByGroup = new Map<
      string,
      {
        id: string;
        name: string;
        priceDeltaMinor: string;
        version: number;
      }[]
    >();
    for (const choice of choices.rows) {
      const list = choicesByGroup.get(choice.group_id) ?? [];
      list.push({
        id: choice.id,
        name: choice.name,
        priceDeltaMinor: choice.price_delta_minor,
        version: choice.version,
      });
      choicesByGroup.set(choice.group_id, list);
    }
    const groupsByItem = new Map<string, BuyerOptionGroupView[]>();
    for (const group of groups.rows) {
      const list = groupsByItem.get(group.menu_item_id) ?? [];
      list.push({
        id: group.id,
        name: group.name,
        minSelections: group.min_selections,
        maxSelections: group.max_selections,
        sortOrder: group.sort_order,
        version: group.version,
        choices: choicesByGroup.get(group.id) ?? [],
      });
      groupsByItem.set(group.menu_item_id, list);
    }
    const itemsByCategory = new Map<string, BuyerMenuItemView[]>();
    for (const row of rows) {
      const list = itemsByCategory.get(row.category_id) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        description: row.description,
        priceMinor: row.price_minor,
        currency: row.currency as 'IDR',
        status: row.status,
        version: row.version,
        imageRef: row.image_ref,
        optionGroups: groupsByItem.get(row.id) ?? [],
      });
      itemsByCategory.set(row.category_id, list);
    }
    const categories = await this.database.pool.query<{
      id: string;
      name: string;
      sort_order: number;
    }>(
      `SELECT id, name, sort_order
         FROM menu_categories
        WHERE tenant_id = $1 AND status = 'active'
          AND ($2::uuid IS NULL OR id = $2)
        ORDER BY sort_order, id`,
      [tenantId, query.categoryId ?? null],
    );
    const data: BuyerCategoryView[] = [];
    for (const category of categories.rows) {
      const categoryItems = itemsByCategory.get(category.id);
      if (!categoryItems?.length) continue;
      data.push({
        id: category.id,
        name: category.name,
        sortOrder: category.sort_order,
        items: categoryItems,
      });
    }
    return {
      data: {
        tenantId,
        campusId: tenant.campusId,
        timezone: tenant.timezone,
        categories: data,
      },
      meta: { truncated },
    };
  }

  async getMenuItem(tenantId: string, itemId: string) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(itemId, 'itemId');
    const tenant = await this.requireVisibleTenant(tenantId);
    const item = await this.database.pool.query<{
      id: string;
      category_id: string;
      category_name: string;
      category_status: string;
      name: string;
      description: string;
      price_minor: string;
      currency: string;
      status: string;
      version: number;
      image_ref: string | null;
    }>(
      `SELECT mi.id, mi.category_id, cat.name AS category_name,
              cat.status AS category_status, mi.name, mi.description,
              mi.price_minor::text, mi.currency, mi.status, mi.version,
              mi.image_ref
         FROM menu_items mi
         JOIN menu_categories cat
           ON cat.tenant_id = mi.tenant_id AND cat.id = mi.category_id
        WHERE mi.tenant_id = $1 AND mi.id = $2`,
      [tenantId, itemId],
    );
    const row = item.rows[0];
    if (!row || row.status === 'archived' || row.category_status !== 'active') {
      throw new NotFoundException('Menu item not found');
    }
    const groups = await this.database.pool.query<{
      id: string;
      name: string;
      min_selections: number;
      max_selections: number;
      sort_order: number;
      version: number;
    }>(
      `SELECT id, name, min_selections, max_selections, sort_order, version
         FROM menu_option_groups
        WHERE tenant_id = $1 AND menu_item_id = $2 AND status = 'active'
        ORDER BY sort_order, id`,
      [tenantId, itemId],
    );
    const groupIds = groups.rows.map((group) => group.id);
    const choices = groupIds.length
      ? await this.database.pool.query<{
          id: string;
          group_id: string;
          name: string;
          price_delta_minor: string;
          version: number;
        }>(
          `SELECT id, group_id, name, price_delta_minor::text, version
             FROM menu_option_choices
            WHERE tenant_id = $1 AND group_id = ANY($2::uuid[])
              AND status = 'active'
            ORDER BY group_id, id`,
          [tenantId, groupIds],
        )
      : { rows: [] as never[] };
    const choicesByGroup = new Map<
      string,
      {
        id: string;
        name: string;
        priceDeltaMinor: string;
        version: number;
      }[]
    >();
    for (const choice of choices.rows) {
      const list = choicesByGroup.get(choice.group_id) ?? [];
      list.push({
        id: choice.id,
        name: choice.name,
        priceDeltaMinor: choice.price_delta_minor,
        version: choice.version,
      });
      choicesByGroup.set(choice.group_id, list);
    }
    return {
      data: {
        tenantId,
        campusId: tenant.campusId,
        timezone: tenant.timezone,
        item: {
          id: row.id,
          categoryId: row.category_id,
          categoryName: row.category_name,
          name: row.name,
          description: row.description,
          priceMinor: row.price_minor,
          currency: row.currency as 'IDR',
          status: row.status as 'active' | 'sold_out',
          version: row.version,
          imageRef: row.image_ref,
          optionGroups: groups.rows.map((group) => ({
            id: group.id,
            name: group.name,
            minSelections: group.min_selections,
            maxSelections: group.max_selections,
            sortOrder: group.sort_order,
            version: group.version,
            choices: choicesByGroup.get(group.id) ?? [],
          })),
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Tenant admin CRUD (permission tenant.menu.manage, enforced server-side)
  // ---------------------------------------------------------------------------

  async listAdminMenu(actorUserId: string, tenantId: string) {
    this.assertUuid(tenantId, 'tenantId');
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      'tenant.menu.manage',
    );
    const [categories, items, groups, choices] = await Promise.all([
      this.database.pool.query<CategoryDbRow>(
        `SELECT id, tenant_id, name, sort_order, status, ${TS_SELECT}
           FROM menu_categories WHERE tenant_id = $1
          ORDER BY sort_order, id LIMIT $2`,
        [tenantId, MAX_ADMIN_ROWS],
      ),
      this.database.pool.query<MenuItemDbRow>(
        `SELECT ${ITEM_SELECT}
           FROM menu_items WHERE tenant_id = $1
          ORDER BY name, id LIMIT $2`,
        [tenantId, MAX_ADMIN_ROWS],
      ),
      this.database.pool.query<OptionGroupDbRow>(
        `SELECT id, tenant_id, menu_item_id, name, min_selections,
                max_selections, sort_order, status, version, ${TS_SELECT}
           FROM menu_option_groups WHERE tenant_id = $1
          ORDER BY menu_item_id, sort_order, id LIMIT $2`,
        [tenantId, MAX_ADMIN_ROWS],
      ),
      this.database.pool.query<OptionChoiceDbRow>(
        `SELECT choice.id, choice.tenant_id, choice.group_id, choice.name,
                choice.price_delta_minor::text, choice.status, choice.version,
                to_char(choice.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                to_char(choice.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
           FROM menu_option_choices choice
          WHERE choice.tenant_id = $1
          ORDER BY choice.group_id, choice.id LIMIT $2`,
        [tenantId, MAX_ADMIN_ROWS],
      ),
    ]);
    return {
      data: {
        tenantId,
        categories: categories.rows.map((row) => this.mapCategory(row)),
        items: items.rows.map((row) => this.mapItem(row)),
        optionGroups: groups.rows.map((row) => this.mapGroup(row)),
        optionChoices: choices.rows.map((row) => this.mapChoice(row)),
      },
      meta: {
        truncated:
          categories.rows.length >= MAX_ADMIN_ROWS ||
          items.rows.length >= MAX_ADMIN_ROWS ||
          groups.rows.length >= MAX_ADMIN_ROWS ||
          choices.rows.length >= MAX_ADMIN_ROWS,
      },
    };
  }

  async createCategory(
    actorUserId: string,
    tenantId: string,
    input: CreateCategoryInput,
  ) {
    const name = this.normalizeName(input.name, 100, 'name');
    const sortOrder = this.normalizeSortOrder(input.sortOrder);
    this.assertUuid(tenantId, 'tenantId');
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      try {
        const result = await client.query<CategoryDbRow>(
          `INSERT INTO menu_categories (tenant_id, name, sort_order, status, updated_at)
           VALUES ($1, $2, $3, 'active', now())
           RETURNING id, tenant_id, name, sort_order, status, ${TS_SELECT}`,
          [tenantId, name, sortOrder ?? 0],
        );
        return { data: this.mapCategory(result.rows[0]) };
      } catch (error) {
        throw this.mapWriteError(error, 'Category name already exists');
      }
    });
  }

  async updateCategory(
    actorUserId: string,
    tenantId: string,
    categoryId: string,
    input: UpdateCategoryInput,
  ) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(categoryId, 'categoryId');
    const name =
      input.name !== undefined
        ? this.normalizeName(input.name, 100, 'name')
        : undefined;
    const sortOrder = this.normalizeSortOrder(input.sortOrder);
    const status = this.normalizeStatus(
      input.status,
      CATEGORY_STATUSES,
      'status',
    );
    if (name === undefined && sortOrder === undefined && status === undefined) {
      throw new BadRequestException(
        'Provide at least one field to update: name, sortOrder, or status',
      );
    }
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      const current = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM menu_categories
          WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, categoryId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Menu category not found');
      const statusAction = this.archiveAuditAction(
        'category',
        row.status,
        status ?? row.status,
      );
      const audit = this.planAudit(
        input.reason,
        statusAction
          ? [
              {
                action: statusAction,
                metadata: { oldStatus: row.status, newStatus: status },
              },
            ]
          : [],
      );
      try {
        const result = await client.query<CategoryDbRow>(
          `UPDATE menu_categories
              SET name = COALESCE($3, name),
                  sort_order = COALESCE($4, sort_order),
                  status = COALESCE($5, status),
                  updated_at = now()
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, tenant_id, name, sort_order, status, ${TS_SELECT}`,
          [tenantId, categoryId, name, sortOrder, status],
        );
        if (result.rowCount !== 1)
          throw new NotFoundException('Menu category not found');
        if (audit)
          await this.appendAudits(
            client,
            actorUserId,
            tenantId,
            'menu_category',
            categoryId,
            audit,
          );
        return { data: this.mapCategory(result.rows[0]) };
      } catch (error) {
        throw this.mapWriteError(error, 'Category name already exists');
      }
    });
  }

  /** Soft delete: archives the category; rows referenced by orders remain. */
  async archiveCategory(
    actorUserId: string,
    tenantId: string,
    categoryId: string,
    reason: string,
  ) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(categoryId, 'categoryId');
    const auditReason = this.requireReason(reason);
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      const result = await client.query<CategoryDbRow>(
        `UPDATE menu_categories
            SET status = 'archived', updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status <> 'archived'
          RETURNING id, tenant_id, name, sort_order, status, ${TS_SELECT}`,
        [tenantId, categoryId],
      );
      if (result.rowCount === 1) {
        await this.appendAudits(
          client,
          actorUserId,
          tenantId,
          'menu_category',
          categoryId,
          {
            reason: auditReason,
            events: [{ action: 'tenant.menu.category.archived' }],
          },
        );
        return { data: this.mapCategory(result.rows[0]) };
      }
      const existing = await client.query<CategoryDbRow>(
        `SELECT id, tenant_id, name, sort_order, status, ${TS_SELECT}
           FROM menu_categories WHERE tenant_id = $1 AND id = $2`,
        [tenantId, categoryId],
      );
      if (!existing.rows[0])
        throw new NotFoundException('Menu category not found');
      return { data: this.mapCategory(existing.rows[0]) };
    });
  }

  async createMenuItem(
    actorUserId: string,
    tenantId: string,
    input: CreateMenuItemInput,
  ) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(input.categoryId, 'categoryId');
    const name = this.normalizeName(input.name, 160, 'name');
    const description = this.normalizeDescription(input.description);
    const priceMinor = this.normalizeMinorInput(input.priceMinor, 'priceMinor');
    const status = this.normalizeStatus(
      input.status ?? 'active',
      ['active', 'sold_out'],
      'status',
    );
    const imageRef = this.normalizeImageRef(input.imageRef);
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      await this.requireActiveCategory(client, tenantId, input.categoryId);
      const result = await client.query<MenuItemDbRow>(
        `INSERT INTO menu_items
           (tenant_id, category_id, name, description, price_minor, currency,
            status, version, image_ref, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'IDR', $6, 1, $7, now())
         RETURNING ${ITEM_SELECT}`,
        [
          tenantId,
          input.categoryId,
          name,
          description ?? '',
          priceMinor,
          status,
          imageRef ? imageRef : null,
        ],
      );
      return { data: this.mapItem(result.rows[0]) };
    });
  }

  async updateMenuItem(
    actorUserId: string,
    tenantId: string,
    itemId: string,
    input: UpdateMenuItemInput,
  ) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(itemId, 'itemId');
    this.assertExpectedVersion(input.expectedVersion);
    const name =
      input.name !== undefined
        ? this.normalizeName(input.name, 160, 'name')
        : undefined;
    const description = this.normalizeDescription(input.description);
    const priceMinor =
      input.priceMinor !== undefined
        ? this.normalizeMinorInput(input.priceMinor, 'priceMinor')
        : undefined;
    const status = this.normalizeStatus(input.status, ITEM_STATUSES, 'status');
    const imageRef = this.normalizeImageRef(input.imageRef);
    if (
      name === undefined &&
      description === undefined &&
      priceMinor === undefined &&
      input.categoryId === undefined &&
      status === undefined &&
      imageRef === undefined
    ) {
      throw new BadRequestException('Provide at least one field to update');
    }
    if (input.categoryId !== undefined)
      this.assertUuid(input.categoryId, 'categoryId');
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      const current = await client.query<{
        id: string;
        version: number;
        price_minor: string;
        status: string;
      }>(
        `SELECT id, version, price_minor::text, status FROM menu_items
          WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, itemId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Menu item not found');
      if (row.version !== input.expectedVersion)
        throw new ConflictException('Menu item changed');
      const events: CatalogAuditEvent[] = [];
      if (priceMinor !== undefined && priceMinor !== row.price_minor) {
        events.push({
          action: 'tenant.menu.item.price_changed',
          metadata: {
            oldPriceMinor: row.price_minor,
            newPriceMinor: priceMinor,
          },
        });
      }
      const statusAction = this.itemStatusAuditAction(
        row.status,
        status ?? row.status,
      );
      if (statusAction) {
        events.push({
          action: statusAction,
          metadata: { oldStatus: row.status, newStatus: status },
        });
      }
      const audit = this.planAudit(input.reason, events);
      if (input.categoryId !== undefined)
        await this.requireActiveCategory(client, tenantId, input.categoryId);
      const result = await client.query<MenuItemDbRow>(
        `UPDATE menu_items
            SET name = COALESCE($3, name),
                description = COALESCE($4, description),
                price_minor = COALESCE($5, price_minor),
                category_id = COALESCE($6, category_id),
                status = COALESCE($7, status),
                image_ref = CASE
                  WHEN $9::text IS NOT NULL THEN NULLIF($9, '')
                  ELSE image_ref
                END,
                archived_at = CASE
                  WHEN $7::varchar IS NULL THEN archived_at
                  WHEN $7::varchar = 'archived' THEN now()
                  ELSE NULL
                END,
                version = version + 1,
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND version = $8
          RETURNING ${ITEM_SELECT}`,
        [
          tenantId,
          itemId,
          name,
          description,
          priceMinor,
          input.categoryId ?? null,
          status,
          input.expectedVersion,
          imageRef,
        ],
      );
      if (result.rowCount !== 1)
        throw new ConflictException('Menu item changed');
      if (audit)
        await this.appendAudits(
          client,
          actorUserId,
          tenantId,
          'menu_item',
          itemId,
          audit,
        );
      return { data: this.mapItem(result.rows[0]) };
    });
  }

  /** Soft delete: archives the item; order snapshots never reference live rows. */
  async archiveMenuItem(
    actorUserId: string,
    tenantId: string,
    itemId: string,
    reason: string,
  ) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(itemId, 'itemId');
    const auditReason = this.requireReason(reason);
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      const result = await client.query<MenuItemDbRow>(
        `UPDATE menu_items
            SET status = 'archived', archived_at = now(),
                version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status <> 'archived'
          RETURNING ${ITEM_SELECT}`,
        [tenantId, itemId],
      );
      if (result.rowCount === 1) {
        await this.appendAudits(
          client,
          actorUserId,
          tenantId,
          'menu_item',
          itemId,
          {
            reason: auditReason,
            events: [{ action: 'tenant.menu.item.archived' }],
          },
        );
        return { data: this.mapItem(result.rows[0]) };
      }
      const existing = await client.query<MenuItemDbRow>(
        `SELECT ${ITEM_SELECT}
           FROM menu_items WHERE tenant_id = $1 AND id = $2`,
        [tenantId, itemId],
      );
      if (!existing.rows[0]) throw new NotFoundException('Menu item not found');
      return { data: this.mapItem(existing.rows[0]) };
    });
  }

  async createOptionGroup(
    actorUserId: string,
    tenantId: string,
    menuItemId: string,
    input: CreateOptionGroupInput,
  ) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(menuItemId, 'menuItemId');
    const name = this.normalizeName(input.name, 100, 'name');
    const minSelections = this.normalizeSelectionCount(
      input.minSelections ?? 0,
      'minSelections',
      0,
    );
    const maxSelections = this.normalizeSelectionCount(
      input.maxSelections ?? 1,
      'maxSelections',
      1,
    );
    this.assertSelectionBounds(minSelections, maxSelections);
    const sortOrder = this.normalizeSortOrder(input.sortOrder);
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      await this.requireMenuItem(client, tenantId, menuItemId);
      const result = await client.query<OptionGroupDbRow>(
        `INSERT INTO menu_option_groups
           (tenant_id, menu_item_id, name, min_selections, max_selections,
            sort_order, status, version, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', 1, now())
         RETURNING id, tenant_id, menu_item_id, name, min_selections,
                   max_selections, sort_order, status, version, ${TS_SELECT}`,
        [
          tenantId,
          menuItemId,
          name,
          minSelections,
          maxSelections,
          sortOrder ?? 0,
        ],
      );
      await this.bumpMenuItemVersion(client, tenantId, menuItemId);
      return { data: this.mapGroup(result.rows[0]) };
    });
  }

  async updateOptionGroup(
    actorUserId: string,
    tenantId: string,
    groupId: string,
    input: UpdateOptionGroupInput,
  ) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(groupId, 'groupId');
    this.assertExpectedVersion(input.expectedVersion);
    const name =
      input.name !== undefined
        ? this.normalizeName(input.name, 100, 'name')
        : undefined;
    const sortOrder = this.normalizeSortOrder(input.sortOrder);
    const status = this.normalizeStatus(
      input.status,
      CATEGORY_STATUSES,
      'status',
    );
    if (
      name === undefined &&
      input.minSelections === undefined &&
      input.maxSelections === undefined &&
      sortOrder === undefined &&
      status === undefined
    ) {
      throw new BadRequestException('Provide at least one field to update');
    }
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      const current = await client.query<{
        id: string;
        menu_item_id: string;
        min_selections: number;
        max_selections: number;
        status: string;
        version: number;
      }>(
        `SELECT id, menu_item_id, min_selections, max_selections, status,
                version
           FROM menu_option_groups
          WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, groupId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Option group not found');
      if (row.version !== input.expectedVersion)
        throw new ConflictException('Option group changed');
      const statusAction = this.archiveAuditAction(
        'option_group',
        row.status,
        status ?? row.status,
      );
      const audit = this.planAudit(
        input.reason,
        statusAction
          ? [
              {
                action: statusAction,
                metadata: { oldStatus: row.status, newStatus: status },
              },
            ]
          : [],
      );
      const minSelections =
        input.minSelections !== undefined
          ? this.normalizeSelectionCount(
              input.minSelections,
              'minSelections',
              0,
            )
          : row.min_selections;
      const maxSelections =
        input.maxSelections !== undefined
          ? this.normalizeSelectionCount(
              input.maxSelections,
              'maxSelections',
              1,
            )
          : row.max_selections;
      this.assertSelectionBounds(minSelections, maxSelections);
      const result = await client.query<OptionGroupDbRow>(
        `UPDATE menu_option_groups
            SET name = COALESCE($3, name),
                min_selections = $4,
                max_selections = $5,
                sort_order = COALESCE($6, sort_order),
                status = COALESCE($7, status),
                version = version + 1,
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND version = $8
          RETURNING id, tenant_id, menu_item_id, name, min_selections,
                    max_selections, sort_order, status, version, ${TS_SELECT}`,
        [
          tenantId,
          groupId,
          name,
          minSelections,
          maxSelections,
          sortOrder,
          status,
          input.expectedVersion,
        ],
      );
      if (result.rowCount !== 1)
        throw new ConflictException('Option group changed');
      if (audit)
        await this.appendAudits(
          client,
          actorUserId,
          tenantId,
          'menu_option_group',
          groupId,
          audit,
        );
      await this.bumpMenuItemVersion(client, tenantId, row.menu_item_id);
      return { data: this.mapGroup(result.rows[0]) };
    });
  }

  /** Soft delete: archives the group so quotes stop offering its choices. */
  async archiveOptionGroup(
    actorUserId: string,
    tenantId: string,
    groupId: string,
    reason: string,
  ) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(groupId, 'groupId');
    const auditReason = this.requireReason(reason);
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      const result = await client.query<OptionGroupDbRow>(
        `UPDATE menu_option_groups
            SET status = 'archived', version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status <> 'archived'
          RETURNING id, tenant_id, menu_item_id, name, min_selections,
                    max_selections, sort_order, status, version, ${TS_SELECT}`,
        [tenantId, groupId],
      );
      if (result.rowCount === 1) {
        await this.appendAudits(
          client,
          actorUserId,
          tenantId,
          'menu_option_group',
          groupId,
          {
            reason: auditReason,
            events: [{ action: 'tenant.menu.option_group.archived' }],
          },
        );
        await this.bumpMenuItemVersion(
          client,
          tenantId,
          result.rows[0].menu_item_id,
        );
        return { data: this.mapGroup(result.rows[0]) };
      }
      const existing = await client.query<OptionGroupDbRow>(
        `SELECT id, tenant_id, menu_item_id, name, min_selections,
                max_selections, sort_order, status, version, ${TS_SELECT}
           FROM menu_option_groups WHERE tenant_id = $1 AND id = $2`,
        [tenantId, groupId],
      );
      if (!existing.rows[0])
        throw new NotFoundException('Option group not found');
      return { data: this.mapGroup(existing.rows[0]) };
    });
  }

  async createOptionChoice(
    actorUserId: string,
    tenantId: string,
    groupId: string,
    input: CreateOptionChoiceInput,
  ) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(groupId, 'groupId');
    const name = this.normalizeName(input.name, 100, 'name');
    const priceDeltaMinor = this.normalizeMinorInput(
      input.priceDeltaMinor ?? '0',
      'priceDeltaMinor',
    );
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      const group = await this.requireOptionGroup(client, tenantId, groupId);
      try {
        const result = await client.query<OptionChoiceDbRow>(
          `INSERT INTO menu_option_choices
             (tenant_id, group_id, name, price_delta_minor, status, version, updated_at)
           VALUES ($1, $2, $3, $4, 'active', 1, now())
           RETURNING id, tenant_id, group_id, name, price_delta_minor::text,
                     status, version, ${TS_SELECT}`,
          [tenantId, groupId, name, priceDeltaMinor],
        );
        await this.bumpOptionGroupVersion(client, tenantId, groupId);
        await this.bumpMenuItemVersion(client, tenantId, group.menu_item_id);
        return { data: this.mapChoice(result.rows[0]) };
      } catch (error) {
        throw this.mapWriteError(error, 'Option name already exists in group');
      }
    });
  }

  async updateOptionChoice(
    actorUserId: string,
    tenantId: string,
    choiceId: string,
    input: UpdateOptionChoiceInput,
  ) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(choiceId, 'choiceId');
    this.assertExpectedVersion(input.expectedVersion);
    const name =
      input.name !== undefined
        ? this.normalizeName(input.name, 100, 'name')
        : undefined;
    const priceDeltaMinor =
      input.priceDeltaMinor !== undefined
        ? this.normalizeMinorInput(input.priceDeltaMinor, 'priceDeltaMinor')
        : undefined;
    const status = this.normalizeStatus(
      input.status,
      CATEGORY_STATUSES,
      'status',
    );
    if (
      name === undefined &&
      priceDeltaMinor === undefined &&
      status === undefined
    ) {
      throw new BadRequestException('Provide at least one field to update');
    }
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      const current = await client.query<{
        id: string;
        group_id: string;
        menu_item_id: string;
        price_delta_minor: string;
        status: string;
        version: number;
      }>(
        `SELECT choice.id, choice.group_id, grp.menu_item_id,
                choice.price_delta_minor::text, choice.status, choice.version
           FROM menu_option_choices choice
           JOIN menu_option_groups grp
             ON grp.tenant_id = choice.tenant_id AND grp.id = choice.group_id
          WHERE choice.tenant_id = $1 AND choice.id = $2
          FOR UPDATE OF choice`,
        [tenantId, choiceId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Option choice not found');
      if (row.version !== input.expectedVersion)
        throw new ConflictException('Option choice changed');
      const events: CatalogAuditEvent[] = [];
      if (
        priceDeltaMinor !== undefined &&
        priceDeltaMinor !== row.price_delta_minor
      ) {
        events.push({
          action: 'tenant.menu.option.price_changed',
          metadata: {
            oldPriceDeltaMinor: row.price_delta_minor,
            newPriceDeltaMinor: priceDeltaMinor,
          },
        });
      }
      const statusAction = this.archiveAuditAction(
        'option',
        row.status,
        status ?? row.status,
      );
      if (statusAction) {
        events.push({
          action: statusAction,
          metadata: { oldStatus: row.status, newStatus: status },
        });
      }
      const audit = this.planAudit(input.reason, events);
      try {
        const result = await client.query<OptionChoiceDbRow>(
          `UPDATE menu_option_choices
              SET name = COALESCE($3, name),
                  price_delta_minor = COALESCE($4, price_delta_minor),
                  status = COALESCE($5, status),
                  version = version + 1,
                  updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND version = $6
            RETURNING id, tenant_id, group_id, name, price_delta_minor::text,
                      status, version, ${TS_SELECT}`,
          [
            tenantId,
            choiceId,
            name,
            priceDeltaMinor,
            status,
            input.expectedVersion,
          ],
        );
        if (result.rowCount !== 1)
          throw new ConflictException('Option choice changed');
        if (audit)
          await this.appendAudits(
            client,
            actorUserId,
            tenantId,
            'menu_option_choice',
            choiceId,
            audit,
          );
        await this.bumpOptionGroupVersion(client, tenantId, row.group_id);
        await this.bumpMenuItemVersion(client, tenantId, row.menu_item_id);
        return { data: this.mapChoice(result.rows[0]) };
      } catch (error) {
        throw this.mapWriteError(error, 'Option name already exists in group');
      }
    });
  }

  /** Soft delete: archives the choice; quotes stop pricing it. */
  async archiveOptionChoice(
    actorUserId: string,
    tenantId: string,
    choiceId: string,
    reason: string,
  ) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(choiceId, 'choiceId');
    const auditReason = this.requireReason(reason);
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.menu.manage',
        client,
      );
      const current = await client.query<{
        id: string;
        group_id: string;
        menu_item_id: string;
      }>(
        `SELECT choice.id, choice.group_id, grp.menu_item_id
           FROM menu_option_choices choice
           JOIN menu_option_groups grp
             ON grp.tenant_id = choice.tenant_id AND grp.id = choice.group_id
          WHERE choice.tenant_id = $1 AND choice.id = $2
          FOR UPDATE OF choice`,
        [tenantId, choiceId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Option choice not found');
      const result = await client.query<OptionChoiceDbRow>(
        `UPDATE menu_option_choices
            SET status = 'archived', version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status <> 'archived'
          RETURNING id, tenant_id, group_id, name, price_delta_minor::text,
                    status, version, ${TS_SELECT}`,
        [tenantId, choiceId],
      );
      if (result.rowCount === 1) {
        await this.appendAudits(
          client,
          actorUserId,
          tenantId,
          'menu_option_choice',
          choiceId,
          {
            reason: auditReason,
            events: [{ action: 'tenant.menu.option.archived' }],
          },
        );
        await this.bumpOptionGroupVersion(client, tenantId, row.group_id);
        await this.bumpMenuItemVersion(client, tenantId, row.menu_item_id);
        return { data: this.mapChoice(result.rows[0]) };
      }
      const existing = await client.query<OptionChoiceDbRow>(
        `SELECT id, tenant_id, group_id, name, price_delta_minor::text,
                status, version, ${TS_SELECT}
           FROM menu_option_choices WHERE tenant_id = $1 AND id = $2`,
        [tenantId, choiceId],
      );
      if (!existing.rows[0])
        throw new NotFoundException('Option choice not found');
      return { data: this.mapChoice(existing.rows[0]) };
    });
  }

  // ---------------------------------------------------------------------------
  // Shared internals
  // ---------------------------------------------------------------------------

  private async requireVisibleTenant(tenantId: string) {
    const result = await this.database.pool.query<{
      id: string;
      campus_id: string;
      timezone: string;
    }>(
      `SELECT t.id, t.campus_id, c.timezone
         FROM tenants t JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND t.status <> 'archived' AND c.status = 'active'`,
      [tenantId],
    );
    const tenant = result.rows[0];
    if (!tenant) throw new NotFoundException('Tenant not found');
    return { campusId: tenant.campus_id, timezone: tenant.timezone };
  }

  private async requireMenuItem(
    client: PoolClient,
    tenantId: string,
    itemId: string,
  ) {
    const result = await client.query<{ id: string }>(
      'SELECT id FROM menu_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [tenantId, itemId],
    );
    if (!result.rows[0]) throw new NotFoundException('Menu item not found');
    return result.rows[0];
  }

  private async requireOptionGroup(
    client: PoolClient,
    tenantId: string,
    groupId: string,
  ) {
    const result = await client.query<{ id: string; menu_item_id: string }>(
      `SELECT id, menu_item_id FROM menu_option_groups
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, groupId],
    );
    if (!result.rows[0]) throw new NotFoundException('Option group not found');
    return result.rows[0];
  }

  private async requireActiveCategory(
    client: PoolClient,
    tenantId: string,
    categoryId: string,
  ) {
    const result = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM menu_categories WHERE tenant_id = $1 AND id = $2',
      [tenantId, categoryId],
    );
    const category = result.rows[0];
    if (!category) throw new NotFoundException('Menu category not found');
    if (category.status !== 'active')
      throw new ConflictException('Menu category is archived');
    return category;
  }

  private async bumpMenuItemVersion(
    client: PoolClient,
    tenantId: string,
    itemId: string,
  ) {
    await client.query(
      'UPDATE menu_items SET version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2',
      [tenantId, itemId],
    );
  }

  private async bumpOptionGroupVersion(
    client: PoolClient,
    tenantId: string,
    groupId: string,
  ) {
    await client.query(
      'UPDATE menu_option_groups SET version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2',
      [tenantId, groupId],
    );
  }

  private async withTransaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private validateQuoteInput(
    tenantId: string,
    slotId: string,
    items: readonly QuoteItemInput[],
  ): void {
    if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(slotId)) {
      throw new BadRequestException('Invalid tenant or pickup slot id');
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
      throw new BadRequestException('Quote must contain 1 to 50 menu items');
    }
    const ids = new Set<string>();
    for (const item of items) {
      if (
        !UUID_PATTERN.test(item.menuItemId) ||
        ids.has(item.menuItemId) ||
        !Array.isArray(item.optionIds) ||
        item.optionIds.length > 50 ||
        new Set(item.optionIds).size !== item.optionIds.length ||
        item.optionIds.some(
          (id: unknown) => typeof id !== 'string' || !UUID_PATTERN.test(id),
        )
      ) {
        throw new BadRequestException('Invalid quote line');
      }
      // Operational pilot bound (DB allows 1..999): keep quotes orderable.
      if (
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > MAX_QUOTE_LINE_QUANTITY
      ) {
        throw new BadRequestException(
          `Quote line quantity must be an integer between 1 and ${MAX_QUOTE_LINE_QUANTITY}`,
        );
      }
      ids.add(item.menuItemId);
    }
  }

  private parseMinor(value: string): bigint {
    if (!/^(0|[1-9]\d{0,37})$/.test(value)) {
      throw new ConflictException('Menu price is invalid');
    }
    return BigInt(value);
  }

  private normalizeMinor(value: string): string {
    return this.parseMinor(value).toString();
  }

  private assertUuid(value: string, field: string): void {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new BadRequestException(`Invalid ${field}`);
    }
  }

  private assertExpectedVersion(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new BadRequestException(
        'expectedVersion must be a positive integer',
      );
    }
  }

  private normalizeName(
    value: string,
    maxLength: number,
    field: string,
  ): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(
        `${field} must be 1 to ${maxLength} characters`,
      );
    }
    return normalized;
  }

  private normalizeDescription(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 2000) {
      throw new BadRequestException(
        'description must be at most 2000 characters',
      );
    }
    return value;
  }

  private normalizeMinorInput(value: string, field: string): string {
    if (typeof value !== 'string' || !MINOR_INPUT_PATTERN.test(value)) {
      throw new BadRequestException(
        `${field} must be a non-negative integer decimal string`,
      );
    }
    return value;
  }

  /**
   * Three-state image reference: undefined = leave untouched, '' = clear to
   * NULL, any other value (<= 500 chars, trimmed) = set. Keeping '' distinct
   * from undefined matters for the UPDATE CASE: pg binds undefined as NULL
   * ("no change"), while NULLIF($n, '') turns the empty string into an
   * explicit clear.
   */
  private normalizeImageRef(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 500) {
      throw new BadRequestException('imageRef must be at most 500 characters');
    }
    return value.trim();
  }

  private normalizeSortOrder(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
      throw new BadRequestException('sortOrder must be an integer >= 0');
    }
    return value;
  }

  private normalizeSelectionCount(
    value: number,
    field: string,
    min: number,
  ): number {
    if (
      !Number.isSafeInteger(value) ||
      value < min ||
      value > MAX_SELECTIONS_LIMIT
    ) {
      throw new BadRequestException(
        `${field} must be an integer between ${min} and ${MAX_SELECTIONS_LIMIT}`,
      );
    }
    return value;
  }

  private assertSelectionBounds(minSelections: number, maxSelections: number) {
    if (minSelections > maxSelections) {
      throw new BadRequestException(
        'minSelections cannot exceed maxSelections',
      );
    }
  }

  private normalizeStatus<T extends string>(
    value: T | undefined,
    allowed: readonly T[],
    field: string,
  ): T | undefined {
    if (value === undefined) return undefined;
    if (!allowed.includes(value)) {
      throw new BadRequestException(
        `${field} must be one of: ${allowed.join(', ')}`,
      );
    }
    return value;
  }

  private normalizeBuyerStatuses(value: string | undefined): readonly string[] {
    if (value === undefined) return BUYER_ITEM_STATUSES;
    if (!(BUYER_ITEM_STATUSES as readonly string[]).includes(value)) {
      throw new BadRequestException('status must be one of: active, sold_out');
    }
    return [value];
  }

  private normalizeSearch(value: string | undefined): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !value.trim() || value.length > 100) {
      throw new BadRequestException('search must be 1 to 100 characters');
    }
    // Escape LIKE metacharacters so search terms match literally.
    return value.trim().replace(/[\\%_]/g, (character) => `\\${character}`);
  }

  private requireReason(reason: string | undefined): string {
    const normalized = typeof reason === 'string' ? reason.trim() : '';
    if (!normalized || normalized.length > 300) {
      throw new BadRequestException(
        'A reason of 1 to 300 characters is required for money or status changes',
      );
    }
    return normalized;
  }

  /**
   * Bundles the audit events a mutation must write. When at least one event
   * applies, the DTO reason becomes mandatory (root decision: money/status
   * changes are manager decisions and must be audited with actor + reason).
   */
  private planAudit(
    reason: string | undefined,
    events: CatalogAuditEvent[],
  ): PlannedAudit | null {
    if (events.length === 0) return null;
    return { reason: this.requireReason(reason), events };
  }

  private async appendAudits(
    client: PoolClient,
    actorUserId: string,
    tenantId: string,
    targetType: CatalogAuditTarget,
    targetId: string,
    planned: PlannedAudit,
  ): Promise<void> {
    for (const event of planned.events) {
      await this.audit.append(client, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: event.action,
        targetType,
        targetId,
        reason: planned.reason,
        ...(event.metadata ? { metadata: event.metadata } : {}),
      });
    }
  }

  private itemStatusAuditAction(
    oldStatus: string,
    newStatus: string,
  ): string | null {
    if (oldStatus === newStatus) return null;
    if (newStatus === 'archived') return 'tenant.menu.item.archived';
    if (oldStatus === 'archived') return 'tenant.menu.item.restored';
    if (newStatus === 'sold_out') return 'tenant.menu.item.sold_out';
    return 'tenant.menu.item.available';
  }

  private archiveAuditAction(
    kind: 'category' | 'option_group' | 'option',
    oldStatus: string,
    newStatus: string,
  ): string | null {
    if (oldStatus === newStatus) return null;
    return newStatus === 'archived'
      ? `tenant.menu.${kind}.archived`
      : `tenant.menu.${kind}.restored`;
  }

  private mapWriteError(error: unknown, uniqueMessage: string): unknown {
    if (this.isUniqueViolation(error))
      return new ConflictException(uniqueMessage);
    return error;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }

  private mapCategory(row: CategoryDbRow): CategoryView {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      sortOrder: row.sort_order,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapItem(row: MenuItemDbRow): MenuItemView {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      categoryId: row.category_id,
      name: row.name,
      description: row.description,
      priceMinor: row.price_minor,
      currency: row.currency as 'IDR',
      status: row.status,
      version: row.version,
      imageRef: row.image_ref,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapGroup(row: OptionGroupDbRow): OptionGroupView {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      menuItemId: row.menu_item_id,
      name: row.name,
      minSelections: row.min_selections,
      maxSelections: row.max_selections,
      sortOrder: row.sort_order,
      status: row.status,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapChoice(row: OptionChoiceDbRow): OptionChoiceView {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      groupId: row.group_id,
      name: row.name,
      priceDeltaMinor: row.price_delta_minor,
      status: row.status,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
