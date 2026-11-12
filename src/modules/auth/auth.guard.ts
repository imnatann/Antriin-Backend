import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';

export interface AuthenticatedPrincipal {
  userId: string;
  sessionId: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string') this.unauthorized();
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
    if (!match) this.unauthorized();
    const principal = await this.auth.authenticate(match[1]);
    (request as FastifyRequest & { user?: AuthenticatedPrincipal }).user =
      principal;
    return true;
  }

  private unauthorized(): never {
    throw new UnauthorizedException({
      code: 'unauthorized',
      message: 'A valid bearer token is required',
    });
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedPrincipal }>();
    if (!request.user)
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'A valid bearer token is required',
      });
    return request.user;
  },
);
