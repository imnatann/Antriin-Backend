import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
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
import { CasesController } from '../src/modules/cases/cases.controller';
import { CasesService } from '../src/modules/cases/cases.service';
import type { CaseView } from '../src/modules/cases/cases.service';

const CAMPUS_ID = randomUUID();
const TENANT_ID = randomUUID();
const ORDER_ID = randomUUID();
const CASE_ID = randomUUID();
const ACTOR_ID = randomUUID();
const TS = '2026-11-13T10:00:00.123456Z';

type Call = { method: string; args: unknown[] };

/**
 * Validated DTOs are class instances that keep declared-but-absent keys as
 * undefined; compare only the values that were actually supplied.
 */
function bodyOf(value: unknown): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(source).filter(([, item]) => item !== undefined),
  );
}

function caseView(): CaseView {
  return {
    id: CASE_ID,
    campusId: CAMPUS_ID,
    tenantId: TENANT_ID,
    orderId: ORDER_ID,
    buyerId: randomUUID(),
    openedByUserId: ACTOR_ID,
    category: 'order_issue',
    status: 'reported',
    subject: 'Cold food at pickup',
    details: '',
    decisionReason: null,
    decidedByUserId: null,
    decidedAt: null,
    version: 1,
    createdAt: TS,
    updatedAt: TS,
  };
}

/**
 * Service double: the transport layer (routes, guard, DTO validation, error
 * mapping, envelope, status codes) is what is under test.
 */
class StubCasesService {
  readonly calls: Call[] = [];
  readonly failures: Record<string, unknown> = {};

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.failures[method];
    if (failure) throw failure;
  }

  async openBuyerCase(...args: unknown[]): Promise<CaseView> {
    this.record('openBuyerCase', args);
    return caseView();
  }

  async listBuyerCases(...args: unknown[]) {
    this.record('listBuyerCases', args);
    return { items: [caseView()], nextCursor: null };
  }

  async getBuyerCase(...args: unknown[]): Promise<CaseView> {
    this.record('getBuyerCase', args);
    return caseView();
  }

  async openTenantCase(...args: unknown[]): Promise<CaseView> {
    this.record('openTenantCase', args);
    return caseView();
  }

  async listTenantCases(...args: unknown[]) {
    this.record('listTenantCases', args);
    return { items: [caseView()], nextCursor: 'cursor-2' };
  }

  async getTenantCase(...args: unknown[]): Promise<CaseView> {
    this.record('getTenantCase', args);
    return caseView();
  }

  async openCampusCase(...args: unknown[]): Promise<CaseView> {
    this.record('openCampusCase', args);
    return caseView();
  }

  async listCampusCases(...args: unknown[]) {
    this.record('listCampusCases', args);
    return { items: [caseView()], nextCursor: null };
  }

  async getCampusCase(...args: unknown[]): Promise<CaseView> {
    this.record('getCampusCase', args);
    return caseView();
  }

  async decideCase(...args: unknown[]) {
    this.record('decideCase', args);
    return { case: caseView(), refund: null };
  }
}

