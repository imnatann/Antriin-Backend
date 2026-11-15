import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { CoreModule } from '../src/config/core.module';
import { DatabaseService } from '../src/database/database.service';
import { EventsModule } from '../src/modules/events/events.module';
import { AuthService } from '../src/modules/auth/auth.service';
import {
  EVENTS_STREAM_OPTIONS,
  type EventsStreamOptions,
} from '../src/modules/events/events.constants';
import { EventsAuthGuard } from '../src/modules/events/events-auth.guard';
import { EventsController } from '../src/modules/events/events.controller';
import { EventsService } from '../src/modules/events/events.service';

const TOKEN_A = 'a'.repeat(40);
const TOKEN_B = 'b'.repeat(40);

const OPTIONS: EventsStreamOptions = {
  // Millisecond timings: the defaults are asserted separately, and this suite
  // must not spend 15 minutes proving the lifetime cap works.
  pollIntervalMs: 25,
  heartbeatIntervalMs: 100,
  connectionLifetimeMs: 5_000,
  batchSize: 50,
  drainTimeoutMs: 1_000,
  retryHintMs: 3_000,
};

interface Principal {
  userId: string;
  sessionId: string;
}

/** The AuthService surface the guard uses; the real session lookup is not stubbed. */
class StubAuthService {
  readonly calls: string[] = [];
  readonly tokens = new Map<string, Principal>();

  async authenticate(token: string): Promise<Principal> {
    this.calls.push(token);
    const principal = this.tokens.get(token);
    if (!principal)
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'A valid bearer token is required',
      });
    return principal;
  }
}

interface ParsedFrame {
  raw: string;
  comment?: string;
  event?: string;
  id?: string;
  retry?: number;
  data?: unknown;
}

function parseFrame(raw: string): ParsedFrame {
  const frame: ParsedFrame = { raw };
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) frame.comment = line.slice(1).trim();
    else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
    else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    else if (line.startsWith('retry:'))
      frame.retry = Number(line.slice(6).trim());
  }
  if (dataLines.length > 0) frame.data = JSON.parse(dataLines.join('\n'));
  return frame;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads an event stream incrementally. app.inject() cannot be used here: it
 * resolves only once the response ends, and this response is meant to stay open.
 */
class SseClient {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly abort: AbortController;
  private buffer = '';
  readonly frames: ParsedFrame[] = [];
  ended = false;

  constructor(response: Response, abort: AbortController) {
    assert.ok(response.body, 'stream has no body');
    this.reader = response.body.getReader();
    this.abort = abort;
  }

  close(): void {
    this.abort.abort();
  }

  notificationFrames(): ParsedFrame[] {
    return this.frames.filter((frame) => frame.event === 'notification');
  }

  async waitFor(
    predicate: (frame: ParsedFrame) => boolean,
    timeoutMs = 5_000,
  ): Promise<ParsedFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(this.describe('timed out waiting'));
      await this.readChunk(remaining);
      if (this.ended) {
        const last = this.frames.find(predicate);
        if (last) return last;
        throw new Error(this.describe('stream ended early'));
      }
    }
  }

  async waitForEnd(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(this.describe('stream did not end'));
      await this.readChunk(remaining);
    }
  }

  private describe(reason: string): string {
    return (
      reason +
      '; received ' +
      JSON.stringify(this.frames.map((frame) => frame.raw))
    );
  }

  private async readChunk(timeoutMs: number): Promise<void> {
    const pending = this.reader.read();
    // Attached so an abort during a timed-out read is never an unhandled rejection.
    pending.catch(() => undefined);
    // Cleared below: a leftover multi-second timer would keep the test process
    // alive long after the suite finished.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const result = await Promise.race([pending, expired]);
      if (result === 'timeout') return;
      if (result.done) {
        this.ended = true;
        this.flush();
        return;
      }
      this.buffer += this.decoder.decode(result.value, { stream: true });
      this.flush();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private flush(): void {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end === -1) return;
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      if (raw.length > 0) this.frames.push(parseFrame(raw));
    }
  }
}

