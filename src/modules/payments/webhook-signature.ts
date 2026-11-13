import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sandbox webhook authentication helpers.
 *
 * The signature is HMAC-SHA256 over the string timestamp + '.' + exactRawBody
 * using PAYMENTS_SANDBOX_WEBHOOK_SECRET. Signature and timestamp travel in
 * separate headers. The timestamp bounds request age (replay window); it is
 * unrelated to the historical occurredAt inside the event payload, which may
 * legitimately be old for late-success reconciliation.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'x-antriin-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-antriin-timestamp';
export const WEBHOOK_MAX_SKEW_SECONDS = 300;

const TIMESTAMP_PATTERN = /^[0-9]{1,15}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;

export type WebhookVerificationFailureCode =
  | 'WEBHOOK_CREDENTIALS_MISSING'
  | 'WEBHOOK_TIMESTAMP_INVALID'
  | 'WEBHOOK_TIMESTAMP_SKEW'
  | 'WEBHOOK_SIGNATURE_INVALID';

export type WebhookVerification =
  { ok: true } | { ok: false; code: WebhookVerificationFailureCode };

/** HMAC-SHA256 hex digest over timestamp + '.' + rawBody (exact bytes). */
export function computeWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: Buffer,
): string {
  return createHmac('sha256', secret)
    .update(timestamp + '.', 'utf8')
    .update(rawBody)
    .digest('hex');
}

export function verifyWebhookRequest(input: {
  secret: string;
  timestampHeader: unknown;
  signatureHeader: unknown;
  rawBody: Buffer | undefined;
  nowEpochSeconds?: number;
  maxSkewSeconds?: number;
}): WebhookVerification {
  const { secret, timestampHeader, signatureHeader, rawBody } = input;
  const maxSkew = input.maxSkewSeconds ?? WEBHOOK_MAX_SKEW_SECONDS;
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  if (
    typeof timestampHeader !== 'string' ||
    typeof signatureHeader !== 'string' ||
    !rawBody ||
    rawBody.length === 0
  )
    return { ok: false, code: 'WEBHOOK_CREDENTIALS_MISSING' };
  if (!TIMESTAMP_PATTERN.test(timestampHeader))
    return { ok: false, code: 'WEBHOOK_TIMESTAMP_INVALID' };
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp))
    return { ok: false, code: 'WEBHOOK_TIMESTAMP_INVALID' };
  if (Math.abs(now - timestamp) > maxSkew)
    return { ok: false, code: 'WEBHOOK_TIMESTAMP_SKEW' };
  // Fail closed when the secret is absent; sandbox mode requires it via config.
  if (!secret) return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };
  const signature = signatureHeader.toLowerCase();
  if (!SIGNATURE_PATTERN.test(signature))
    return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };
  const expected = Buffer.from(
    computeWebhookSignature(secret, timestampHeader, rawBody),
    'utf8',
  );
  const provided = Buffer.from(signature, 'utf8');
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  )
    return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };
  return { ok: true };
}
