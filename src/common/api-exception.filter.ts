import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

const codes: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    const body =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    // Preserve the established readiness response used by infrastructure probes.
    if (
      request.url.split('?')[0] === '/v1/health/ready' &&
      status === 503 &&
      typeof body === 'object' &&
      body !== null &&
      'dependencies' in body
    ) {
      void response.status(status).send(body);
      return;
    }
    const fields =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};
    const requestId = request.id || randomUUID();
    const declaredCode = fields.code;
    const code =
      typeof declaredCode === 'string' &&
      /^[A-Z][A-Z0-9_]{1,63}$/.test(declaredCode)
        ? declaredCode
        : (codes[status] ??
          (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'));
    const details =
      status === 400 && Array.isArray(fields.message)
        ? fields.message
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 20)
            .map((item) => item.slice(0, 200))
        : undefined;
    const message =
      status >= 500
        ? status === 503
          ? 'Service temporarily unavailable'
          : 'An unexpected error occurred'
        : typeof fields.message === 'string'
          ? fields.message
          : typeof body === 'string'
            ? body
            : 'Request rejected';
    void response
      .header('x-request-id', requestId)
      .status(status)
      .send({
        error: {
          code,
          message,
          ...(details ? { details } : {}),
          request_id: requestId,
        },
      });
  }
}
