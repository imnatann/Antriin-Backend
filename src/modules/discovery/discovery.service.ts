import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_RECOMMENDATION_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_QUERY_LENGTH = 100;
/**
 * Recommendations are ranked in memory (the score mixes a per-tenant review
 * aggregate with the freshness of the next pickup slot), so the query fetches
 * a bounded candidate pool ordered deterministically by (price, name, id) and
 * the ranking slices it afterwards. A campus catalog far above this size would
 * need a materialized score in SQL; the pilot catalog is far below it.
 */
const MAX_RECOMMENDATION_CANDIDATES = 200;

/**
 * Recommendation heuristic (documented here, in meta.criteria and in the
 * OpenAPI description - never invented silently):
 *
 *   rating    (weight 0.6): the tenant's visible-review average mapped from
 *             1..5 onto 0..1 as (average - 1) / 4. An item whose tenant has no
 *             visible review uses the NEUTRAL 0.5 and is flagged in
 *             meta.criteria; no synthetic rating value is ever returned.
 *   freshness (weight 0.4): max(0, 1 - hoursUntilNextOpenSlot / 24), so a
 *             slot starting within the hour scores 1 and one 24h out scores 0.
 *   score = 0.6 * rating + 0.4 * freshness, rounded to 4 decimals (a ranking
 *   heuristic, not money: float arithmetic is acceptable and the output is a
 *   decimal string).
 */
const RATING_WEIGHT = 0.6;
const FRESHNESS_WEIGHT = 0.4;
const NEUTRAL_RATING = 0.5;
const FRESHNESS_HORIZON_HOURS = 24;

export interface SearchOptions {
  q?: string;
  campusId?: string;
  limit?: number;
}

export interface RecommendationOptions {
  campusId?: string;
  tenantId?: string;
  budgetMaxMinor?: string;
  limit?: number;
}

export interface SearchTenantView {
  id: string;
  name: string;
  campusId: string;
  campusName: string;
  location: string;
  status: string;
  matchedOn: 'name' | 'location';
}

export interface SearchItemView {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  categoryId: string;
  categoryName: string;
  name: string;
  description: string;
  priceMinor: string;
  currency: string;
  status: string;
}

export interface SearchResult {
  data: { tenants: SearchTenantView[]; items: SearchItemView[] };
  meta: { query: string; limit: number };
}

export interface RecommendationView {
  menuItemId: string;
  name: string;
  description: string;
  priceMinor: string;
  currency: string;
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  rating: { average: string | null; count: number };
  nextPickupStartsAt: string | null;
  score: string;
}

export interface RecommendationCriteria {
  weights: { rating: number; nextPickupFreshness: number };
  rating: {
    source: string;
    normalization: string;
    neutralWhenNoReviews: number;
  };
  nextPickupFreshness: {
    horizonHours: number;
    formula: string;
  };
  score: string;
  candidateLimit: number;
  order: string;
}

export interface RecommendationResult {
  data: RecommendationView[];
  meta: { limit: number; criteria: RecommendationCriteria };
}

type SearchTenantRow = {
  id: string;
  name: string;
  campus_id: string;
  campus_name: string;
  location: string;
  status: string;
  matched_on: 'name' | 'location';
};

type SearchItemRow = {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_status: string;
  category_id: string;
  category_name: string;
  name: string;
  description: string;
  price_minor: string;
  currency: string;
  status: string;
};

type RecommendationRow = {
  menu_item_id: string;
  name: string;
  description: string;
  price_minor: string;
  currency: string;
  tenant_id: string;
  tenant_name: string;
  tenant_status: string;
  average_rating: string | null;
  review_count: string;
  next_pickup_starts_at: string;
  hours_until_start: string;
};

/**
 * Public discovery: free-text search and recommendations over the buyer-facing
 * catalog. Both endpoints are unauthenticated (REQUIREMENTS §3.2: browsing does
 * not require an account), so there is no actor and no permission scope to
 * resolve - AccessService is deliberately not injected here. What keeps the
 * surface safe is the row filter instead: only active campuses, non-archived
 * tenants and buyer-visible (active/sold_out) items of active categories are
 * ever projected, so discovery cannot reveal a hidden or archived row. Nothing
 * in this service writes, so no audit trail is produced either.
 */
