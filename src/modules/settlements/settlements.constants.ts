/**
 * Shared constants for the settlements slice (order payable release, the
 * tenant finance summary and the tenant finance transaction feed).
 *
 * Ledger account names and error codes are part of the contract documented in
 * docs/design/settlement-payout.md section 4 and docs/modules/settlements.md.
 * Every ledger leg of the settlement/payout flow uses its OWN reference
 * namespace because (reference_namespace, reference_id) is globally unique on
 * ledger_transactions (docs/LEDGER.md).
 */

/** System ledger account holding captured order funds (D16.1). */
export const ORDER_PAYMENT_ESCROW_ACCOUNT = 'orders.payment.escrow';

/** Per-tenant released-and-available funds (D18 Q1). */
export const TENANT_PAYABLE_SYSTEM_KEY_PREFIX = 'tenant.payable.';

/** Per-tenant funds held by an active payout (D18 Q1). */
export const TENANT_PAYOUT_HOLD_SYSTEM_KEY_PREFIX = 'tenant.payout.hold.';

/** Global counter-account for money leaving through the payout provider. */
export const PAYOUT_CLEARING_SYSTEM_KEY = 'payout.clearing';

/** Reference namespace of the release leg (unique per order). */
export const SETTLEMENT_RELEASE_REFERENCE_NAMESPACE = 'settlement_release';

/** Ledger idempotency scope of the release leg. */
export const SETTLEMENT_RELEASE_IDEMPOTENCY_SCOPE = 'settlements.release';

/** Service actor id used by automatic release legs (D18 Q2). */
export const SETTLEMENTS_SERVICE_ACTOR = 'settlements';

export const PAYOUT_HOLD_REFERENCE_NAMESPACE = 'payout_hold';
export const PAYOUT_SETTLE_REFERENCE_NAMESPACE = 'payout_settle';
export const PAYOUT_RELEASE_REFERENCE_NAMESPACE = 'payout_release';

export const PAYOUT_HOLD_IDEMPOTENCY_SCOPE = 'payouts.hold';
export const PAYOUT_SETTLE_IDEMPOTENCY_SCOPE = 'payouts.settle';
export const PAYOUT_RELEASE_IDEMPOTENCY_SCOPE = 'payouts.release';

/**
 * Stable error codes of the settlements slice. Release is called from the
 * pickup handover and the case-decision transactions, where it must never fail
 * the caller; those paths consume the discriminated result instead of an
 * exception. HTTP finance reads use these codes only for domain conflicts.
 */
export const SETTLEMENT_ERROR_CODES = {
  /** The order is not completed, so no payable may be released yet. */
  notHandedOver: 'SETTLEMENT_NOT_HANDED_OVER',
  /** An operational case is still open for the order. */
  openCaseBlocked: 'SETTLEMENT_OPEN_CASE_BLOCKED',
  /** A refund row exists for the order (pilot: refunds and release exclude). */
  refundPending: 'SETTLEMENT_REFUND_PENDING',
  /** The order has no successful payment to release. */
  paymentMissing: 'SETTLEMENT_PAYMENT_MISSING',
  /** A settlement row already exists for the order (idempotent replay). */
  alreadyReleased: 'SETTLEMENT_ALREADY_RELEASED',
  /** Only IDR is modelled in the pilot. */
  currencyUnsupported: 'SETTLEMENT_CURRENCY_UNSUPPORTED',
} as const;

/** Orders statuses that mean "no money is waiting for this order". */
export const ORDER_TERMINAL_STATUSES = [
  'completed',
  'cancelled',
  'declined',
] as const;

/** Case statuses that block a release (docs/design section 6). */
export const OPEN_CASE_STATUSES = [
  'reported',
  'under_review',
  'awaiting_information',
] as const;

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;
