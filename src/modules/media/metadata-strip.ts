/**
 * Removal of embedded metadata (EXIF, XMP, IPTC, comments) from an uploaded
 * image, in pure TypeScript over the container bytes.
 *
 * Why this exists: a phone photo carries GPS coordinates, the device model and
 * the capture time in its EXIF block. Storing those bytes verbatim publishes the
 * photographer's location to every buyer who loads the menu picture, and the
 * uploader never agreed to that. The container formats put that data in clearly
 * delimited segments, so it can be dropped without decoding a single pixel -
 * no image library, no native dependency.
 *
 * What is removed:
 *   JPEG - APP1 (EXIF and XMP), APP13 (Photoshop/IPTC) and COM (free-text
 *          comment) segments.
 *   PNG  - tEXt, zTXt, iTXt and eXIf chunks.
 *   WebP - EXIF and XMP chunks, with the VP8X header flags for them cleared.
 *
 * What is deliberately kept:
 *   - JPEG APP0 (JFIF): density and aspect ratio live there, no personal data.
 *   - JPEG APP2 (ICC profile): colour management, not identity. Dropping it
 *     would visibly change how the image renders on a colour-managed display,
 *     which is a worse trade than keeping a profile that says nothing about the
 *     photographer. It is metadata in the container sense, not private data.
 *   - PNG iCCP, gAMA, cHRM, sRGB, pHYs, PLTE, tRNS and any chunk this file does
 *     not recognise: decoders need them, and none of them is personal data.
 *
 * The rebuild keeps the image data byte-for-byte (JPEG scan data and PNG IDAT
 * chunks are copied unchanged); tests re-run `probeImage` on the result to prove
 * the file is still a readable image of the same format and size.
 */

export interface MetadataStripResult {
  /** Bytes to store. The same Buffer instance when nothing was removed. */
  buffer: Buffer;
  /** True when at least one metadata segment or chunk was dropped. */
  stripped: boolean;
  /** Container labels that were dropped, in file order (APP1, tEXt, EXIF...). */
  removed: string[];
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Remove embedded metadata from a supported image.
 *
 * Content that is not one of the three accepted formats, or a container whose
 * chunk walk cannot be trusted, is returned untouched: an unparsed header is
 * not proof that the remaining bytes are metadata, and a stripper that guesses
 * can silently destroy image data.
 */
export function stripImageMetadata(buffer: Buffer): MetadataStripResult {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return stripPng(buffer);
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return stripJpeg(buffer);
  }
  if (
    buffer.length >= 16 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return stripWebp(buffer);
  }
  return { buffer, stripped: false, removed: [] };
}

/* -------------------------------------------------------------------------- */
/* JPEG                                                                       */
/* -------------------------------------------------------------------------- */

const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;

/**
 * Marker chain walk, the same shape as `image-probe.ts` uses to find the frame
 * header: every marker segment carries its own length, except the standalone
 * TEM/RSTn markers, and the scan data that follows SOS is entropy-coded and
 * must never be searched for markers.
 */
function stripJpeg(buffer: Buffer): MetadataStripResult {
  const kept: Buffer[] = [buffer.subarray(0, 2)]; // SOI
  const removed: string[] = [];
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break; // no marker where one must be: corrupt
    const next = offset + 1 < buffer.length ? buffer[offset + 1] : null;
    if (next === null) break; // dangling 0xFF at the end
    if (next === 0xff) {
      // Fill byte: legal padding before the real marker, kept verbatim so the
      // rebuilt chain stays aligned with what the encoder produced.
      kept.push(buffer.subarray(offset, offset + 1));
      offset += 1;
      continue;
    }
    if (next === 0x01 || (next >= 0xd0 && next <= 0xd7)) {
      kept.push(buffer.subarray(offset, offset + 2)); // standalone marker
      offset += 2;
      continue;
    }
    if (next === JPEG_EOI) {
      kept.push(buffer.subarray(offset)); // EOI plus any trailing bytes
      offset = buffer.length;
      break;
    }
    if (offset + 4 > buffer.length) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    const end = offset + 2 + length;
    if (end > buffer.length) break;
    const label = jpegRemovedLabel(next);
    if (label === null) kept.push(buffer.subarray(offset, end));
    else removed.push(label);
    offset = end;
    if (next === JPEG_SOS) {
      // Everything from here is compressed image data up to EOI. Copying it in
      // one slice is what keeps the picture bit-identical.
      kept.push(buffer.subarray(offset));
      offset = buffer.length;
      break;
    }
  }

  if (offset < buffer.length) {
    // The walk stopped on something it could not parse (a truncated or
    // impossible segment). Keep the remainder rather than risk cutting image
    // data, and let the caller see that the file was not fully understood.
    kept.push(buffer.subarray(offset));
  }
  if (removed.length === 0) return { buffer, stripped: false, removed: [] };
  return { buffer: Buffer.concat(kept), stripped: true, removed };
}

