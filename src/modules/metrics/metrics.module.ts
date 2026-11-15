import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsRegistry } from './metrics.registry';
import { MetricsTokenGuard } from './metrics-token.guard';

/**
 * B11 metrics. Importing this module registers the collecting interceptor for
 * the whole application (APP_INTERCEPTOR) and exposes GET /api/v1/metrics.
 * Nothing else has to be added to main.ts or app.module.ts beyond the import.
 */
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsRegistry,
    MetricsTokenGuard,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [MetricsRegistry],
})
export class MetricsModule {}
