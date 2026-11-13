import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';

@Controller('errors')
class ErrorController {
  @Get('rate')
  rateFailure() {
    throw new HttpException(
      {
        code: 'otp_locked',
        message: 'Wait before retrying',
        retryAfterSeconds: 60,
      },
      429,
    );
  }
  @Get('private')
  privateFailure() {
    throw new Error('private-database-connection-secret');
  }
  @Get('validation')
  validationFailure() {
    throw new BadRequestException(['amount must be a string']);
  }
}
describe('Safe API error contract', () => {
  let app: NestFastifyApplication;
  before(async () => {
    const module = await Test.createTestingModule({
      controllers: [ErrorController],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  after(async () => {
    await app.close();
  });
  it('does not leak internal errors and correlates the response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/errors/private',
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.includes('private-database'), false);
    assert.equal(response.json().error.code, 'INTERNAL_ERROR');
    assert.equal(
      response.json().error.request_id,
      response.headers['x-request-id'],
    );
  });
  it('retains safe validation details with a stable code', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/errors/validation',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    assert.deepEqual(response.json().error.details, [
      'amount must be a string',
    ]);
  });
  it('preserves domain codes and provides bounded retry instructions', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/errors/rate',
    });
    assert.equal(response.statusCode, 429);
    assert.equal(response.json().error.code, 'otp_locked');
    assert.equal(response.json().error.retry_after_seconds, 60);
    assert.equal(response.headers['retry-after'], '60');
  });
});
