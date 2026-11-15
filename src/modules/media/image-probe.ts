import { MEDIA_CONTENT_TYPES, type MediaContentType } from './media.constants';

export interface ImageProbe {
  contentType: MediaContentType;
  width: number | null;
  height: number | null;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Identify an image from its magic bytes and read its dimensions from the
 * header, without decoding pixel data and without an image library.
 *
 * The client-declared content type is never trusted on its own: a request that
 * claims `image/png` but carries a JPEG (or an HTML document) is rejected by
 * comparing this probe against the declared type. Dimensions are best-effort -
 * an unusual but valid header yields `null` rather than a rejection, because
 * the size is metadata for the client, not a safety property.
 *
 * Returns null when the bytes are not one of the accepted formats.
 */
export function probeImage(buffer: Buffer): ImageProbe | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    // IHDR is required to be the first chunk: length(4) type(4) then
    // width(4) height(4), both big-endian.
    if (buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return dimensions('image/png', width, height);
    }
    return dimensions('image/png', null, null);
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    const size = jpegDimensions(buffer);
    return dimensions('image/jpeg', size?.width ?? null, size?.height ?? null);
  }

  if (
    buffer.length >= 16 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const size = webpDimensions(buffer);
    return dimensions('image/webp', size?.width ?? null, size?.height ?? null);
  }

  return null;
}

function dimensions(
  contentType: MediaContentType,
  width: number | null,
  height: number | null,
): ImageProbe {
  const valid = width !== null && height !== null && width > 0 && height > 0;
  return {
    contentType,
    width: valid ? width : null,
    height: valid ? height : null,
  };
}

/**
 * Walk the JPEG marker chain to the first Start-Of-Frame segment, which is the
 * only place the frame size is recorded. Standalone markers carry no length
 * field, so they advance by two bytes instead of by their declared length.
 */
function jpegDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    // Fill bytes: a run of 0xFF is legal padding before the real marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers (TEM, RSTn) have no payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 && // DHT
      marker !== 0xc8 && // JPG extension
      marker !== 0xcc; // DAC
    if (isStartOfFrame) {
      if (offset + 9 > buffer.length) return null;
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

/** Read the canvas size from a WebP container (VP8, VP8L or VP8X). */
function webpDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    // 4-byte size, 1 flags byte, 3 reserved, then width-1 / height-1 as
    // 24-bit little-endian values.
    if (buffer.length < 30) return null;
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
    };
  }
  if (chunk === 'VP8 ') {
    // Frame tag (3) then the 0x9d 0x01 0x2a keyframe signature at offset 23.
    if (
      buffer.length < 30 ||
      buffer[23] !== 0x9d ||
      buffer[24] !== 0x01 ||
      buffer[25] !== 0x2a
    )
      return null;
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (buffer.length < 25 || buffer[20] !== 0x2f) return null;
    const b1 = buffer[21];
    const b2 = buffer[22];
    const b3 = buffer[23];
    const b4 = buffer[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6)),
    };
  }
  return null;
}

/** True when the declared type is one this module can store and serve. */
export function isSupportedContentType(
  value: string,
): value is MediaContentType {
  return (MEDIA_CONTENT_TYPES as readonly string[]).includes(value);
}
