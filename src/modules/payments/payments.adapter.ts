import { createHash } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * A permanent provider-request failure. Retrying cannot succeed, so the
 * request processor marks the outbox row dead instead of backing off.
 */
export class PermanentPaymentRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PermanentPaymentRequestError';
    this.code = code;
  }
}

export interface ProviderIntentInput {
  id: string;
  providerReference: string;
  amountMinor: string;
  currency: string;
}

/**
 * Port for top-up payment providers. Only the controlled sandbox stub exists;
 * production QRIS/Midtrans adapters require real contracts and credentials
 * and are intentionally not implemented in this slice.
 */
export interface TopupProviderAdapter {
  readonly provider: string;
  /** Deterministic per-intent reference; unique per (provider, reference). */
  buildProviderReference(input: {
    userId: string;
    idempotencyKey: string;
    requestHash: string;
  }): string;
  /** Buyer-facing payment payload (sandbox QRIS mock string). */
  renderQrisPayload(input: {
    providerReference: string;
    amountMinor: string;
    currency: string;
  }): string;
  /**
   * Registers the payment request with the provider. Called by the request
   * processor OUTSIDE any database transaction or row lock. Implementations
   * must be safe to retry with the same providerReference.
   */
  createPaymentRequest(
    intent: ProviderIntentInput,
  ): Promise<{ providerReference: string }>;
}

export const PAYMENTS_PROVIDER_ADAPTER = Symbol('PAYMENTS_PROVIDER_ADAPTER');

/**
 * Controlled sandbox stub: pure deterministic functions, no real network and
 * no real money. Refuses to operate when NODE_ENV is production.
 */
@Injectable()
export class SandboxPaymentsAdapter implements TopupProviderAdapter {
  readonly provider = 'sandbox';

  constructor(private readonly config: ConfigService) {}

  buildProviderReference(input: {
    userId: string;
    idempotencyKey: string;
    requestHash: string;
  }): string {
    this.assertNotProduction();
    const digest = createHash('sha256')
      .update(
        input.userId + '|' + input.idempotencyKey + '|' + input.requestHash,
        'utf8',
      )
      .digest('hex');
    return 'sbx-' + digest.slice(0, 48);
  }

  renderQrisPayload(input: {
    providerReference: string;
    amountMinor: string;
    currency: string;
  }): string {
    this.assertNotProduction();
    return (
      'ANTRIIN-QRIS-SANDBOX-v1|' +
      input.providerReference +
      '|' +
      input.currency +
      '|' +
      input.amountMinor
    );
  }

  async createPaymentRequest(
    intent: ProviderIntentInput,
  ): Promise<{ providerReference: string }> {
    this.assertNotProduction();
    // Deterministic stub: the reference was derived from the same inputs at
    // intent creation, so registration only re-derives and confirms it.
    if (!intent.providerReference.startsWith('sbx-'))
      throw new PermanentPaymentRequestError(
        'PROVIDER_REFERENCE_INVALID',
        'Sandbox provider reference has an unexpected shape',
      );
    return { providerReference: intent.providerReference };
  }

  private assertNotProduction(): void {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'production')
      throw new ServiceUnavailableException({
        code: 'PAYMENTS_PROVIDER_DISABLED',
        message: 'Sandbox payments are never available in production',
      });
  }
}
