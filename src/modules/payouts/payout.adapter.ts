import { createHash } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ACCOUNT_NUMBER_PATTERN } from './bank-account.crypto';

/**
 * A permanent payout-provider failure: retrying cannot succeed, so the
 * processor fails the payout (and releases the hold) instead of backing off.
 */
export class PermanentPayoutRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PermanentPayoutRequestError';
    this.code = code;
  }
}

export type PayoutProviderStatus = 'succeeded' | 'failed' | 'pending';

export interface PayoutSubmissionInput {
  payoutId: string;
  providerReference: string;
  amountMinor: string;
  currency: string;
  /** Destination snapshot of the payout row. */
  bankCode: string;
  accountHolderName: string;
  /**
   * Decrypted account number, resolved by the processor OUTSIDE any database
   * transaction or lock. Implementations MUST NOT log, persist or echo it.
   */
  accountNumber: string;
  attempt: number;
}

export interface PayoutSubmissionResult {
  status: PayoutProviderStatus;
  providerReference: string;
  occurredAt: Date;
  /** Stable, non-secret error code when status is 'failed'. */
  errorCode?: string;
}

/**
 * Port for payout providers. Only a controlled sandbox stub exists; a real
 * bank/disbursement adapter requires contracts, credentials and a verified
 * destination flow and is intentionally out of scope (D18 Q4/Q8).
 *
 * Implementations must be safe to retry with the SAME providerReference (the
 * provider dedupes it) and must never move money themselves: the hold/settle/
 * release ledger legs belong exclusively to PayoutsService.
 */
export interface PayoutProviderAdapter {
  readonly provider: string;
  buildProviderReference(input: {
    payoutId: string;
    amountMinor: string;
  }): string;
  /** Called OUTSIDE any database transaction or row lock. */
  submitPayout(input: PayoutSubmissionInput): Promise<PayoutSubmissionResult>;
}

export const PAYOUTS_PROVIDER_ADAPTER = Symbol('PAYOUTS_PROVIDER_ADAPTER');

/**
 * Controlled sandbox stub: deterministic, no network and no real money. Every
 * submission succeeds so the pilot flow is reproducible; failure/pending
 * behaviour is exercised in tests through injected stub adapters. Refuses to
 * operate unless PAYOUTS_PROVIDER_MODE is 'sandbox' and NODE_ENV is not
 * production.
 */
@Injectable()
export class SandboxPayoutAdapter implements PayoutProviderAdapter {
  readonly provider = 'sandbox';

  constructor(private readonly config: ConfigService) {}

  buildProviderReference(input: {
    payoutId: string;
    amountMinor: string;
  }): string {
    const digest = createHash('sha256')
      .update(input.payoutId + '|' + input.amountMinor, 'utf8')
      .digest('hex');
    return 'sbx-pyo-' + digest.slice(0, 40);
  }

  async submitPayout(
    input: PayoutSubmissionInput,
  ): Promise<PayoutSubmissionResult> {
    this.assertSandbox();
    if (!input.providerReference.startsWith('sbx-pyo-'))
      throw new PermanentPayoutRequestError(
        'PROVIDER_REFERENCE_INVALID',
        'Sandbox payout reference has an unexpected shape',
      );
    if (!ACCOUNT_NUMBER_PATTERN.test(input.accountNumber))
      throw new PermanentPayoutRequestError(
        'PAYOUT_ACCOUNT_INVALID',
        'Destination account number has an unexpected shape',
      );
    // Deterministic stub: the sandbox provider always settles successfully.
    return {
      status: 'succeeded',
      providerReference: input.providerReference,
      occurredAt: new Date(),
    };
  }

  private assertSandbox(): void {
    if (
      this.config.getOrThrow<string>('NODE_ENV') === 'production' ||
      this.config.get<string>('PAYOUTS_PROVIDER_MODE') !== 'sandbox'
    )
      throw new ServiceUnavailableException({
        code: 'PAYOUT_PROVIDER_DISABLED',
        message: 'Sandbox payouts are not available in this mode',
      });
  }
}
