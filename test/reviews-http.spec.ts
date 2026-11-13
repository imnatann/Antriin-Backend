import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import {
  PublicReviewsController,
  ReviewsController,
} from '../src/modules/reviews/reviews.controller';
import { ReviewsService } from '../src/modules/reviews/reviews.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CAMPUS_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const REVIEW_ID = '55555555-5555-4555-8555-555555555555';
const TS = '2026-11-13T10:00:00.000000Z';

const view = {
  id: REVIEW_ID,
  campusId: CAMPUS_ID,
  tenantId: TENANT_ID,
  orderId: ORDER_ID,
  buyerId: ACTOR_ID,
  rating: 4,
  body: 'Enak',
  status: 'visible' as const,
  createdAt: TS,
  updatedAt: TS,
  reply: null,
  openReportCount: 0,
};

class StubReviewsService {
  calls: string[] = [];
  failure?: unknown;

  private check() {
    if (this.failure) throw this.failure;
  }

  async createReview(_userId: string, _orderId: string, input: unknown) {
    this.calls.push('create');
    this.check();
    return { ...view, ...(input as Record<string, unknown>) };
  }
  async listBuyerReviews(_userId: string, options: unknown) {
    this.calls.push('listMine');
    this.check();
    return { items: [view], nextCursor: null, options };
  }
  async updateReview() {
    this.calls.push('update');
    this.check();
    return view;
  }
  async deleteReview() {
    this.calls.push('delete');
    this.check();
    return view;
  }
  async reportReview() {
    this.calls.push('report');
    this.check();
    return { ...view, status: 'reported' as const, openReportCount: 1 };
  }
  async listTenantReviews() {
    this.calls.push('listTenant');
    this.check();
    return { items: [view], nextCursor: null };
  }
  async replyToReview() {
    this.calls.push('reply');
    this.check();
    return view;
  }
  async listModerationQueue() {
    this.calls.push('queue');
    this.check();
    return { items: [view], nextCursor: null };
  }
  async decideModeration() {
    this.calls.push('decide');
    this.check();
    return { ...view, status: 'hidden' as const };
  }
  async listPublicReviews() {
    this.calls.push('listPublic');
    this.check();
    return { items: [view], nextCursor: null };
  }
}

