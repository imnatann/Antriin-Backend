import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
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

const MAX_MINOR = 10n ** 38n - 1n;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class CatalogService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly availability: AvailabilityService,
  ) {}

  async quote(
    client: PoolClient,
    tenantId: string,
    slotId: string,
    items: readonly QuoteItemInput[],
  ): Promise<OrderQuote> {
    this.validateQuoteInput(tenantId, slotId, items);
    const slot = await this.availability.assertBookableSlot(
      client,
      tenantId,
      slotId,
      'share',
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
    const choicesByGroup = new Map<string, OptionChoiceRow[]>();
    for (const choice of choiceResult.rows) {
      const choices = choicesByGroup.get(choice.group_id) ?? [];
      choices.push(choice);
      choicesByGroup.set(choice.group_id, choices);
    }

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
      .update(JSON.stringify(snapshot))
      .digest('hex');
    return { quoteHash, ...snapshot };
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
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        !Array.isArray(item.optionIds) ||
        item.optionIds.length > 50 ||
        new Set(item.optionIds).size !== item.optionIds.length ||
        item.optionIds.some(
          (id: unknown) => typeof id !== 'string' || !UUID_PATTERN.test(id),
        )
      ) {
        throw new BadRequestException('Invalid quote line');
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
}
