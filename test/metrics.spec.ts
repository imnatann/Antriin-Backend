import 'reflect-metadata';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConflictException,
  Controller,
  Get,
  Global,
  Module,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { MetricsModule } from '../src/modules/metrics/metrics.module';
import { MetricsRegistry } from '../src/modules/metrics/metrics.registry';

const NEWLINE = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

describe('MetricsRegistry rendering', () => {
  it('emits HELP/TYPE metadata for every metric family and the process gauges', () => {
    const text = new MetricsRegistry().render();

    assert.ok(text.startsWith('# HELP antriin_http_requests_total '));
    assert.ok(text.includes('# TYPE antriin_http_requests_total counter'));
    assert.ok(
      text.includes('# TYPE antriin_http_request_duration_seconds histogram'),
    );
    assert.ok(text.includes('# TYPE antriin_process_uptime_seconds gauge'));
    assert.ok(
      text.includes('# TYPE antriin_process_resident_memory_bytes gauge'),
    );
    assert.ok(text.includes('# TYPE antriin_nodejs_heap_used_bytes gauge'));
    assert.ok(text.includes('# TYPE antriin_nodejs_heap_total_bytes gauge'));
    assert.ok(text.endsWith(NEWLINE));
  });

  it('counts requests per method, route template and status class', () => {
    const registry = new MetricsRegistry();
    registry.observeHttpRequest({
      method: 'GET',
      route: '/api/v1/search',
      statusCode: 200,
      durationSeconds: 0.002,
    });
    registry.observeHttpRequest({
      method: 'get',
      route: '/api/v1/search',
      statusCode: 201,
      durationSeconds: 0.002,
    });
    registry.observeHttpRequest({
      method: 'GET',
      route: '/api/v1/search',
      statusCode: 429,
      durationSeconds: 0.3,
    });

    const text = registry.render();
    assert.ok(
      text.includes(
        'antriin_http_requests_total{method="GET",route="/api/v1/search",status_class="2xx"} 2',
      ),
    );
    assert.ok(
      text.includes(
        'antriin_http_requests_total{method="GET",route="/api/v1/search",status_class="4xx"} 1',
      ),
    );
    assert.ok(
      text.includes(
        'antriin_http_request_duration_seconds_count{method="GET",route="/api/v1/search",status_class="2xx"} 2',
      ),
    );
  });

  it('renders cumulative histogram buckets with a +Inf total', () => {
    const registry = new MetricsRegistry();
    for (const durationSeconds of [0.002, 0.002, 0.3])
      registry.observeHttpRequest({
        method: 'GET',
        route: '/api/v1/search',
        statusCode: 200,
        durationSeconds,
      });

    const text = registry.render();
    const series = '{method="GET",route="/api/v1/search",status_class="2xx"';
    assert.ok(
      text.includes(
        'antriin_http_request_duration_seconds_bucket' +
          series +
          ',le="0.005"} 2',
      ),
    );
    assert.ok(
      text.includes(
        'antriin_http_request_duration_seconds_bucket' +
          series +
          ',le="0.25"} 2',
      ),
    );
    assert.ok(
      text.includes(
        'antriin_http_request_duration_seconds_bucket' +
          series +
          ',le="0.5"} 3',
      ),
      'a 300ms request lands in 0.5 but not in 0.25',
    );
    assert.ok(
      text.includes(
        'antriin_http_request_duration_seconds_bucket' +
          series +
          ',le="+Inf"} 3',
      ),
    );
    assert.ok(
      text.includes(
        'antriin_http_request_duration_seconds_sum' + series + '} 0.304',
      ),
    );
  });

  it('escapes label values instead of emitting a broken exposition', () => {
    const registry = new MetricsRegistry();
    registry.observeHttpRequest({
      method: 'GET',
      route: '/api/v1/weird' + NEWLINE + 'route"x' + BACKSLASH + 'y',
      statusCode: 404,
      durationSeconds: 0.001,
    });

    const text = registry.render();
    const lines = text.split(NEWLINE);
    const seriesLine = lines.find((line) =>
      line.startsWith('antriin_http_requests_total{'),
    );
    assert.ok(seriesLine, 'the series must be rendered on one line');
    assert.ok(
      seriesLine.includes('route="/api/v1/weird' + BACKSLASH + 'nroute'),
    );
    assert.ok(
      seriesLine.includes(BACKSLASH + '"x' + BACKSLASH + BACKSLASH + 'y'),
      'quotes and backslashes are escaped, not emitted raw',
    );
    assert.equal(
      text.split('antriin_http_requests_total{').length - 1,
      1,
      'one request must produce exactly one counter series',
    );
  });

  it('keeps a bounded number of series when routes explode', () => {
    const registry = new MetricsRegistry();
    for (let index = 0; index < 600; index += 1)
      registry.observeHttpRequest({
        method: 'GET',
        route: '/api/v1/invented/' + index,
        statusCode: 404,
        durationSeconds: 0.001,
      });

    const text = registry.render();
    const seriesCount = text.split('antriin_http_requests_total{').length - 1;
    assert.ok(seriesCount < 600, 'series growth must be capped');
    assert.ok(
      text.includes(
        'antriin_http_requests_total{method="GET",route="__other__"',
      ),
      'overflow is reported instead of dropping observations silently',
    );
  });
});

