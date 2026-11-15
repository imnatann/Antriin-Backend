import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { probeImage } from '../src/modules/media/image-probe';
import { MediaService } from '../src/modules/media/media.service';

/**
 * The privacy guarantee end to end: what is on disk must not contain the
 * metadata the client uploaded, and the asset row must say that.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const MAX_BYTES = 8192;

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
const contains = (haystack: Buffer, needle: string): boolean =>
  haystack.includes(Buffer.from(needle, 'latin1'));

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** PNG chunk with a zero CRC: the probe and the stripper read structure only. */
function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  return chunk;
}

function png(width: number, height: number, text?: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts: Buffer[] = [PNG_SIGNATURE, pngChunk('IHDR', ihdr)];
  if (text) parts.push(pngChunk('tEXt', Buffer.from(text, 'latin1')));
  parts.push(
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x00, 0x01, 0x02])),
    pngChunk('IEND', Buffer.alloc(0)),
  );
  return Buffer.concat(parts);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

function jpeg(width: number, height: number, exif?: string): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1;
  sof[6] = 1;
  sof[7] = 0x11;
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (exif) {
    parts.push(
      jpegSegment(
        0xe1,
        Buffer.concat([
          Buffer.from('Exif\0\0', 'latin1'),
          Buffer.from(exif, 'latin1'),
        ]),
      ),
      jpegSegment(0xfe, Buffer.from('GPS -6.21462,106.84513', 'latin1')),
    );
  }
  parts.push(
    jpegSegment(0xc0, sof),
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]),
  );
  return Buffer.concat(parts);
}

function webpChunk(fourcc: string, payload: Buffer): Buffer {
  const pad = payload.length & 1 ? 1 : 0;
  const chunk = Buffer.alloc(8 + payload.length + pad);
  chunk.write(fourcc, 0, 'ascii');
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function webp(width: number, height: number, exif?: string): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = exif ? 0x08 : 0x00;
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const body: Buffer[] = [webpChunk('VP8X', vp8x)];
  if (exif) body.push(webpChunk('EXIF', Buffer.from(exif, 'latin1')));
  body.push(
    webpChunk('VP8L', Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x11])),
  );
  const payload = Buffer.concat(body);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(payload.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, payload]);
}

const EXIF_TEXT = 'iPhone 15 Pro GPSLatitude -6.21462 2026:01:02 03:04:05';

