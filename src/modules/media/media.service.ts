import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { DatabaseService } from '../../database/database.service';
import {
  MEDIA_CONTENT_TYPES,
  MEDIA_EXTENSIONS,
  MEDIA_PURPOSES,
  type MediaContentType,
  type MediaPurpose,
} from './media.constants';
import { isSupportedContentType, probeImage } from './image-probe';

/** Microsecond ISO string, produced by PostgreSQL (convention D7). */
const ISO = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface StoredMediaAsset {
  id: string;
  purpose: string;
  storageKey: string;
  contentType: MediaContentType;
  byteSize: number;
  checksumSha256: string;
  originalFilename: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UploadMediaInput {
  buffer: Buffer;
  declaredContentType: string;
  filename: string;
}

interface MediaRow {
  id: string;
  purpose: string;
  storage_key: string;
  content_type: MediaContentType;
  byte_size: number;
  checksum_sha256: string;
  original_filename: string;
  width: number | null;
  height: number | null;
  created_at_iso: string;
  updated_at_iso: string;
}

const COLUMNS = `
  id, purpose, storage_key, content_type, byte_size, checksum_sha256,
  original_filename, width, height,
  ${ISO.replace('%s', 'created_at')} AS created_at_iso,
  ${ISO.replace('%s', 'updated_at')} AS updated_at_iso`;

/**
 * Local-disk image storage.
 *
 * Bytes are written under MEDIA_ROOT with a server-generated key; the database
 * row is the only thing that makes a file reachable, so an unregistered or
 * soft-deleted file is invisible even though it is still on disk. Uploads are
 * validated by sniffing the file header - the client's declared content type is
 * cross-checked, never trusted alone.
 *
 * This is the pilot storage option: it is single-host and does not survive a
 * container rebuild. docs/modules/media.md records what has to change before
 * multi-instance deployment.
 */
@Injectable()
export class MediaService implements OnModuleInit {
  private readonly root: string;
  private readonly maxBytes: number;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService,
  ) {
    this.root = resolve(config.getOrThrow<string>('MEDIA_ROOT'));
    this.maxBytes = config.getOrThrow<number>('MEDIA_MAX_BYTES');
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** Advertised upload limits, so a client can check a file before sending it. */
  get limits() {
    return {
      maxBytes: this.maxBytes,
      contentTypes: [...MEDIA_CONTENT_TYPES],
      purposes: [...MEDIA_PURPOSES],
    };
  }

  async create(
    userId: string,
    purpose: MediaPurpose,
    input: UploadMediaInput,
  ): Promise<StoredMediaAsset> {
    if (input.buffer.length === 0) {
      throw new BadRequestException({
        code: 'MEDIA_EMPTY_FILE',
        message: 'The uploaded file is empty',
      });
    }
    if (input.buffer.length > this.maxBytes) {
      throw new PayloadTooLargeException({
        code: 'MEDIA_FILE_TOO_LARGE',
        message: `The uploaded file exceeds the ${this.maxBytes} byte limit`,
      });
    }

    const declared = input.declaredContentType
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!isSupportedContentType(declared)) {
      throw new UnsupportedMediaTypeException({
        code: 'MEDIA_TYPE_NOT_ALLOWED',
        message: `Only ${MEDIA_CONTENT_TYPES.join(', ')} are accepted`,
      });
    }

    const probe = probeImage(input.buffer);
    if (!probe) {
      throw new UnsupportedMediaTypeException({
        code: 'MEDIA_CONTENT_UNRECOGNISED',
        message: 'The file content is not a recognised image',
      });
    }
    if (probe.contentType !== declared) {
      throw new UnsupportedMediaTypeException({
        code: 'MEDIA_TYPE_MISMATCH',
        message: `The file content is ${probe.contentType}, not the declared ${declared}`,
      });
    }

    const storageKey = this.newStorageKey(probe.contentType);
    const absolutePath = this.resolvePath(storageKey);
    const checksum = createHash('sha256').update(input.buffer).digest('hex');
    const filename = input.filename.slice(0, 255);

    await mkdir(dirname(absolutePath), { recursive: true });
    // Write then rename: a partially written file never appears under the key
    // the database will point at.
    const temporary = `${absolutePath}.${randomUUID()}.part`;
    await writeFile(temporary, input.buffer, { mode: 0o640 });
    try {
      await rename(temporary, absolutePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }

    const client = await this.database.pool.connect();
    try {
      const result = await client.query<MediaRow>(
        `INSERT INTO media_assets
           (owner_user_id, purpose, storage_key, content_type, byte_size,
            checksum_sha256, original_filename, width, height)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING ${COLUMNS}`,
        [
          userId,
          purpose,
          storageKey,
          probe.contentType,
          input.buffer.length,
          checksum,
          filename,
          probe.width,
          probe.height,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('media_assets insert returned no row');
      return this.render(row);
    } catch (error) {
      // The row is the only thing that makes the file reachable, so an insert
      // that did not commit must not leave an orphan behind.
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Look up a reachable asset; soft-deleted rows are treated as absent. */
  async findById(id: string): Promise<StoredMediaAsset | null> {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query<MediaRow>(
        `SELECT ${COLUMNS} FROM media_assets
         WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      const row = result.rows[0];
      return row ? this.render(row) : null;
    } finally {
      client.release();
    }
  }

  /**
   * Soft delete. The row becomes a tombstone and GET stops serving it; the file
   * stays on disk for an operator-driven cleanup pass.
   *
   * Another user's asset reports 404 rather than 403 so the endpoint cannot be
   * used to probe for the existence of someone else's uploads.
   */
  async remove(userId: string, id: string): Promise<void> {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(
        `UPDATE media_assets
         SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [id, userId],
      );
      if (result.rowCount === 0) throw this.notFound();
    } finally {
      client.release();
    }
  }

  /** Absolute path for a stored key, refusing anything outside MEDIA_ROOT. */
  resolvePath(storageKey: string): string {
    const absolute = resolve(this.root, storageKey);
    if (!absolute.startsWith(`${this.root}${sep}`)) {
      throw new Error('storage key escapes the media root');
    }
    return absolute;
  }

  /** True when the bytes are still on disk (a row can outlive its file). */
  async exists(asset: StoredMediaAsset): Promise<boolean> {
    try {
      const info = await stat(this.resolvePath(asset.storageKey));
      return info.isFile();
    } catch {
      return false;
    }
  }

  notFound(): NotFoundException {
    return new NotFoundException({
      code: 'MEDIA_NOT_FOUND',
      message: 'Media not found',
    });
  }

  /**
   * Keys are server-generated: `YYYY/MM/<uuid>.<ext>`. A client never supplies
   * any part of the path, so it cannot traverse the root or collide with
   * another owner's file.
   */
  private newStorageKey(contentType: MediaContentType): string {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${year}/${month}/${randomUUID()}.${MEDIA_EXTENSIONS[contentType]}`;
  }

  private render(row: MediaRow): StoredMediaAsset {
    return {
      id: row.id,
      purpose: row.purpose,
      storageKey: row.storage_key,
      contentType: row.content_type,
      byteSize: row.byte_size,
      checksumSha256: row.checksum_sha256,
      originalFilename: row.original_filename,
      width: row.width,
      height: row.height,
      createdAt: row.created_at_iso,
      updatedAt: row.updated_at_iso,
    };
  }
}
