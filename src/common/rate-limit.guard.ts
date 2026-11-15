import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, randomBytes } from 'node:crypto';
import {
  RATE_LIMIT_ERROR_CODE,
  RATE_LIMIT_KEY_PREFIX,
  isRateLimitExemptPath,
  normalisePath,
  policyForRequest,
  routeBucket,
} from './rate-limit.policy';
import type { RateLimitPolicy } from './rate-limit.policy';
import { RATE_LIMIT_STORE } from './rate-limit.store';
import type { RateLimitStore } from './rate-limit.store';

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER_SHAPE = /^Bearer ([A-Za-z0-9._~+/-]{16,256})$/;

/**
 * Process-local salt used only when AUTH_SECRET is unusable. It keeps client
 * IPs and session tokens out of Redis keys even in a misconfigured deployment;
 * it is random per process, so limiting is not shared across replicas in that
 * state (the auth module already refuses to authenticate without a secret).
 */
const FALLBACK_SALT = randomBytes(32);

type RateLimitRequest = FastifyRequest & {
  user?: { userId?: string };
};

type RateLimitIdentity = {
  /** Which namespace the identity value belongs to. Also part of the key. */
  kind: 'user' | 'session' | 'ip';
  /** User id, or an HMAC of the session token / client IP. Never a raw secret. */
  value: string;
};

/**
 * Global, Redis-backed rate limiter for B3.
 *
 * Intended registration (root owns src/app.module.ts):
 *
 *   imports: [..., RateLimitModule]
 *   providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }]
 *
 * Policies (see src/common/rate-limit.policy.ts):
 * - public reads 120/min per client IP
 * - authenticated reads 300/min per user
 * - POST/PATCH/PUT/DELETE 60/min per user (60/min per IP when unauthenticated)
 *
 * Identity:
 * - request.user.userId when an authentication guard already ran (guards are
 *   ordered global -> controller -> route, so a global rate limit guard runs
 *   BEFORE the route-level AuthGuard and normally sees no principal);
 * - otherwise the bearer session token, keyed by HMAC-SHA256 so the raw token is
 *   never stored and two clients behind one campus NAT never share a bucket;
 * - otherwise the client IP, again only as an HMAC.
 * A global guard must not perform a database lookup of its own: doing so once
 * per request would double session lookups and let a spray of invented bearer
 * tokens turn every request into a query. When this guard is applied after
 * authentication (controller/route scope), the literal per-user-id bucket is
 * used instead.
 *
 * Fail OPEN: when the counter store is unavailable the request is allowed and
 * one warning is logged per outage. Availability of public reads (campus
 * browsing) matters more than a strict limit, and the OTP/pickup credential
 * endpoints keep their own fail-closed limiters.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  /** True while the store is failing, so an outage logs once, not per request. */
  private degraded = false;

  constructor(
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<RateLimitRequest>();
    const path = normalisePath(request.url ?? '');
    if (isRateLimitExemptPath(path)) return true;

    const identity = this.identity(request);
    const policy = policyForRequest(
      request.method,
      identity.kind === 'user' || identity.kind === 'session',
    );
    const bucket = routeBucket(request.routeOptions?.url, path);
    const key = `${RATE_LIMIT_KEY_PREFIX}:${policy.name}:${bucket}:${identity.kind}:${identity.value}`;

    let result: Awaited<ReturnType<RateLimitStore['hit']>>;
    try {
      result = await this.store.hit(key, policy.windowSeconds);
    } catch {
      this.reportDegraded();
      return true;
    }
    if (this.degraded) this.degraded = false;

    const retryAfterSeconds = clampRetryAfter(
      result.retryAfterSeconds,
      policy.windowSeconds,
    );
    const allowed = result.count <= policy.limit;
    const reply = http.getResponse<FastifyReply>();
    this.writeHeaders(reply, policy, result.count, retryAfterSeconds, allowed);
    if (allowed) return true;
    throw new HttpException(
      {
        code: RATE_LIMIT_ERROR_CODE,
        message: `Too many requests; retry after ${retryAfterSeconds} seconds`,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private identity(request: RateLimitRequest): RateLimitIdentity {
    const userId = request.user?.userId;
    if (typeof userId === 'string' && UUID_SHAPE.test(userId))
      return { kind: 'user', value: userId };

    const authorization = request.headers?.authorization;
    const token =
      typeof authorization === 'string'
        ? BEARER_SHAPE.exec(authorization)?.[1]
        : undefined;
    if (token)
      return { kind: 'session', value: this.digest(`session:${token}`) };

    const ip = request.ip || request.socket?.remoteAddress || 'unknown';
    return { kind: 'ip', value: this.digest(`ip:${ip}`) };
  }

  private digest(value: string): string {
    const secret = this.config.get<string>('AUTH_SECRET');
    const key =
      typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32
        ? secret
        : FALLBACK_SALT;
    return createHmac('sha256', key).update(value, 'utf8').digest('hex');
  }

  private writeHeaders(
    reply: FastifyReply,
    policy: RateLimitPolicy,
    count: number,
    retryAfterSeconds: number,
    allowed: boolean,
  ): void {
    if (typeof reply?.header !== 'function') return;
    reply
      .header('ratelimit-limit', String(policy.limit))
      .header('ratelimit-remaining', String(Math.max(0, policy.limit - count)))
      .header('ratelimit-reset', String(retryAfterSeconds))
      .header('ratelimit-policy', `${policy.limit};w=${policy.windowSeconds}`);
    // The ApiExceptionFilter sets Retry-After for the 429 too; setting it here
    // keeps the header correct for callers that use the guard without it.
    if (!allowed) reply.header('retry-after', String(retryAfterSeconds));
  }

  private reportDegraded(): void {
    if (this.degraded) return;
    this.degraded = true;
    this.logger.warn(
      'Global rate limiting is unavailable; allowing requests (fail open)',
    );
  }
}

function clampRetryAfter(value: number, windowSeconds: number): number {
  if (!Number.isFinite(value)) return windowSeconds;
  const rounded = Math.ceil(value);
  if (rounded < 1) return 1;
  return Math.min(rounded, windowSeconds);
}
