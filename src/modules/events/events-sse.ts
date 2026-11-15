import type { ServerResponse } from 'node:http';

export interface SseEvent {
  /** SSE `event:` name. */
  event: string;
  /** Serialized as one JSON line; JSON.stringify never emits a raw newline. */
  data: unknown;
  /** SSE `id:`; the browser echoes it back as Last-Event-ID after a drop. */
  id?: string;
}

/**
 * One SSE connection, written straight to the HTTP response.
 *
 * Writes are bounded: a client that stops reading gets `drainTimeoutMs` of
 * grace and is then dropped instead of letting `write()` buffer events in
 * process memory forever. Nothing here is buffered per connection beyond the
 * frame being written, so one stalled phone cannot slow the API down.
 */
export class SseConnection {
  private closed = false;

  constructor(
    private readonly res: ServerResponse,
    private readonly drainTimeoutMs: number,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send the status line and headers; nothing may be written after end(). */
  open(headers: Record<string, string>): void {
    if (this.closed) return;
    this.res.socket?.setNoDelay(true);
    this.res.writeHead(200, headers);
    this.res.flushHeaders();
  }

  async write(chunk: string): Promise<boolean> {
    if (this.closed) return false;
    try {
      if (this.res.write(chunk)) return true;
    } catch {
      this.closed = true;
      return false;
    }
    return this.waitForDrain();
  }

  async send(event: SseEvent): Promise<boolean> {
    return this.write(this.frame(event));
  }

  /** A comment frame keeps proxies from timing out without emitting an event. */
  async comment(text: string): Promise<boolean> {
    return this.write(`: ${text}\n\n`);
  }

  /** Mark the connection closed and finish the response exactly once. */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.res.end();
    } catch {
      // The socket is already gone; nothing to flush and nothing to report.
    }
  }

  private frame(event: SseEvent): string {
    const lines: string[] = [];
    if (event.id) lines.push(`id: ${event.id}`);
    lines.push(`event: ${event.event}`);
    lines.push(`data: ${JSON.stringify(event.data)}`);
    return `${lines.join('\n')}\n\n`;
  }

  /**
   * `write()` returned false: the kernel buffer is full. Wait for 'drain', but
   * never indefinitely, and never block the event loop while waiting.
   */
  private waitForDrain(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.res.off('drain', onDrain);
        this.res.off('close', onClose);
        this.res.off('error', onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve(true);
      };
      const onClose = () => {
        cleanup();
        this.closed = true;
        resolve(false);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, this.drainTimeoutMs);
      timer.unref();
      this.res.on('drain', onDrain);
      this.res.on('close', onClose);
      this.res.on('error', onClose);
    });
  }
}
