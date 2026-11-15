import type { FastifyReply } from 'fastify';
import {
  EVENTS_EVENT_NOTIFICATION,
  EVENTS_EVENT_READY,
  EVENTS_EVENT_RECONNECT,
  type EventsStreamOptions,
} from './events.constants';
import { SseConnection } from './events-sse';
import type {
  EventsCursor,
  EventsService,
  NotificationEvent,
} from './events.service';

/** Late socket errors are already reflected by 'close'; nothing to handle. */
const IGNORED_SOCKET_ERROR = (): void => undefined;

export interface EventsStreamInput {
  userId: string;
  cursor: EventsCursor;
  options: EventsStreamOptions;
  /** Row source; `EventsService.fetchAfter` in production. */
  feed: Pick<EventsService, 'fetchAfter'>;
}

/**
 * One SSE connection tailing a single recipient's notifications.
 *
 * The connection is a supervisor around three timers plus the socket:
 *   - poll: reads notifications created after the cursor (see EventsService)
 *   - heartbeat: a comment frame so proxies do not drop an idle connection
 *   - lifetime: ends the stream after connectionLifetimeMs with a `reconnect`
 *     event, which bounds how long one connection pins a socket and gives the
 *     client a defined point to resume from.
 *
 * Every timer and listener is released on 'close', and close() is idempotent so
 * a client disconnect, a failed write and the lifetime cap all converge on the
 * same teardown.
 */
export class EventsStream {
  private readonly connection: SseConnection;
  private cursor: EventsCursor;
  private lastEventId: string | null;
  private closed = false;
  private polling = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 'close' on the response covers both a client disconnect and our own end(). */
  private readonly onClientGone = () => this.close();

  constructor(
    private readonly reply: FastifyReply,
    private readonly input: EventsStreamInput,
  ) {
    this.connection = new SseConnection(
      reply.raw,
      input.options.drainTimeoutMs,
    );
    this.cursor = input.cursor;
    this.lastEventId = input.cursor.id;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async start(): Promise<void> {
    const options = this.input.options;
    // Take ownership of the socket before the first byte: Fastify must not try
    // to send a JSON body down a response that is now an event stream.
    this.reply.hijack();
    this.reply.raw.on('close', this.onClientGone);
    // Kept for the life of the response, not removed in close(): a socket error
    // that arrives after teardown would otherwise be an unhandled 'error' event
    // and take the process down. It holds no reference to this stream.
    this.reply.raw.on('error', IGNORED_SOCKET_ERROR);
    this.connection.open({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx (and equivalents) buffer proxied responses unless told not to,
      // which turns a live stream into a stall.
      'x-accel-buffering': 'no',
    });

    if (!(await this.connection.write(`retry: ${options.retryHintMs}\n\n`))) {
      this.close();
      return;
    }
    const ready = await this.connection.send({
      event: EVENTS_EVENT_READY,
      data: {
        stream: 'notifications',
        userId: this.input.userId,
        pollIntervalMs: options.pollIntervalMs,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        connectionLifetimeMs: options.connectionLifetimeMs,
        resume: 'send last_event_id (or Last-Event-ID) on reconnect',
      },
    });
    if (!ready) {
      this.close();
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, options.pollIntervalMs);
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, options.heartbeatIntervalMs);
    this.lifetimeTimer = setTimeout(() => {
      void this.expire();
    }, options.connectionLifetimeMs);
    // Cover the window between resolving the cursor and the first tick.
    void this.poll();
  }

  /** Stop every timer, drop the listeners and finish the response. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    this.reply.raw.off('close', this.onClientGone);
    this.connection.end();
  }

  private stopTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.lifetimeTimer = null;
  }

  private async poll(): Promise<void> {
    // Never overlap polls: a slow database would otherwise queue work faster
    // than it drains and pile connection state up in memory.
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const events = await this.input.feed.fetchAfter(
        this.input.userId,
        this.cursor,
        this.input.options.batchSize,
      );
      for (const event of events) {
        if (this.closed) return;
        if (!(await this.emitNotification(event))) return;
      }
    } catch {
      // A failed read means the stream can no longer promise to be live (the
      // database went away, or the pool refused a connection). End it instead
      // of leaving a connection that will never receive anything; the client
      // reconnects with Last-Event-ID and resumes from the last delivered id.
      this.close();
    } finally {
      this.polling = false;
    }
  }

  private async emitNotification(event: NotificationEvent): Promise<boolean> {
    const written = await this.connection.send({
      event: EVENTS_EVENT_NOTIFICATION,
      id: event.id,
      data: event,
    });
    if (!written) {
      this.close();
      return false;
    }
    // Advance only after the frame reached the socket, so a dropped connection
    // resumes from the last event the client could actually have seen.
    this.cursor = { createdAt: event.createdAt, id: event.id };
    this.lastEventId = event.id;
    return true;
  }

  private async heartbeat(): Promise<void> {
    if (this.closed) return;
    if (!(await this.connection.comment('heartbeat'))) this.close();
  }

  private async expire(): Promise<void> {
    if (this.closed) return;
    this.stopTimers();
    await this.connection.send({
      event: EVENTS_EVENT_RECONNECT,
      id: this.lastEventId ?? undefined,
      data: {
        reason: 'connection_lifetime',
        lastEventId: this.lastEventId,
      },
    });
    this.close();
  }
}
