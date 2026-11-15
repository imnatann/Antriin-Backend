import 'reflect-metadata';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionContext, HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { RateLimitGuard } from '../src/common/rate-limit.guard';
import type {
  RateLimitStore,
  RateLimitStoreResult,
} from '../src/common/rate-limit.store';
import { RATE_LIMIT_KEY_PREFIX } from '../src/common/rate-limit.policy';

const TEST_SECRET = 'a'.repeat(48);
const CLIENT_IP = '203.0.113.10';
const USER_ID = '7c9f5d1e-3b2a-4c8d-9e0f-1a2b3c4d5e6f';
const OTHER_USER_ID = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

/**
 * Stub counter store: it keeps the same contract as RedisRateLimitStore
 * (count including the current request + remaining window seconds) so the
 * guard's allow/deny arithmetic and key shapes are exercised without Redis.
 */
class StubStore implements RateLimitStore {
  readonly hits: { key: string; windowSeconds: number }[] = [];
  retryAfterSeconds = 42;
  /** Number of upcoming calls that must fail, simulating a Redis outage. */
  failures = 0;
  /** When set, every hit reports this count (to test the deny path). */
  forcedCount: number | null = null;
  private readonly counts = new Map<string, number>();

  async hit(key: string, windowSeconds: number): Promise<RateLimitStoreResult> {
    this.hits.push({ key, windowSeconds });
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('redis unavailable');
    }
    const count = this.forcedCount ?? (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { count, retryAfterSeconds: this.retryAfterSeconds };
  }
}

interface FakeReply {
  header(name: string, value: string): FakeReply;
}

interface RequestOptions {
  ip?: string;
  method?: string;
  url?: string;
  /** null means "no route matched", undefined means the URL doubles as template. */
  routeTemplate?: string | null;
  userId?: string;
  authorization?: string;
}

