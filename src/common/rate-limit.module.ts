import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../infrastructure/infrastructure.module';
import { RateLimitGuard } from './rate-limit.guard';
import { RATE_LIMIT_STORE, RedisRateLimitStore } from './rate-limit.store';

/**
 * Wiring for the global rate limiter (B3).
 *
 * Importing this module does NOT limit anything by itself: the guard is
 * exported so the root can decide where it applies. To limit the whole API:
 *
 *   imports: [..., RateLimitModule]
 *   providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }]
 *
 * The store token and the guard are exported so that wiring resolves in the
 * module that declares the APP_GUARD provider (usually AppModule).
 */
@Module({
  imports: [InfrastructureModule],
  providers: [
    RateLimitGuard,
    { provide: RATE_LIMIT_STORE, useClass: RedisRateLimitStore },
  ],
  exports: [RateLimitGuard, RATE_LIMIT_STORE],
})
export class RateLimitModule {}
