import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import { DiscoveryService } from '../src/modules/discovery/discovery.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

async function createCampus(pool: Pool, name: string, status = 'active') {
  const result = await pool.query<{ id: string }>(
    'insert into campuses (name, status) values ($1, $2) returning id',
    [name, status],
  );
  return result.rows[0].id;
}

async function createTenant(
  pool: Pool,
  campusId: string,
  name: string,
  location: string,
  status = 'open',
) {
  const result = await pool.query<{ id: string }>(
    'insert into tenants (campus_id, name, location, status) values ($1, $2, $3, $4) returning id',
    [campusId, name, location, status],
  );
  return result.rows[0].id;
}

async function createCategory(
  pool: Pool,
  tenantId: string,
  name: string,
  status = 'active',
) {
  const result = await pool.query<{ id: string }>(
    'insert into menu_categories (tenant_id, name, status) values ($1, $2, $3) returning id',
    [tenantId, name, status],
  );
  return result.rows[0].id;
}

async function createItem(
  pool: Pool,
  tenantId: string,
  categoryId: string,
  input: {
    name: string;
    description?: string;
    priceMinor: string;
    status?: 'active' | 'sold_out' | 'archived';
  },
) {
  const status = input.status ?? 'active';
  const result = await pool.query<{ id: string }>(
    `insert into menu_items
       (tenant_id, category_id, name, description, price_minor, currency, status,
        archived_at, updated_at)
     values ($1, $2, $3, $4, $5, 'IDR', $6::varchar, case when $6::varchar = 'archived' then now() else null end, now())
     returning id`,
    [
      tenantId,
      categoryId,
      input.name,
      input.description ?? '',
      input.priceMinor,
      status,
    ],
  );
  return result.rows[0].id;
}

async function createSlot(
  pool: Pool,
  tenantId: string,
  options: {
    startInMinutes: number;
    durationMinutes?: number;
    capacity?: number;
    reservedCount?: number;
    status?: 'open' | 'closed';
  },
) {
  const duration = options.durationMinutes ?? 60;
  const result = await pool.query<{ id: string }>(
    `insert into pickup_slots
       (tenant_id, starts_at, ends_at, capacity, reserved_count, status,
        version, created_at, updated_at)
     values ($1, now() + ($2::int * interval '1 minute'),
             now() + (($2::int + $3::int) * interval '1 minute'),
             $4, $5, $6, 1, now(), now())
     returning id`,
    [
      tenantId,
      options.startInMinutes,
      duration,
      options.capacity ?? 5,
      options.reservedCount ?? 0,
      options.status ?? 'open',
    ],
  );
  return result.rows[0].id;
}

async function createBuyer(pool: Pool, name: string) {
  const result = await pool.query<{ id: string }>(
    'insert into users (display_name) values ($1) returning id',
    [name],
  );
  return result.rows[0].id;
}

async function createCompletedOrder(
  pool: Pool,
  tenantId: string,
  buyerId: string,
  slotId: string,
) {
  const result = await pool.query<{ id: string }>(
    `insert into orders
       (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot,
        tenant_timezone_snapshot, pickup_starts_at, pickup_ends_at, status,
        currency, subtotal_minor, total_minor, paid_at, confirmed_at, ready_at,
        completed_at, cancelled_at, declined_at, created_at, updated_at)
     values ($1, $2, $3, 'Tenant snapshot', 'Asia/Jakarta', now(),
             now() + interval '1 hour', 'completed', 'IDR', 1000, 1000,
             now(), now(), now(), now(), null, null, now(), now())
     returning id`,
    [buyerId, tenantId, slotId],
  );
  return result.rows[0].id;
}

async function createReview(
  pool: Pool,
  input: {
    campusId: string;
    tenantId: string;
    orderId: string;
    buyerId: string;
    rating: number;
    status?: 'visible' | 'hidden';
    deleted?: boolean;
  },
) {
  const hidden = input.status === 'hidden';
  await pool.query(
    `insert into reviews
       (campus_id, tenant_id, order_id, buyer_id, rating, body, status,
        hidden_at, hidden_by_user_id, deleted_at, created_at, updated_at)
     values ($1, $2, $3, $4::uuid, $5, 'Ulasan pembeli', $6::varchar,
             case when $7::boolean then now() else null end,
             case when $7::boolean then $4::uuid else null end,
             case when $8::boolean then now() else null end, now(), now())`,
    [
      input.campusId,
      input.tenantId,
      input.orderId,
      input.buyerId,
      input.rating,
      input.status ?? 'visible',
      hidden,
      Boolean(input.deleted),
    ],
  );
}

