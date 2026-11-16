import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PermanentPaymentRequestError,
  type ProviderIntentInput,
  type TopupProviderAdapter,
} from './payments.adapter';

/** Xendit pins QR behaviour to an explicit API version header. */
export const XENDIT_API_VERSION = '2022-07-31';
export const XENDIT_DEFAULT_BASE_URL = 'https://api.xendit.co';
/** A hung provider call must not hold a worker slot indefinitely. */
export const XENDIT_TIMEOUT_MS = 10_000;

/**
 * Xendit QR Code adapter (test-mode keys).
 *
 * Two things make this different from the sandbox stub:
 *  - the QR string is issued by Xendit in the response to POST /qr_codes and
 *    can never be recomputed, so it is persisted by the caller;
 *  - a failure can be transient (network, 5xx, 429) or permanent (4xx from a
 *    rejected request). Only the permanent case may burn the retry budget.
 *
 * Only the request is made here. Settling a payment is the webhook's job:
 * this adapter never credits anything.
 */
@Injectable()
export class XenditPaymentsAdapter implements TopupProviderAdapter {
  readonly provider = 'xendit';

  constructor(private readonly config: ConfigService) {}

  /**
   * reference_id is what the callback echoes back, so it must be stable across
   * retries of the same intent and unique per intent. It is derived from the
   * same inputs the sandbox stub uses, which keeps idempotency behaviour
   * identical between the two adapters.
   */
  buildProviderReference(input: {
    userId: string;
    idempotencyKey: string;
    requestHash: string;
  }): string {
    const digest = createHash('sha256')
      .update(
        input.userId + '|' + input.idempotencyKey + '|' + input.requestHash,
        'utf8',
      )
      .digest('hex');
    return 'antriin-' + digest.slice(0, 48);
  }

  /**
   * Xendit issues the payload, so there is nothing to render locally. The
   * caller serves the persisted qr_string instead.
   */
  renderQrisPayload(): string | null {
    return null;
  }

  async createPaymentRequest(
    intent: ProviderIntentInput,
  ): Promise<{ providerReference: string; qrPayload: string | null }> {
    const secretKey = this.config.get<string>('XENDIT_SECRET_KEY') ?? '';
    if (!secretKey)
      throw new PermanentPaymentRequestError(
        'XENDIT_NOT_CONFIGURED',
        'XENDIT_SECRET_KEY is not configured',
      );
    const baseUrl =
      this.config.get<string>('XENDIT_API_BASE_URL') || XENDIT_DEFAULT_BASE_URL;
    const amount = Number(intent.amountMinor);
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new PermanentPaymentRequestError(
        'XENDIT_AMOUNT_INVALID',
        'Top-up amount is not a positive integer in the smallest unit',
      );

    const response = await this.request(baseUrl, secretKey, {
      reference_id: intent.providerReference,
      type: 'DYNAMIC',
      currency: intent.currency,
      amount,
    });

    const body = response as {
      reference_id?: unknown;
      qr_string?: unknown;
    };
    // Echoing a different reference means the QR cannot be reconciled with the
    // intent, so it must never reach a buyer.
    if (body.reference_id !== intent.providerReference)
      throw new PermanentPaymentRequestError(
        'XENDIT_REFERENCE_MISMATCH',
        'Xendit returned a different reference_id than requested',
      );
    if (typeof body.qr_string !== 'string' || body.qr_string.length === 0)
      throw new PermanentPaymentRequestError(
        'XENDIT_QR_MISSING',
        'Xendit response did not contain a qr_string',
      );
    return {
      providerReference: intent.providerReference,
      qrPayload: body.qr_string,
    };
  }

  private async request(
    baseUrl: string,
    secretKey: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const url = baseUrl.replace(/\/$/, '') + '/qr_codes';
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          // Xendit uses HTTP Basic with the secret key as the username and an
          // empty password.
          authorization:
            'Basic ' + Buffer.from(secretKey + ':', 'utf8').toString('base64'),
          'content-type': 'application/json',
          'api-version': XENDIT_API_VERSION,
          // Safe to retry: the same reference_id must not create a second QR.
          'idempotency-key': payload.reference_id as string,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(XENDIT_TIMEOUT_MS),
      });
    } catch (error) {
      // Network failure or timeout: transient, so the processor backs off.
      // The cause is kept so a log names the real transport failure.
      throw new Error(
        'XENDIT_REQUEST_FAILED: ' +
          (error instanceof Error ? error.message : 'unknown transport error'),
        { cause: error },
      );
    }

    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new PermanentPaymentRequestError(
          'XENDIT_RESPONSE_INVALID',
          'Xendit returned a non-JSON success response',
        );
      }
    }

    // 429 and 5xx are the provider telling us to try again later; any other
    // 4xx means the request itself is wrong and retrying cannot help.
    const code =
      'XENDIT_HTTP_' + String(response.status) + this.errorCodeSuffix(text);
    if (response.status === 429 || response.status >= 500)
      throw new Error(code);
    throw new PermanentPaymentRequestError(
      code,
      'Xendit rejected the QR request with status ' +
        String(response.status) +
        ' (' +
        code +
        ')',
    );
  }

  /** Append Xendit's own error_code so logs name the real cause. */
  private errorCodeSuffix(body: string): string {
    try {
      const parsed = JSON.parse(body) as { error_code?: unknown };
      if (typeof parsed.error_code === 'string')
        return ':' + parsed.error_code.slice(0, 60);
    } catch {
      // Not JSON; the status alone is the code.
    }
    return '';
  }
}
