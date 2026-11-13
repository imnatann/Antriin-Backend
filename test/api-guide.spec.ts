import 'reflect-metadata';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  ApiGuideController,
  ApiGuideMarkdownController,
} from '../src/modules/api-guide/api-guide.controller';
import { ApiGuideService } from '../src/modules/api-guide/api-guide.service';

/** A miniature document with the same shape SwaggerModule produces. */
function fixture(): OpenAPIObject {
  return {
    openapi: '3.0.0',
    info: { title: 'Antriin API', version: '0.1.0', contact: {} },
    paths: {
      '/api/v1/health/live': {
        get: {
          tags: ['Health'],
          summary: 'Process liveness',
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/v1/orders/{orderId}/reviews': {
        post: {
          tags: ['Reviews'],
          summary: 'Buyer reviews their own completed order',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'orderId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReviewBodyDto' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Review created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          rating: { type: 'integer', minimum: 1, maximum: 5 },
                          reply: { type: 'object', nullable: true },
                        },
                        required: ['id', 'rating'],
                      },
                    },
                    required: ['data'],
                  },
                },
              },
            },
            '409': { description: 'Review already exists' },
          },
        },
      },
    },
    components: {
      schemas: {
        ReviewBodyDto: {
          type: 'object',
          properties: {
            rating: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description: 'Stars',
            },
            body: { type: 'string', minLength: 1, maxLength: 2000 },
          },
          required: ['rating', 'body'],
        },
      },
    },
  } as unknown as OpenAPIObject;
}

function guide(): ApiGuideService {
  const service = new ApiGuideService();
  service.setDocument(fixture());
  return service;
}

describe('API guide', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('is not exposed until the document is registered', () => {
    const service = new ApiGuideService();
    assert.throws(() => service.getDocument());
    assert.throws(() => service.renderHtml());
    assert.throws(() => service.renderMarkdown());
  });

  it('derives every endpoint, parameter and response from the document', () => {
    const markdown = guide().renderMarkdown();
    assert.match(markdown, /POST \/api\/v1\/orders\/\{orderId\}\/reviews/);
    assert.match(markdown, /GET \/api\/v1\/health\/live/);
    assert.match(markdown, /\| orderId \| path \| ya \| string\(uuid\) \|/);
    assert.match(markdown, /- \*\*201\*\* Review created/);
    assert.match(markdown, /- \*\*409\*\* Review already exists/);
    // Envelope is unwrapped so the payload fields stay visible.
    assert.match(markdown, /\x60id\x60: \x60string\(uuid\)\x60 \(wajib\)/);
    assert.match(
      markdown,
      /\x60rating\x60: \x60integer\x60 \(wajib\) — range 1\.\.5/,
    );
    // Bearer is flagged; the public route is not.
    assert.match(
      markdown,
      /Buyer reviews their own completed order _\(bearer\)_/,
    );
    assert.match(markdown, /Process liveness _\(publik\)_/);
  });

  it('lists every component object with types, required flags and bounds', () => {
    const markdown = guide().renderMarkdown();
    assert.match(markdown, /## 7\. Objects/);
    assert.match(markdown, /### ReviewBodyDto/);
    assert.match(markdown, /\| body \| string \| ya \| panjang 1\.\.2000 \|/);
    // The request body points at the object instead of inlining it.
    assert.match(markdown, /\*\*Body \(wajib\):\*\* -> \x60ReviewBodyDto\x60/);
  });

  it('states the prefix once and never doubles it', () => {
    const markdown = guide().renderMarkdown();
    assert.match(markdown, /\x60\/api\/v1\x60 — semua path di bawah/);
    assert.equal(markdown.includes('/api/v1/api/v1'), false);
  });

  it('renders the HTML page with escaped prose', () => {
    const html = guide().renderHtml();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<h1>Antriin API Guide<\/h1>/);
    assert.match(html, /<code>\/api\/v1\/orders\/\{orderId\}\/reviews<\/code>/);
    assert.match(html, /<span class="auth">bearer<\/span>/);
    // Markdown syntax from the prose is converted, not printed literally.
    assert.equal(html.includes('**'), false);
    assert.equal(html.includes('`'), false);
  });

  it('serves html, markdown and the raw document under /api/v1', async () => {
    const service = guide();
    const module = await Test.createTestingModule({
      controllers: [ApiGuideController, ApiGuideMarkdownController],
      providers: [{ provide: ApiGuideService, useValue: service }],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const html = await app.inject({ method: 'GET', url: '/api/v1/guide' });
    assert.equal(html.statusCode, 200);
    assert.match(String(html.headers['content-type']), /text\/html/);
    assert.match(html.body, /Antriin API Guide/);

    const markdown = await app.inject({
      method: 'GET',
      url: '/api/v1/guide.md',
    });
    assert.equal(markdown.statusCode, 200);
    assert.match(String(markdown.headers['content-type']), /text\/markdown/);
    assert.match(markdown.body, /# Antriin API Guide/);

    const document = await app.inject({
      method: 'GET',
      url: '/api/v1/guide/openapi.json',
    });
    assert.equal(document.statusCode, 200);
    assert.equal(
      (document.json() as { info: { version: string } }).info.version,
      '0.1.0',
    );
  });

  it('answers 404 when the document was never registered', async () => {
    const module = await Test.createTestingModule({
      controllers: [ApiGuideController, ApiGuideMarkdownController],
      providers: [ApiGuideService],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const instance = app;
    for (const url of [
      '/api/v1/guide',
      '/api/v1/guide.md',
      '/api/v1/guide/openapi.json',
    ]) {
      const response = await instance.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 404, url);
    }
  });
});
