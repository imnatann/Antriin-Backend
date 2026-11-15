import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { probeImage } from '../src/modules/media/image-probe';
import { stripImageMetadata } from '../src/modules/media/metadata-strip';

/**
 * These fixtures are real containers, not markers in a mock: a PNG with valid
 * chunk CRCs, a JPEG with a full marker chain and scan data, a WebP with a RIFF
 * chunk list. The stripper is judged on two things at once - the metadata must
 * be gone, and the file that remains must still be the same readable image.
 */

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/* -------------------------------------------------------------------------- */
/* PNG                                                                        */
/* -------------------------------------------------------------------------- */

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** CRC-32 of a PNG chunk (type + data), table-driven. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return chunk;
}

const PNG_IDAT = Buffer.from([
  0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
]);

function pngIhdr(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return ihdr;
}

/** PNG with a camera-style metadata set around its pixel data. */
function pngWithMetadata(width = 40, height = 30): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', pngIhdr(width, height)),
    pngChunk('tEXt', Buffer.from('Author\0Dewi Photographer', 'latin1')),
    pngChunk(
      'zTXt',
      Buffer.concat([
        Buffer.from('Comment\0', 'latin1'),
        Buffer.from([0x00]),
        Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
      ]),
    ),
    pngChunk(
      'iTXt',
      Buffer.from(
        'XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>GPSLatitude</x:xmpmeta>',
        'latin1',
      ),
    ),
    pngChunk(
      'eXIf',
      Buffer.from(
        'II*\0\x08\0\0\0iPhone 15 Pro\0GPSLatitude -6.21462\0',
        'latin1',
      ),
    ),
    pngChunk('IDAT', PNG_IDAT),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Every chunk of a PNG (raw bytes, header included), in file order. */
function pngChunks(buffer: Buffer): { type: string; raw: Buffer }[] {
  const chunks: { type: string; raw: Buffer }[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) break;
    chunks.push({ type, raw: buffer.subarray(offset, end) });
    offset = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** True when `needle` appears anywhere in `haystack`. */
const contains = (haystack: Buffer, needle: string): boolean =>
  haystack.includes(Buffer.from(needle, 'latin1'));

/* -------------------------------------------------------------------------- */
/* JPEG                                                                       */
/* -------------------------------------------------------------------------- */

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

/** Baseline JPEG whose marker chain carries EXIF, ICC, IPTC and a comment. */
function jpegWithMetadata(width = 640, height = 480): Buffer {
  const app0 = jpegSegment(
    0xe0,
    Buffer.concat([
      Buffer.from('JFIF\0', 'latin1'),
      Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    ]),
  );
  const app1 = jpegSegment(
    0xe1,
    Buffer.concat([
      Buffer.from('Exif\0\0', 'latin1'),
      Buffer.from('II*\0\x08\0\0\0', 'latin1'),
      Buffer.from('iPhone 15 Pro\0', 'latin1'),
      Buffer.from('2026:01:02 03:04:05\0', 'latin1'),
      Buffer.from('GPSLatitude=-6.21462,GPSLongitude=106.84513', 'latin1'),
    ]),
  );
  const app2 = jpegSegment(
    0xe2,
    Buffer.concat([
      Buffer.from('ICC_PROFILE\0', 'latin1'),
      Buffer.from([0x01, 0x01, 0x02, 0x0a, 0x00, 0x00]),
    ]),
  );
  const app13 = jpegSegment(
    0xed,
    Buffer.concat([
      Buffer.from('Photoshop 3.0', 'latin1'),
      Buffer.from([0x00]),
      Buffer.from('8BIMIPTCDigest', 'latin1'),
      Buffer.from([0x00]),
      Buffer.from('Antriin stall photo', 'latin1'),
    ]),
  );
  const comment = jpegSegment(
    0xfe,
    Buffer.from('shot at -6.21462, 106.84513', 'latin1'),
  );

  const sof = Buffer.alloc(15);
  sof[0] = 8; // sample precision
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3; // components
  sof[6] = 1;
  sof[7] = 0x11;
  sof[8] = 0;
  sof[9] = 2;
  sof[10] = 0x11;
  sof[11] = 1;
  sof[12] = 3;
  sof[13] = 0x11;
  sof[14] = 1;

  const sos = jpegSegment(
    0xda,
    Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]),
  );
  // Scan data, including a byte pair that looks like an APP1 marker. A correct
  // stripper stops walking at SOS, so this must survive untouched.
  const scan = Buffer.from([
    0x12, 0x34, 0x56, 0xff, 0xe1, 0x00, 0x10, 0x9a, 0xbc,
  ]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    app1,
    app2,
    app13,
    comment,
    jpegSegment(0xc0, sof),
    sos,
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** Baseline JPEG with no metadata at all, only JPEG required segments. */
function plainJpeg(width = 8, height = 8): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1;
  sof[6] = 1;
  sof[7] = 0x11;
  sof[8] = 0;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xc0, sof),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/* -------------------------------------------------------------------------- */
