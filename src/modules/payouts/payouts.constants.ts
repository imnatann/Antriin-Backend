/**
 * Shared constants for the payouts slice (bank accounts, payout requests,
 * provider processing) - docs/design/settlement-payout.md, D18.
 */

/**
 * Pilot bank allowlist. A bank code is a registered identifier, not free text;
 * the list stays intentionally small and must be extended (with the provider's
 * own code mapping) before real payouts are enabled.
 */
export const BANK_CODES = [
  'BCA',
  'BNI',
  'BRI',
  'BSI',
  'MANDIRI',
  'PERMATA',
  'CIMB',
  'BTN',
  'DANAMON',
  'JAGO',
  'BJB',
  'MEGA',
  'OCBC',
  'PANIN',
  'BTPN',
  'SEABANK',
] as const;

export const MAX_ACCOUNT_HOLDER_LENGTH = 200;
export const MAX_REASON_LENGTH = 500;

/** Provider submission attempts before a payout needs human assistance. */
export const MAX_PAYOUT_REQUEST_ATTEMPTS = 5;
export const PAYOUT_BACKOFF_BASE_SECONDS = 5;
export const PAYOUT_BACKOFF_MAX_SECONDS = 300;
export const PAYOUT_LEASE_SECONDS = 60;

/** Queue wiring owned by root (D11); the module does not register it. */
export const PAYOUTS_QUEUE_NAME = 'payout-requests';
export const PAYOUTS_QUEUE_JOB_NAME = 'request';
export const PAYOUT_REQUEST_STALE_ALARM_SECONDS = 120;

/** Stable error codes surfaced to clients (design section 7). */
export const PAYOUT_ERROR_CODES = {
  /** PAYOUTS_PROVIDER_MODE is 'disabled' (always true in production). */
  providerDisabled: 'PAYOUT_PROVIDER_DISABLED',
  /** amountMinor is not a positive integer minor-unit string. */
  amountInvalid: 'PAYOUT_AMOUNT_INVALID',
  /** The tenant payable balance is lower than the requested amount. */
  amountExceedsAvailable: 'PAYOUT_AMOUNT_EXCEEDS_AVAILABLE',
  /** Another payout of this tenant is still requested/processing. */
  activeExists: 'PAYOUT_ACTIVE_EXISTS',
  /** The destination account is not active + verified for this tenant. */
  bankAccountUnverified: 'PAYOUT_BANK_ACCOUNT_UNVERIFIED',
  /** Illegal status transition (cancel after processing, etc.). */
  stateConflict: 'PAYOUT_STATE_CONFLICT',
  /** The Idempotency-Key was reused with different input. */
  idempotencyReused: 'PAYOUT_IDEMPOTENCY_REUSED',
  /** The Idempotency-Key header is missing or malformed. */
  idempotencyKeyInvalid: 'PAYOUT_IDEMPOTENCY_KEY_INVALID',
  /** Settlement allocation did not consume the payout amount exactly. */
  allocationMismatch: 'PAYOUT_ALLOCATION_MISMATCH',
  /** Payout funds are held and a human must reconcile the provider outcome. */
  needsAssistance: 'PAYOUT_NEEDS_ASSISTANCE',
} as const;

export const BANK_ACCOUNT_ERROR_CODES = {
  /** Q4: the verification mechanism is not decided, so the endpoint is off. */
  verificationDisabled: 'BANK_ACCOUNT_VERIFICATION_DISABLED',
  /** AUTH_ENCRYPTION_KEY is missing or malformed. */
  encryptionDisabled: 'BANK_ACCOUNT_ENCRYPTION_DISABLED',
  /** Account number shape is invalid after normalization. */
  numberInvalid: 'BANK_ACCOUNT_NUMBER_INVALID',
  /** Bank code is not in the pilot allowlist. */
  bankUnsupported: 'BANK_ACCOUNT_BANK_UNSUPPORTED',
  /** The same active account is already registered for the tenant. */
  alreadyExists: 'BANK_ACCOUNT_ALREADY_EXISTS',
  /** Only an active account can be replaced/disabled. */
  notActive: 'BANK_ACCOUNT_NOT_ACTIVE',
} as const;

/** Audit actions of this slice (docs/design section 5.3). */
export const PAYOUT_AUDIT_ACTIONS = {
  bankAccountCreated: 'tenant.bank_account.created',
  bankAccountReplaced: 'tenant.bank_account.replaced',
  bankAccountVerified: 'tenant.bank_account.verified',
  bankAccountDisabled: 'tenant.bank_account.disabled',
  payoutRequested: 'tenant.payout.requested',
  payoutCancelled: 'tenant.payout.cancelled',
  payoutSucceeded: 'tenant.payout.succeeded',
  payoutFailed: 'tenant.payout.failed',
  payoutNeedsAssistance: 'tenant.payout.needs_assistance',
} as const;