describe('Reviews HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubReviewsService;

  const auth = { authorization: 'Bearer test-token' };
  const protectedRoutes = [
    { method: 'POST' as const, url: `/api/v1/orders/${ORDER_ID}/reviews` },
    { method: 'GET' as const, url: '/api/v1/me/reviews' },
    { method: 'PATCH' as const, url: `/api/v1/reviews/${REVIEW_ID}` },
    { method: 'DELETE' as const, url: `/api/v1/reviews/${REVIEW_ID}` },
    { method: 'POST' as const, url: `/api/v1/reviews/${REVIEW_ID}/reports` },
    {
      method: 'GET' as const,
      url: `/api/v1/tenants/${TENANT_ID}/reviews/manage`,
    },
    {
      method: 'POST' as const,
      url: `/api/v1/tenants/${TENANT_ID}/reviews/${REVIEW_ID}/replies`,
    },
    {
      method: 'GET' as const,
      url: `/api/v1/campuses/${CAMPUS_ID}/moderation/reviews`,
    },
    {
      method: 'POST' as const,
      url: `/api/v1/campuses/${CAMPUS_ID}/moderation/reviews/${REVIEW_ID}/decision`,
    },
  ];

  beforeEach(async () => {
    stub = new StubReviewsService();
    const guard = {
      canActivate: (context: ExecutionContext) => {
        const request = context.switchToHttp().getRequest<{
          headers: { authorization?: string };
          user?: { userId: string; sessionId: string };
        }>();
        if (request.headers.authorization !== 'Bearer test-token') {
          throw new UnauthorizedException({
            code: 'unauthorized',
            message: 'A valid bearer token is required',
          });
        }
        request.user = { userId: ACTOR_ID, sessionId: 'session-1' };
        return true;
      },
    };
    const module = await Test.createTestingModule({
      controllers: [ReviewsController, PublicReviewsController],
      providers: [{ provide: ReviewsService, useValue: stub }],
    })
      .overrideGuard(AuthGuard)
      .useValue(guard)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires a bearer token on every authenticated review route', async () => {
    for (const route of protectedRoutes) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
      });
      assert.equal(response.statusCode, 401, route.url);
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        'unauthorized',
      );
    }
    assert.deepEqual(stub.calls, []);
  });

  it('serves the public tenant review list without a token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${TENANT_ID}/reviews`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: { id: string; rating: number }[];
      meta: { next_cursor: string | null };
    };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].rating, 4);
    assert.equal(body.meta.next_cursor, null);
    assert.deepEqual(stub.calls, ['listPublic']);
  });

  it('validates the review body before the service runs', async () => {
    for (const body of [
      { rating: 0, body: 'x' },
      { rating: 6, body: 'x' },
      { rating: 4.5, body: 'x' },
      { rating: 4, body: '' },
      { rating: 4 },
      { rating: 4, body: 'x', extra: 'nope' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/orders/${ORDER_ID}/reviews`,
        headers: auth,
        payload: body,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(body));
    }
    assert.deepEqual(stub.calls, []);
  });

  it('creates a review and echoes the stored view', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${ORDER_ID}/reviews`,
      headers: auth,
      payload: { rating: 5, body: 'Enak' },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as { data: { rating: number; body: string } };
    assert.equal(body.data.rating, 5);
    assert.equal(body.data.body, 'Enak');
  });

  it('returns 200 for the buyer soft delete', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/reviews/${REVIEW_ID}`,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(stub.calls, ['delete']);
  });

  it('validates the moderation decision body', async () => {
    for (const body of [
      { action: 'delete', reason: 'x' },
      { action: 'hide' },
      { action: 'hide', reason: '' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/campuses/${CAMPUS_ID}/moderation/reviews/${REVIEW_ID}/decision`,
        headers: auth,
        payload: body,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(body));
    }
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/campuses/${CAMPUS_ID}/moderation/reviews/${REVIEW_ID}/decision`,
      headers: auth,
      payload: { action: 'hide', reason: 'Memuat data pribadi' },
    });
    assert.equal(ok.statusCode, 201);
    assert.equal(
      (ok.json() as { data: { status: string } }).data.status,
      'hidden',
    );
  });

  it('maps service denials to 403 and conflicts to 409', async () => {
    stub.failure = new ForbiddenException({
      code: 'tenant_permission_required',
      message: 'Tenant permission is required',
    });
    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${TENANT_ID}/reviews/manage`,
      headers: auth,
    });
    assert.equal(forbidden.statusCode, 403);

    stub.failure = new ConflictException({
      code: 'REVIEW_ALREADY_EXISTS',
      message: 'This order already has a review',
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${ORDER_ID}/reviews`,
      headers: auth,
      payload: { rating: 5, body: 'Enak' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(
      (conflict.json() as { error: { code: string } }).error.code,
      'REVIEW_ALREADY_EXISTS',
    );
  });

  it('rejects a malformed path id and cursor before the service runs', async () => {
    const badId = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/not-a-uuid/reviews',
    });
    assert.equal(badId.statusCode, 400);
    const badCursor = await app.inject({
      method: 'GET',
      url: '/api/v1/me/reviews?cursor=not%20a%20cursor',
      headers: auth,
    });
    assert.equal(badCursor.statusCode, 400);
    const badLimit = await app.inject({
      method: 'GET',
      url: '/api/v1/me/reviews?limit=101',
      headers: auth,
    });
    assert.equal(badLimit.statusCode, 400);
    assert.deepEqual(stub.calls, []);
  });
});
