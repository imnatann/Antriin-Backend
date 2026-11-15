import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeImage } from '../src/modules/media/image-probe';

/** Minimal PNG: signature + IHDR, which is all the header reader needs. */
function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8; // bit depth
  buffer[25] = 6; // colour type
  return buffer;
}

/**
 * Minimal baseline JPEG: SOI, an APP0 segment, then SOF0 carrying the frame
 * size. The marker chain is the point - the size is never at a fixed offset.
 */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(18);
  app0[0] = 0xff;
  app0[1] = 0xe0;
  app0.writeUInt16BE(16, 2); // length includes the two length bytes
  app0.write('JFIF', 4, 'ascii');
  app0[8] = 1;
  app0[9] = 1;
  app0[10] = 0;
  app0.writeUInt16BE(1, 11);
  app0.writeUInt16BE(1, 13);

  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // components
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

/** Extended WebP: canvas size lives in the VP8X chunk as width-1/height-1. */
function webpVp8x(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(22, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

/** Lossless WebP: size is bit-packed across the first four VP8L bytes. */
function webpVp8l(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(25);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(17, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8L', 12, 'ascii');
  buffer.writeUInt32LE(5, 16);
  buffer[20] = 0x2f;
  const w = width - 1;
  const h = height - 1;
  buffer[21] = w & 0xff;
  buffer[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  buffer[23] = (h >> 2) & 0xff;
  buffer[24] = (h >> 10) & 0x0f;
  return buffer;
}

describe('probeImage', () => {
  it('reads PNG dimensions from IHDR', () => {
    assert.deepEqual(probeImage(png(1920, 1080)), {
      contentType: 'image/png',
      width: 1920,
      height: 1080,
    });
  });

  it('walks the JPEG marker chain to the frame header', () => {
    assert.deepEqual(probeImage(jpeg(640, 480)), {
      contentType: 'image/jpeg',
      width: 640,
      height: 480,
    });
  });

  it('reads the VP8X canvas size of an extended WebP', () => {
    assert.deepEqual(probeImage(webpVp8x(800, 600)), {
      contentType: 'image/webp',
      width: 800,
      height: 600,
    });
  });

  it('reads the bit-packed size of a lossless WebP', () => {
    assert.deepEqual(probeImage(webpVp8l(5, 3)), {
      contentType: 'image/webp',
      width: 5,
      height: 3,
    });
  });

  it('identifies the format even when the header is too short for a size', () => {
    // Only the signature survives: the type is known, the size is not invented.
    const truncated = png(1, 1).subarray(0, 20);
    assert.deepEqual(probeImage(truncated), {
      contentType: 'image/png',
      width: null,
      height: null,
    });
  });

  it('returns null for content that is not an accepted image', () => {
    assert.equal(
      probeImage(Buffer.from('<!doctype html><script>x</script>')),
      null,
    );
    assert.equal(
      probeImage(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])),
      null,
    ); // GIF
    assert.equal(probeImage(Buffer.alloc(0)), null);
  });

  it('does not read a size from a corrupt JPEG segment length', () => {
    const broken = jpeg(10, 10);
    broken.writeUInt16BE(0, 4); // zero-length APP0: invalid, must not loop forever
    assert.deepEqual(probeImage(broken), {
      contentType: 'image/jpeg',
      width: null,
      height: null,
    });
  });
});
