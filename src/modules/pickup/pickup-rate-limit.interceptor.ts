import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { createHmac } from 'node:crypto';
import { Observable, from, throwError } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { RedisService } from '../../infrastructure/redis.service';
import {
  PICKUP_ERROR_CODES,
  PICKUP_RATE_LIMIT_KEY_PREFIX,
  PICKUP_RATE_LIMIT_MAX_FAILED_ATTEMPTS,
  PICKUP_RATE_LIMIT_WINDOW_SECONDS,
} from './pickup.constants';

/**
 * Brute-force protection for code-presentation endpoints (verify + handover),
 * rebuilt per review R3-01:
 * - ONLY failed code attempts count toward the quota (invalid / expired /
 *   revoked / consumed). Successful verifications and handovers never touch
 *   the counter, so a busy legitimate counter can never lock itself out.
 * - The bucket is keyed per (client IP, tenant, actor), not per IP alone, so
 *   one noisy client cannot block other counters behind the same NAT/proxy.
 *   NOTE: deployments behind a reverse proxy MUST enable Fastify trustProxy
 *   (root-owned main.ts) or request.ip is the proxy address for everyone.
 * - Same Redis instance and Lua-counter pattern as AuthRateLimitGuard (which
 *   must not be edited), with a DISTINCT key namespace so pickup failures
 *   never mix with OTP counters. The IP is stored only as HMAC-SHA256.
 * - Fail-closed: when Redis is unavailable the request is refused with 503
 *   (never allowed through).
 *
 * Implemented as an interceptor (not a guard) because the failure count can
 * only be known AFTER the handler ran; guards execute before it.
 */
const READ_FAILED_COUNT = `
  local current = tonumber(redis.call('GET', KEYS[1]) or '0')
  local ttl = redis.call('TTL', KEYS[1])
  return {current, ttl}
`;
const INCREMENT_WITH_TTL = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return current
`;

/**
 * Domain failures that prove a wrong/stale code was presented and therefore
 * feed the brute-force budget. Deliberately EXCLUDED: 404 cross-tenant (root
 * brief contract), 403/401 (session/permission, not code guessing),
 * PICKUP_ORDER_NOT_ELIGIBLE and ORDER_STATE_CONFLICT (order state, says
 * nothing about code correctness) and 5xx.
 */
const COUNTED_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  PICKUP_ERROR_CODES.codeInvalid,
  PICKUP_ERROR_CODES.credentialExpired,
  PICKUP_ERROR_CODES.credentialRevoked,
  PICKUP_ERROR_CODES.credentialConsumed,
]);

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RateLimitState {
  count: number;
  ttl: number;
}

@Injectable()
export class PickupRateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<
      FastifyRequest & {
        user?: { userId?: string };
        params?: { tenantId?: string };
      }
    >();
    const secret = this.config.get<string>('AUTH_SECRET');
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new ServiceUnavailableException({
        code: PICKUP_ERROR_CODES.notConfigured,
        message: 'Pickup credential protection is not configured',
      });
    }
    const key = this.bucketKey(request, secret);
    return from(this.readFailedCount(key)).pipe(
      switchMap((state) => {
        if (state === null) {
          return throwError(
            () =>
              new ServiceUnavailableException({
                code: PICKUP_ERROR_CODES.rateLimitUnavailable,
                message: 'Pickup code verification is temporarily unavailable',
              }),
          );
        }
        if (state.count >= PICKUP_RATE_LIMIT_MAX_FAILED_ATTEMPTS) {
          return throwError(
            () =>
              new HttpException(
                {
                  code: PICKUP_ERROR_CODES.rateLimited,
                  message: 'Too many failed pickup code attempts',
                  retryAfterSeconds:
                    state.ttl > 0
                      ? state.ttl
                      : PICKUP_RATE_LIMIT_WINDOW_SECONDS,
                },
                HttpStatus.TOO_MANY_REQUESTS,
              ),
          );
        }
        return next.handle().pipe(
          catchError((error: unknown) => {
            if (!this.isCountedFailure(error)) {
              return throwError(() => error);
            }
            return from(this.recordFailure(key)).pipe(
              switchMap(() => throwError(() => error)),
            );
          }),
        );
      }),
    );
  }

  /** Key shape: antriin:pickup:rate:code:hmac(ip):tenantId:actorUserId */
  private bucketKey(
    request: FastifyRequest & {
      user?: { userId?: string };
      params?: { tenantId?: string };
    },
    secret: string,
  ): string {
    const ip = request.ip || request.socket?.remoteAddress || 'unknown';
    const ipHash = createHmac('sha256', secret)
      .update(ip, 'utf8')
      .digest('hex');
    const tenantId = UUID_SHAPE.test(request.params?.tenantId ?? '')
      ? (request.params?.tenantId as string)
      : 'invalid-tenant';
    const actorId = UUID_SHAPE.test(request.user?.userId ?? '')
      ? (request.user?.userId as string)
      : 'anonymous';
    return `${PICKUP_RATE_LIMIT_KEY_PREFIX}:${ipHash}:${tenantId}:${actorId}`;
  }

  private async readFailedCount(key: string): Promise<RateLimitState | null> {
    try {
      await this.redis.ping();
      const raw = (await this.redis.client.eval(
        READ_FAILED_COUNT,
        1,
        key,
      )) as unknown;
      if (!Array.isArray(raw) || raw.length < 2) return null;
      const count = Number(raw[0]);
      const ttl = Number(raw[1]);
      if (!Number.isSafeInteger(count) || !Number.isSafeInteger(ttl)) {
        return null;
      }
      return { count, ttl };
    } catch {
      return null;
    }
  }

  /** Best-effort: the domain error must propagate even if Redis flaps here. */
  private async recordFailure(key: string): Promise<void> {
    try {
      await this.redis.client.eval(
        INCREMENT_WITH_TTL,
        1,
        key,
        PICKUP_RATE_LIMIT_WINDOW_SECONDS,
      );
    } catch {
      // ignored on purpose
    }
  }

  private isCountedFailure(error: unknown): boolean {
    if (!(error instanceof HttpException)) return false;
    const response = error.getResponse();
    if (typeof response !== 'object' || response === null) return false;
    const code = (response as { code?: unknown }).code;
    return typeof code === 'string' && COUNTED_FAILURE_CODES.has(code);
  }
}