describe(
  'MediaService strips metadata before storing',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let service: MediaService;
    let root: string;
    let ownerId: string;
    const createdIds: string[] = [];

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl });
      root = await mkdtemp(join(tmpdir(), 'antriin-media-privacy-'));
      const config = {
        getOrThrow: (key: string) => {
          if (key === 'MEDIA_ROOT') return root;
          if (key === 'MEDIA_MAX_BYTES') return MAX_BYTES;
          throw new Error('unexpected config key ' + key);
        },
      } as unknown as ConfigService;
      service = new MediaService(
        { pool } as unknown as DatabaseService,
        config,
      );
      await service.onModuleInit();

      const owner = await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        ['Media Privacy ' + Date.now()],
      );
      ownerId = owner.rows[0].id;
    });

    after(async () => {
      if (createdIds.length) {
        await pool.query(
          'delete from media_assets where id = any($1::uuid[])',
          [createdIds],
        );
      }
      await pool.query('delete from users where id = $1', [ownerId]);
      await pool.end();
      await rm(root, { recursive: true, force: true });
    });

    async function upload(bytes: Buffer, declaredContentType: string) {
      const asset = await service.create(ownerId, 'menu_item', {
        buffer: bytes,
        declaredContentType,
        filename: 'photo',
      });
      createdIds.push(asset.id);
      return asset;
    }

    async function bytesOnDisk(asset: { storageKey: string }): Promise<Buffer> {
      return readFile(service.resolvePath(asset.storageKey));
    }

    it('stores a JPEG without its EXIF block and records that it did', async () => {
      const original = jpeg(64, 32, EXIF_TEXT);
      assert.equal(contains(original, 'iPhone 15 Pro'), true);

      const asset = await upload(original, 'image/jpeg');

      assert.equal(asset.metadataStripped, true);
      assert.equal(asset.moderationStatus, 'unreviewed');
      assert.equal(asset.width, 64);
      assert.equal(asset.height, 32);

      // The bytes on disk, not just the response, are the guarantee.
      const stored = await bytesOnDisk(asset);
      for (const secret of [
        'Exif',
        'iPhone 15 Pro',
        'GPSLatitude',
        '-6.21462',
      ]) {
        assert.equal(
          contains(stored, secret),
          false,
          secret + ' still on disk',
        );
      }
      assert.equal(stored.length, asset.byteSize);
      assert.equal(stored.length < original.length, true);
      assert.equal(sha256(stored), asset.checksumSha256);
      // Still the same picture, per the module's own probe.
      assert.deepEqual(probeImage(stored), {
        contentType: 'image/jpeg',
        width: 64,
        height: 32,
      });

      const row = await pool.query<{
        metadata_stripped: boolean;
        moderation_status: string;
        byte_size: number;
        checksum_sha256: string;
      }>(
        'select metadata_stripped, moderation_status, byte_size, checksum_sha256 from media_assets where id = $1',
        [asset.id],
      );
      assert.deepEqual(row.rows[0], {
        metadata_stripped: true,
        moderation_status: 'unreviewed',
        byte_size: stored.length,
        checksum_sha256: sha256(stored),
      });

      // Reading it back reports the same state.
      const found = await service.findById(asset.id);
      assert.equal(found?.metadataStripped, true);
      assert.equal(found?.moderationStatus, 'unreviewed');
    });

    it('stores a PNG without text chunks', async () => {
      const original = png(40, 30, 'Author\0Dewi Photographer');
      const asset = await upload(original, 'image/png');

      const stored = await bytesOnDisk(asset);
      assert.equal(asset.metadataStripped, true);
      assert.equal(contains(stored, 'Dewi Photographer'), false);
      assert.equal(contains(stored, 'tEXt'), false);
      // IDAT and IEND survive, so a decoder still has pixels.
      assert.equal(contains(stored, 'IDAT'), true);
      assert.equal(contains(stored, 'IEND'), true);
      assert.deepEqual(probeImage(stored), {
        contentType: 'image/png',
        width: 40,
        height: 30,
      });
    });

    it('stores a WebP without EXIF and with a consistent RIFF size', async () => {
      const original = webp(800, 600, EXIF_TEXT);
      const asset = await upload(original, 'image/webp');

      const stored = await bytesOnDisk(asset);
      assert.equal(asset.metadataStripped, true);
      assert.equal(contains(stored, 'iPhone 15 Pro'), false);
      assert.equal(stored.readUInt32LE(4), stored.length - 8);
      assert.deepEqual(probeImage(stored), {
        contentType: 'image/webp',
        width: 800,
        height: 600,
      });
    });

    it('leaves a clean image byte-identical and says nothing was stripped', async () => {
      const original = png(6, 6);
      const asset = await upload(original, 'image/png');
      const stored = await bytesOnDisk(asset);

      assert.equal(asset.metadataStripped, false);
      assert.deepEqual(stored, original);
      assert.equal(asset.byteSize, original.length);
      assert.equal(asset.checksumSha256, sha256(original));
    });

    it('re-uploading already stripped bytes changes neither the bytes nor the flag', async () => {
      const first = await upload(jpeg(20, 10, EXIF_TEXT), 'image/jpeg');
      const stripped = await bytesOnDisk(first);

      const second = await upload(stripped, 'image/jpeg');

      assert.equal(second.metadataStripped, false);
      assert.equal(second.checksumSha256, first.checksumSha256);
      assert.deepEqual(await bytesOnDisk(second), stripped);
    });
  },
);
