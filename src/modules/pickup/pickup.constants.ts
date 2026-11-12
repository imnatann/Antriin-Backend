/**
 * Shared constants for the pickup slice (credential issuance/rotation,
 * code verification and the one-time handover). Kept in one module so the
 * service, guard, DTOs and tests agree on the same bounds and error codes.
 *
 * Security model (AGENTS.md, docs/reviews/wave1-decisions.md D12.10):
 * - the plaintext code is NEVER stored: lookup uses a deterministic
 *   HMAC-SHA256 hash keyed with AUTH_SECRET (code_hash, 64 hex chars);
 * - code_ciphertext (AES-256-GCM with AUTH_ENCRYPTION_KEY) exists solely so
 *   the owning buyer can re-display the code in the app; it is never logged;
 * - brute-force protection is app-level rate limiting in Redis (D12: no
 *   attempt counter column in the DB).
 */

/**
 * Crockford-style base32 without 0, 1, I, L, O and U so a code read aloud or
 * typed by staff has no ambiguous characters. 30^8 ~= 6.6e11 possibilities.
 */
export const PICKUP_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PICKUP_CODE_LENGTH = 8;

/** Display grouping for humans (XXXX-XXXX); stored/normalized without it. */
export const PICKUP_CODE_DISPLAY_SEPARATOR = '-';

/**
 * Accepted input shape before normalization: letters/digits with optional
 * spaces or dashes. Normalization strips separators and upper-cases, so staff
 * can type the code exactly as spoken.
 */
export const PICKUP_CODE_INPUT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9 -]{2,30}[A-Za-z0-9]$/;
export const PICKUP_CODE_NORMALIZED_PATTERN = /^[A-Z0-9]{4,32}$/;

/** PICKUP_CREDENTIAL_TTL_SECONDS bounds (environment.ts, D2). */
export const PICKUP_TTL_DEFAULT_SECONDS = 7200;
export const PICKUP_TTL_MIN_SECONDS = 300;
export const PICKUP_TTL_MAX_SECONDS = 86400;

/** Collision-safe code generation retries on code_hash unique violation. */
export const PICKUP_CODE_GENERATION_ATTEMPTS = 5;

/**
 * Rate limit for code-presentation endpoints (verify + handover): per client
 * IP inside a sliding-window counter (same Redis instance and Lua pattern as
 * AuthRateLimitGuard, distinct key namespace).
 */
export const PICKUP_RATE_LIMIT_WINDOW_SECONDS = 600;
export const PICKUP_RATE_LIMIT_MAX_ATTEMPTS = 30;
export const PICKUP_RATE_LIMIT_KEY_PREFIX = 'antriin:pickup:rate:code';

/** Audit actions (convention tenant.<domain>.<entity>.<event>, root brief). */
export const PICKUP_AUDIT_ACTIONS = {
  issued: 'tenant.pickup.credential_issued',
  revoked: 'tenant.pickup.credential_revoked',
} as const;

/** Reason bound (mirrors order transition reasons: audit + event). */
export const MAX_PICKUP_REASON_LENGTH = 500;

/**
 * Stable error codes surfaced to clients (UPPER_SNAKE like the orders slice
 * for domain errors; lower_snake like the auth slice for infra/guard errors).
 */
export const PICKUP_ERROR_CODES = {
  /** Order is not in ready_for_pickup, so no credential may be issued. */
  notReady: 'PICKUP_NOT_READY',
  /** No credential matches the presented code (deliberately not a 404 so a
   * foreign-tenant code and a garbage code stay distinguishable per brief;
   * 409 avoids client auth-interceptors treating it as session expiry). */
  codeInvalid: 'PICKUP_CODE_INVALID',
  /** No active credential for this order/buyer, or the code belongs to an
   * order of another tenant (existence is never leaked across scopes). */
  credentialNotFound: 'PICKUP_CREDENTIAL_NOT_FOUND',
  /** The credential was revoked (rotation or staff action). */
  credentialRevoked: 'PICKUP_CREDENTIAL_REVOKED',
  /** The credential was already used at handover (replay is a consistent 409,
   * never a second effect - documented idempotency choice). */
  credentialConsumed: 'PICKUP_CREDENTIAL_CONSUMED',
  /** expires_at has passed; issuance of a fresh code is required. */
  credentialExpired: 'PICKUP_CREDENTIAL_EXPIRED',
  /** Concurrent handover race resolved by DB unique/FK defenses. */
  handoverConflict: 'PICKUP_HANDOVER_CONFLICT',
  /** Extremely unlikely: repeated code_hash collisions during generation. */
  codeGenerationFailed: 'pickup_code_generation_failed',
  /** AUTH_SECRET / AUTH_ENCRYPTION_KEY missing or malformed. */
  notConfigured: 'pickup_not_configured',
  /** Stored ciphertext cannot be decrypted (e.g. encryption key rotated). */
  codeUnavailable: 'pickup_code_unavailable',
  /** Too many code attempts from this client. */
  rateLimited: 'pickup_rate_limited',
  /** Redis unavailable: code verification fails closed. */
  rateLimitUnavailable: 'pickup_rate_limit_unavailable',
} as const;
