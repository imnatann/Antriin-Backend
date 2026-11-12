/**
 * Shared constants for the orders slice (checkout, tenant state machine,
 * schedule proposals). Kept in one module so the service, DTOs and tests agree
 * on the same bounds instead of duplicating literals.
 */

/**
 * Canonical order statuses (docs/REQUIREMENTS-API.md §4 + schema 0007
 * `orders_status_check`). `awaiting_payment` is not representable: an order is
 * only born after a successful wallet debit (PILOT-POLICY), so checkout writes
 * `paid_awaiting_tenant` directly.
 */
export const ORDER_STATUSES = [
  'paid_awaiting_tenant',
  'confirmed',
  'preparing',
  'ready_for_pickup',
  'completed',
  'declined',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses where a tenant may still confirm/decline and a proposal may be decided. */
export const PRE_PRODUCTION_STATUSES: readonly OrderStatus[] = [
  'paid_awaiting_tenant',
  'confirmed',
];

/**
 * Idempotency route scope for checkout. Stored verbatim in
 * order_request_idempotency.route_name and part of the unique key with
 * (actor_user_id, key_hash).
 */
export const ORDER_CHECKOUT_ROUTE = 'POST /v1/orders';

/**
 * Stable system ledger account that receives order payments. Payment money is
 * held apart from tenant payables (docs/PILOT-POLICY.md: release only after a
 * completed handover), and it is deliberately NOT the sandbox top-up account.
 * Reported to the root for the ledger-account registry.
 */
export const PAYMENT_ESCROW_SYSTEM_KEY = 'orders.payment.escrow';

/** Pilot operational cart bounds (DB bounds are looser: quantity 1..999). */
export const MAX_CHECKOUT_LINES = 50;
export const MAX_LINE_QUANTITY = 200;
export const MAX_LINE_OPTIONS = 50;
export const MAX_SPECIAL_REQUEST_LENGTH = 500;
export const MAX_ITEM_NOTES_LENGTH = 500;

/** Client-supplied idempotency key (uuid or opaque token). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Retention of the idempotency record. The cleanup job is a wave-operational
 * task (R1-16); the column and partial index already exist in migration 0007.
 */
export const IDEMPOTENCY_RETENTION_DAYS = 30;

/** Cursor pagination bounds (same shape as the wallet slice). */
export const ORDER_PAGE_LIMIT_DEFAULT = 25;
export const ORDER_PAGE_LIMIT_MAX = 100;

/** Order number: AN-YYYYMMDD-XXXXXX (UTC creation date + Crockford base32). */
export const ORDER_NUMBER_PATTERN = /^AN-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/;
export const ORDER_NUMBER_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ORDER_NUMBER_SUFFIX_LENGTH = 6;
/** Collision-safe insert retries on unique violation (23505). */
export const ORDER_NUMBER_ATTEMPTS = 5;

/** Permission required for each tenant transition (D10 inventory). */
export const TENANT_ORDER_PERMISSIONS = {
  confirm: ['tenant.orders.accept'],
  prepare: ['tenant.orders.prepare'],
  // Root brief: ready may be driven by accept OR prepare; both are checked.
  ready: ['tenant.orders.prepare', 'tenant.orders.accept'],
  decline: ['tenant.orders.accept'],
  propose: ['tenant.orders.accept'],
  read: ['tenant.orders.read'],
} as const;