/** Label of a JPEG segment that must be dropped, or null to keep it. */
function jpegRemovedLabel(marker: number): string | null {
  if (marker === 0xe1) return 'APP1'; // EXIF and XMP
  if (marker === 0xed) return 'APP13'; // Photoshop IRB / IPTC captions
  if (marker === 0xfe) return 'COM'; // free-text comment
  return null;
}

/* -------------------------------------------------------------------------- */
/* PNG                                                                        */
/* -------------------------------------------------------------------------- */

const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf']);

/**
 * Ancillary chunk walk. PNG chunks are length-prefixed and carry no padding,
 * so dropping one is a matter of not copying its bytes; the CRC of every kept
 * chunk stays valid because the chunk body is copied unchanged.
 */
function stripPng(buffer: Buffer): MetadataStripResult {
  const kept: Buffer[] = [buffer.subarray(0, 8)]; // signature
  const removed: string[] = [];
  let offset = 8;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    // 2^31-1 is the format's own maximum; a longer chunk cannot fit any file.
    if (length > 0x7fffffff || offset + 12 + length > buffer.length) break;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (PNG_METADATA_CHUNKS.has(type)) removed.push(type);
    else kept.push(buffer.subarray(offset, end));
    offset = end;
    if (type === 'IEND') break;
  }

  if (offset < buffer.length) {
    // A truncated chunk or bytes after IEND. Copy them verbatim: they cannot be
    // identified as metadata, and dropping unknown bytes could remove pixels.
    kept.push(buffer.subarray(offset));
  }
  if (removed.length === 0) return { buffer, stripped: false, removed: [] };
  return { buffer: Buffer.concat(kept), stripped: true, removed };
}

/* -------------------------------------------------------------------------- */
/* WebP                                                                       */
/* -------------------------------------------------------------------------- */

const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);
// VP8X flag bits, from the RIFF container specification.
const WEBP_VP8X_EXIF_FLAG = 0x08;
const WEBP_VP8X_XMP_FLAG = 0x04;

interface WebpChunk {
  start: number;
  end: number;
  fourcc: string;
}

/**
 * RIFF chunk walk. Two details matter beyond dropping the chunks:
 * every chunk is padded to an even length, so the pad byte belongs to the chunk
 * being skipped; and the VP8X header advertises which optional chunks follow -
 * leaving the EXIF/XMP bits set after the chunks are gone would tell a decoder
 * to look for data that is not there.
 */
function stripWebp(buffer: Buffer): MetadataStripResult {
  const declared = buffer.readUInt32LE(4);
  // The RIFF size field is the container's own authority; bytes past it are not
  // part of the file. A truncated file falls back to what is actually present.
  const riffEnd = 8 + declared <= buffer.length ? 8 + declared : buffer.length;

  const chunks: WebpChunk[] = [];
  const removed: string[] = [];
  let offset = 12;

  while (offset + 8 <= riffEnd) {
    const fourcc = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const payloadEnd = offset + 8 + size;
    if (payloadEnd > riffEnd) break;
    const end = Math.min(payloadEnd + (size & 1), riffEnd);
    if (WEBP_METADATA_CHUNKS.has(fourcc)) removed.push(fourcc);
    else chunks.push({ start: offset, end, fourcc });
    offset = end;
  }

  if (removed.length === 0) return { buffer, stripped: false, removed: [] };

  const clearFlags =
    (removed.includes('EXIF') ? WEBP_VP8X_EXIF_FLAG : 0) |
    (removed.includes('XMP ') ? WEBP_VP8X_XMP_FLAG : 0);

  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const slice = buffer.subarray(chunk.start, chunk.end);
    // slice[0..4) is the fourcc, [4..8) the size, [8] the first payload byte.
    if (chunk.fourcc === 'VP8X' && slice.length >= 9) {
      const patched = Buffer.from(slice);
      patched[8] &= ~clearFlags;
      parts.push(patched);
    } else {
      parts.push(slice);
    }
  }
  // A chunk that did not parse cleanly is kept as-is: the RIFF walk cannot tell
  // whether its bytes contain image data.
  if (offset < riffEnd) parts.push(buffer.subarray(offset, riffEnd));
  const body = Buffer.concat(parts);

  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  // RIFF size counts everything after the size field: 'WEBP' plus the chunks.
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');

  return {
    buffer: Buffer.concat([header, body]),
    stripped: true,
    removed,
  };
}
