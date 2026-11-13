import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * A permanent refund-provider failure. Retrying cannot succeed, so the
 * request processor parks the refund for human assistance instead of
 * backing off forever.
 */
export class PermanentRefundRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PermanentRefundRequestError';
    this.code = code;
  }
}

export type RefundProviderStatus = 'succeeded' | 'failed' | 'pending';

export interface RefundSubmissionInput {
  refundId: string;
  providerReference: string;
  amountMinor: string;
  currency: string;
  attempt: number;
}

export interface RefundSubmissionResult {
  status: RefundProviderStatus;
  providerReference: string;
  occurredAt: Date;
  /** Stable, non-secret error code when status is 'failed'. */
  errorCode?: string;
}

/**
 * Port for refund providers. Only the controlled sandbox stub exists; a real
 * QRIS/Midtrans refund adapter requires contracts and credentials and is
 * intentionally out of scope. Implementations must be safe to retry with the
 * same providerReference and must never move wallet money themselves:
 * crediting is exclusively done by RefundsService via WalletService.
 */
export interface RefundProviderAdapter {
  readonly provider: string;
  /** Deterministic, stable traceability reference for one refund. */
  buildProviderReference(input: {
    refundId: string;
    orderId: string;
    amountMinor: string;
  }): string;
  /**
   * Submits (or re-polls) the refund at the provider. Called OUTSIDE any
   * database transaction or row lock. Must be idempotent per
   * providerReference: repeated calls never double-refund.
   */
  submitRefund(input: RefundSubmissionInput): Promise<RefundSubmissionResult>;
}

export const REFUNDS_PROVIDER_ADAPTER = Symbol('REFUNDS_PROVIDER_ADAPTER');

/**
 * Controlled sandbox stub: pure deterministic functions, no real network and
 * no real money. Every submission deterministically succeeds so the pilot
 * flow is reproducible; failed/pending provider behaviour is exercised in
 * tests through injected stub adapters. Refuses to operate unless
 * REFUNDS_PROVIDER_MODE is 'sandbox' and NODE_ENV is not production.
 */
@Injectable()
export class SandboxRefundAdapter implements RefundProviderAdapter {
  readonly provider = 'sandbox';

  constructor(private readonly config: ConfigService) {}

  buildProviderReference(input: {
    refundId: string;
    orderId: string;
    amountMinor: string;
  }): string {
    const digest = createHash('sha256')
      .update(
        input.refundId + '|' + input.orderId + '|' + input.amountMinor,
        'utf8',
      )
      .digest('hex');
    return 'sbx-rfd-' + digest.slice(0, 40);
  }

  async submitRefund(
    input: RefundSubmissionInput,
  ): Promise<RefundSubmissionResult> {
    this.assertSandbox();
    if (!input.providerReference.startsWith('sbx-rfd-'))
      throw new PermanentRefundRequestError(
        'PROVIDER_REFERENCE_INVALID',
        'Sandbox refund reference has an unexpected shape',
      );
    // Deterministic stub: the sandbox provider always settles successfully.
    return {
      status: 'succeeded',
      providerReference: input.providerReference,
      occurredAt: new Date(),
    };
  }

  /**
   * A disabled provider is a PERMANENT configuration condition: retrying can
   * never succeed, so it must not burn the transient retry budget. The refund
   * is parked for human assistance on the first attempt instead (the HTTP 503
   * contract still applies at RefundsService.initiateCancellationRefund, which
   * refuses to create a refund at all while the mode is disabled).
   */
  private assertSandbox(): void {
    if (
      this.config.getOrThrow<string>('NODE_ENV') === 'production' ||
      this.config.get<string>('REFUNDS_PROVIDER_MODE') !== 'sandbox'
    )
      throw new PermanentRefundRequestError(
        'REFUNDS_PROVIDER_DISABLED',
        'Sandbox refunds are not available in this mode',
      );
  }
}
