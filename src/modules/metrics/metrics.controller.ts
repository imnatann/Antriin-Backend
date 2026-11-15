import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { MetricsRegistry } from './metrics.registry';
import { MetricsTokenGuard } from './metrics-token.guard';

/**
 * Prometheus scrape endpoint. Mounted under the global /api/v1 prefix, so the
 * address is /api/v1/metrics; the rate limiter exempts it for the same reason
 * probes are exempt (see RATE_LIMIT_EXEMPT_ROOTS).
 */
@ApiTags('Metrics')
@Controller('metrics')
@UseGuards(MetricsTokenGuard)
export class MetricsController {
  constructor(private readonly registry: MetricsRegistry) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('cache-control', 'no-store')
  @ApiOperation({
    summary: 'Prometheus metrics (text exposition format 0.0.4)',
    description:
      'Request counter and duration histogram labelled by method, route template and status class, plus process uptime and memory gauges. Open while METRICS_TOKEN is unset; otherwise a bearer token is required and anything else is answered with 401.',
  })
  @ApiOkResponse({ description: 'Prometheus text exposition' })
  @ApiUnauthorizedResponse({
    description:
      'METRICS_TOKEN is configured and the bearer token is missing or wrong',
  })
  scrape(): string {
    return this.registry.render();
  }
}
