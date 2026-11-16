import { randomBytes } from 'node:crypto';
import {
  ORDER_NUMBER_ALPHABET,
  ORDER_NUMBER_SUFFIX_LENGTH,
} from './orders.constants';

/**
 * Public, non-guessable display number: `AN-YYYYMMDD-XXXXXX`.
 *
 * - The date part is the UTC creation date (stable, sortable, not a secret).
 * - The suffix is Crockford base32 (no I/L/O/U) so support staff can read it
 *   aloud without ambiguity.
 * - It is NOT a security token: pickup validation uses pickup_credentials
 *   (AGENTS.md: never rely on a sequential order number as a secret).
 * - Collision safety comes from the unique index `orders_order_number_uq`
 *   plus a bounded retry on SQLSTATE 23505 in the checkout transaction.
 */
/**
 * `bytes` is injectable so a test can drive the suffix deterministically.
 * The alphabet is 32 characters and 256 is a multiple of 32, so `byte % 32`
 * is uniform over the whole alphabet; a test that simply draws thousands of
 * numbers cannot assert "no collision" because the birthday bound makes that
 * fail roughly one run in eighty with a genuinely correct generator.
 */
export function generateOrderNumber(
  now: Date = new Date(),
  bytes: Buffer = randomBytes(ORDER_NUMBER_SUFFIX_LENGTH),
): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  let suffix = '';
  for (let index = 0; index < ORDER_NUMBER_SUFFIX_LENGTH; index += 1) {
    const byte = bytes[index % bytes.length];
    suffix += ORDER_NUMBER_ALPHABET[byte % ORDER_NUMBER_ALPHABET.length];
  }
  return `AN-${date}-${suffix}`;
}
