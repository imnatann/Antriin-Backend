import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import type { NestInterceptor } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsRegistry } from './metrics.registry';

/**
 * Route template recorded for a request Fastify could not match. A raw URL
 * would let a client create one series per invented path; a constant keeps the
 * registry bounded.
 */
export const UNMATCHED_ROUTE = '__unmatched__';

/** Route template for metrics. Never the raw URL (query strings would explode). */
export function resolveRouteTemplate(
  request: Pick<FastifyRequest, 'routeOptions' | 'url'>,
): string {
  const template = request.routeOptions?.url;
  if (typeof template === 'string' && template.length > 0) return template;
  return UNMATCHED_ROUTE;
}

/** Status the ApiExceptionFilter will answer with for a thrown error. */
export function statusCodeOf(error: unknown): number {
  if (error instanceof HttpException) return error.getStatus();
  return 500;
}

/**
 * Collects one observation per HTTP request into the Prometheus registry.
 * Registered as APP_INTERCEPTOR by MetricsModule, so importing that module is
 * enough to start collecting; the /metrics route only renders what is here.
 *
 * The duration is measured from the moment Nest starts handling the request
 * until the handler produced (or failed to produce) a result, and the status
 * class comes from the reply on success or from the thrown HttpException on
 * failure - the exception filter runs after interceptors.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly registry: MetricsRegistry) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const startedAt = process.hrtime.bigint();
    const record = (statusCode: number): void => {
      const elapsed = process.hrtime.bigint() - startedAt;
      this.registry.observeHttpRequest({
        method: request.method,
        route: resolveRouteTemplate(request),
        statusCode,
        durationSeconds: Number(elapsed) / 1e9,
      });
    };
    return next.handle().pipe(
      tap({
        next: () => record(http.getResponse<FastifyReply>().statusCode),
        error: (error: unknown) => record(statusCodeOf(error)),
      }),
    );
  }
}
