import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { DiscoveryController } from '../src/modules/discovery/discovery.controller';
import { DiscoveryService } from '../src/modules/discovery/discovery.service';
import { DatabaseService } from '../src/database/database.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CAMPUS_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '44444444-4444-4444-8444-444444444444';
const TS = '2026-11-13T10:00:00.000000Z';

const searchResult = {
  data: {
    tenants: [
      {
        id: TENANT_ID,
        name: 'Warung Sate',
        campusId: CAMPUS_ID,
        campusName: 'Kampus Utama',
        location: 'Gedung A',
        status: 'open',
        matchedOn: 'name' as const,
      },
    ],
    items: [
      {
        id: ITEM_ID,
        tenantId: TENANT_ID,
        tenantName: 'Warung Sate',
        tenantStatus: 'open',
        categoryId: '55555555-5555-4555-8555-555555555555',
        categoryName: 'Makanan',
        name: 'Sate Ayam',
        description: 'Sate dengan bumbu kacang',
        priceMinor: '25000',
        currency: 'IDR',
        status: 'active',
      },
    ],
  },
  meta: { query: 'sate', limit: 20 },
};

const recommendationResult = {
  data: [
    {
      menuItemId: ITEM_ID,
      name: 'Sate Ayam',
      description: 'Sate dengan bumbu kacang',
      priceMinor: '25000',
      currency: 'IDR',
      tenantId: TENANT_ID,
      tenantName: 'Warung Sate',
      tenantStatus: 'open',
      rating: { average: null, count: 0 },
      nextPickupStartsAt: TS,
      score: '0.8125',
    },
  ],
  meta: {
    limit: 10,
    criteria: {
      weights: { rating: 0.6, nextPickupFreshness: 0.4 },
      rating: {
        source: 'visible reviews',
        normalization: '(average - 1) / 4',
        neutralWhenNoReviews: 0.5,
      },
      nextPickupFreshness: { horizonHours: 24, formula: 'max(0, 1 - h / 24)' },
      score: '0.6 * rating + 0.4 * freshness',
      candidateLimit: 200,
      order: 'score desc, price asc, name asc, id asc',
    },
  },
};

/** Query DTOs arrive as class instances; compare their plain JSON shape. */
function plain(options: unknown): unknown {
  return JSON.parse(JSON.stringify(options));
}

class StubDiscoveryService {
  calls: { method: string; options: unknown }[] = [];
  failure?: unknown;

  async search(options: { q?: string }) {
    this.calls.push({ method: 'search', options });
    // Mirrors the service guard so the HTTP layer can be checked for the
    // stable SEARCH_QUERY_REQUIRED code without a database.
    if (!options.q || !options.q.trim())
      throw new BadRequestException({
        code: 'SEARCH_QUERY_REQUIRED',
        message: 'q is required and must be 1 to 100 characters',
      });
    if (this.failure) throw this.failure;
    return {
      ...searchResult,
      meta: { ...searchResult.meta, query: options.q },
    };
  }

  async recommend(options: unknown) {
    this.calls.push({ method: 'recommend', options });
    if (this.failure) throw this.failure;
    return recommendationResult;
  }
}

function configure(app: NestFastifyApplication): void {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
}

