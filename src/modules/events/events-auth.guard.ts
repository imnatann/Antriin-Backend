import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { EVENTS_ACCESS_TOKEN_PATTERN } from './events.constants';

/**
 * Authentication for the SSE stream only.
 *
 * AuthGuard is left untouched: it reads the Authorization header, and loosening
 * it would weaken every other route to solve a problem that belongs to one
 * endpoint. EventSource cannot set headers, so this guard accepts the same
 * bearer token from `?access_token=` as a second source and hands it to the
 * same AuthService.authenticate call, which checks the session hash, expiry,
 * revocation and user status.
 *
 * When an Authorization header is present it must be valid: a malformed header
 * plus a valid query token is still rejected, so a proxy that injects a broken
 * header cannot silently downgrade the endpoint to query-string auth.
 *
 * A token in a URL is a second-class credential: it can land in proxy access
 * logs and request diagnostics. It is accepted on this one route because the
 * browser EventSource API has no way to set a header, and a client that can set
 * headers should use them. The token is still validated by AuthService (hash,
 * expiry, revocation, user status); nothing is trusted from the string itself.
 */
@Injectable()
export class EventsAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = this.tokenFrom(request);
    if (!token) this.unauthorized();
    const principal = await this.auth.authenticate(token);
    (request as FastifyRequest & { user?: AuthenticatedPrincipal }).user =
      principal;
    return true;
  }

  private tokenFrom(request: FastifyRequest): string | null {
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string') {
      // Same expression as AuthGuard, including the length bounds.
      const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
      return match ? match[1] : null;
    }
    const query = request.query as { access_token?: unknown } | undefined;
    const accessToken = query?.access_token;
    return typeof accessToken === 'string' &&
      EVENTS_ACCESS_TOKEN_PATTERN.test(accessToken)
      ? accessToken
      : null;
  }

  private unauthorized(): never {
    throw new UnauthorizedException({
      code: 'unauthorized',
      message: 'A valid bearer token is required',
    });
  }
}
