/**
 * Global (cross-endpoint) HTTP rate limiting policy for B3.
 *
 * Today only the OTP endpoints (src/modules/auth/auth-rate-limit.guard.ts) and
 * the pickup code endpoints (src/modules/pickup/pickup-rate-limit.interceptor.ts)
 * are bounded. Public reads such as GET /search, /recommendations and
 * /media/{id} have no limit at all, so one client can spend the whole API's
 * capacity on them.
 *
 * Design notes:
 * - Limits are per identity AND per coarse route bucket. A bucket is the first
 *   static path segment after the /api/v1 prefix (/api/v1/tenants/:id/orders ->
 *   "tenants"), so one noisy endpoint cannot exhaust the budget the same client
 *   still needs for another resource family. A per-exact-route bucket would
 *   give every endpoint a full private budget (no protection at all); a
 *   per-identity-only bucket would let one runaway endpoint starve every other
 *   call from the same client.
 * - Numbers come from the task brief, not from a product decision document, and
 *   are deliberately generous for reads: browsing must stay possible.
 * - Read methods are GET/HEAD/OPTIONS. Everything else is treated as a write.
 * - /health/*, /metrics and /webhooks/* are exempt: probes, scrapers and
 *   provider callbacks are not user traffic (and a webhook provider cannot be
 *   asked to retry on our schedule).
 */

export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** Redis key namespace. Distinct from the auth/pickup namespaces on purpose. */
export const RATE_LIMIT_KEY_PREFIX = 'antriin:ratelimit:global';

/** Error code returned with HTTP 429 (ApiExceptionFilter passes it through). */
export const RATE_LIMIT_ERROR_CODE = 'RATE_LIMITED';

/** Global prefix installed by src/main.ts. Only used to normalise paths. */
export const API_PATH_PREFIX = '/api/v1';

/** Path roots that must never be limited (compared after prefix removal). */
export const RATE_LIMIT_EXEMPT_ROOTS = [
  '/health',
  '/metrics',
  '/webhooks',
] as const;

export type RateLimitPolicyName =
  | 'public-read'
  | 'authenticated-read'
  | 'authenticated-write'
  | 'anonymous-write';

export interface RateLimitPolicy {
  /** Stable name; part of the Redis key so policies never mix counters. */
  name: RateLimitPolicyName;
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT_POLICIES: Record<RateLimitPolicyName, RateLimitPolicy> =
  {
    /** Unauthenticated reads: 120 per minute per client IP. */
    'public-read': {
      name: 'public-read',
      limit: 120,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    },
    /** Authenticated reads: 300 per minute per user. */
    'authenticated-read': {
      name: 'authenticated-read',
      limit: 300,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    },
    /** Mutations: 60 per minute per user. */
    'authenticated-write': {
      name: 'authenticated-write',
      limit: 60,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    },
    /**
     * Mutations from a caller with no usable identity: same 60/minute ceiling
     * per IP. Authenticating endpoints keep their own stricter limiters.
     */
    'anonymous-write': {
      name: 'anonymous-write',
      limit: 60,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    },
  };

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isReadMethod(method: string | undefined): boolean {
  return READ_METHODS.has((method ?? '').toUpperCase());
}

export function policyForRequest(
  method: string | undefined,
  authenticated: boolean,
): RateLimitPolicy {
  if (!isReadMethod(method))
    return authenticated
      ? RATE_LIMIT_POLICIES['authenticated-write']
      : RATE_LIMIT_POLICIES['anonymous-write'];
  return authenticated
    ? RATE_LIMIT_POLICIES['authenticated-read']
    : RATE_LIMIT_POLICIES['public-read'];
}

/**
 * Drop the query string and the global API prefix so one route matches whether
 * it is described as "/api/v1/search" or "/search".
 */
export function normalisePath(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  if (path === API_PATH_PREFIX) return '/';
  if (path.startsWith(API_PATH_PREFIX + '/'))
    return path.slice(API_PATH_PREFIX.length);
  return path;
}

export function isRateLimitExemptPath(path: string): boolean {
  return RATE_LIMIT_EXEMPT_ROOTS.some(
    (root) => path === root || path.startsWith(root + '/'),
  );
}

/**
 * Coarse bucket for one request: the first static (non-parameter) path segment.
 * Falls back to "root" for "/", "/:id" and anything without a static segment.
 */
export function routeBucket(
  routeTemplate: string | undefined,
  path: string,
): string {
  const source =
    typeof routeTemplate === 'string' && routeTemplate.length > 0
      ? routeTemplate
      : path;
  const segment = normalisePath(source)
    .split('/')
    .find((part) => part.length > 0 && !part.startsWith(':'));
  return sanitiseBucket(segment);
}

function sanitiseBucket(segment: string | undefined): string {
  const cleaned = (segment ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'root';
}
