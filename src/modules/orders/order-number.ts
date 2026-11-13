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
export function generateOrderNumber(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const bytes = randomBytes(ORDER_NUMBER_SUFFIX_LENGTH);
  let suffix = '';
  for (const byte of bytes) {
    suffix += ORDER_NUMBER_ALPHABET[byte % ORDER_NUMBER_ALPHABET.length];
  }
  return `AN-${date}-${suffix}`;
}