/* WebP                                                                       */
/* -------------------------------------------------------------------------- */

function webpChunk(fourcc: string, payload: Buffer): Buffer {
  const pad = payload.length & 1 ? 1 : 0;
  const chunk = Buffer.alloc(8 + payload.length + pad);
  chunk.write(fourcc, 0, 'ascii');
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function riff(body: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

/** Extended WebP: VP8X canvas header, one image chunk, then EXIF and XMP. */
function webpWithMetadata(width = 800, height = 600): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x20 | 0x08 | 0x04; // ICC profile, EXIF and XMP all advertised
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);

  const image = webpChunk(
    'VP8L',
    Buffer.from([0x2f, 0x7f, 0x1f, 0x00, 0x00, 0xaa, 0xbb]),
  );
  const exif = webpChunk(
    'EXIF',
    Buffer.from('Exif\0\0iPhone 15 Pro\0GPSLatitude -6.21462', 'latin1'),
  );
  const xmp = webpChunk(
    'XMP ',
    Buffer.from(
      '<x:xmpmeta>creator=Dewi;GPSLatitude=-6.21462</x:xmpmeta>',
      'latin1',
    ),
  );

  return riff(Buffer.concat([webpChunk('VP8X', vp8x), image, exif, xmp]));
}

/** Lossy WebP without any optional chunk. */
function plainWebp(): Buffer {
  return riff(
    webpChunk(
      'VP8 ',
      Buffer.from([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00]),
    ),
  );
}

/** FourCCs present in a RIFF/WEBP file, in order. */
function webpFourccs(buffer: Buffer): string[] {
  const found: string[] = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const fourcc = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    found.push(fourcc);
    offset += 8 + size + (size & 1);
  }
  return found;
}