function contextFor(options: RequestOptions = {}): {
  context: ExecutionContext;
  headers: Record<string, string>;
} {
  const ip = options.ip ?? CLIENT_IP;
  const url = options.url ?? '/api/v1/search';
  const headers: Record<string, string> = {};
  const reply: FakeReply = {
    header(name, value) {
      headers[name.toLowerCase()] = String(value);
      return reply;
    },
  };
  const request = {
    ip,
    socket: { remoteAddress: ip },
    method: options.method ?? 'GET',
    url,
    headers: options.authorization
      ? { authorization: options.authorization }
      : {},
    routeOptions:
      options.routeTemplate === null
        ? undefined
        : { url: options.routeTemplate ?? url.split('?')[0] },
    user: options.userId ? { userId: options.userId } : undefined,
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

function build(): { store: StubStore; guard: RateLimitGuard } {
  const store = new StubStore();
  const config = {
    get: (key: string) => (key === 'AUTH_SECRET' ? TEST_SECRET : undefined),
  } as unknown as ConfigService;
  return { store, guard: new RateLimitGuard(store, config) };
}

function reasonOf(error: unknown): {
  code?: unknown;
  retryAfterSeconds?: unknown;
} {
  assert.ok(error instanceof HttpException, 'expected an HttpException');
  const body = error.getResponse();
  return typeof body === 'object' && body !== null
    ? (body as { code?: unknown; retryAfterSeconds?: unknown })
    : {};
}

describe('RateLimitGuard policies and headers', () => {
  it('allows an anonymous read under the 120/min budget and reports the window', async () => {
    const { store, guard } = build();
    const { context, headers } = contextFor({ url: '/api/v1/search' });

    assert.equal(await guard.canActivate(context), true);

    assert.equal(store.hits.length, 1);
    assert.equal(store.hits[0].windowSeconds, 60);
    assert.match(
      store.hits[0].key,
      new RegExp(
        '^' + RATE_LIMIT_KEY_PREFIX + ':public-read:search:ip:[0-9a-f]{64}$',
      ),
    );
    assert.equal(headers['ratelimit-limit'], '120');
    assert.equal(headers['ratelimit-remaining'], '119');
    assert.equal(headers['ratelimit-reset'], '42');
    assert.equal(headers['retry-after'], undefined);
  });

  it('answers 429 RATE_LIMITED with retryAfterSeconds once the budget is spent', async () => {
    const { store, guard } = build();
    const { context, headers } = contextFor({ url: '/api/v1/search' });
    store.forcedCount = 121;

    await assert.rejects(
      () => guard.canActivate(context),
      (error: unknown) => {
        const body = reasonOf(error);
        assert.equal((error as HttpException).getStatus(), 429);
        assert.equal(body.code, 'RATE_LIMITED');
        assert.equal(body.retryAfterSeconds, 42);
        return true;
      },
    );
    assert.equal(headers['retry-after'], '42');
    assert.equal(headers['ratelimit-remaining'], '0');
    assert.equal(headers['ratelimit-limit'], '120');
  });

  it('gives an authenticated read 300/min keyed by user id, never by client IP', async () => {
    const { store, guard } = build();
    const fromOffice = contextFor({ userId: USER_ID, ip: CLIENT_IP });
    const fromHome = contextFor({ userId: USER_ID, ip: '198.51.100.4' });

    assert.equal(await guard.canActivate(fromOffice.context), true);
    assert.equal(await guard.canActivate(fromHome.context), true);

    const [office, home] = store.hits.map((hit) => hit.key);
    assert.equal(
      office,
      RATE_LIMIT_KEY_PREFIX + ':authenticated-read:search:user:' + USER_ID,
    );
    assert.equal(home, office, 'the same user shares one bucket across IPs');
    assert.ok(!office.includes(CLIENT_IP));
    assert.ok(!office.includes('198.51.100.4'));
    assert.equal(fromOffice.headers['ratelimit-limit'], '300');

    // A different user from the same IP must not share the bucket either.
    const otherUser = contextFor({ userId: OTHER_USER_ID, ip: CLIENT_IP });
    await guard.canActivate(otherUser.context);
    assert.notEqual(store.hits[2].key, office);
    assert.ok(store.hits[2].key.endsWith(':user:' + OTHER_USER_ID));
  });

  it('separates the write budget (60/min) from the read budget', async () => {
    const { store, guard } = build();
    const read = contextFor({ userId: USER_ID, method: 'GET' });
    const write = contextFor({
      userId: USER_ID,
      method: 'POST',
      url: '/api/v1/search',
    });

    await guard.canActivate(read.context);
    await guard.canActivate(write.context);

    assert.equal(write.headers['ratelimit-limit'], '60');
    assert.equal(
      store.hits[1].key,
      RATE_LIMIT_KEY_PREFIX + ':authenticated-write:search:user:' + USER_ID,
    );
    assert.notEqual(store.hits[0].key, store.hits[1].key);
  });

  it('uses the 60/min write budget per IP for an unauthenticated mutation', async () => {
    const { store, guard } = build();
    const { context, headers } = contextFor({
      method: 'POST',
      url: '/api/v1/orders',
    });

    assert.equal(await guard.canActivate(context), true);
    assert.equal(headers['ratelimit-limit'], '60');
    assert.match(store.hits[0].key, /:anonymous-write:orders:ip:[0-9a-f]{64}$/);
  });

  it('falls back to an HMAC of the session token when no principal is attached', async () => {
    const { store, guard } = build();
    const token = 'sess-' + 'q'.repeat(40);
    const { context, headers } = contextFor({
      authorization: 'Bearer ' + token,
    });

    assert.equal(await guard.canActivate(context), true);
    assert.equal(headers['ratelimit-limit'], '300');
    assert.match(
      store.hits[0].key,
      new RegExp(':authenticated-read:search:session:[0-9a-f]{64}$'),
    );
    assert.ok(
      !store.hits[0].key.includes(token),
      'the raw session token must never reach Redis',
    );
    assert.ok(!store.hits[0].key.includes(CLIENT_IP));
  });

  it('ignores a non-bearer Authorization header and keeps the IP bucket', async () => {
    const { store, guard } = build();
    const { context } = contextFor({ authorization: 'Basic dXNlcjpwYXNz' });

    assert.equal(await guard.canActivate(context), true);
    assert.match(store.hits[0].key, /:public-read:search:ip:[0-9a-f]{64}$/);
  });

  it('buckets per resource family so one noisy endpoint cannot starve another', async () => {
    const { store, guard } = build();
    const collection = contextFor({
      ip: CLIENT_IP,
      url: '/api/v1/tenants/8b4f',
      routeTemplate: '/api/v1/tenants/:id',
    });
    const nested = contextFor({
      ip: CLIENT_IP,
      url: '/api/v1/tenants/8b4f/orders',
      routeTemplate: '/api/v1/tenants/:id/orders',
    });
    const other = contextFor({
      ip: CLIENT_IP,
      url: '/api/v1/recommendations',
    });

    await guard.canActivate(collection.context);
    await guard.canActivate(nested.context);
    await guard.canActivate(other.context);

    const [tenantsKey, nestedKey, otherKey] = store.hits.map((hit) => hit.key);
    assert.equal(nestedKey, tenantsKey, 'same resource family shares a bucket');
    assert.notEqual(otherKey, tenantsKey);
    assert.match(tenantsKey, /:public-read:tenants:ip:/);
    assert.match(otherKey, /:public-read:recommendations:ip:/);
  });

  it('keeps one key for a route whatever the query string is', async () => {
    const { store, guard } = build();
    const first = contextFor({
      ip: CLIENT_IP,
      url: '/api/v1/search?q=kopi',
      routeTemplate: null,
    });
    const second = contextFor({
      ip: CLIENT_IP,
      url: '/api/v1/search?q=teh&limit=2',
      routeTemplate: null,
    });

    await guard.canActivate(first.context);
    await guard.canActivate(second.context);
    assert.equal(store.hits[0].key, store.hits[1].key);
    assert.ok(!store.hits[0].key.includes('kopi'));
  });

  it('exempts health, metrics and webhook paths without touching the store', async () => {
    const { store, guard } = build();
    const paths = [
      '/api/v1/health',
      '/api/v1/health/live',
      '/api/v1/health/ready',
      '/api/v1/metrics',
      '/api/v1/webhooks/payments',
      '/api/v1/webhooks/payments/callback',
    ];
    for (const path of paths) {
      const { context } = contextFor({ url: path });
      assert.equal(await guard.canActivate(context), true, path);
    }
    assert.equal(store.hits.length, 0);
  });
});

describe('RateLimitGuard availability behaviour', () => {
  afterEach(() => mock.restoreAll());

  it('fails open and logs one warning per outage instead of per request', async () => {
    const warn = mock.method(Logger.prototype, 'warn', () => undefined);
    const { store, guard } = build();
    const { context } = contextFor();

    store.failures = 2;
    assert.equal(await guard.canActivate(context), true);
    assert.equal(await guard.canActivate(context), true);
    assert.equal(
      warn.mock.callCount(),
      1,
      'an outage must not log on every request',
    );

    // A successful hit ends the outage, so a later outage warns again.
    assert.equal(await guard.canActivate(context), true);
    store.failures = 1;
    assert.equal(await guard.canActivate(context), true);
    assert.equal(warn.mock.callCount(), 2);
  });

  it('bounds Retry-After inside the policy window', async () => {
    const { store, guard } = build();
    const { context } = contextFor();
    store.forcedCount = 500;

    store.retryAfterSeconds = 900;
    await assert.rejects(
      () => guard.canActivate(context),
      (error: unknown) => {
        assert.equal(reasonOf(error).retryAfterSeconds, 60);
        return true;
      },
      'a TTL longer than the window must not ask the client to wait longer',
    );

    store.retryAfterSeconds = 0;
    await assert.rejects(
      () => guard.canActivate(context),
      (error: unknown) => {
        assert.equal(reasonOf(error).retryAfterSeconds, 1);
        return true;
      },
      'an expired TTL still asks for one second, never zero',
    );
  });

  it('does not exempt a path that merely starts with an exempt word', async () => {
    const { store, guard } = build();
    const { context } = contextFor({ url: '/api/v1/metrics-export' });

    assert.equal(await guard.canActivate(context), true);
    assert.equal(store.hits.length, 1);
    assert.match(store.hits[0].key, /:public-read:metrics-export:ip:/);
  });
});