@Controller('probe')
class ProbeController {
  @Get()
  ok() {
    return { data: { status: 'ok' } };
  }

  @Get('conflict')
  conflict() {
    throw new ConflictException({
      code: 'PROBE_CONFLICT',
      message: 'probe conflict',
    });
  }
}

function configModule(token: string | undefined) {
  @Global()
  @Module({
    providers: [
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) => (key === 'METRICS_TOKEN' ? token : undefined),
        },
      },
    ],
    exports: [ConfigService],
  })
  class StubConfigModule {}
  return StubConfigModule;
}

describe('GET /metrics HTTP contract', () => {
  let app: NestFastifyApplication | undefined;

  async function createApp(token?: string): Promise<NestFastifyApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [configModule(token), MetricsModule],
      controllers: [ProbeController],
    }).compile();
    const created = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    created.setGlobalPrefix('api/v1');
    created.useGlobalFilters(new ApiExceptionFilter());
    await created.init();
    await created.getHttpAdapter().getInstance().ready();
    return created;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves the Prometheus text exposition for recorded requests', async () => {
    app = await createApp();
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/probe' })).statusCode,
      200,
    );

    const scrape = await app.inject({ method: 'GET', url: '/api/v1/metrics' });
    assert.equal(scrape.statusCode, 200);
    assert.ok(
      String(scrape.headers['content-type']).startsWith(
        'text/plain; version=0.0.4',
      ),
      'a Prometheus server needs the versioned text content type',
    );
    const body = scrape.body;
    assert.ok(
      body.includes(
        'antriin_http_requests_total{method="GET",route="/api/v1/probe",status_class="2xx"} 1',
      ),
    );
    assert.ok(
      body.includes(
        'antriin_http_request_duration_seconds_count{method="GET",route="/api/v1/probe",status_class="2xx"} 1',
      ),
    );
    assert.ok(body.includes('antriin_process_uptime_seconds '));
    assert.ok(body.includes('antriin_process_resident_memory_bytes '));
  });

  it('labels a failed request with its 4xx status class and the route template', async () => {
    app = await createApp();
    const failure = await app.inject({
      method: 'GET',
      url: '/api/v1/probe/conflict',
    });
    assert.equal(failure.statusCode, 409);
    assert.equal(failure.json().error.code, 'PROBE_CONFLICT');

    const scrape = await app.inject({ method: 'GET', url: '/api/v1/metrics' });
    assert.ok(
      scrape.body.includes(
        'antriin_http_requests_total{method="GET",route="/api/v1/probe/conflict",status_class="4xx"} 1',
      ),
    );
  });

  it('stays open when METRICS_TOKEN is not configured', async () => {
    app = await createApp();
    const scrape = await app.inject({ method: 'GET', url: '/api/v1/metrics' });
    assert.equal(scrape.statusCode, 200);
    assert.ok(
      scrape.body.includes('# TYPE antriin_http_requests_total counter'),
    );
  });

  it('requires the configured bearer token and answers 401 otherwise', async () => {
    app = await createApp('scrape-token-for-tests');
    const missing = await app.inject({ method: 'GET', url: '/api/v1/metrics' });
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json().error.code, 'UNAUTHENTICATED');

    const wrong = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics',
      headers: { authorization: 'Bearer not-the-token' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().error.code, 'UNAUTHENTICATED');

    const accepted = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics',
      headers: { authorization: 'Bearer scrape-token-for-tests' },
    });
    assert.equal(accepted.statusCode, 200);
    assert.ok(
      accepted.body.includes('# TYPE antriin_http_requests_total counter'),
    );
  });
});
