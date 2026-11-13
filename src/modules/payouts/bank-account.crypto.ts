import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { BANK_ACCOUNT_ERROR_CODES } from './payouts.constants';

/**
 * Bank account number protection (REQUIREMENTS section 7.6, AGENTS.md).
 *
 * - The plaintext number is NEVER stored, returned or logged.
 * - account_number_ciphertext = AES-256-GCM with AUTH_ENCRYPTION_KEY (same
 *   pattern as pickup codes / auth secrets), base64(iv | tag | ciphertext).
 * - account_number_hash = HMAC-SHA256 with a key DERIVED from the encryption
 *   key, because an account number has low entropy and a plain hash would be
 *   reversible by enumeration; it exists only for duplicate detection.
 * - account_number_masked ('****1234') is the only representation the API may
 *   return.
 */

export const ACCOUNT_NUMBER_PATTERN = /^[0-9]{6,20}$/;

export type BankAccountKeys = {
  encryptionKey: Buffer;
  dedupeKey: Buffer;
};

/** Resolve and validate the configured keys; fails closed with a 503. */
export function bankAccountKeys(config: ConfigService): BankAccountKeys {
  const text = config.get<string>('AUTH_ENCRYPTION_KEY');
  const unavailable = (): ServiceUnavailableException =>
    new ServiceUnavailableException({
      code: BANK_ACCOUNT_ERROR_CODES.encryptionDisabled,
      message: 'Bank account protection is not configured',
    });
  if (!text) throw unavailable();
  const encryptionKey = Buffer.from(text, 'base64');
  if (encryptionKey.length !== 32) throw unavailable();
  const dedupeKey = createHmac('sha256', encryptionKey)
    .update('antriin.bank_account.dedupe.v1', 'utf8')
    .digest();
  return { encryptionKey, dedupeKey };
}

/** Strip spaces/dashes and validate the digits-only account number. */
export function normalizeAccountNumber(raw: string): string {
  const normalized = (raw ?? '').replace(/[\s-]/g, '');
  if (!ACCOUNT_NUMBER_PATTERN.test(normalized))
    throw new BadRequestException({
      code: BANK_ACCOUNT_ERROR_CODES.numberInvalid,
      message: 'Account number must be 6 to 20 digits',
    });
  return normalized;
}

/** The only shape that may leave the server. */
export function maskAccountNumber(normalized: string): string {
  return '****' + normalized.slice(-4);
}

export function encryptAccountNumber(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptAccountNumber(key: Buffer, payload: string): string {
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length < 29) throw new Error('Invalid encrypted account number');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf8',
  );
}

/** Keyed HMAC for duplicate detection (never a plain hash). */
export function hashAccountNumber(key: Buffer, plaintext: string): string {
  return createHmac('sha256', key).update(plaintext, 'utf8').digest('hex');
}
