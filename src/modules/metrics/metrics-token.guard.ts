import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

const BEARER_SHAPE = /^Bearer (.+)$/;

/**
 * Optional bearer gate for GET /metrics.
 *
 * METRICS_TOKEN is not part of the validated environment schema yet (the root
 * wires it); while it is unset the scrape route stays open so a local Prometheus
 * or a smoke test works without configuration. As soon as it is set, a
 * missing or wrong token is answered with 401 (never 403: the caller is not
 * authenticated rather than not allowed).
 */
@Injectable()
export class MetricsTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('METRICS_TOKEN');
    if (!expected) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const authorization = request.headers?.authorization;
    const provided =
      typeof authorization === 'string'
        ? BEARER_SHAPE.exec(authorization)?.[1]
        : undefined;
    if (!provided || !sameToken(expected, provided)) throw this.unauthorized();
    return true;
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: 'A valid metrics token is required',
    });
  }
}

/** Constant-time comparison that never throws on a length mismatch. */
function sameToken(expected: string, provided: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');
  if (left.length !== right.length) {
    // Still compare something of equal length so the failure path is not
    // measurably cheaper; the result is ignored.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
