import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AvailabilityService } from '../src/modules/availability/availability.service';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { TenantOperatingHoursService } from '../src/modules/tenants/tenant-operating-hours.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const MICRO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function httpStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'getStatus' in error
    ? (error as { getStatus(): number }).getStatus()
    : undefined;
}

function pgCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

describe('Catalog PostgreSQL integration', { skip: !testDatabaseUrl }, () => {
  let pool: Pool;
  let access: AccessService;
  let availability: AvailabilityService;
  let audit: AuditService;
  let catalog: CatalogService;

  let campusA: string;
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let ownerB: string;
  let kitchenMenuA: string;
  let kitchenNoMenuA: string;
  let pickupMenuA: string;
  let stranger: string;
  let slotA: string;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl, max: 12 });
    await pool.query('select 1');
    const database = { pool } as unknown as DatabaseService;
    access = new AccessService(database);
    audit = new AuditService(database, access);
    const operatingHours = new TenantOperatingHoursService(
      database,
      access,
      audit,
    );
    availability = new AvailabilityService(
      database,
      access,
      operatingHours,
      audit,
    );
    catalog = new CatalogService(database, access, availability, audit);

    campusA = randomUUID();
    const campusB = randomUUID();
    tenantA = randomUUID();
    tenantB = randomUUID();
    ownerA = randomUUID();
    ownerB = randomUUID();
    kitchenMenuA = randomUUID();
    kitchenNoMenuA = randomUUID();
    pickupMenuA = randomUUID();
    stranger = randomUUID();

    await pool.query(
      `INSERT INTO campuses (id, name, timezone, status)
         VALUES ($1, 'Catalog campus A', 'Asia/Jakarta', 'active'),
                ($2, 'Catalog campus B', 'Asia/Jakarta', 'active')`,
      [campusA, campusB],
    );
    await pool.query(
      `INSERT INTO tenants (id, campus_id, name, location, status)
         VALUES ($1, $3, 'Catalog tenant A', 'Kantin A', 'open'),
                ($2, $4, 'Catalog tenant B', 'Kantin B', 'open')`,
      [tenantA, tenantB, campusA, campusB],
    );
    await pool.query(
      `INSERT INTO users (id, display_name, status)
         VALUES ($1, 'Catalog owner A', 'active'),
                ($2, 'Catalog owner B', 'active'),
                ($3, 'Catalog kitchen with menu', 'active'),
                ($4, 'Catalog kitchen without menu', 'active'),
                ($5, 'Catalog pickup with forged menu grant', 'active'),
                ($6, 'Catalog stranger', 'active')`,
      [ownerA, ownerB, kitchenMenuA, kitchenNoMenuA, pickupMenuA, stranger],
    );
    await pool.query(
      `INSERT INTO tenant_memberships
           (tenant_id, user_id, role, permissions, owner_verified_at)
         VALUES ($1, $3, 'owner', '{}'::text[], now()),
                ($2, $4, 'owner', '{}'::text[], now()),
                ($1, $5, 'kitchen', ARRAY['tenant.menu.manage']::text[], NULL),
                ($1, $6, 'kitchen', ARRAY['tenant.orders.read']::text[], NULL),
                ($1, $7, 'pickup', ARRAY['tenant.menu.manage']::text[], NULL)`,
      [
        tenantA,
        tenantB,
        ownerA,
        ownerB,
        kitchenMenuA,
        kitchenNoMenuA,
        pickupMenuA,
      ],
    );
    // Weekly operating hours covering any local weekday (tenant-campus slice
    // owns these tables; the fixture only inserts rows, never changes them).
    for (const tenant of [tenantA, tenantB]) {
      for (let weekday = 0; weekday < 7; weekday += 1) {
        await pool.query(
          `INSERT INTO tenant_operating_hours
               (tenant_id, weekday, is_open, opens_at, closes_at, updated_at)
             VALUES ($1, $2, true, '00:00:00', '23:59:59', now())`,
          [tenant, weekday],
        );
      }
    }
    // Open slot two days ahead, 12:00-13:00 Asia/Jakarta (05:00-06:00 UTC).
    const startsAt = new Date();
    startsAt.setUTCHours(5, 0, 0, 0);
    startsAt.setUTCDate(startsAt.getUTCDate() + 2);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const slot = await pool.query<{ id: string }>(
      `INSERT INTO pickup_slots
           (tenant_id, starts_at, ends_at, capacity, status, updated_at)
         VALUES ($1, $2, $3, 5, 'open', now())
         RETURNING id`,
      [tenantA, startsAt.toISOString(), endsAt.toISOString()],
    );
    slotA = slot.rows[0].id;
  });

  after(async () => {
    // Fixtures live only in the isolated, disposable TEST_DATABASE_URL.
    await pool?.end();
  });

  async function seedItem(
    tenantId: string,
    actor: string,
    options: { priceMinor?: string; name?: string } = {},
  ) {
    const category = await catalog.createCategory(actor, tenantId, {
      name: `Category ${randomUUID()}`,
    });
    const item = await catalog.createMenuItem(actor, tenantId, {
      categoryId: category.data.id,
      name: options.name ?? `Item ${randomUUID()}`,
      priceMinor: options.priceMinor ?? '10000',
    });
    return { categoryId: category.data.id, itemId: item.data.id };
  }

  async function readItemVersion(itemId: string): Promise<number> {
    const result = await pool.query<{ version: number }>(
      'SELECT version FROM menu_items WHERE id = $1',
      [itemId],
    );
    return result.rows[0].version;
  }

  it('creates categories, items, groups and choices with versioned updates', async () => {
    const category = await catalog.createCategory(ownerA, tenantA, {
      name: `Makanan ${randomUUID()}`,
      sortOrder: 3,
    });
    assert.equal(category.data.status, 'active');
    assert.equal(category.data.sortOrder, 3);
    assert.equal(category.data.tenantId, tenantA);
    assert.match(category.data.updatedAt, MICRO_TS);

    const item = await catalog.createMenuItem(ownerA, tenantA, {
      categoryId: category.data.id,
      name: 'Nasi Ayam Sambal',
      description: 'Ayam goreng + sambal',
      priceMinor: '15000',
    });
    assert.equal(item.data.version, 1);
    assert.equal(item.data.priceMinor, '15000');
    assert.equal(item.data.currency, 'IDR');
    assert.equal(item.data.status, 'active');
    assert.match(item.data.updatedAt, MICRO_TS);

    const group = await catalog.createOptionGroup(
      ownerA,
      tenantA,
      item.data.id,
      {
        name: 'Tingkat Sambal',
        minSelections: 1,
        maxSelections: 1,
      },
    );
    assert.equal(group.data.version, 1);
    assert.equal(group.data.minSelections, 1);
    // Option composition changed, so the parent item version must bump.
    assert.equal(await readItemVersion(item.data.id), 2);

    const choice = await catalog.createOptionChoice(
      ownerA,
      tenantA,
      group.data.id,
      {
        name: 'Ekstra',
        priceDeltaMinor: '2000',
      },
    );
    assert.equal(choice.data.version, 1);
    assert.equal(choice.data.priceDeltaMinor, '2000');
    assert.equal(await readItemVersion(item.data.id), 3);

    const updatedItem = await catalog.updateMenuItem(
      ownerA,
      tenantA,
      item.data.id,
      {
        priceMinor: '16000',
        expectedVersion: 3,
        reason: 'Adjust price for promo end',
      },
    );
    assert.equal(updatedItem.data.version, 4);
    assert.equal(updatedItem.data.priceMinor, '16000');

    const updatedChoice = await catalog.updateOptionChoice(
      ownerA,
      tenantA,
      choice.data.id,
      {
        priceDeltaMinor: '2500',
        expectedVersion: 1,
        reason: 'Adjust chili surcharge',
      },
    );
    assert.equal(updatedChoice.data.version, 2);
    assert.equal(updatedChoice.data.priceDeltaMinor, '2500');
    // Choice change bumps both the group version and the parent item version.
    assert.equal(await readItemVersion(item.data.id), 5);
    const groupRow = await pool.query<{ version: number }>(
      'SELECT version FROM menu_option_groups WHERE id = $1',
      [group.data.id],
    );
    assert.equal(groupRow.rows[0].version, 3);

    // Stale expectedVersion is rejected with a conflict.
    await assert.rejects(
      catalog.updateMenuItem(ownerA, tenantA, item.data.id, {
        priceMinor: '17000',
        expectedVersion: 4,
      }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 409);
        return true;
      },
    );
    // Empty update payloads are rejected.
    await assert.rejects(
      catalog.updateMenuItem(ownerA, tenantA, item.data.id, {
        expectedVersion: 5,
      }),
      /at least one field/i,
    );
  });

  it('serializes concurrent item updates through row lock plus version guard', async () => {
    const { itemId } = await seedItem(tenantA, ownerA, { priceMinor: '10000' });
    const update = (priceMinor: string) =>
      catalog.updateMenuItem(ownerA, tenantA, itemId, {
        priceMinor,
        expectedVersion: 1,
        reason: 'Concurrent update race test',
      });
    const results = await Promise.allSettled([
      update('11000'),
      update('12000'),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      httpStatus((rejected[0] as PromiseRejectedResult).reason),
      409,
    );
    assert.equal(await readItemVersion(itemId), 2);
  });

  it('isolates catalog scope between tenants and enforces the composite FK', async () => {
    const a = await seedItem(tenantA, ownerA);
    const b = await seedItem(tenantB, ownerB);

    // Owner A has no membership on tenant B: writes are forbidden.
    await assert.rejects(
      catalog.updateCategory(ownerA, tenantB, b.categoryId, { name: 'Hacked' }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 403);
        return true;
      },
    );
    await assert.rejects(
      catalog.createCategory(ownerA, tenantB, { name: `X ${randomUUID()}` }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 403);
        return true;
      },
    );

    // Owner B cannot touch tenant A rows even addressed via tenant B scope.
    await assert.rejects(
      catalog.updateCategory(ownerB, tenantB, a.categoryId, { name: 'Hacked' }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 404);
        return true;
      },
    );
    await assert.rejects(
      catalog.updateMenuItem(ownerB, tenantB, a.itemId, {
        priceMinor: '1',
        expectedVersion: 1,
      }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 404);
        return true;
      },
    );
    await assert.rejects(catalog.getMenuItem(tenantB, a.itemId), /not found/i);

    // Buyer discovery never leaks across tenants.
    const menuA = await catalog.listMenu(tenantA);
    const idsA = menuA.data.categories.flatMap((category) =>
      category.items.map((menuItem) => menuItem.id),
    );
    assert.ok(idsA.includes(a.itemId));
    assert.ok(!idsA.includes(b.itemId));
    assert.ok(
      menuA.data.categories.every((category) => category.items.length > 0),
    );
    assert.equal(menuA.data.campusId, campusA);
    assert.equal(menuA.data.timezone, 'Asia/Jakarta');

    // Creating an item in tenant A with tenant B's category is rejected by
    // the service (tenant-scoped lookup) ...
    await assert.rejects(
      catalog.createMenuItem(ownerA, tenantA, {
        categoryId: b.categoryId,
        name: 'Cross tenant item',
        priceMinor: '1000',
      }),
      /Menu category not found/,
    );
    // ... and by the composite FK (tenant_id, category_id) at the DB layer.
    await assert.rejects(
      pool.query(
        `INSERT INTO menu_items
             (tenant_id, category_id, name, description, price_minor, currency, status, updated_at)
           VALUES ($1, $2, 'FK probe', '', '1000', 'IDR', 'active', now())`,
        [tenantA, b.categoryId],
      ),
      (error: unknown) => {
        assert.equal(pgCode(error), '23503');
        return true;
      },
    );
  });

  it('rejects negative and fractional money at service and database layers', async () => {
    const { categoryId, itemId } = await seedItem(tenantA, ownerA);
    for (const priceMinor of ['-5', '10.5', 'abc', '1e3', ' 100', '']) {
      await assert.rejects(
        catalog.createMenuItem(ownerA, tenantA, {
          categoryId,
          name: 'Bad price item',
          priceMinor,
        }),
        /priceMinor/,
      );
    }
    const groupId = (
      await catalog.createOptionGroup(ownerA, tenantA, itemId, { name: 'G' })
    ).data.id;
    await assert.rejects(
      catalog.createOptionChoice(ownerA, tenantA, groupId, {
        name: 'Negative delta',
        priceDeltaMinor: '-1',
      }),
      /priceDeltaMinor/,
    );

    // Database check constraints are the last line of defense.
    await assert.rejects(
      pool.query(
        `INSERT INTO menu_items
             (tenant_id, category_id, name, description, price_minor, currency, status, updated_at)
           VALUES ($1, $2, 'DB negative', '', '-5', 'IDR', 'active', now())`,
        [tenantA, categoryId],
      ),
      (error: unknown) => {
        assert.equal(pgCode(error), '23514');
        return true;
      },
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO menu_items
             (tenant_id, category_id, name, description, price_minor, currency, status, updated_at)
           VALUES ($1, $2, 'DB fraction', '', '10.5', 'IDR', 'active', now())`,
        [tenantA, categoryId],
      ),
      (error: unknown) => {
        assert.equal(pgCode(error), '23514');
        return true;
      },
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO menu_option_choices
             (tenant_id, group_id, name, price_delta_minor, status, updated_at)
           VALUES ($1, $2, 'DB negative delta', '-1', 'active', now())`,
        [tenantA, groupId],
      ),
      (error: unknown) => {
        assert.equal(pgCode(error), '23514');
        return true;
      },
    );
    // Group selection bounds are enforced by the service and by the DB check.
    await assert.rejects(
      catalog.createOptionGroup(ownerA, tenantA, itemId, {
        name: 'Bad bounds',
        minSelections: 2,
        maxSelections: 1,
      }),
      /minSelections cannot exceed maxSelections/,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO menu_option_groups
             (tenant_id, menu_item_id, name, min_selections, max_selections, sort_order, status, updated_at)
           VALUES ($1, $2, 'DB bad bounds', 2, 1, 0, 'active', now())`,
        [tenantA, itemId],
      ),
      (error: unknown) => {
        assert.equal(pgCode(error), '23514');
        return true;
      },
    );
  });

  it('enforces tenant.menu.manage for every write path', async () => {
    const payload = { name: `Perm ${randomUUID()}` };
    // Kitchen staff without the permission is denied.
    await assert.rejects(
      catalog.createCategory(kitchenNoMenuA, tenantA, payload),
      (error: unknown) => {
        assert.equal(httpStatus(error), 403);
        return true;
      },
    );
    // Pickup staff can never hold menu.manage, even with a forged grant row.
    await assert.rejects(
      catalog.createCategory(pickupMenuA, tenantA, payload),
      (error: unknown) => {
        assert.equal(httpStatus(error), 403);
        return true;
      },
    );
    // A user without any membership is denied.
    await assert.rejects(
      catalog.createCategory(stranger, tenantA, payload),
      (error: unknown) => {
        assert.equal(httpStatus(error), 403);
        return true;
      },
    );
    // Kitchen staff explicitly granted menu.manage succeeds.
    const created = await catalog.createCategory(
      kitchenMenuA,
      tenantA,
      payload,
    );
    assert.equal(created.data.name, payload.name);
    // The admin listing is also permission-gated and tenant scoped.
    await assert.rejects(
      catalog.listAdminMenu(stranger, tenantA),
      (error: unknown) => {
        assert.equal(httpStatus(error), 403);
        return true;
      },
    );
    const admin = await catalog.listAdminMenu(kitchenMenuA, tenantA);
    assert.equal(admin.data.tenantId, tenantA);
    assert.ok(
      admin.data.categories.some((category) => category.id === created.data.id),
    );
    assert.ok(
      admin.data.categories.every((category) => category.tenantId === tenantA),
    );
  });

  it('archives instead of deleting and hides archived rows from buyers', async () => {
    const { categoryId, itemId } = await seedItem(tenantA, ownerA);
    const group = await catalog.createOptionGroup(ownerA, tenantA, itemId, {
      name: 'Sambal',
      minSelections: 1,
      maxSelections: 1,
    });
    const choice = await catalog.createOptionChoice(
      ownerA,
      tenantA,
      group.data.id,
      {
        name: 'Sedang',
      },
    );

    const archivedItem = await catalog.archiveMenuItem(
      ownerA,
      tenantA,
      itemId,
      'Item retired for test',
    );
    assert.equal(archivedItem.data.status, 'archived');
    const stillThere = await pool.query(
      'SELECT 1 FROM menu_items WHERE id = $1',
      [itemId],
    );
    assert.equal(stillThere.rowCount, 1, 'archive must not delete the row');
    // Archiving again is idempotent.
    const again = await catalog.archiveMenuItem(
      ownerA,
      tenantA,
      itemId,
      'Item retired for test',
    );
    assert.equal(again.data.status, 'archived');

    await assert.rejects(catalog.getMenuItem(tenantA, itemId), /not found/i);
    const menu = await catalog.listMenu(tenantA);
    const ids = menu.data.categories.flatMap((category) =>
      category.items.map((menuItem) => menuItem.id),
    );
    assert.ok(!ids.includes(itemId));

    const archivedGroup = await catalog.archiveOptionGroup(
      ownerA,
      tenantA,
      group.data.id,
      'Group retired for test',
    );
    assert.equal(archivedGroup.data.status, 'archived');
    const archivedChoice = await catalog.archiveOptionChoice(
      ownerA,
      tenantA,
      choice.data.id,
      'Choice retired for test',
    );
    assert.equal(archivedChoice.data.status, 'archived');

    const archivedCategory = await catalog.archiveCategory(
      ownerA,
      tenantA,
      categoryId,
      'Category retired for test',
    );
    assert.equal(archivedCategory.data.status, 'archived');
    const categoryRow = await pool.query(
      'SELECT 1 FROM menu_categories WHERE id = $1',
      [categoryId],
    );
    assert.equal(categoryRow.rowCount, 1);

    // Unknown or cross-tenant ids stay 404 on archive paths.
    await assert.rejects(
      catalog.archiveMenuItem(ownerA, tenantA, randomUUID(), 'not found probe'),
      (error: unknown) => {
        assert.equal(httpStatus(error), 404);
        return true;
      },
    );
  });

  it('supports discovery filters, literal search and unique names', async () => {
    const token = randomUUID().slice(0, 8);
    const { categoryId } = await seedItem(tenantA, ownerA, {
      name: `Nasi Spesial ${token}`,
    });
    const soldOut = await catalog.createMenuItem(ownerA, tenantA, {
      categoryId,
      name: `Soto ${token}`,
      priceMinor: '12000',
      status: 'sold_out',
    });
    const percent = await catalog.createMenuItem(ownerA, tenantA, {
      categoryId,
      name: `100% Jus ${token}`,
      priceMinor: '8000',
    });

    const all = await catalog.listMenu(tenantA, { search: token });
    const allItems = all.data.categories.flatMap((category) => category.items);
    assert.equal(allItems.length, 3);

    const soldOutOnly = await catalog.listMenu(tenantA, {
      status: 'sold_out',
      search: token,
    });
    const soldItems = soldOutOnly.data.categories.flatMap(
      (category) => category.items,
    );
    assert.equal(soldItems.length, 1);
    assert.equal(soldItems[0].id, soldOut.data.id);

    // LIKE metacharacters in the search term must match literally:
    // unescaped, '%' would match every item of the tenant.
    const literal = await catalog.listMenu(tenantA, { search: '100%' });
    const literalItems = literal.data.categories.flatMap(
      (category) => category.items,
    );
    assert.equal(literalItems.length, 1);
    assert.equal(literalItems[0].id, percent.data.id);

    const byCategory = await catalog.listMenu(tenantA, { categoryId });
    assert.equal(byCategory.data.categories.length, 1);
    assert.equal(byCategory.data.categories[0].id, categoryId);

    const detail = await catalog.getMenuItem(tenantA, percent.data.id);
    assert.equal(detail.data.item.name, percent.data.name);
    assert.equal(detail.data.item.categoryId, categoryId);

    // Unique constraints surface as conflicts.
    const duplicateCategory = await pool.query<{ name: string }>(
      'SELECT name FROM menu_categories WHERE id = $1',
      [categoryId],
    );
    await assert.rejects(
      catalog.createCategory(ownerA, tenantA, {
        name: duplicateCategory.rows[0].name,
      }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 409);
        return true;
      },
    );
    const group = await catalog.createOptionGroup(
      ownerA,
      tenantA,
      percent.data.id,
      {
        name: 'Gula',
      },
    );
    await catalog.createOptionChoice(ownerA, tenantA, group.data.id, {
      name: 'Sedikit',
    });
    await assert.rejects(
      catalog.createOptionChoice(ownerA, tenantA, group.data.id, {
        name: 'Sedikit',
      }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 409);
        return true;
      },
    );

    // Archived tenants are invisible to buyers.
    const archivedTenant = randomUUID();
    await pool.query(
      `INSERT INTO tenants (id, campus_id, name, location, status)
         VALUES ($1, $2, 'Archived tenant', 'X', 'archived')`,
      [archivedTenant, campusA],
    );
    await assert.rejects(catalog.listMenu(archivedTenant), (error: unknown) => {
      assert.equal(httpStatus(error), 404);
      return true;
    });
  });

  it('quotes server-priced snapshots with a deterministic canonical hash', async () => {
    const { itemId: itemA } = await seedItem(tenantA, ownerA, {
      priceMinor: '15000',
    });
    const { itemId: itemB } = await seedItem(tenantA, ownerA, {
      priceMinor: '5000',
    });
    const sambal = await catalog.createOptionGroup(ownerA, tenantA, itemA, {
      name: 'Tingkat Sambal',
      minSelections: 1,
      maxSelections: 1,
    });
    const sedang = await catalog.createOptionChoice(
      ownerA,
      tenantA,
      sambal.data.id,
      {
        name: 'Sedang',
        priceDeltaMinor: '0',
      },
    );
    const ekstra = await catalog.createOptionChoice(
      ownerA,
      tenantA,
      sambal.data.id,
      {
        name: 'Ekstra',
        priceDeltaMinor: '2000',
      },
    );
    const drinks = await catalog.createOptionGroup(ownerA, tenantA, itemA, {
      name: 'Minuman',
      minSelections: 0,
      maxSelections: 2,
    });
    const esTeh = await catalog.createOptionChoice(
      ownerA,
      tenantA,
      drinks.data.id,
      {
        name: 'Es Teh',
        priceDeltaMinor: '3000',
      },
    );
    const itemVersion = await readItemVersion(itemA);

    const quoteOnce = async (
      lines: { menuItemId: string; quantity: number; optionIds: string[] }[],
    ) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const quote = await catalog.quote(client, tenantA, slotA, lines);
        await client.query('ROLLBACK');
        return quote;
      } finally {
        client.release();
      }
    };

    const lines = [
      {
        menuItemId: itemA,
        quantity: 2,
        optionIds: [ekstra.data.id, esTeh.data.id],
      },
      { menuItemId: itemB, quantity: 1, optionIds: [] },
    ];
    const quote = await quoteOnce(lines);

    // unit = 15000 + 2000 + 3000 = 20000; 2 x 20000 + 1 x 5000 = 45000.
    assert.equal(quote.subtotalMinor, '45000');
    assert.equal(quote.totalMinor, '45000');
    assert.equal(quote.currency, 'IDR');
    assert.equal(quote.tenant.id, tenantA);
    assert.equal(quote.tenant.campusId, campusA);
    assert.equal(quote.tenant.timezone, 'Asia/Jakarta');
    assert.equal(quote.slot.id, slotA);
    assert.equal(quote.slot.version, 1);
    const lineA = quote.items.find((line) => line.menuItemId === itemA);
    assert.ok(lineA);
    assert.equal(lineA.basePriceMinor, '15000');
    assert.equal(lineA.unitPriceMinor, '20000');
    assert.equal(lineA.quantity, 2);
    assert.equal(lineA.menuVersion, itemVersion);
    // Options are a set; the snapshot order is canonical (groupId, id).
    assert.deepEqual(
      lineA.options.map((option) => [option.id, option.priceDeltaMinor]).sort(),
      [
        [ekstra.data.id, '2000'],
        [esTeh.data.id, '3000'],
      ].sort(),
    );
    const canonicalKeys = lineA.options.map(
      (option) => `${option.groupId}:${option.id}`,
    );
    assert.deepEqual(canonicalKeys, [...canonicalKeys].sort());

    // Deterministic: identical input produces identical hashes.
    const repeat = await quoteOnce(lines);
    assert.equal(repeat.quoteHash, quote.quoteHash);
    // Canonical: reordering the cart lines does not change the hash.
    const reordered = await quoteOnce([lines[1], lines[0]]);
    assert.equal(reordered.quoteHash, quote.quoteHash);
    assert.equal(
      reordered.items[0].menuItemId,
      itemB,
      'response keeps request order',
    );
    // Different quantity or options change the hash.
    const otherQuantity = await quoteOnce([
      { ...lines[0], quantity: 3 },
      lines[1],
    ]);
    assert.notEqual(otherQuantity.quoteHash, quote.quoteHash);
    const otherOption = await quoteOnce([
      {
        menuItemId: itemA,
        quantity: 2,
        optionIds: [sedang.data.id, esTeh.data.id],
      },
      lines[1],
    ]);
    assert.notEqual(otherOption.quoteHash, quote.quoteHash);
    assert.match(quote.quoteHash, /^[0-9a-f]{64}$/);

    // Quote is read-only: no capacity reservation and no slot mutation.
    const slotRow = await pool.query<{
      reserved_count: number;
      version: number;
    }>('SELECT reserved_count, version FROM pickup_slots WHERE id = $1', [
      slotA,
    ]);
    assert.equal(slotRow.rows[0].reserved_count, 0);
    assert.equal(slotRow.rows[0].version, 1);
  });

  it('rejects quotes for unavailable items, bad options and bad input', async () => {
    const active = await seedItem(tenantA, ownerA, { priceMinor: '9000' });
    const soldOut = await catalog.createMenuItem(ownerA, tenantA, {
      categoryId: active.categoryId,
      name: 'Sold out item',
      priceMinor: '9000',
      status: 'sold_out',
    });
    const archived = await seedItem(tenantA, ownerA);
    await catalog.archiveMenuItem(
      ownerA,
      tenantA,
      archived.itemId,
      'Removed from menu',
    );
    const other = await seedItem(tenantB, ownerB);
    const group = await catalog.createOptionGroup(
      ownerA,
      tenantA,
      active.itemId,
      {
        name: 'Wajib',
        minSelections: 1,
        maxSelections: 1,
      },
    );
    const choiceOne = await catalog.createOptionChoice(
      ownerA,
      tenantA,
      group.data.id,
      {
        name: 'Satu',
      },
    );
    const choiceTwo = await catalog.createOptionChoice(
      ownerA,
      tenantA,
      group.data.id,
      {
        name: 'Dua',
      },
    );
    const run = async (
      lines: { menuItemId: string; quantity: number; optionIds: string[] }[],
      tenantId = tenantA,
    ) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await catalog.quote(client, tenantId, slotA, lines);
        await client.query('ROLLBACK');
        return result;
      } finally {
        client.release();
      }
    };

    await assert.rejects(
      run([{ menuItemId: soldOut.data.id, quantity: 1, optionIds: [] }]),
      (error: unknown) => {
        assert.equal(httpStatus(error), 409);
        return true;
      },
    );
    await assert.rejects(
      run([{ menuItemId: archived.itemId, quantity: 1, optionIds: [] }]),
      (error: unknown) => {
        assert.equal(httpStatus(error), 409);
        return true;
      },
    );
    await assert.rejects(
      run([{ menuItemId: other.itemId, quantity: 1, optionIds: [] }]),
      (error: unknown) => {
        assert.equal(httpStatus(error), 409);
        return true;
      },
    );
    // Missing required selection (min 1) is a client error.
    await assert.rejects(
      run([{ menuItemId: active.itemId, quantity: 1, optionIds: [] }]),
      (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      },
    );
    // Exceeding max selections is a client error.
    await assert.rejects(
      run([
        {
          menuItemId: active.itemId,
          quantity: 1,
          optionIds: [choiceOne.data.id, choiceTwo.data.id],
        },
      ]),
      (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      },
    );
    // Option belonging to another item is rejected.
    const otherGroup = await catalog.createOptionGroup(
      ownerA,
      tenantA,
      (await seedItem(tenantA, ownerA)).itemId,
      {
        name: 'Lain',
      },
    );
    const otherChoice = await catalog.createOptionChoice(
      ownerA,
      tenantA,
      otherGroup.data.id,
      { name: 'Bukan untuk item ini' },
    );
    await assert.rejects(
      run([
        {
          menuItemId: active.itemId,
          quantity: 1,
          optionIds: [otherChoice.data.id],
        },
      ]),
      /Option is invalid for the selected menu item/,
    );
    // Input validation: pilot operational bound is 1..200 per line.
    for (const quantity of [0, 201, 1.5]) {
      await assert.rejects(
        run([
          {
            menuItemId: active.itemId,
            quantity,
            optionIds: [choiceOne.data.id],
          },
        ]),
        /quantity/i,
      );
    }
    await assert.rejects(run([]), /1 to 50 menu items/);
    await assert.rejects(
      run([
        {
          menuItemId: active.itemId,
          quantity: 1,
          optionIds: [choiceOne.data.id],
        },
        {
          menuItemId: active.itemId,
          quantity: 1,
          optionIds: [choiceOne.data.id],
        },
      ]),
      /Invalid quote line/,
    );
    await assert.rejects(
      catalog.quote(
        {
          query: async () => ({ rows: [] }),
        } as unknown as import('pg').PoolClient,
        'not-a-uuid',
        slotA,
        [{ menuItemId: active.itemId, quantity: 1, optionIds: [] }],
      ),
      /Invalid tenant or pickup slot id/,
    );
    // A paused tenant cannot be quoted (needs its own tenant-scoped slot).
    const slotB = await pool.query<{ id: string }>(
      `INSERT INTO pickup_slots (tenant_id, starts_at, ends_at, capacity, status, updated_at)
         SELECT $1, starts_at, ends_at, capacity, status, now()
           FROM pickup_slots WHERE id = $2
         RETURNING id`,
      [tenantB, slotA],
    );
    await pool.query(
      "UPDATE tenants SET status = 'paused', updated_at = now() WHERE id = $1",
      [tenantB],
    );
    const clientB = await pool.connect();
    try {
      await clientB.query('BEGIN');
      await assert.rejects(
        catalog.quote(clientB, tenantB, slotB.rows[0].id, [
          { menuItemId: other.itemId, quantity: 1, optionIds: [] },
        ]),
        (error: unknown) => {
          assert.equal(httpStatus(error), 409);
          return true;
        },
      );
      await clientB.query('ROLLBACK');
    } finally {
      clientB.release();
    }
  });
  it('supports imageRef, archived_at lifecycle and rejects zero-total quotes', async () => {
    const { categoryId, itemId } = await seedItem(tenantA, ownerA, {
      priceMinor: '0',
    });
    const withImage = await catalog.createMenuItem(ownerA, tenantA, {
      categoryId,
      name: 'Free sample',
      priceMinor: '0',
      imageRef: 'media://sample.png',
    });
    assert.equal(withImage.data.imageRef, 'media://sample.png');
    assert.equal(withImage.data.archivedAt, null);

    const cleared = await catalog.updateMenuItem(
      ownerA,
      tenantA,
      withImage.data.id,
      {
        imageRef: '',
        expectedVersion: 1,
      },
    );
    assert.equal(cleared.data.imageRef, null);

    const archived = await catalog.archiveMenuItem(
      ownerA,
      tenantA,
      withImage.data.id,
      'Temporarily retired',
    );
    assert.equal(archived.data.status, 'archived');
    assert.match(archived.data.archivedAt ?? '', MICRO_TS);

    // Bidirectional CHECK (0007): archived rows must keep archived_at set.
    await assert.rejects(
      pool.query('UPDATE menu_items SET archived_at = NULL WHERE id = $1', [
        withImage.data.id,
      ]),
      (error: unknown) => {
        assert.equal(pgCode(error), '23514');
        return true;
      },
    );

    const reactivated = await catalog.updateMenuItem(
      ownerA,
      tenantA,
      withImage.data.id,
      {
        status: 'sold_out',
        expectedVersion: archived.data.version,
        reason: 'Reactivated as sold out',
      },
    );
    assert.equal(reactivated.data.status, 'sold_out');
    assert.equal(reactivated.data.archivedAt, null);

    // DB CHECK (migration 0007): archived_at only while status = 'archived'.
    await assert.rejects(
      pool.query('UPDATE menu_items SET archived_at = now() WHERE id = $1', [
        itemId,
      ]),
      (error: unknown) => {
        assert.equal(pgCode(error), '23514');
        return true;
      },
    );

    // Zero-total quotes are rejected in the pilot (orders CHECK subtotal > 0).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        catalog.quote(client, tenantA, slotA, [
          { menuItemId: itemId, quantity: 1, optionIds: [] },
        ]),
        /Quote total must be greater than zero/,
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('audits money and status changes with actor, target and reason', async () => {
    const { categoryId, itemId } = await seedItem(tenantA, ownerA, {
      priceMinor: '10000',
    });
    // The reason comes from the DTO and is mandatory for audited changes.
    await assert.rejects(
      catalog.updateMenuItem(ownerA, tenantA, itemId, {
        priceMinor: '11000',
        expectedVersion: 1,
      }),
      /reason of 1 to 300 characters/i,
    );
    await assert.rejects(
      catalog.archiveMenuItem(ownerA, tenantA, itemId, '   '),
      /reason of 1 to 300 characters/i,
    );
    await catalog.updateMenuItem(ownerA, tenantA, itemId, {
      priceMinor: '11000',
      expectedVersion: 1,
      reason: 'Supplier price increase',
    });
    await catalog.updateMenuItem(ownerA, tenantA, itemId, {
      status: 'sold_out',
      expectedVersion: 2,
      reason: 'Out of stock today',
    });
    await catalog.updateMenuItem(ownerA, tenantA, itemId, {
      status: 'active',
      expectedVersion: 3,
      reason: 'Back in stock',
    });
    await catalog.archiveMenuItem(ownerA, tenantA, itemId, 'Discontinued');
    const itemAudits = await pool.query<{
      action: string;
      reason: string;
      actor_user_id: string;
    }>(
      `SELECT action, reason, actor_user_id FROM audit_events
        WHERE scope_type = 'tenant' AND scope_id = $1 AND target_id = $2
        ORDER BY occurred_at, id`,
      [tenantA, itemId],
    );
    assert.deepEqual(
      itemAudits.rows.map((row) => [row.action, row.reason, row.actor_user_id]),
      [
        ['tenant.menu.item.price_changed', 'Supplier price increase', ownerA],
        ['tenant.menu.item.sold_out', 'Out of stock today', ownerA],
        ['tenant.menu.item.available', 'Back in stock', ownerA],
        ['tenant.menu.item.archived', 'Discontinued', ownerA],
      ],
    );

    await catalog.archiveCategory(
      ownerA,
      tenantA,
      categoryId,
      'Seasonal reset',
    );
    await catalog.updateCategory(ownerA, tenantA, categoryId, {
      status: 'active',
      reason: 'Season reopened',
    });
    const categoryAudits = await pool.query<{
      action: string;
      reason: string;
    }>(
      `SELECT action, reason FROM audit_events
        WHERE scope_type = 'tenant' AND scope_id = $1 AND target_id = $2
        ORDER BY occurred_at, id`,
      [tenantA, categoryId],
    );
    assert.deepEqual(
      categoryAudits.rows.map((row) => [row.action, row.reason]),
      [
        ['tenant.menu.category.archived', 'Seasonal reset'],
        ['tenant.menu.category.restored', 'Season reopened'],
      ],
    );

    // Option price deltas are money changes and get audited too.
    const optionSeed = await seedItem(tenantA, ownerA);
    const group = await catalog.createOptionGroup(
      ownerA,
      tenantA,
      optionSeed.itemId,
      { name: 'Sambal' },
    );
    const choice = await catalog.createOptionChoice(
      ownerA,
      tenantA,
      group.data.id,
      { name: 'Sedang' },
    );
    await catalog.updateOptionChoice(ownerA, tenantA, choice.data.id, {
      priceDeltaMinor: '1500',
      expectedVersion: 1,
      reason: 'Chili price adjustment',
    });
    await catalog.archiveOptionChoice(
      ownerA,
      tenantA,
      choice.data.id,
      'No longer offered',
    );
    const choiceAudits = await pool.query<{ action: string; reason: string }>(
      'SELECT action, reason FROM audit_events WHERE target_id = $1 ORDER BY occurred_at, id',
      [choice.data.id],
    );
    assert.deepEqual(
      choiceAudits.rows.map((row) => [row.action, row.reason]),
      [
        ['tenant.menu.option.price_changed', 'Chili price adjustment'],
        ['tenant.menu.option.archived', 'No longer offered'],
      ],
    );

    // Non-audited edits (description) still require no reason.
    await catalog.updateMenuItem(ownerA, tenantA, optionSeed.itemId, {
      description: 'updated copy',
      expectedVersion: await readItemVersion(optionSeed.itemId),
    });
  });

  it('hides items of archived categories from buyers and quotes', async () => {
    const token = randomUUID().slice(0, 8);
    const { categoryId, itemId } = await seedItem(tenantA, ownerA, {
      name: `Nasi Kategori ${token}`,
      priceMinor: '13000',
    });
    await catalog.archiveCategory(
      ownerA,
      tenantA,
      categoryId,
      'Category closed for now',
    );

    const menu = await catalog.listMenu(tenantA, { search: token });
    assert.equal(menu.data.categories.length, 0);
    await assert.rejects(catalog.getMenuItem(tenantA, itemId), /not found/i);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        catalog.quote(client, tenantA, slotA, [
          { menuItemId: itemId, quantity: 1, optionIds: [] },
        ]),
        (error: unknown) => {
          assert.equal(httpStatus(error), 409);
          return true;
        },
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Reactivating the category makes the untouched item visible again.
    await catalog.updateCategory(ownerA, tenantA, categoryId, {
      status: 'active',
      reason: 'Category reopened',
    });
    const reopened = await catalog.listMenu(tenantA, { search: token });
    const ids = reopened.data.categories.flatMap((category) =>
      category.items.map((menuItem) => menuItem.id),
    );
    assert.ok(ids.includes(itemId));
  });

  it('quote never locks the pickup slot row (advisory validation, root D15)', async () => {
    const { itemId } = await seedItem(tenantA, ownerA, { priceMinor: '7000' });
    const holder = await pool.connect();
    try {
      // Simulate a concurrent checkout that already holds the slot row lock.
      await holder.query('BEGIN');
      await holder.query(
        'SELECT id FROM pickup_slots WHERE id = $1 FOR UPDATE',
        [slotA],
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Any slot row lock attempt by quote would queue behind the holder
        // and fail with 55P03 instead of returning a snapshot.
        await client.query("SET LOCAL lock_timeout = '2s'");
        const startedAt = Date.now();
        const quote = await catalog.quote(client, tenantA, slotA, [
          { menuItemId: itemId, quantity: 1, optionIds: [] },
        ]);
        const elapsedMs = Date.now() - startedAt;
        await client.query('ROLLBACK');
        assert.equal(quote.slot.id, slotA);
        assert.ok(
          elapsedMs < 1500,
          `quote waited ${elapsedMs}ms; it must not touch the slot row lock`,
        );
      } finally {
        client.release();
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});
