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

const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const CREATE_LIMIT = 10;
const VERIFY_LIMIT = 60;
const INCREMENT_WITH_TTL = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return current
`;

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const secret = this.config.get<string>('AUTH_SECRET');
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32)
      throw new ServiceUnavailableException({
        code: 'auth_not_configured',
        message: 'Authentication is not configured',
      });
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const ipHash = createHmac('sha256', secret)
      .update(ip, 'utf8')
      .digest('hex');
    const isVerification = request.url.includes('/verify');
    const limit = isVerification ? VERIFY_LIMIT : CREATE_LIMIT;
    const category = isVerification ? 'otp-verify' : 'otp-create';
    const key = `antriin:auth:rate:${category}:${ipHash}`;
    try {
      await this.redis.ping();
      const count = Number(
        await this.redis.client.eval(
          INCREMENT_WITH_TTL,
          1,
          key,
          RATE_LIMIT_WINDOW_SECONDS,
        ),
      );
      if (!Number.isSafeInteger(count) || count > limit)
        throw new HttpException(
          {
            code: 'auth_rate_limited',
            message: 'Too many authentication requests',
            retryAfterSeconds: RATE_LIMIT_WINDOW_SECONDS,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        code: 'auth_rate_limit_unavailable',
        message: 'Authentication is temporarily unavailable',
      });
    }
  }
}