function webpChunkRaw(buffer: Buffer, fourcc: string): Buffer | null {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size & 1);
    if (type === fourcc) return buffer.subarray(offset, end);
    offset = end;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('stripImageMetadata - PNG', () => {
  it('drops text and EXIF chunks while keeping the pixel-critical chunks', () => {
    const original = pngWithMetadata(40, 30);
    assert.deepEqual(
      pngChunks(original).map((chunk) => chunk.type),
      ['IHDR', 'tEXt', 'zTXt', 'iTXt', 'eXIf', 'IDAT', 'IEND'],
    );

    const result = stripImageMetadata(original);

    assert.equal(result.stripped, true);
    assert.deepEqual(result.removed, ['tEXt', 'zTXt', 'iTXt', 'eXIf']);
    assert.deepEqual(
      pngChunks(result.buffer).map((chunk) => chunk.type),
      ['IHDR', 'IDAT', 'IEND'],
    );

    // The payload really is gone, not just renamed.
    for (const secret of [
      'Dewi Photographer',
      'GPSLatitude',
      'iPhone 15 Pro',
      'xmpmeta',
    ]) {
      assert.equal(contains(original, secret), true, secret + ' in original');
      assert.equal(
        contains(result.buffer, secret),
        false,
        secret + ' stripped',
      );
    }

    // Kept chunks are byte-identical, CRCs included.
    const before = new Map(pngChunks(original).map((c) => [c.type, c.raw]));
    for (const chunk of pngChunks(result.buffer)) {
      assert.deepEqual(chunk.raw, before.get(chunk.type));
    }

    // Still a PNG of the same size, per the module's own probe.
    assert.deepEqual(probeImage(result.buffer), {
      contentType: 'image/png',
      width: 40,
      height: 30,
    });
    assert.equal(result.buffer.subarray(0, 8).equals(PNG_SIGNATURE), true);
    assert.equal(result.buffer.length < original.length, true);
    assert.notEqual(sha256(result.buffer), sha256(original));
  });

  it('leaves a PNG without metadata byte-identical', () => {
    const plain = Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', pngIhdr(4, 4)),
      pngChunk('IDAT', PNG_IDAT),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const result = stripImageMetadata(plain);
    assert.equal(result.stripped, false);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.buffer, plain);
    assert.deepEqual(probeImage(result.buffer), {
      contentType: 'image/png',
      width: 4,
      height: 4,
    });
  });

  it('leaves a file alone when a chunk length cannot be trusted', () => {
    const original = pngWithMetadata(4, 4);
    const broken = Buffer.from(original);
    // IHDR claims a chunk that runs past the end of the file, so the walk stops
    // immediately. Guessing which bytes are metadata from here could cut pixels,
    // so the file is returned untouched and `stripped` says so.
    broken.writeUInt32BE(0x7fffffff, 8);
    const result = stripImageMetadata(broken);
    assert.equal(result.stripped, false);
    assert.deepEqual(result.buffer, broken);
    assert.deepEqual(result.removed, []);
    assert.equal(contains(result.buffer, 'Dewi Photographer'), true);
  });
});

describe('stripImageMetadata - JPEG', () => {
  it('drops APP1, APP13 and COM but keeps JFIF, ICC and the scan data', () => {
    const original = jpegWithMetadata(640, 480);
    const result = stripImageMetadata(original);

    assert.equal(result.stripped, true);
    assert.deepEqual(result.removed, ['APP1', 'APP13', 'COM']);

    for (const secret of [
      'Exif\0\0',
      'iPhone 15 Pro',
      '2026:01:02 03:04:05',
      '-6.21462',
      'Photoshop 3.0',
      'stall photo',
    ]) {
      assert.equal(contains(original, secret), true, secret + ' in original');
      assert.equal(
        contains(result.buffer, secret),
        false,
        secret + ' stripped',
      );
    }

    // Colour profile and JFIF density are not personal data and stay.
    assert.equal(contains(result.buffer, 'JFIF'), true);
    assert.equal(contains(result.buffer, 'ICC_PROFILE'), true);

    // Structure: SOI ... EOI, and the whole tail from SOS is byte-identical.
    assert.deepEqual(result.buffer.subarray(0, 2), Buffer.from([0xff, 0xd8]));
    assert.deepEqual(
      result.buffer.subarray(result.buffer.length - 2),
      Buffer.from([0xff, 0xd9]),
    );
    const sosOffset = original.indexOf(Buffer.from([0xff, 0xda]));
    const tail = original.subarray(sosOffset);
    assert.deepEqual(
      result.buffer.subarray(result.buffer.length - tail.length),
      tail,
    );
    // ...including the APP1-looking bytes inside the compressed data, which a
    // naive rescan of the whole file would have eaten.
    assert.equal(
      result.buffer.includes(Buffer.from([0xff, 0xe1, 0x00, 0x10])),
      true,
    );

    assert.deepEqual(probeImage(result.buffer), {
      contentType: 'image/jpeg',
      width: 640,
      height: 480,
    });
    assert.equal(result.buffer.length < original.length, true);
    assert.notEqual(sha256(result.buffer), sha256(original));
  });

  it('leaves a JPEG without metadata byte-identical', () => {
    const plain = plainJpeg(8, 8);
    const result = stripImageMetadata(plain);
    assert.equal(result.stripped, false);
    assert.deepEqual(result.buffer, plain);
    assert.deepEqual(probeImage(result.buffer), {
      contentType: 'image/jpeg',
      width: 8,
      height: 8,
    });
  });

  it('keeps a truncated marker chain rather than throwing', () => {
    const original = jpegWithMetadata(64, 32);
    // Cut in the middle of the APP13 payload: the walk cannot finish, so the
    // rest of the bytes must be preserved instead of guessed at.
    const truncated = original.subarray(
      0,
      original.indexOf(Buffer.from('Photoshop')) + 5,
    );
    const result = stripImageMetadata(truncated);
    assert.equal(result.stripped, true); // the APP1 before it still went
    assert.equal(result.buffer[0], 0xff);
    assert.equal(result.buffer[1], 0xd8);
    assert.equal(contains(result.buffer, 'Exif'), false);
    // The segment the walk could not finish was not silently cut away.
    assert.equal(contains(result.buffer, 'Photo'), true);
  });
});