@Injectable()
export class DiscoveryService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Case-insensitive search over tenant name/location and menu item
   * name/description. LIKE metacharacters in the term are escaped so a query
   * like "100%" or "a_b" matches literally. Each side is capped by the same
   * limit: tenants ordered by name, items by price then name.
   */
  async search(options: SearchOptions = {}): Promise<SearchResult> {
    const query = normalizeQuery(options.q);
    const limit = normalizeLimit(options.limit, DEFAULT_SEARCH_LIMIT);
    const pattern = likePattern(query);
    const campusId = options.campusId ?? null;
    const [tenants, items] = await Promise.all([
      this.database.pool.query<SearchTenantRow>(
        `select t.id::text, t.name, t.campus_id::text, c.name as campus_name,
                t.location, t.status,
                case when t.name ilike $1 then 'name' else 'location' end as matched_on
           from tenants t
           join campuses c on c.id = t.campus_id
          where c.status = 'active'
            and t.status <> 'archived'
            and ($2::uuid is null or t.campus_id = $2)
            and (t.name ilike $1 or t.location ilike $1)
          order by t.name, t.id
          limit $3`,
        [pattern, campusId, limit],
      ),
      // sold_out items stay in the result on purpose: the item exists and the
      // client marks it unavailable from the returned status. Only archived
      // items and archived categories are excluded.
      this.database.pool.query<SearchItemRow>(
        `select mi.id::text, mi.tenant_id::text, t.name as tenant_name,
                t.status as tenant_status, mi.category_id::text,
                cat.name as category_name, mi.name, mi.description,
                mi.price_minor::text as price_minor, mi.currency, mi.status
           from menu_items mi
           join tenants t on t.id = mi.tenant_id
           join campuses c on c.id = t.campus_id
           join menu_categories cat
             on cat.tenant_id = mi.tenant_id and cat.id = mi.category_id
          where c.status = 'active'
            and t.status <> 'archived'
            and mi.status in ('active', 'sold_out')
            and cat.status = 'active'
            and ($2::uuid is null or t.campus_id = $2)
            and (mi.name ilike $1 or mi.description ilike $1)
          order by mi.price_minor, mi.name, mi.id
          limit $3`,
        [pattern, campusId, limit],
      ),
    ]);
    return {
      data: {
        tenants: tenants.rows.map((row) => ({
          id: row.id,
          name: row.name,
          campusId: row.campus_id,
          campusName: row.campus_name,
          location: row.location,
          status: row.status,
          matchedOn: row.matched_on,
        })),
        items: items.rows.map((row) => ({
          id: row.id,
          tenantId: row.tenant_id,
          tenantName: row.tenant_name,
          tenantStatus: row.tenant_status,
          categoryId: row.category_id,
          categoryName: row.category_name,
          name: row.name,
          description: row.description,
          priceMinor: row.price_minor,
          currency: row.currency,
          status: row.status,
        })),
      },
      meta: { query, limit },
    };
  }

  /**
   * Ranked menu items from open tenants of active campuses that still have an
   * open, future pickup slot with free capacity. Ratings come only from
   * visible, non-deleted reviews of the item's tenant (reviews are tenant
   * scoped; there is no per-item review) and stay null when there are none.
   */
  async recommend(
    options: RecommendationOptions = {},
  ): Promise<RecommendationResult> {
    const limit = normalizeLimit(options.limit, DEFAULT_RECOMMENDATION_LIMIT);
    const budget = options.budgetMaxMinor ?? null;
    const result = await this.database.pool.query<RecommendationRow>(
      `select mi.id::text as menu_item_id, mi.name, mi.description,
              mi.price_minor::text as price_minor, mi.currency,
              t.id::text as tenant_id, t.name as tenant_name,
              t.status as tenant_status,
              rating.average_rating, rating.review_count,
              to_char(next_slot.starts_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as next_pickup_starts_at,
              next_slot.hours_until_start
         from menu_items mi
         join tenants t on t.id = mi.tenant_id
         join campuses c on c.id = t.campus_id
         join menu_categories cat
           on cat.tenant_id = mi.tenant_id and cat.id = mi.category_id
         join lateral (
           select s.starts_at,
                  extract(epoch from (s.starts_at - now())) / 3600.0 as hours_until_start
             from pickup_slots s
            where s.tenant_id = t.id
              and s.status = 'open'
              and s.reserved_count < s.capacity
              and s.starts_at > now()
            order by s.starts_at, s.id
            limit 1
         ) next_slot on true
         left join lateral (
           select round(avg(r.rating)::numeric, 2)::text as average_rating,
                  count(*)::text as review_count
             from reviews r
            where r.tenant_id = t.id
              and r.status = 'visible'
              and r.deleted_at is null
         ) rating on true
        where c.status = 'active'
          and t.status = 'open'
          and mi.status = 'active'
          and cat.status = 'active'
          and ($1::uuid is null or t.campus_id = $1)
          and ($2::uuid is null or t.id = $2)
          and ($3::numeric is null or mi.price_minor <= $3::numeric)
        order by mi.price_minor, mi.name, mi.id
        limit $4`,
      [
        options.campusId ?? null,
        options.tenantId ?? null,
        budget,
        MAX_RECOMMENDATION_CANDIDATES,
      ],
    );

    const ranked = result.rows.map((row) => this.toRecommendation(row));
    // Deterministic ordering: score first, then price, name and id so equal
    // scores never depend on the database's row order.
    ranked.sort(
      (left, right) =>
        Number(right.score) - Number(left.score) ||
        compareMinor(left.priceMinor, right.priceMinor) ||
        compareText(left.name, right.name) ||
        compareText(left.menuItemId, right.menuItemId),
    );
    return {
      data: ranked.slice(0, limit),
      meta: {
        limit,
        criteria: {
          weights: {
            rating: RATING_WEIGHT,
            nextPickupFreshness: FRESHNESS_WEIGHT,
          },
          rating: {
            source:
              'reviews with status=visible and deleted_at is null, aggregated per tenant (reviews are tenant scoped, not per menu item)',
            normalization:
              'average (1..5, two decimals) mapped to 0..1 as (average - 1) / 4',
            neutralWhenNoReviews: NEUTRAL_RATING,
          },
          nextPickupFreshness: {
            horizonHours: FRESHNESS_HORIZON_HOURS,
            formula:
              'max(0, 1 - hoursUntilNextOpenSlot / ' +
              String(FRESHNESS_HORIZON_HOURS) +
              ')',
          },
          score:
            '0.6 * rating + 0.4 * freshness, rounded to 4 decimals; a ranking heuristic, not a money or quality claim',
          candidateLimit: MAX_RECOMMENDATION_CANDIDATES,
          order: 'score desc, price asc, name asc, id asc',
        },
      },
    };
  }

  private toRecommendation(row: RecommendationRow): RecommendationView {
    const average = row.average_rating;
    const ratingValue =
      average === null
        ? NEUTRAL_RATING
        : clamp((Number(average) - 1) / 4, 0, 1);
    const hours = Number(row.hours_until_start);
    const freshness = Number.isFinite(hours)
      ? clamp(1 - hours / FRESHNESS_HORIZON_HOURS, 0, 1)
      : 0;
    const score = (
      RATING_WEIGHT * ratingValue +
      FRESHNESS_WEIGHT * freshness
    ).toFixed(4);
    return {
      menuItemId: row.menu_item_id,
      name: row.name,
      description: row.description,
      priceMinor: row.price_minor,
      currency: row.currency,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      tenantStatus: row.tenant_status,
      rating: {
        average,
        count: Number(row.review_count),
      },
      nextPickupStartsAt: row.next_pickup_starts_at,
      score,
    };
  }
}

function normalizeQuery(value: string | undefined): string {
  const query = typeof value === 'string' ? value.trim() : '';
  if (!query || query.length > MAX_QUERY_LENGTH) {
    throw new BadRequestException({
      code: 'SEARCH_QUERY_REQUIRED',
      message:
        'q is required and must be 1 to ' +
        String(MAX_QUERY_LENGTH) +
        ' characters',
    });
  }
  return query;
}

/** Escapes LIKE metacharacters so the term matches literally. */
function likePattern(query: string): string {
  return '%' + query.replace(/[\\%_]/g, (match) => '\\' + match) + '%';
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new BadRequestException(
      'limit must be an integer from 1 to ' + String(MAX_LIMIT),
    );
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareMinor(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : 1;
}
