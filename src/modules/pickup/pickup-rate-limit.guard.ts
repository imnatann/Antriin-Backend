import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { createHmac } from 'node:crypto';
import { RedisService } from '../../infrastructure/redis.service';
import {
  PICKUP_ERROR_CODES,
  PICKUP_RATE_LIMIT_KEY_PREFIX,
  PICKUP_RATE_LIMIT_MAX_ATTEMPTS,
  PICKUP_RATE_LIMIT_WINDOW_SECONDS,
} from './pickup.constants';

/**
 * Brute-force protection for code-presentation endpoints (verify + handover).
 * Same Redis instance, Lua counter and fail-closed semantics as the auth
 * slice AuthRateLimitGuard (which must not be edited), with a DISTINCT key
 * namespace so pickup attempts never mix with OTP counters:
 * antriin:pickup:rate:code:hmac-sha256(AUTH_SECRET, client ip).
 * The client IP is stored only as an HMAC (no plaintext IP in Redis).
 */
const INCREMENT_WITH_TTL = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return current
`;

@Injectable()
export class PickupRateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const secret = this.config.get<string>('AUTH_SECRET');
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new ServiceUnavailableException({
        code: PICKUP_ERROR_CODES.notConfigured,
        message: 'Pickup credential protection is not configured',
      });
    }
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const ipHash = createHmac('sha256', secret)
      .update(ip, 'utf8')
      .digest('hex');
    const key = `${PICKUP_RATE_LIMIT_KEY_PREFIX}:${ipHash}`;
    try {
      await this.redis.ping();
      const count = Number(
        await this.redis.client.eval(
          INCREMENT_WITH_TTL,
          1,
          key,
          PICKUP_RATE_LIMIT_WINDOW_SECONDS,
        ),
      );
      if (
        !Number.isSafeInteger(count) ||
        count > PICKUP_RATE_LIMIT_MAX_ATTEMPTS
      ) {
        throw new HttpException(
          {
            code: PICKUP_ERROR_CODES.rateLimited,
            message: 'Too many pickup code attempts',
            retryAfterSeconds: PICKUP_RATE_LIMIT_WINDOW_SECONDS,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        code: PICKUP_ERROR_CODES.rateLimitUnavailable,
        message: 'Pickup code verification is temporarily unavailable',
      });
    }
  }
}