describe('stripImageMetadata - WebP', () => {
  it('drops EXIF and XMP, clears their VP8X flags and fixes the RIFF size', () => {
    const original = webpWithMetadata(800, 600);
    assert.deepEqual(webpFourccs(original), ['VP8X', 'VP8L', 'EXIF', 'XMP ']);

    const result = stripImageMetadata(original);

    assert.equal(result.stripped, true);
    assert.deepEqual(result.removed, ['EXIF', 'XMP ']);
    assert.deepEqual(webpFourccs(result.buffer), ['VP8X', 'VP8L']);

    for (const secret of [
      'iPhone 15 Pro',
      'GPSLatitude',
      'xmpmeta',
      'creator=Dewi',
    ]) {
      assert.equal(contains(original, secret), true, secret + ' in original');
      assert.equal(
        contains(result.buffer, secret),
        false,
        secret + ' stripped',
      );
    }

    // RIFF size counts everything after the size field.
    assert.equal(result.buffer.readUInt32LE(4), result.buffer.length - 8);
    assert.equal(result.buffer.toString('ascii', 0, 4), 'RIFF');
    assert.equal(result.buffer.toString('ascii', 8, 12), 'WEBP');

    // VP8X still advertises ICC but no longer EXIF/XMP, or a decoder would look
    // for chunks that are gone.
    const vp8x = webpChunkRaw(result.buffer, 'VP8X')!;
    assert.equal(vp8x[8], 0x20);
    // The image chunk survives byte-for-byte.
    assert.deepEqual(
      webpChunkRaw(result.buffer, 'VP8L'),
      webpChunkRaw(original, 'VP8L'),
    );

    assert.deepEqual(probeImage(result.buffer), {
      contentType: 'image/webp',
      width: 800,
      height: 600,
    });
    assert.notEqual(sha256(result.buffer), sha256(original));
  });

  it('leaves a WebP without metadata byte-identical', () => {
    const plain = plainWebp();
    const result = stripImageMetadata(plain);
    assert.equal(result.stripped, false);
    assert.deepEqual(result.buffer, plain);
  });

  it('keeps an odd-length image chunk and its pad byte intact', () => {
    // VP8L payload is 7 bytes, so the chunk carries one pad byte before EXIF;
    // a walk that forgets the pad would misread the next fourcc.
    const original = webpWithMetadata(10, 10);
    const result = stripImageMetadata(original);
    assert.deepEqual(webpFourccs(result.buffer), ['VP8X', 'VP8L']);
    assert.deepEqual(probeImage(result.buffer), {
      contentType: 'image/webp',
      width: 10,
      height: 10,
    });
  });
});

describe('stripImageMetadata - boundaries', () => {
  it('returns unknown content untouched', () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'),
      Buffer.from('<!doctype html><script>alert(1)</script>', 'latin1'),
      Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1'),
    ]) {
      const result = stripImageMetadata(bytes);
      assert.equal(result.stripped, false);
      assert.deepEqual(result.buffer, bytes);
      assert.deepEqual(result.removed, []);
    }
  });

  it('is idempotent: stripping stripped bytes changes nothing', () => {
    for (const bytes of [
      pngWithMetadata(),
      jpegWithMetadata(),
      webpWithMetadata(),
    ]) {
      const once = stripImageMetadata(bytes);
      const twice = stripImageMetadata(once.buffer);
      assert.equal(twice.stripped, false);
      assert.deepEqual(twice.buffer, once.buffer);
    }
  });
});
