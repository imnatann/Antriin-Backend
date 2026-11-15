import { Injectable } from '@nestjs/common';
import { RedisService } from '../infrastructure/redis.service';

/**
 * What one rate limit hit learned from the store.
 * - count: how many requests this identity already made in the window,
 *   including the current one.
 * - retryAfterSeconds: seconds until the window resets, taken from the key TTL.
 */
export interface RateLimitStoreResult {
  count: number;
  retryAfterSeconds: number;
}

/**
 * Counter store behind the global limiter. Kept as a small interface so the
 * guard can be unit tested with a stub, and so the Redis implementation is the
 * only part that knows about ioredis.
 */
export interface RateLimitStore {
  hit(key: string, windowSeconds: number): Promise<RateLimitStoreResult>;
}

/** DI token for the store (see src/common/rate-limit.module.ts). */
export const RATE_LIMIT_STORE = 'RATE_LIMIT_STORE';

/**
 * INCR + EXPIRE in one script so the TTL is always set exactly once and the
 * reply carries the real remaining window instead of a number guessed by the
 * caller. Same shape as the auth/pickup limiters (which must not be edited),
 * in a separate key namespace.
 */
const INCREMENT_WITH_TTL = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
  end
  return {current, ttl}
`;

/**
 * Redis-backed counter store. It reuses the shared RedisService connection
 * (src/infrastructure) instead of opening a second ioredis client.
 */
@Injectable()
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisService) {}

  async hit(key: string, windowSeconds: number): Promise<RateLimitStoreResult> {
    // RedisService connects lazily; a guard can run before any health probe has
    // connected the client, and eval on a "wait" client would throw.
    if (
      this.redis.client.status === 'wait' ||
      this.redis.client.status === 'end'
    )
      await this.redis.client.connect();
    const raw = (await this.redis.client.eval(
      INCREMENT_WITH_TTL,
      1,
      key,
      windowSeconds,
    )) as unknown;
    if (!Array.isArray(raw) || raw.length < 2)
      throw new Error('Unexpected rate limit reply from Redis');
    const count = Number(raw[0]);
    const ttl = Number(raw[1]);
    if (!Number.isSafeInteger(count) || count < 1)
      throw new Error('Unexpected rate limit counter from Redis');
    if (!Number.isSafeInteger(ttl) || ttl < 0)
      throw new Error('Unexpected rate limit TTL from Redis');
    return {
      count,
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }
}
