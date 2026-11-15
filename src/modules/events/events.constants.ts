/**
 * Timing and guard rails for GET /api/v1/events/stream.
 *
 * Injected through EVENTS_STREAM_OPTIONS instead of hardcoded so a test can run
 * the exact production code path with millisecond timings; the module supplies
 * DEFAULT_EVENTS_STREAM_OPTIONS, which is what the API uses.
 */
export interface EventsStreamOptions {
  /** How often the notifications table is polled for new rows. */
  pollIntervalMs: number;
  /** SSE comment written on an idle socket so proxies keep the connection. */
  heartbeatIntervalMs: number;
  /** Hard cap on connection lifetime; the stream then ends with `reconnect`. */
  connectionLifetimeMs: number;
  /** Maximum notifications written in one poll. */
  batchSize: number;
  /** How long one socket write may wait for `drain` before the client is dropped. */
  drainTimeoutMs: number;
  /** EventSource retry hint, sent once when the stream opens. */
  retryHintMs: number;
}

export const EVENTS_STREAM_OPTIONS = Symbol('EVENTS_STREAM_OPTIONS');

/**
 * Polling the database is deliberate: the notifications table is inserted into
 * by whichever API or worker instance handled the domain change, so a second
 * API instance sees the same rows. An in-process event bus would only deliver
 * to the connection that happened to be on the same process.
 */
export const DEFAULT_EVENTS_STREAM_OPTIONS: EventsStreamOptions = {
  pollIntervalMs: 2_000,
  heartbeatIntervalMs: 15_000,
  connectionLifetimeMs: 15 * 60_000,
  batchSize: 50,
  drainTimeoutMs: 5_000,
  retryHintMs: 3_000,
};

/**
 * The token shape AuthGuard accepts after "Bearer ": URL-safe base64, 32-128
 * characters. The query-parameter path reuses it, so a token the header path
 * would reject cannot get in through `?access_token=`.
 */
export const EVENTS_ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** Event names written on the stream. */
export const EVENTS_EVENT_READY = 'ready';
export const EVENTS_EVENT_NOTIFICATION = 'notification';
export const EVENTS_EVENT_RECONNECT = 'reconnect';
