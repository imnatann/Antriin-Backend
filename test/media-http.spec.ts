import 'reflect-metadata';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { MediaController } from '../src/modules/media/media.controller';
import { MediaService } from '../src/modules/media/media.service';
import type { StoredMediaAsset } from '../src/modules/media/media.service';

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '55555555-5555-4555-8555-555555555555';
const ASSET_ID = '66666666-6666-4666-8666-666666666666';
const MAX_BYTES = 1024;

const pngBytes = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

function multipartBody(
  data: Buffer,
  options: { field?: string; filename?: string; contentType?: string } = {},
) {
  const boundary = '----antriinMediaTestBoundary';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${options.field ?? 'file'}"; filename="${options.filename ?? 'photo.png'}"\r\n` +
      `Content-Type: ${options.contentType ?? 'image/png'}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, data, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const storedAsset: StoredMediaAsset = {
  id: ASSET_ID,
  purpose: 'menu_item',
  storageKey: '2026/01/asset.png',
  contentType: 'image/png',
  byteSize: 33,
  checksumSha256: 'a'.repeat(64),
  originalFilename: 'photo.png',
  width: 10,
  height: 10,
  metadataStripped: true,
  moderationStatus: 'unreviewed',
  createdAt: '2026-01-01T00:00:00.000000Z',
  updatedAt: '2026-01-01T00:00:00.000000Z',
};

class StubMediaService {
  calls: string[] = [];
  lastUpload?: {
    userId: string;
    purpose: string;
    declaredContentType: string;
    byteSize: number;
    filename: string;
  };
  failure?: unknown;
  asset: StoredMediaAsset | null = storedAsset;
  onDisk = true;
  filePath = '';
  removeFailure?: unknown;

  readonly limits = {
    maxBytes: MAX_BYTES,
    contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    purposes: [
      'menu_item',
      'tenant_logo',
      'tenant_cover',
      'avatar',
      'case_evidence',
    ],
  };

  async create(
    userId: string,
    purpose: string,
    input: { buffer: Buffer; declaredContentType: string; filename: string },
  ) {
    this.calls.push('create');
    this.lastUpload = {
      userId,
      purpose,
      declaredContentType: input.declaredContentType,
      byteSize: input.buffer.length,
      filename: input.filename,
    };
    if (this.failure) throw this.failure;
    return storedAsset;
  }

  async findById() {
    this.calls.push('findById');
    return this.asset;
  }

  async exists() {
    return this.onDisk;
  }

  resolvePath() {
    return this.filePath;
  }

  async remove() {
    this.calls.push('remove');
    if (this.removeFailure) throw this.removeFailure;
  }

  notFound() {
    return new NotFoundException({
      code: 'MEDIA_NOT_FOUND',
      message: 'Media not found',
    });
  }
}

describe('Media HTTP contract', () => {
  let app: NestFastifyApplication;
  let stub: StubMediaService;
  let directory: string;

  const auth = { authorization: 'Bearer test-token' };
  const base = '/api/v1/media';

  // app.inject takes one headers object, so the multipart content type has to be
  // merged with the auth header rather than spread over it.
  function upload(
    url: string,
    bytes: Buffer,
    headers: Record<string, string>,
    options?: { field?: string; filename?: string; contentType?: string },
  ) {
    const mp = multipartBody(bytes, options);
    return app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...mp.headers },
      payload: mp.body,
    });
  }

  beforeEach(async () => {
    stub = new StubMediaService();
    directory = await mkdtemp(join(tmpdir(), 'antriin-media-http-'));
    stub.filePath = join(directory, 'asset.png');
    await writeFile(stub.filePath, pngBytes(10, 10));

    const guard = {
      canActivate: (context: ExecutionContext) => {
        const request = context.switchToHttp().getRequest<{
          headers: { authorization?: string };
          user?: { userId: string; sessionId: string };
        }>();
        if (request.headers.authorization !== 'Bearer test-token') {
          throw new UnauthorizedException({
            code: 'unauthorized',
            message: 'A valid bearer token is required',
          });
        }
        request.user = { userId: ACTOR_ID, sessionId: 'session-1' };
        return true;
      },
    };

    const module = await Test.createTestingModule({
      controllers: [MediaController],
      providers: [{ provide: MediaService, useValue: stub }],
    })
      .overrideGuard(AuthGuard)
      .useValue(guard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.register(multipart, {
      limits: { fileSize: MAX_BYTES, files: 1, fields: 0 },
    });
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
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('advertises its limits without a token', async () => {
    const response = await app.inject({ method: 'GET', url: base + '/limits' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: { maxBytes: number } };
    assert.equal(body.data.maxBytes, MAX_BYTES);
  });

  it('requires a bearer token to upload and to delete', async () => {
    const unauthorised = await upload(
      base + '?purpose=menu_item',
      pngBytes(4, 4),
      {},
    );
    assert.equal(unauthorised.statusCode, 401);

    const remove = await app.inject({
      method: 'DELETE',
      url: base + '/' + ASSET_ID,
    });
    assert.equal(remove.statusCode, 401);
    assert.deepEqual(stub.calls, []);
  });

  it('rejects a missing or unknown purpose', async () => {
    const missing = await upload(base, pngBytes(4, 4), auth);
    assert.equal(missing.statusCode, 400);

    const unknown = await upload(
      base + '?purpose=wallpaper',
      pngBytes(4, 4),
      auth,
    );
    assert.equal(unknown.statusCode, 400);
    assert.deepEqual(stub.calls, []);
  });

  it('rejects a request with no file part', async () => {
    const response = await upload(
      base + '?purpose=menu_item',
      pngBytes(4, 4),
      auth,
      {
        field: 'other',
      },
    );
    assert.equal(response.statusCode, 400);
    const body = response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'MEDIA_FILE_REQUIRED');
  });

  it('stores a file and returns its public url in the data envelope', async () => {
    const bytes = pngBytes(320, 240);
    const response = await upload(base + '?purpose=menu_item', bytes, auth);
    assert.equal(response.statusCode, 201);
    const body = response.json() as {
      data: {
        id: string;
        url: string;
        metadataStripped: boolean;
        moderationStatus: string;
      };
    };
    assert.equal(body.data.id, ASSET_ID);
    assert.equal(body.data.url, '/api/v1/media/' + ASSET_ID);
    // The response says whether the stored bytes were rewritten, and what the
    // (read-only) review state is - it never claims the image was reviewed.
    assert.equal(body.data.metadataStripped, true);
    assert.equal(body.data.moderationStatus, 'unreviewed');
    assert.equal(stub.lastUpload?.userId, ACTOR_ID);
    assert.equal(stub.lastUpload?.purpose, 'menu_item');
    assert.equal(stub.lastUpload?.declaredContentType, 'image/png');
    assert.equal(stub.lastUpload?.byteSize, bytes.length);
  });

  it('preserves the service error code when the type is refused', async () => {
    stub.failure = new UnsupportedMediaTypeException({
      code: 'MEDIA_TYPE_MISMATCH',
      message: 'The file content is image/jpeg, not the declared image/png',
    });
    const response = await upload(
      base + '?purpose=menu_item',
      pngBytes(4, 4),
      auth,
    );
    assert.equal(response.statusCode, 415);
    const body = response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'MEDIA_TYPE_MISMATCH');
  });

  it('answers 413 before the service sees an oversized file', async () => {
    const response = await upload(
      base + '?purpose=menu_item',
      Buffer.alloc(MAX_BYTES + 1, 0x41),
      auth,
    );
    assert.equal(response.statusCode, 413);
    const body = response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'MEDIA_FILE_TOO_LARGE');
    assert.deepEqual(stub.calls, []);
  });

  it('streams the bytes with an immutable ETag and honours If-None-Match', async () => {
    const response = await app.inject({
      method: 'GET',
      url: base + '/' + ASSET_ID,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(
      response.headers['cache-control'],
      'public, max-age=31536000, immutable',
    );
    assert.equal(response.headers.etag, '"' + 'a'.repeat(64) + '"');
    assert.deepEqual(response.rawPayload, pngBytes(10, 10));

    const cached = await app.inject({
      method: 'GET',
      url: base + '/' + ASSET_ID,
      headers: { 'if-none-match': '"' + 'a'.repeat(64) + '"' },
    });
    assert.equal(cached.statusCode, 304);
  });

  it('returns 404 for an unknown, deleted or unreadable asset', async () => {
    stub.asset = null;
    const unknown = await app.inject({
      method: 'GET',
      url: base + '/' + ASSET_ID,
    });
    assert.equal(unknown.statusCode, 404);
    assert.equal(
      (unknown.json() as { error: { code: string } }).error.code,
      'MEDIA_NOT_FOUND',
    );

    // A row can outlive its file; that must read as absent, not as a 500.
    stub.asset = storedAsset;
    stub.onDisk = false;
    const orphan = await app.inject({
      method: 'GET',
      url: base + '/' + ASSET_ID,
    });
    assert.equal(orphan.statusCode, 404);
  });

  it('rejects a malformed id before reaching the service', async () => {
    const response = await app.inject({
      method: 'GET',
      url: base + '/not-a-uuid',
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(stub.calls, []);
  });

  it('deletes with 204 and reports another owner as 404', async () => {
    const ok = await app.inject({
      method: 'DELETE',
      url: base + '/' + ASSET_ID,
      headers: auth,
    });
    assert.equal(ok.statusCode, 204);
    assert.equal(ok.body, '');

    stub.removeFailure = new NotFoundException({
      code: 'MEDIA_NOT_FOUND',
      message: 'Media not found',
    });
    const foreign = await app.inject({
      method: 'DELETE',
      url: base + '/' + ASSET_ID,
      headers: { authorization: 'Bearer test-token', 'x-actor': OTHER_ID },
    });
    assert.equal(foreign.statusCode, 404);
  });
});
