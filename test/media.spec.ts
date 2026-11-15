import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { MediaService } from '../src/modules/media/media.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const MAX_BYTES = 4096;

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(18);
  app0[0] = 0xff;
  app0[1] = 0xe0;
  app0.writeUInt16BE(16, 2);
  app0.write('JFIF', 4, 'ascii');
  app0[8] = 1;
  app0[9] = 1;
  app0.writeUInt16BE(1, 11);
  app0.writeUInt16BE(1, 13);

  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe('MediaService against PostgreSQL', { skip: !testDatabaseUrl }, () => {
  let pool: Pool;
  let service: MediaService;
  let root: string;
  let ownerId: string;
  let otherId: string;
  const createdIds: string[] = [];

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    root = await mkdtemp(join(tmpdir(), 'antriin-media-it-'));
    const config = {
      getOrThrow: (key: string) => {
        if (key === 'MEDIA_ROOT') return root;
        if (key === 'MEDIA_MAX_BYTES') return MAX_BYTES;
        throw new Error('unexpected config key ' + key);
      },
    } as unknown as ConfigService;
    service = new MediaService({ pool } as unknown as DatabaseService, config);
    await service.onModuleInit();

    const owner = await pool.query<{ id: string }>(
      'insert into users (display_name) values ($1) returning id',
      ['Media Owner ' + Date.now()],
    );
    ownerId = owner.rows[0].id;
    const other = await pool.query<{ id: string }>(
      'insert into users (display_name) values ($1) returning id',
      ['Media Other ' + Date.now()],
    );
    otherId = other.rows[0].id;
  });

  after(async () => {
    if (createdIds.length) {
      await pool.query('delete from media_assets where id = any($1::uuid[])', [
        createdIds,
      ]);
    }
    await pool.query('delete from users where id = any($1::uuid[])', [
      [ownerId, otherId],
    ]);
    await pool.end();
    await rm(root, { recursive: true, force: true });
  });

  async function upload(
    bytes: Buffer,
    declaredContentType = 'image/png',
    userId = ownerId,
    purpose: 'menu_item' | 'avatar' = 'menu_item',
  ) {
    const asset = await service.create(userId, purpose, {
      buffer: bytes,
      declaredContentType,
      filename: 'photo.png',
    });
    createdIds.push(asset.id);
    return asset;
  }

  it('writes the file to disk and records the asset', async () => {
    const bytes = png(320, 240);
    const asset = await upload(bytes);

    assert.equal(asset.purpose, 'menu_item');
    assert.equal(asset.contentType, 'image/png');
    assert.equal(asset.byteSize, bytes.length);
    assert.equal(asset.width, 320);
    assert.equal(asset.height, 240);
    assert.equal(asset.originalFilename, 'photo.png');
    assert.equal(
      asset.checksumSha256,
      createHash('sha256').update(bytes).digest('hex'),
    );
    // Microsecond ISO string straight from PostgreSQL, not a JS Date round-trip.
    assert.match(
      asset.createdAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );

    const info = await stat(service.resolvePath(asset.storageKey));
    assert.equal(info.size, bytes.length);
    assert.match(asset.storageKey, /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);

    const found = await service.findById(asset.id);
    assert.equal(found?.id, asset.id);
    assert.equal(await service.exists(asset), true);
  });

  it('stores a JPEG and reads its frame size', async () => {
    const asset = await upload(jpeg(64, 32), 'image/jpeg');
    assert.equal(asset.contentType, 'image/jpeg');
    assert.equal(asset.width, 64);
    assert.equal(asset.height, 32);
    assert.match(asset.storageKey, /\.jpg$/);
  });

  it('refuses an empty, oversized or unlisted file', async () => {
    await assert.rejects(
      () => upload(Buffer.alloc(0)),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 400,
    );
    await assert.rejects(
      () => upload(Buffer.concat([png(1, 1), Buffer.alloc(MAX_BYTES)])),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 413,
    );
    await assert.rejects(
      () => upload(png(1, 1), 'image/gif'),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 415,
    );
  });

  it('refuses content that contradicts the declared type', async () => {
    // A JPEG uploaded as image/png: the header, not the header field, decides.
    await assert.rejects(
      () => upload(jpeg(8, 8), 'image/png'),
      (error: { getStatus?: () => number; getResponse?: () => unknown }) => {
        assert.equal(error.getStatus?.(), 415);
        assert.equal(
          (error.getResponse?.() as { code?: string }).code,
          'MEDIA_TYPE_MISMATCH',
        );
        return true;
      },
    );
  });

  it('refuses bytes that are not an image at all', async () => {
    await assert.rejects(
      () =>
        upload(
          Buffer.from('<html><script>alert(1)</script></html>'),
          'image/png',
        ),
      (error: { getResponse?: () => unknown }) => {
        assert.equal(
          (error.getResponse?.() as { code?: string }).code,
          'MEDIA_CONTENT_UNRECOGNISED',
        );
        return true;
      },
    );
  });

  it('soft deletes: the asset stops being reachable but the row survives', async () => {
    const asset = await upload(png(4, 4));
    await service.remove(ownerId, asset.id);

    assert.equal(await service.findById(asset.id), null);
    const row = await pool.query<{ deleted_at: Date | null }>(
      'select deleted_at from media_assets where id = $1',
      [asset.id],
    );
    assert.notEqual(row.rows[0].deleted_at, null);

    // Deleting twice is a 404, not a silent success.
    await assert.rejects(
      () => service.remove(ownerId, asset.id),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 404,
    );
  });

  it("refuses to delete another owner's asset and leaves it readable", async () => {
    const asset = await upload(png(6, 6));
    await assert.rejects(
      () => service.remove(otherId, asset.id),
      (error: { getStatus?: () => number; getResponse?: () => unknown }) => {
        assert.equal(error.getStatus?.(), 404);
        assert.equal(
          (error.getResponse?.() as { code?: string }).code,
          'MEDIA_NOT_FOUND',
        );
        return true;
      },
    );
    assert.equal((await service.findById(asset.id))?.id, asset.id);
  });

  it('reports a row whose file vanished as not existing', async () => {
    const asset = await upload(png(5, 5));
    await unlink(service.resolvePath(asset.storageKey));
    assert.equal(await service.exists(asset), false);
    // The row is still there: the database is the authority on existence, the
    // disk check only stops a stream from failing mid-response.
    assert.equal((await service.findById(asset.id))?.id, asset.id);
  });

  it('refuses a storage key that escapes the media root', () => {
    assert.throws(() => service.resolvePath('../../etc/passwd'));
    assert.throws(() => service.resolvePath('/etc/passwd'));
  });

  it('enforces the column CHECKs even for a direct insert', async () => {
    // The service validates in TypeScript; these assertions prove the database
    // refuses the same rows, so a future writer cannot bypass the rules.
    const base = {
      owner: ownerId,
      purpose: 'menu_item',
      key: 'x/' + Date.now() + '.png',
      contentType: 'image/png',
      byteSize: 10,
      checksum: 'a'.repeat(64),
    };
    const insert = (overrides: Partial<typeof base>) => {
      const row = { ...base, ...overrides };
      return pool.query(
        `insert into media_assets
           (owner_user_id, purpose, storage_key, content_type, byte_size, checksum_sha256)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          row.owner,
          row.purpose,
          row.key,
          row.contentType,
          row.byteSize,
          row.checksum,
        ],
      );
    };
    const violates = async (overrides: Partial<typeof base>) => {
      await assert.rejects(
        () => insert(overrides),
        (error: { code?: string }) => {
          assert.equal(error.code, '23514');
          return true;
        },
      );
    };

    await violates({ purpose: 'wallpaper' });
    await violates({ contentType: 'image/svg+xml' });
    await violates({ byteSize: 0 });
    await violates({ byteSize: 20971521 });
    await violates({ checksum: 'not-a-hash' });

    // One dimension without the other is refused; both null is allowed.
    await assert.rejects(
      () =>
        pool.query(
          `insert into media_assets
             (owner_user_id, purpose, storage_key, content_type, byte_size,
              checksum_sha256, width)
           values ($1,'menu_item',$2,'image/png',10,$3,5)`,
          [ownerId, base.key, base.checksum],
        ),
      (error: { code?: string }) => {
        assert.equal(error.code, '23514');
        return true;
      },
    );

    // A second row cannot reuse a storage key.
    await assert.rejects(
      async () => {
        await insert({});
        await insert({ key: base.key });
      },
      (error: { code?: string }) => {
        assert.equal(error.code, '23505');
        return true;
      },
    );
    await pool.query('delete from media_assets where storage_key = $1', [
      base.key,
    ]);
  });
});