async function buildApp(input: {
  pool: unknown;
  auth: StubAuthService;
  options: EventsStreamOptions;
}): Promise<{ app: NestFastifyApplication; url: string }> {
  const moduleRef = await Test.createTestingModule({
    controllers: [EventsController],
    providers: [
      EventsService,
      EventsAuthGuard,
      { provide: AuthService, useValue: input.auth },
      { provide: DatabaseService, useValue: { pool: input.pool } },
      { provide: EVENTS_STREAM_OPTIONS, useValue: input.options },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
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
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { app, url: `http://127.0.0.1:${port}/api/v1/events/stream` };
}

describe('Events stream authentication', () => {
  const auth = new StubAuthService();
  let app: NestFastifyApplication;
  let baseUrl: string;

  before(async () => {
    const built = await buildApp({
      // No request that fails authentication may reach the database.
      pool: {
        query: () => {
          throw new Error('database reached for a request that was rejected');
        },
      },
      auth,
      options: OPTIONS,
    });
    app = built.app;
    baseUrl = built.url;
  });

  after(async () => {
    await app.close();
  });

  it('rejects a request that carries no token at all', async () => {
    const before = auth.calls.length;
    const response = await fetch(baseUrl);
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'unauthorized');
    assert.equal(auth.calls.length, before);
  });

  it('rejects a malformed Authorization header without asking the session store', async () => {
    const before = auth.calls.length;
    for (const authorization of [
      'Bearer short',
      'Bearer ' + 'a'.repeat(129),
      TOKEN_A,
      'Basic ' + TOKEN_A,
    ]) {
      const response = await fetch(baseUrl, { headers: { authorization } });
      assert.equal(response.status, 401, authorization);
    }
    assert.equal(auth.calls.length, before);
  });

  it('rejects an unknown token from the header and from access_token', async () => {
    const before = auth.calls.length;
    const header = await fetch(baseUrl, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    assert.equal(header.status, 401);
    const query = await fetch(
      `${baseUrl}?access_token=${encodeURIComponent(TOKEN_B)}`,
    );
    assert.equal(query.status, 401);
    const body = (await query.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'unauthorized');
    // Both reached AuthService; neither was accepted on shape alone.
    assert.deepEqual(auth.calls.slice(before), [TOKEN_A, TOKEN_B]);
  });

  it('does not fall back to the query token when the header is malformed', async () => {
    const before = auth.calls.length;
    for (const authorization of ['Bearer nope', 'token']) {
      const response = await fetch(
        `${baseUrl}?access_token=${encodeURIComponent(TOKEN_A)}`,
        { headers: { authorization } },
      );
      assert.equal(response.status, 401, authorization);
    }
    assert.equal(auth.calls.length, before);
  });

  it('rejects an unknown query parameter instead of ignoring it', async () => {
    const principal = { userId: randomUUID(), sessionId: randomUUID() };
    auth.tokens.set(TOKEN_A, principal);
    try {
      const response = await fetch(
        `${baseUrl}?access_token=${encodeURIComponent(TOKEN_A)}&recipient_user_id=${randomUUID()}`,
      );
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    } finally {
      auth.tokens.delete(TOKEN_A);
    }
  });
});

describe(
  'Events stream over PostgreSQL',
  { skip: !process.env.TEST_DATABASE_URL },
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const auth = new StubAuthService();
    const createdUsers: string[] = [];
    const apps: NestFastifyApplication[] = [];
    let baseUrl: string;
    let shortLifetimeUrl: string;

    async function createUser(displayName: string): Promise<string> {
      const id = randomUUID();
      await pool.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [
        id,
        displayName,
      ]);
      createdUsers.push(id);
      return id;
    }

    async function insertNotification(
      recipient: string,
      template = 'order.status_changed',
    ): Promise<{ id: string; aggregateId: string }> {
      const eventId = randomUUID();
      const aggregateId = randomUUID();
      await pool.query(
        `INSERT INTO outbox_events
           (id, event_key, request_hash, event_type, aggregate_type, aggregate_id, recipient_ids)
         VALUES ($1, $2, repeat('e', 64), $3, 'order', $4, $5)`,
        [eventId, `test:${eventId}`, template, aggregateId, [recipient]],
      );
      const id = randomUUID();
      await pool.query(
        `INSERT INTO notifications (id, event_id, recipient_user_id, template, data)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          id,
          eventId,
          recipient,
          template,
          JSON.stringify({ aggregateType: 'order', aggregateId }),
        ],
      );
      return { id, aggregateId };
    }

    async function openStream(url: string): Promise<{
      client: SseClient;
      response: Response;
    }> {
      const abort = new AbortController();
      const response = await fetch(url, { signal: abort.signal });
      return { client: new SseClient(response, abort), response };
    }

    before(async () => {
      const main = await buildApp({ pool, auth, options: OPTIONS });
      apps.push(main.app);
      baseUrl = main.url;
      const capped = await buildApp({
        pool,
        auth,
        options: { ...OPTIONS, connectionLifetimeMs: 250 },
      });
      apps.push(capped.app);
      shortLifetimeUrl = capped.url;
    });

    after(async () => {
      for (const app of apps) await app.close();
      // Notifications this suite created are removable; the outbox rows are
      // immutable by trigger (outbox.spec.ts leaves the same rows behind).
      if (createdUsers.length > 0) {
        await pool
          .query(
            'DELETE FROM notifications WHERE recipient_user_id = ANY($1::uuid[])',
            [createdUsers],
          )
          .catch(() => undefined);
      }
      await pool.end();
    });

    it('opens with a ready event and accepts the token from the header', async () => {
      const buyer = await createUser('Events header buyer');
      auth.tokens.set(TOKEN_A, { userId: buyer, sessionId: randomUUID() });
      const abort = new AbortController();
      const response = await fetch(baseUrl, {
        signal: abort.signal,
        headers: { authorization: `Bearer ${TOKEN_A}` },
      });
      const client = new SseClient(response, abort);
      try {
        assert.equal(response.status, 200);
        assert.equal(
          response.headers.get('content-type'),
          'text/event-stream; charset=utf-8',
        );
        assert.equal(
          response.headers.get('cache-control'),
          'no-cache, no-transform',
        );
        assert.equal(response.headers.get('x-accel-buffering'), 'no');
        const ready = await client.waitFor((frame) => frame.event === 'ready');
        const data = ready.data as { stream: string; userId: string };
        assert.equal(data.stream, 'notifications');
        assert.equal(data.userId, buyer);
        // An EventSource reconnect hint is sent once, before any event.
        assert.equal(client.frames[0].retry, 3_000);
      } finally {
        client.close();
        auth.tokens.delete(TOKEN_A);
      }
    });

    it("emits the caller's notifications and never another user's row", async () => {
      const buyer = await createUser('Events buyer');
      const other = await createUser('Events other buyer');
      auth.tokens.set(TOKEN_A, { userId: buyer, sessionId: randomUUID() });
      // The query parameter is the EventSource path: it cannot set headers.
      const { client, response } = await openStream(
        `${baseUrl}?access_token=${TOKEN_A}`,
      );
      try {
        assert.equal(response.status, 200);
        await client.waitFor((frame) => frame.event === 'ready');

        const mine = await insertNotification(buyer);
        const delivered = await client.waitFor(
          (frame) => frame.event === 'notification' && frame.id === mine.id,
        );
        const payload = delivered.data as {
          id: string;
          template: string;
          data: { aggregateType: string; aggregateId: string };
          createdAt: string;
          readAt: string | null;
        };
        assert.equal(payload.id, mine.id);
        assert.equal(payload.template, 'order.status_changed');
        assert.deepEqual(payload.data, {
          aggregateType: 'order',
          aggregateId: mine.aggregateId,
        });
        // Microseconds straight from PostgreSQL, never rounded through a Date.
        assert.match(
          payload.createdAt,
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
        );
        assert.equal(payload.readAt, null);

        // A row for someone else must never appear. Arriving before the next
        // notification for this caller proves a poll ran while it existed.
        const foreign = await insertNotification(other);
        const second = await insertNotification(buyer);
        await client.waitFor(
          (frame) => frame.event === 'notification' && frame.id === second.id,
        );
        const ids = client.notificationFrames().map((frame) => frame.id);
        assert.ok(ids.includes(mine.id));
        assert.ok(ids.includes(second.id));
        assert.ok(!ids.includes(foreign.id));
      } finally {
        client.close();
        auth.tokens.delete(TOKEN_A);
      }
    });

    it('does not replay the backlog for a fresh connection', async () => {
      const buyer = await createUser('Events backlog buyer');
      auth.tokens.set(TOKEN_A, { userId: buyer, sessionId: randomUUID() });
      const backlog = await insertNotification(buyer);
      const { client } = await openStream(`${baseUrl}?access_token=${TOKEN_A}`);
      try {
        await client.waitFor((frame) => frame.event === 'ready');
        // Several poll intervals pass with nothing to send: history stays on
        // GET /me/notifications instead of flooding a new connection.
        await sleep(OPTIONS.pollIntervalMs * 4);
        assert.equal(client.notificationFrames().length, 0);
        const next = await insertNotification(buyer);
        await client.waitFor(
          (frame) => frame.event === 'notification' && frame.id === next.id,
        );
        assert.equal(client.notificationFrames().length, 1);
        assert.ok(
          !client.notificationFrames().some((frame) => frame.id === backlog.id),
        );
      } finally {
        client.close();
        auth.tokens.delete(TOKEN_A);
      }
    });

    it('resumes after last_event_id instead of replaying everything', async () => {
      const buyer = await createUser('Events resume buyer');
      auth.tokens.set(TOKEN_A, { userId: buyer, sessionId: randomUUID() });
      const first = await insertNotification(buyer);
      const second = await insertNotification(buyer);
      const { client } = await openStream(
        `${baseUrl}?access_token=${TOKEN_A}&last_event_id=${first.id}`,
      );
      try {
        await client.waitFor((frame) => frame.event === 'ready');
        const delivered = await client.waitFor(
          (frame) => frame.event === 'notification' && frame.id === second.id,
        );
        assert.equal((delivered.data as { id: string }).id, second.id);
        await sleep(OPTIONS.pollIntervalMs * 4);
        assert.ok(
          !client.notificationFrames().some((frame) => frame.id === first.id),
        );
      } finally {
        client.close();
        auth.tokens.delete(TOKEN_A);
      }
    });

    it('accepts the same resume point from the Last-Event-ID header', async () => {
      const buyer = await createUser('Events header resume buyer');
      auth.tokens.set(TOKEN_A, { userId: buyer, sessionId: randomUUID() });
      const first = await insertNotification(buyer);
      const second = await insertNotification(buyer);
      const abort = new AbortController();
      const response = await fetch(baseUrl, {
        signal: abort.signal,
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'last-event-id': first.id,
        },
      });
      const client = new SseClient(response, abort);
      try {
        await client.waitFor((frame) => frame.event === 'notification');
        await sleep(OPTIONS.pollIntervalMs * 4);
        assert.deepEqual(
          client.notificationFrames().map((frame) => frame.id),
          [second.id],
        );
      } finally {
        client.close();
        auth.tokens.delete(TOKEN_A);
      }
    });

    it('rejects an unusable resume point before streaming anything', async () => {
      const buyer = await createUser('Events bad cursor buyer');
      const other = await createUser('Events bad cursor other');
      auth.tokens.set(TOKEN_A, { userId: buyer, sessionId: randomUUID() });
      const foreign = await insertNotification(other);

      for (const url of [
        `${baseUrl}?access_token=${TOKEN_A}&last_event_id=${randomUUID()}`,
        `${baseUrl}?access_token=${TOKEN_A}&last_event_id=${foreign.id}`,
        `${baseUrl}?access_token=${TOKEN_A}&last_event_id=not-a-uuid`,
      ]) {
        const response = await fetch(url);
        assert.equal(response.status, 400, url);
        const body = (await response.json()) as { error: { code: string } };
        // Shape is rejected by the DTO, ownership by the service; both are 400.
        assert.ok(
          body.error.code === 'EVENTS_INVALID_LAST_EVENT_ID' ||
            body.error.code === 'VALIDATION_ERROR',
          url,
        );
      }

      const badHeader = await fetch(baseUrl, {
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'last-event-id': 'not-a-uuid',
        },
      });
      assert.equal(badHeader.status, 400);
      const headerBody = (await badHeader.json()) as {
        error: { code: string };
      };
      assert.equal(headerBody.error.code, 'EVENTS_INVALID_LAST_EVENT_ID');
      auth.tokens.delete(TOKEN_A);
    });

    it('keeps an idle connection alive with heartbeat comments', async () => {
      const buyer = await createUser('Events heartbeat buyer');
      auth.tokens.set(TOKEN_A, { userId: buyer, sessionId: randomUUID() });
      const { client } = await openStream(`${baseUrl}?access_token=${TOKEN_A}`);
      try {
        await client.waitFor((frame) => frame.event === 'ready');
        const beat = await client.waitFor(
          (frame) => frame.comment === 'heartbeat',
        );
        // A comment carries no event name, id or data: nothing for the client
        // to treat as a notification.
        assert.equal(beat.event, undefined);
        assert.equal(beat.id, undefined);
        assert.equal(beat.data, undefined);
      } finally {
        client.close();
        auth.tokens.delete(TOKEN_A);
      }
    });

    it('ends a long-lived connection with a reconnect event', async () => {
      const buyer = await createUser('Events lifetime buyer');
      auth.tokens.set(TOKEN_A, { userId: buyer, sessionId: randomUUID() });
      const { client } = await openStream(
        `${shortLifetimeUrl}?access_token=${TOKEN_A}`,
      );
      try {
        await client.waitFor((frame) => frame.event === 'ready');
        const delivered = await insertNotification(buyer);
        await client.waitFor(
          (frame) =>
            frame.event === 'notification' && frame.id === delivered.id,
        );
        const reconnect = await client.waitFor(
          (frame) => frame.event === 'reconnect',
        );
        const data = reconnect.data as { reason: string; lastEventId: string };
        assert.equal(data.reason, 'connection_lifetime');
        // The cap says where to resume, so the client does not replay.
        assert.equal(data.lastEventId, delivered.id);
        assert.equal(reconnect.id, delivered.id);
        // The server really ends the response instead of leaving it open.
        await client.waitForEnd();
        assert.equal(client.ended, true);
      } finally {
        client.close();
        auth.tokens.delete(TOKEN_A);
      }
    });
  },
);
/** Same minimal environment module-wiring.spec.ts uses; nothing is dialled. */
const WIRING_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '3000',
  CORS_ORIGINS: 'http://localhost:3001',
  SWAGGER_ENABLED: 'false',
  DATABASE_URL: 'postgresql://local:local@127.0.0.1:1/unused',
  DATABASE_POOL_MAX: '1',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6381',
  LOG_LEVEL: 'silent',
  AUTH_SECRET: 'wiring-test-secret-value-0123456789abcdef',
  AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PAYOUTS_PROVIDER_MODE: 'disabled',
  REFUNDS_PROVIDER_MODE: 'disabled',
  PAYMENTS_PROVIDER_MODE: 'disabled',
};

describe('Events module wiring', () => {
  before(() => {
    for (const [key, value] of Object.entries(WIRING_ENV)) {
      process.env[key] = value;
    }
  });

  it('resolves the guard from the module graph instead of a hand-built stub', async () => {
    // The controller works with AuthService injected by AuthModule; a module
    // that forgets that import compiles fine in this file's other suites (they
    // provide AuthService directly) and fails only at boot. This compiles the
    // real EventsModule with CoreModule so the dependency is proven.
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, EventsModule],
    }).compile();
    try {
      assert.ok(moduleRef.get(EventsController));
      assert.ok(moduleRef.get(EventsAuthGuard));
      assert.ok(moduleRef.get(EventsService));
    } finally {
      await moduleRef.close();
    }
  });
});