describe('Cases HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubCasesService;

  const auth = { authorization: 'Bearer test-token' };
  const buyerOpenUrl = `/v1/orders/${ORDER_ID}/cases`;
  const buyerListUrl = '/v1/me/cases';
  const buyerReadUrl = `/v1/me/cases/${CASE_ID}`;
  const tenantOpenUrl = `/v1/tenants/${TENANT_ID}/cases`;
  const tenantListUrl = tenantOpenUrl;
  const tenantReadUrl = `${tenantOpenUrl}/${CASE_ID}`;
  const campusOpenUrl = `/v1/campuses/${CAMPUS_ID}/cases`;
  const campusReadUrl = `${campusOpenUrl}/${CASE_ID}`;
  const decisionUrl = `${campusReadUrl}/decision`;

  beforeEach(async () => {
    stub = new StubCasesService();
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
      controllers: [CasesController],
      providers: [{ provide: CasesService, useValue: stub }],
    })
      .overrideGuard(AuthGuard)
      .useValue(guard)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('v1');
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

  it('requires a bearer token on every case route', async () => {
    const routes: [string, string, object?][] = [
      ['POST', buyerOpenUrl, { category: 'other', subject: 'x' }],
      ['GET', buyerListUrl],
      ['GET', buyerReadUrl],
      ['POST', tenantOpenUrl, { category: 'other', subject: 'x' }],
      ['GET', tenantListUrl],
      ['GET', tenantReadUrl],
      [
        'POST',
        campusOpenUrl,
        { category: 'other', subject: 'x', tenantId: TENANT_ID },
      ],
      ['GET', campusOpenUrl],
      ['GET', campusReadUrl],
      ['POST', decisionUrl, { status: 'resolved', reason: 'x' }],
    ];
    for (const [method, url, payload] of routes) {
      const response = await app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
      });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        'unauthorized',
      );
    }
    assert.equal(stub.calls.length, 0, 'no handler may run without a session');
  });

  it('forwards the session principal on every route', async () => {
    await app.inject({
      method: 'POST',
      url: buyerOpenUrl,
      headers: auth,
      payload: { category: 'quality', subject: 'Cold soup' },
    });
    const buyerOpen = stub.calls.at(-1);
    assert.equal(buyerOpen?.method, 'openBuyerCase');
    assert.deepEqual(buyerOpen?.args.slice(0, 2), [ACTOR_ID, ORDER_ID]);
    assert.deepEqual(bodyOf(buyerOpen?.args[2]), {
      category: 'quality',
      subject: 'Cold soup',
    });

    await app.inject({ method: 'GET', url: buyerListUrl, headers: auth });
    const buyerList = stub.calls.at(-1);
    assert.equal(buyerList?.method, 'listBuyerCases');
    assert.equal(buyerList?.args[0], ACTOR_ID);
    assert.deepEqual(bodyOf(buyerList?.args[1]), {});

    await app.inject({ method: 'GET', url: buyerReadUrl, headers: auth });
    assert.deepEqual(stub.calls.at(-1), {
      method: 'getBuyerCase',
      args: [ACTOR_ID, CASE_ID],
    });

    await app.inject({
      method: 'POST',
      url: tenantOpenUrl,
      headers: auth,
      payload: {
        category: 'no_show',
        subject: 'Buyer absent',
        orderId: ORDER_ID,
      },
    });
    const tenantOpen = stub.calls.at(-1);
    assert.equal(tenantOpen?.method, 'openTenantCase');
    assert.deepEqual(tenantOpen?.args.slice(0, 2), [ACTOR_ID, TENANT_ID]);
    assert.deepEqual(bodyOf(tenantOpen?.args[2]), {
      category: 'no_show',
      subject: 'Buyer absent',
      orderId: ORDER_ID,
    });

    await app.inject({
      method: 'GET',
      url: `${tenantListUrl}?status=reported`,
      headers: auth,
    });
    const tenantList = stub.calls.at(-1);
    assert.equal(tenantList?.method, 'listTenantCases');
    assert.deepEqual(tenantList?.args.slice(0, 2), [ACTOR_ID, TENANT_ID]);
    assert.deepEqual(bodyOf(tenantList?.args[2]), { status: 'reported' });

    await app.inject({ method: 'GET', url: tenantReadUrl, headers: auth });
    assert.deepEqual(stub.calls.at(-1), {
      method: 'getTenantCase',
      args: [ACTOR_ID, TENANT_ID, CASE_ID],
    });

    await app.inject({
      method: 'POST',
      url: campusOpenUrl,
      headers: auth,
      payload: {
        category: 'other',
        subject: 'Campus note',
        tenantId: TENANT_ID,
      },
    });
    const campusOpen = stub.calls.at(-1);
    assert.equal(campusOpen?.method, 'openCampusCase');
    assert.deepEqual(campusOpen?.args.slice(0, 2), [ACTOR_ID, CAMPUS_ID]);
    assert.deepEqual(bodyOf(campusOpen?.args[2]), {
      category: 'other',
      subject: 'Campus note',
      tenantId: TENANT_ID,
    });

    await app.inject({ method: 'GET', url: campusOpenUrl, headers: auth });
    const campusList = stub.calls.at(-1);
    assert.equal(campusList?.method, 'listCampusCases');
    assert.deepEqual(campusList?.args.slice(0, 2), [ACTOR_ID, CAMPUS_ID]);
    assert.deepEqual(bodyOf(campusList?.args[2]), {});

    await app.inject({ method: 'GET', url: campusReadUrl, headers: auth });
    assert.deepEqual(stub.calls.at(-1), {
      method: 'getCampusCase',
      args: [ACTOR_ID, CAMPUS_ID, CASE_ID],
    });

    await app.inject({
      method: 'POST',
      url: decisionUrl,
      headers: auth,
      payload: { status: 'resolved', reason: 'settled with buyer' },
    });
    const decision = stub.calls.at(-1);
    assert.equal(decision?.method, 'decideCase');
    assert.deepEqual(decision?.args.slice(0, 3), [
      ACTOR_ID,
      CAMPUS_ID,
      CASE_ID,
    ]);
    assert.deepEqual(bodyOf(decision?.args[3]), {
      status: 'resolved',
      reason: 'settled with buyer',
    });
  });

  it('maps domain failures to 403, 404, 409 and 503 with stable codes', async () => {
    stub.failures.listTenantCases = new ForbiddenException(
      'Tenant permission denied',
    );
    const tenantForbidden = await app.inject({
      method: 'GET',
      url: tenantListUrl,
      headers: auth,
    });
    assert.equal(tenantForbidden.statusCode, 403);

    stub.failures.listCampusCases = new ForbiddenException(
      'Campus access denied',
    );
    const campusForbidden = await app.inject({
      method: 'GET',
      url: campusOpenUrl,
      headers: auth,
    });
    assert.equal(campusForbidden.statusCode, 403);

    stub.failures.getCampusCase = new NotFoundException('Case was not found');
    const notFound = await app.inject({
      method: 'GET',
      url: campusReadUrl,
      headers: auth,
    });
    assert.equal(notFound.statusCode, 404);

    stub.failures.getTenantCase = new NotFoundException('Case was not found');
    const crossTenant = await app.inject({
      method: 'GET',
      url: tenantReadUrl,
      headers: auth,
    });
    assert.equal(crossTenant.statusCode, 404);

    stub.failures.decideCase = new ConflictException({
      code: 'CASE_ALREADY_DECIDED',
      message: 'Case is already resolved and cannot be decided again',
    });
    const conflict = await app.inject({
      method: 'POST',
      url: decisionUrl,
      headers: auth,
      payload: { status: 'declined', reason: 'second decision' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(
      (conflict.json() as { error: { code: string } }).error.code,
      'CASE_ALREADY_DECIDED',
    );

    stub.failures.decideCase = new ServiceUnavailableException({
      code: 'REFUNDS_PROVIDER_DISABLED',
      message: 'Refunds are not available while the provider is disabled',
    });
    const disabled = await app.inject({
      method: 'POST',
      url: decisionUrl,
      headers: auth,
      payload: { status: 'approved_cancel', reason: 'cancel and refund' },
    });
    assert.equal(disabled.statusCode, 503);
    assert.equal(
      (disabled.json() as { error: { code: string } }).error.code,
      'REFUNDS_PROVIDER_DISABLED',
    );
  });

  it('rejects unknown fields and malformed input with 400', async () => {
    const rejected: [string, string, object][] = [
      // Status, ids and decisions are server-derived on open.
      [
        'POST',
        buyerOpenUrl,
        { category: 'other', subject: 'x', status: 'resolved' },
      ],
      [
        'POST',
        buyerOpenUrl,
        { category: 'other', subject: 'x', tenantId: TENANT_ID },
      ],
      [
        'POST',
        buyerOpenUrl,
        { category: 'other', subject: 'x', orderId: ORDER_ID },
      ],
      // Category must be a known enum value; subject is required and bounded.
      ['POST', buyerOpenUrl, { category: 'refund', subject: 'x' }],
      ['POST', buyerOpenUrl, { category: 'other', subject: '' }],
      ['POST', buyerOpenUrl, { category: 'other', subject: 'x'.repeat(201) }],
      [
        'POST',
        buyerOpenUrl,
        { category: 'other', subject: 'x', details: 'y'.repeat(4001) },
      ],
      ['POST', buyerOpenUrl, { category: 'other' }],
      // Tenant-scoped open: orderId must be a UUID when present.
      [
        'POST',
        tenantOpenUrl,
        { category: 'other', subject: 'x', orderId: 'nope' },
      ],
      // Campus-scoped open: tenantId is required and must be a UUID.
      ['POST', campusOpenUrl, { category: 'other', subject: 'x' }],
      [
        'POST',
        campusOpenUrl,
        { category: 'other', subject: 'x', tenantId: 'nope' },
      ],
      // Decision: status enum, reason required.
      ['POST', decisionUrl, { status: 'approved', reason: 'x' }],
      ['POST', decisionUrl, { status: 'resolved' }],
      ['POST', decisionUrl, { status: 'resolved', reason: '' }],
      [
        'POST',
        decisionUrl,
        { status: 'resolved', reason: 'x', caseId: CASE_ID },
      ],
    ];
    for (const [method, url, payload] of rejected) {
      const response = await app.inject({
        method,
        url,
        headers: auth,
        payload,
      });
      assert.equal(
        response.statusCode,
        400,
        `${method} ${url} ${JSON.stringify(payload)}`,
      );
    }
    // Non-UUID path parameters never reach the service.
    const malformedPaths: [string, string, object?][] = [
      [
        'POST',
        '/v1/orders/not-a-uuid/cases',
        { category: 'other', subject: 'x' },
      ],
      ['GET', '/v1/tenants/not-a-uuid/cases'],
      ['GET', `/v1/campuses/not-a-uuid/cases/${CASE_ID}`],
      [
        'POST',
        `/v1/campuses/not-a-uuid/cases/${CASE_ID}/decision`,
        {
          status: 'resolved',
          reason: 'x',
        },
      ],
      ['GET', '/v1/me/cases/not-a-uuid'],
    ];
    for (const [method, url, payload] of malformedPaths) {
      const response = await app.inject({
        method,
        url,
        headers: auth,
        ...(payload ? { payload } : {}),
      });
      assert.equal(response.statusCode, 400, `${method} ${url}`);
    }
    assert.equal(
      stub.calls.length,
      0,
      'invalid input must not reach the service',
    );
  });

  it('validates the case list query', async () => {
    for (const query of [
      'status=bogus',
      'cursor=bad%20cursor!',
      'limit=0',
      'limit=101',
      'limit=abc',
      'unknown=1',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `${campusOpenUrl}?${query}`,
        headers: auth,
      });
      assert.equal(response.statusCode, 400, query);
    }
    assert.equal(stub.calls.length, 0);
  });

  it('serves the documented envelope and status codes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: buyerOpenUrl,
      headers: auth,
      payload: { category: 'order_issue', subject: 'Cold food' },
    });
    assert.equal(created.statusCode, 201);
    const createdBody = created.json() as {
      data: { id: string; status: string; createdAt: string };
    };
    assert.equal(createdBody.data.id, CASE_ID);
    assert.equal(createdBody.data.status, 'reported');
    assert.match(createdBody.data.createdAt, /\.\d{6}Z$/);

    const tenantCreated = await app.inject({
      method: 'POST',
      url: tenantOpenUrl,
      headers: auth,
      payload: { category: 'other', subject: 'Tenant note' },
    });
    assert.equal(tenantCreated.statusCode, 201);

    const campusCreated = await app.inject({
      method: 'POST',
      url: campusOpenUrl,
      headers: auth,
      payload: {
        category: 'other',
        subject: 'Campus note',
        tenantId: TENANT_ID,
      },
    });
    assert.equal(campusCreated.statusCode, 201);

    const listed = await app.inject({
      method: 'GET',
      url: tenantListUrl,
      headers: auth,
    });
    assert.equal(listed.statusCode, 200);
    const listedBody = listed.json() as {
      data: { id: string }[];
      meta: { next_cursor: string | null };
    };
    assert.equal(listedBody.data.length, 1);
    assert.equal(listedBody.meta.next_cursor, 'cursor-2');

    const read = await app.inject({
      method: 'GET',
      url: campusReadUrl,
      headers: auth,
    });
    assert.equal(read.statusCode, 200);
    assert.equal((read.json() as { data: { id: string } }).data.id, CASE_ID);

    const decided = await app.inject({
      method: 'POST',
      url: decisionUrl,
      headers: auth,
      payload: { status: 'approved_cancel', reason: 'cancel and refund' },
    });
    assert.equal(decided.statusCode, 200);
    const decidedBody = decided.json() as {
      data: { case: { id: string }; refund: unknown };
    };
    assert.equal(decidedBody.data.case.id, CASE_ID);
    assert.equal(decidedBody.data.refund, null);
  });
});