describe(
  'Discovery slice PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let discovery: DiscoveryService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      await pool.query('select 1');
      discovery = new DiscoveryService({ pool } as unknown as DatabaseService);
    });
    after(async () => {
      await pool?.end();
    });

    it('finds tenants by name and location and items by name and description', async () => {
      const tag = randomUUID();
      const campusId = await createCampus(pool, 'Campus ' + tag);
      const sateTenant = await createTenant(
        pool,
        campusId,
        'Sate ' + tag,
        'Gedung A ' + tag,
      );
      const kopiTenant = await createTenant(
        pool,
        campusId,
        'Kopi ' + tag,
        'Gedung Sate ' + tag,
      );
      const sateCategory = await createCategory(pool, sateTenant, 'Makanan');
      const kopiCategory = await createCategory(pool, kopiTenant, 'Minuman');
      const sateItem = await createItem(pool, sateTenant, sateCategory, {
        name: 'Sate ' + tag + ' Spesial',
        description: 'Sate dengan bumbu kacang',
        priceMinor: '25000',
      });
      const tehItem = await createItem(pool, kopiTenant, kopiCategory, {
        name: 'Es Teh',
        description: 'Teman makan sate ' + tag,
        priceMinor: '10000',
      });

      // Uppercase term proves the match is case-insensitive.
      const result = await discovery.search({
        q: 'SATE ' + tag,
        campusId,
      });

      assert.equal(result.meta.query, 'SATE ' + tag);
      assert.equal(result.meta.limit, 20);
      const matchedOn = new Map(
        result.data.tenants.map((tenant) => [tenant.id, tenant.matchedOn]),
      );
      assert.equal(matchedOn.get(sateTenant), 'name');
      assert.equal(matchedOn.get(kopiTenant), 'location');
      assert.equal(result.data.tenants[0].campusName, 'Campus ' + tag);
      assert.equal(result.data.tenants[0].status, 'open');
      // Tenants are ordered by name.
      assert.deepEqual(
        result.data.tenants.map((tenant) => tenant.name),
        ['Kopi ' + tag, 'Sate ' + tag],
      );

      // Items ordered by price then name: the cheaper drink comes first.
      assert.deepEqual(
        result.data.items.map((item) => item.id),
        [tehItem, sateItem],
      );
      const sateRow = result.data.items.find((item) => item.id === sateItem);
      assert.equal(sateRow?.name, 'Sate ' + tag + ' Spesial');
      assert.equal(sateRow?.priceMinor, '25000');
      assert.equal(sateRow?.currency, 'IDR');
      assert.equal(sateRow?.status, 'active');
      assert.equal(sateRow?.categoryName, 'Makanan');
      assert.equal(sateRow?.tenantName, 'Sate ' + tag);
      assert.equal(sateRow?.tenantStatus, 'open');

      // The same limit caps each side independently.
      const limited = await discovery.search({
        q: 'SATE ' + tag,
        campusId,
        limit: 1,
      });
      assert.equal(limited.meta.limit, 1);
      assert.equal(limited.data.tenants.length, 1);
      assert.equal(limited.data.items.length, 1);
      assert.equal(limited.data.items[0].id, tehItem);
    });

    it('escapes LIKE metacharacters so % and _ match literally', async () => {
      const tag = randomUUID();
      const campusId = await createCampus(pool, 'Campus ' + tag);
      const literalPercent = await createTenant(
        pool,
        campusId,
        'Diskon 100% ' + tag,
        'Lantai 1',
      );
      await createTenant(pool, campusId, 'Diskon 100X ' + tag, 'Lantai 2');
      const literalUnderscore = await createTenant(
        pool,
        campusId,
        'Kedai a_b ' + tag,
        'Lantai 3',
      );
      await createTenant(pool, campusId, 'Kedai axb ' + tag, 'Lantai 4');

      const percent = await discovery.search({ q: '100% ' + tag });
      assert.deepEqual(
        percent.data.tenants.map((tenant) => tenant.id),
        [literalPercent],
      );

      const underscore = await discovery.search({ q: 'a_b ' + tag });
      assert.deepEqual(
        underscore.data.tenants.map((tenant) => tenant.id),
        [literalUnderscore],
      );
    });

    it('never exposes archived tenants, inactive campuses or archived catalog rows', async () => {
      const tag = randomUUID();
      const activeCampusId = await createCampus(pool, 'Active ' + tag);
      const inactiveCampusId = await createCampus(
        pool,
        'Inactive ' + tag,
        'inactive',
      );
      const visibleTenant = await createTenant(
        pool,
        activeCampusId,
        'Terlihat ' + tag,
        'Lokasi terlihat',
      );
      const archivedTenant = await createTenant(
        pool,
        activeCampusId,
        'Arsip ' + tag,
        'Lokasi arsip',
        'archived',
      );
      const inactiveTenant = await createTenant(
        pool,
        inactiveCampusId,
        'Kampus Nonaktif ' + tag,
        'Lokasi nonaktif',
      );
      const visibleCategory = await createCategory(
        pool,
        visibleTenant,
        'Kategori',
      );
      const visibleItem = await createItem(
        pool,
        visibleTenant,
        visibleCategory,
        { name: 'Item ' + tag, priceMinor: '15000' },
      );
      const archivedCategory = await createCategory(
        pool,
        archivedTenant,
        'Kategori arsip',
      );
      await createItem(pool, archivedTenant, archivedCategory, {
        name: 'Item arsip ' + tag,
        priceMinor: '15000',
      });
      const hiddenCategory = await createCategory(
        pool,
        visibleTenant,
        'Kategori nonaktif',
        'archived',
      );
      await createItem(pool, visibleTenant, hiddenCategory, {
        name: 'Item kategori arsip ' + tag,
        priceMinor: '15000',
      });

      const result = await discovery.search({ q: tag });
      assert.deepEqual(
        result.data.tenants.map((tenant) => tenant.id),
        [visibleTenant],
      );
      // Neither the archived tenant nor the tenant of an inactive campus can
      // appear, even though their names contain the term.
      assert.ok(
        !result.data.tenants.some((tenant) => tenant.id === archivedTenant),
      );
      assert.ok(
        !result.data.tenants.some((tenant) => tenant.id === inactiveTenant),
      );
      assert.deepEqual(
        result.data.items.map((item) => item.id),
        [visibleItem],
      );
    });

    it('keeps sold_out items visible with their status', async () => {
      const tag = randomUUID();
      const campusId = await createCampus(pool, 'Campus ' + tag);
      const tenantId = await createTenant(
        pool,
        campusId,
        'Tenant ' + tag,
        'Lokasi',
      );
      const categoryId = await createCategory(pool, tenantId, 'Kategori');
      const soldOutItem = await createItem(pool, tenantId, categoryId, {
        name: 'Habis ' + tag,
        priceMinor: '20000',
        status: 'sold_out',
      });
      const activeItem = await createItem(pool, tenantId, categoryId, {
        name: 'Tersedia ' + tag,
        priceMinor: '20000',
      });
      await createItem(pool, tenantId, categoryId, {
        name: 'Arsip ' + tag,
        priceMinor: '20000',
        status: 'archived',
      });

      const result = await discovery.search({ q: tag, campusId });
      assert.deepEqual(
        result.data.items.map((item) => item.id),
        [soldOutItem, activeItem],
      );
      assert.equal(result.data.items[0].status, 'sold_out');
      assert.equal(result.data.items[1].status, 'active');
    });

    it('rejects a missing or blank query with SEARCH_QUERY_REQUIRED', async () => {
      for (const q of [undefined, '', '   ']) {
        await assert.rejects(
          discovery.search({ q }),
          (error: unknown) => {
            const exception = error as {
              getResponse?: () => { code?: string };
            };
            return exception.getResponse?.().code === 'SEARCH_QUERY_REQUIRED';
          },
          String(q),
        );
      }
    });

    it('recommends only open tenants with a free future pickup slot', async () => {
      const tag = randomUUID();
      const campusId = await createCampus(pool, 'Campus ' + tag);
      const openTenant = await createTenant(
        pool,
        campusId,
        'Buka ' + tag,
        'Lokasi buka',
        'open',
      );
      const closedTenant = await createTenant(
        pool,
        campusId,
        'Tutup ' + tag,
        'Lokasi tutup',
        'closed',
      );
      const fullTenant = await createTenant(
        pool,
        campusId,
        'Penuh ' + tag,
        'Lokasi penuh',
      );
      const pastTenant = await createTenant(
        pool,
        campusId,
        'Lampau ' + tag,
        'Lokasi lampau',
      );
      const closedSlotTenant = await createTenant(
        pool,
        campusId,
        'Slot Tutup ' + tag,
        'Lokasi slot tutup',
      );
      const noSlotTenant = await createTenant(
        pool,
        campusId,
        'Tanpa Slot ' + tag,
        'Lokasi tanpa slot',
      );

      const itemFor = async (tenantId: string, name: string) => {
        const categoryId = await createCategory(pool, tenantId, 'Kategori');
        return createItem(pool, tenantId, categoryId, {
          name,
          priceMinor: '20000',
        });
      };

      const openItem = await itemFor(openTenant, 'Item buka ' + tag);
      await itemFor(closedTenant, 'Item tutup ' + tag);
      await itemFor(fullTenant, 'Item penuh ' + tag);
      await itemFor(pastTenant, 'Item lampau ' + tag);
      await itemFor(closedSlotTenant, 'Item slot tutup ' + tag);
      await itemFor(noSlotTenant, 'Item tanpa slot ' + tag);

      await createSlot(pool, openTenant, { startInMinutes: 300 });
      await createSlot(pool, openTenant, { startInMinutes: 120 });
      await createSlot(pool, closedTenant, { startInMinutes: 120 });
      await createSlot(pool, fullTenant, {
        startInMinutes: 120,
        capacity: 2,
        reservedCount: 2,
      });
      await createSlot(pool, pastTenant, { startInMinutes: -120 });
      await createSlot(pool, closedSlotTenant, {
        startInMinutes: 120,
        status: 'closed',
      });

      const result = await discovery.recommend({ campusId });
      assert.deepEqual(
        result.data.map((item) => item.menuItemId),
        [openItem],
      );
      assert.equal(result.data[0].tenantId, openTenant);
      assert.equal(result.data[0].tenantStatus, 'open');
      assert.equal(result.meta.limit, 10);

      const expected = await pool.query<{ starts_at: string }>(
        `select to_char(min(starts_at) at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as starts_at
           from pickup_slots where tenant_id = $1`,
        [openTenant],
      );
      assert.equal(
        result.data[0].nextPickupStartsAt,
        expected.rows[0].starts_at,
      );
      assert.match(
        result.data[0].nextPickupStartsAt ?? '',
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
      );

      // tenantId narrows the same query to one tenant.
      const scoped = await discovery.recommend({
        campusId,
        tenantId: closedTenant,
      });
      assert.deepEqual(scoped.data, []);

      // Documented heuristic is always published in meta.criteria.
      assert.equal(result.meta.criteria.weights.rating, 0.6);
      assert.equal(result.meta.criteria.weights.nextPickupFreshness, 0.4);
      assert.equal(result.meta.criteria.rating.neutralWhenNoReviews, 0.5);
      assert.equal(result.meta.criteria.nextPickupFreshness.horizonHours, 24);
      assert.ok(result.meta.criteria.order.includes('score desc'));
    });

    it('filters recommendations by budget', async () => {
      const tag = randomUUID();
      const campusId = await createCampus(pool, 'Campus ' + tag);
      const tenantId = await createTenant(
        pool,
        campusId,
        'Tenant ' + tag,
        'Lokasi',
      );
      const categoryId = await createCategory(pool, tenantId, 'Kategori');
      const cheap = await createItem(pool, tenantId, categoryId, {
        name: 'Murah ' + tag,
        priceMinor: '20000',
      });
      const pricey = await createItem(pool, tenantId, categoryId, {
        name: 'Mahal ' + tag,
        priceMinor: '50000',
      });
      await createSlot(pool, tenantId, { startInMinutes: 120 });

      const all = await discovery.recommend({ campusId });
      assert.deepEqual(
        all.data.map((item) => item.menuItemId),
        [cheap, pricey],
      );
      assert.equal(all.data[0].priceMinor, '20000');

      const bounded = await discovery.recommend({
        campusId,
        budgetMaxMinor: '30000',
      });
      assert.deepEqual(
        bounded.data.map((item) => item.menuItemId),
        [cheap],
      );

      const exact = await discovery.recommend({
        campusId,
        budgetMaxMinor: '20000',
      });
      assert.deepEqual(
        exact.data.map((item) => item.menuItemId),
        [cheap],
      );

      const tooLow = await discovery.recommend({
        campusId,
        budgetMaxMinor: '19999',
      });
      assert.deepEqual(tooLow.data, []);
    });

    it('returns a null rating without visible reviews and the real average with them', async () => {
      const tag = randomUUID();
      const campusId = await createCampus(pool, 'Campus ' + tag);
      const ratedTenant = await createTenant(
        pool,
        campusId,
        'Berdasarkan Ulasan ' + tag,
        'Lokasi rating',
      );
      const unratedTenant = await createTenant(
        pool,
        campusId,
        'Tanpa Ulasan ' + tag,
        'Lokasi tanpa rating',
      );
      const ratedCategory = await createCategory(pool, ratedTenant, 'Kategori');
      const ratedItem = await createItem(pool, ratedTenant, ratedCategory, {
        name: 'Item rating ' + tag,
        priceMinor: '10000',
      });
      const unratedCategory = await createCategory(
        pool,
        unratedTenant,
        'Kategori',
      );
      const unratedItem = await createItem(
        pool,
        unratedTenant,
        unratedCategory,
        {
          name: 'Item tanpa rating ' + tag,
          priceMinor: '10000',
        },
      );
      await createSlot(pool, ratedTenant, { startInMinutes: 120 });
      await createSlot(pool, unratedTenant, { startInMinutes: 120 });

      const buyerOne = await createBuyer(pool, 'Buyer one ' + tag);
      const buyerTwo = await createBuyer(pool, 'Buyer two ' + tag);
      const buyerThree = await createBuyer(pool, 'Buyer three ' + tag);
      const buyerFour = await createBuyer(pool, 'Buyer four ' + tag);
      const slotForOrder = async (offset: number) =>
        createSlot(pool, ratedTenant, { startInMinutes: 600 + offset });

      const orderOne = await createCompletedOrder(
        pool,
        ratedTenant,
        buyerOne,
        await slotForOrder(0),
      );
      const orderTwo = await createCompletedOrder(
        pool,
        ratedTenant,
        buyerTwo,
        await slotForOrder(1),
      );
      const orderHidden = await createCompletedOrder(
        pool,
        ratedTenant,
        buyerThree,
        await slotForOrder(2),
      );
      const orderDeleted = await createCompletedOrder(
        pool,
        ratedTenant,
        buyerFour,
        await slotForOrder(3),
      );

      await createReview(pool, {
        campusId,
        tenantId: ratedTenant,
        orderId: orderOne,
        buyerId: buyerOne,
        rating: 4,
      });
      await createReview(pool, {
        campusId,
        tenantId: ratedTenant,
        orderId: orderTwo,
        buyerId: buyerTwo,
        rating: 5,
      });
      // Hidden and buyer-deleted reviews must not influence the average.
      await createReview(pool, {
        campusId,
        tenantId: ratedTenant,
        orderId: orderHidden,
        buyerId: buyerThree,
        rating: 1,
        status: 'hidden',
      });
      await createReview(pool, {
        campusId,
        tenantId: ratedTenant,
        orderId: orderDeleted,
        buyerId: buyerFour,
        rating: 2,
        deleted: true,
      });

      const result = await discovery.recommend({ campusId });
      const rated = result.data.find((item) => item.menuItemId === ratedItem);
      const unrated = result.data.find(
        (item) => item.menuItemId === unratedItem,
      );
      assert.deepEqual(rated?.rating, { average: '4.50', count: 2 });
      assert.deepEqual(unrated?.rating, { average: null, count: 0 });
      assert.ok(rated && unrated);
      // The neutral 0.5 for an unrated tenant is documented, never returned
      // as a rating value.
      assert.equal(unrated.rating.average, null);
      assert.notEqual(rated.score, unrated.score);
    });

    it('orders equal scores deterministically by price, name and id', async () => {
      const tag = randomUUID();
      const campusId = await createCampus(pool, 'Campus ' + tag);
      const tenantId = await createTenant(
        pool,
        campusId,
        'Tenant ' + tag,
        'Lokasi',
      );
      const categoryId = await createCategory(pool, tenantId, 'Kategori');
      // Same tenant, same slot and no reviews => identical score for both.
      const second = await createItem(pool, tenantId, categoryId, {
        name: 'B Item ' + tag,
        priceMinor: '15000',
      });
      const first = await createItem(pool, tenantId, categoryId, {
        name: 'A Item ' + tag,
        priceMinor: '15000',
      });
      const cheaper = await createItem(pool, tenantId, categoryId, {
        name: 'Z Item ' + tag,
        priceMinor: '10000',
      });
      await createSlot(pool, tenantId, { startInMinutes: 120 });

      const result = await discovery.recommend({ campusId });
      assert.deepEqual(
        result.data.map((item) => item.menuItemId),
        [cheaper, first, second],
      );
      assert.equal(result.data[1].score, result.data[2].score);

      const repeated = await discovery.recommend({ campusId });
      assert.deepEqual(repeated.data, result.data);

      const limited = await discovery.recommend({ campusId, limit: 2 });
      assert.deepEqual(
        limited.data.map((item) => item.menuItemId),
        [cheaper, first],
      );
      assert.equal(limited.meta.limit, 2);
    });
  },
);