describe('Discovery HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubDiscoveryService;

  beforeEach(async () => {
    stub = new StubDiscoveryService();
    const module = await Test.createTestingModule({
      controllers: [DiscoveryController],
      providers: [{ provide: DiscoveryService, useValue: stub }],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configure(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves both public routes without a bearer token', async () => {
    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=sate',
    });
    assert.equal(search.statusCode, 200);
    const searchBody = search.json() as typeof searchResult;
    assert.equal(searchBody.meta.query, 'sate');
    assert.equal(searchBody.data.tenants[0].matchedOn, 'name');
    assert.equal(searchBody.data.items[0].status, 'active');

    const recommendations = await app.inject({
      method: 'GET',
      url: '/api/v1/recommendations?campusId=' + CAMPUS_ID,
    });
    assert.equal(recommendations.statusCode, 200);
    const recommendationBody =
      recommendations.json() as typeof recommendationResult;
    assert.equal(recommendationBody.data[0].rating.average, null);
    assert.equal(recommendationBody.data[0].rating.count, 0);
    assert.equal(recommendationBody.meta.criteria.weights.rating, 0.6);

    assert.deepEqual(
      stub.calls.map((call) => call.method),
      ['search', 'recommend'],
    );
    assert.deepEqual(plain(stub.calls[0].options), { q: 'sate' });
    assert.deepEqual(plain(stub.calls[1].options), { campusId: CAMPUS_ID });
  });

  it('rejects a missing or blank q with SEARCH_QUERY_REQUIRED', async () => {
    for (const url of [
      '/api/v1/search',
      '/api/v1/search?q=',
      '/api/v1/search?q=%20%20',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 400, url);
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        'SEARCH_QUERY_REQUIRED',
        url,
      );
    }
  });

  it('rejects invalid limits, ids, budgets and unknown parameters', async () => {
    const urls = [
      '/api/v1/search?q=sate&limit=0',
      '/api/v1/search?q=sate&limit=51',
      '/api/v1/search?q=sate&limit=abc',
      '/api/v1/search?q=sate&campusId=not-a-uuid',
      '/api/v1/search?q=sate&page=2',
      '/api/v1/recommendations?limit=0',
      '/api/v1/recommendations?limit=51',
      '/api/v1/recommendations?tenantId=not-a-uuid',
      '/api/v1/recommendations?campusId=not-a-uuid',
      '/api/v1/recommendations?budgetMaxMinor=1.5',
      '/api/v1/recommendations?budgetMaxMinor=-5',
      '/api/v1/recommendations?sort=rating',
    ];
    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 400, url);
    }
    assert.deepEqual(stub.calls, []);
  });

  it('passes every accepted query parameter to the service', async () => {
    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=sate&campusId=' + CAMPUS_ID + '&limit=5',
    });
    assert.equal(search.statusCode, 200);
    assert.deepEqual(plain(stub.calls[0].options), {
      q: 'sate',
      campusId: CAMPUS_ID,
      limit: 5,
    });

    const recommendations = await app.inject({
      method: 'GET',
      url:
        '/api/v1/recommendations?campusId=' +
        CAMPUS_ID +
        '&tenantId=' +
        TENANT_ID +
        '&budgetMaxMinor=25000&limit=5',
    });
    assert.equal(recommendations.statusCode, 200);
    assert.deepEqual(plain(stub.calls[1].options), {
      campusId: CAMPUS_ID,
      tenantId: TENANT_ID,
      budgetMaxMinor: '25000',
      limit: 5,
    });
  });
});

/**
 * The stub above proves the transport contract; this block runs the real
 * controller and service against an empty database stand-in to prove the
 * documented 200/400 behaviour (no token, stable SEARCH_QUERY_REQUIRED code).
 */
describe('Discovery HTTP contract with the real service', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const emptyDatabase = {
      pool: { query: async () => ({ rows: [] }) },
    } as unknown as DatabaseService;
    const module = await Test.createTestingModule({
      controllers: [DiscoveryController],
      providers: [
        DiscoveryService,
        { provide: DatabaseService, useValue: emptyDatabase },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configure(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns empty envelopes without a token', async () => {
    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=kopi',
    });
    assert.equal(search.statusCode, 200);
    assert.deepEqual(search.json(), {
      data: { tenants: [], items: [] },
      meta: { query: 'kopi', limit: 20 },
    });

    const recommendations = await app.inject({
      method: 'GET',
      url: '/api/v1/recommendations',
    });
    assert.equal(recommendations.statusCode, 200);
    const body = recommendations.json() as typeof recommendationResult;
    assert.deepEqual(body.data, []);
    assert.equal(body.meta.limit, 10);
    assert.equal(body.meta.criteria.rating.neutralWhenNoReviews, 0.5);
  });

  it('answers a blank q with SEARCH_QUERY_REQUIRED before any query', async () => {
    for (const url of [
      '/api/v1/search',
      '/api/v1/search?q=',
      '/api/v1/search?q=%20%20',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 400, url);
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        'SEARCH_QUERY_REQUIRED',
        url,
      );
    }
  });
});
