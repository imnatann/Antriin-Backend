import { Injectable } from '@nestjs/common';

/**
 * Prometheus registry for B11.
 *
 * A tiny hand-rolled implementation instead of a new dependency: the project
 * only needs one counter, one histogram and a few process gauges, and the text
 * exposition format (text/plain; version=0.0.4) is small and stable.
 *
 * Cardinality is bounded on purpose: routes come from the Fastify route
 * template (a fixed set known at boot) and an unmatched request is folded into
 * a single series, so a client cannot grow the registry with random URLs. A
 * hard ceiling exists as a second line of defence.
 */

/** Histogram bucket boundaries in seconds, including +Inf at render time. */
export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

const MAX_SERIES = 512;
const OVERFLOW_ROUTE = '__other__';
const UNMATCHED_ROUTE = '__unmatched__';

export interface HttpRequestObservation {
  method: string;
  /** Route template such as "/api/v1/orders/:id", never a raw URL. */
  route: string;
  statusCode: number;
  durationSeconds: number;
}

interface HttpSeries {
  method: string;
  route: string;
  statusClass: string;
  requests: number;
  /** Cumulative: bucketCounts[i] counts requests <= HTTP_DURATION_BUCKETS[i]. */
  bucketCounts: number[];
  durationSum: number;
  durationCount: number;
}

@Injectable()
export class MetricsRegistry {
  private readonly series = new Map<string, HttpSeries>();

  observeHttpRequest(observation: HttpRequestObservation): void {
    const method = normaliseMethod(observation.method);
    const route =
      observation.route.trim().length > 0
        ? observation.route.trim()
        : UNMATCHED_ROUTE;
    const statusClass = statusClassOf(observation.statusCode);
    const durationSeconds =
      Number.isFinite(observation.durationSeconds) &&
      observation.durationSeconds >= 0
        ? observation.durationSeconds
        : 0;

    const series = this.seriesFor(method, route, statusClass);
    if (!series) return;

    series.requests += 1;
    series.durationSum += durationSeconds;
    series.durationCount += 1;
    for (let index = 0; index < HTTP_DURATION_BUCKETS.length; index += 1)
      if (durationSeconds <= HTTP_DURATION_BUCKETS[index])
        series.bucketCounts[index] += 1;
  }

  /** Prometheus text exposition (version 0.0.4), ending with a newline. */
  render(): string {
    const lines: string[] = [];
    this.renderRequestCounter(lines);
    this.renderDurationHistogram(lines);
    this.renderProcessGauges(lines);
    return lines.join('\n') + '\n';
  }

  private renderRequestCounter(lines: string[]): void {
    lines.push(
      '# HELP antriin_http_requests_total Total HTTP requests handled by the API.',
    );
    lines.push('# TYPE antriin_http_requests_total counter');
    for (const series of this.sorted())
      lines.push(
        'antriin_http_requests_total' +
          labels(series) +
          ' ' +
          formatNumber(series.requests),
      );
  }

  private renderDurationHistogram(lines: string[]): void {
    const name = 'antriin_http_request_duration_seconds';
    lines.push(
      '# HELP antriin_http_request_duration_seconds HTTP request duration in seconds.',
    );
    lines.push('# TYPE antriin_http_request_duration_seconds histogram');
    for (const series of this.sorted()) {
      for (let index = 0; index < HTTP_DURATION_BUCKETS.length; index += 1)
        lines.push(
          name +
            '_bucket' +
            labels(
              series,
              'le="' + formatBucket(HTTP_DURATION_BUCKETS[index]) + '"',
            ) +
            ' ' +
            formatNumber(series.bucketCounts[index]),
        );
      lines.push(
        name +
          '_bucket' +
          labels(series, 'le="+Inf"') +
          ' ' +
          formatNumber(series.durationCount),
      );
      lines.push(
        name + '_sum' + labels(series) + ' ' + formatNumber(series.durationSum),
      );
      lines.push(
        name +
          '_count' +
          labels(series) +
          ' ' +
          formatNumber(series.durationCount),
      );
    }
  }

  private renderProcessGauges(lines: string[]): void {
    const memory = process.memoryUsage();
    pushGauge(
      lines,
      'antriin_process_uptime_seconds',
      'Process uptime in seconds.',
      process.uptime(),
    );
    pushGauge(
      lines,
      'antriin_process_resident_memory_bytes',
      'Resident memory size in bytes.',
      memory.rss,
    );
    pushGauge(
      lines,
      'antriin_nodejs_heap_used_bytes',
      'V8 heap used in bytes.',
      memory.heapUsed,
    );
    pushGauge(
      lines,
      'antriin_nodejs_heap_total_bytes',
      'V8 heap total in bytes.',
      memory.heapTotal,
    );
  }

  private sorted(): HttpSeries[] {
    return [...this.series.values()].sort(
      (left, right) =>
        left.method.localeCompare(right.method) ||
        left.route.localeCompare(right.route) ||
        left.statusClass.localeCompare(right.statusClass),
    );
  }

  private seriesFor(
    method: string,
    route: string,
    statusClass: string,
  ): HttpSeries | null {
    const key = seriesKey(method, route, statusClass);
    const existing = this.series.get(key);
    if (existing) return existing;
    if (this.series.size >= MAX_SERIES) {
      // Registry is saturated: keep growing only a single overflow series per
      // method/status class instead of unbounded series.
      const overflowKey = seriesKey(method, OVERFLOW_ROUTE, statusClass);
      const overflow = this.series.get(overflowKey);
      if (overflow) return overflow;
      const created = createSeries(method, OVERFLOW_ROUTE, statusClass);
      this.series.set(overflowKey, created);
      return created;
    }
    const created = createSeries(method, route, statusClass);
    this.series.set(key, created);
    return created;
  }
}

function seriesKey(method: string, route: string, statusClass: string): string {
  return method + '\u0000' + route + '\u0000' + statusClass;
}

function createSeries(
  method: string,
  route: string,
  statusClass: string,
): HttpSeries {
  return {
    method,
    route,
    statusClass,
    requests: 0,
    bucketCounts: new Array<number>(HTTP_DURATION_BUCKETS.length).fill(0),
    durationSum: 0,
    durationCount: 0,
  };
}

function normaliseMethod(method: string): string {
  const value = (method ?? '').trim().toUpperCase();
  return /^[A-Z]{2,10}$/.test(value) ? value : 'UNKNOWN';
}

function statusClassOf(statusCode: number): string {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)
    return 'unknown';
  return Math.floor(statusCode / 100) + 'xx';
}

function labels(series: HttpSeries, extra?: string): string {
  const base =
    'method="' +
    escapeLabel(series.method) +
    '",route="' +
    escapeLabel(series.route) +
    '",status_class="' +
    escapeLabel(series.statusClass) +
    '"';
  return '{' + base + (extra ? ',' + extra : '') + '}';
}

function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function formatBucket(bucket: number): string {
  return String(bucket);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(6)));
}

function pushGauge(
  lines: string[],
  name: string,
  help: string,
  value: number,
): void {
  lines.push('# HELP ' + name + ' ' + help);
  lines.push('# TYPE ' + name + ' gauge');
  lines.push(name + ' ' + formatNumber(value));
}
