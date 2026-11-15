import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DatabaseService } from '../database/database.service';
import {
  MEDIA_TOMBSTONE_BATCH_SIZE,
  MEDIA_TOMBSTONE_MAX_BATCHES,
  MEDIA_TOMBSTONE_RETENTION_DAYS,
  SWEEP_MEDIA_TOMBSTONES_JOB,
} from './maintenance-jobs.constants';

export type MediaTombstoneSweepSummary = {
  job: typeof SWEEP_MEDIA_TOMBSTONES_JOB;
  scanned: number;
  /** Tombstone rows deleted after their files were removed. */
  purged: number;
  filesDeleted: number;
  /** Keys whose bytes were already gone; the row is still purged. */
  filesMissing: number;
  /** Rows left in place because a key escapes MEDIA_ROOT. */
  skippedUnsafePaths: number;
  /** Rows left in place because a file could not be removed; retried next run. */
  failed: number;
  capped: boolean;
};

type TombstoneRow = {
  id: string;
  storage_key: string;
  thumbnail_key: string | null;
};

/**
 * Removes media tombstones older than MEDIA_TOMBSTONE_RETENTION_DAYS.
 *
 * The media slice deliberately keeps a soft-deleted row and its bytes as
 * operator evidence (src/modules/media/media.service.ts). This job is that
 * cleanup: it deletes the files first and the row only afterwards, so a row can
 * never outlive its bytes silently. A file that cannot be removed keeps the
 * row (and is counted as failed) so the next pass retries instead of leaving an
 * untracked orphan.
 *
 * The path is resolved exactly like MediaService.resolvePath: relative to
 * MEDIA_ROOT, and a key that would escape that directory is refused and left
 * alone. The media module is not modified or imported here.
 *
 * No transaction is held: each row is deleted with a conditional
 * `deleted_at is not null` guard, so two workers racing on the same tombstone
 * can both remove the (already missing) file but only one deletes the row.
 */
@Injectable()
export class SweepMediaTombstonesJob {
  private readonly root: string;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService,
  ) {
    this.root = resolve(config.getOrThrow<string>('MEDIA_ROOT'));
  }

  async run(): Promise<MediaTombstoneSweepSummary> {
    const summary: MediaTombstoneSweepSummary = {
      job: SWEEP_MEDIA_TOMBSTONES_JOB,
      scanned: 0,
      purged: 0,
      filesDeleted: 0,
      filesMissing: 0,
      skippedUnsafePaths: 0,
      failed: 0,
      capped: false,
    };
    let batches = 0;
    let lastBatchSize = 0;
    while (batches < MEDIA_TOMBSTONE_MAX_BATCHES) {
      const rows = await this.dueBatch();
      lastBatchSize = rows.length;
      batches += 1;
      summary.scanned += rows.length;
      for (const row of rows) {
        await this.sweepRow(row, summary);
      }
      if (rows.length < MEDIA_TOMBSTONE_BATCH_SIZE) break;
    }
    summary.capped =
      batches === MEDIA_TOMBSTONE_MAX_BATCHES &&
      lastBatchSize === MEDIA_TOMBSTONE_BATCH_SIZE;
    return summary;
  }

  private async dueBatch(): Promise<TombstoneRow[]> {
    const result = await this.database.pool.query<TombstoneRow>(
      `select id::text as id, storage_key, thumbnail_key
         from media_assets
        where deleted_at is not null
          and deleted_at <= now() - ($1::int * interval '1 day')
        order by deleted_at, id
        limit $2`,
      [MEDIA_TOMBSTONE_RETENTION_DAYS, MEDIA_TOMBSTONE_BATCH_SIZE],
    );
    return result.rows;
  }

  private async sweepRow(
    row: TombstoneRow,
    summary: MediaTombstoneSweepSummary,
  ): Promise<void> {
    const keys = [row.storage_key, row.thumbnail_key].filter(
      (key): key is string => typeof key === 'string' && key !== '',
    );
    let paths: string[];
    try {
      paths = keys.map((key) => this.resolvePath(key));
    } catch {
      // A key outside MEDIA_ROOT is corruption, not something to delete: keep
      // the row so a human can look at what happened.
      summary.skippedUnsafePaths += 1;
      return;
    }
    for (const path of paths) {
      try {
        await rm(path);
        summary.filesDeleted += 1;
      } catch (error) {
        if (isMissingFile(error)) {
          summary.filesMissing += 1;
          continue;
        }
        summary.failed += 1;
        return;
      }
    }
    const deleted = await this.database.pool.query(
      `delete from media_assets
        where id = $1 and deleted_at is not null`,
      [row.id],
    );
    if ((deleted.rowCount ?? 0) > 0) summary.purged += 1;
  }

  /** Same rule as MediaService.resolvePath: never leave MEDIA_ROOT. */
  private resolvePath(storageKey: string): string {
    const absolute = resolve(this.root, storageKey);
    if (!absolute.startsWith(`${this.root}${sep}`)) {
      throw new Error('storage key escapes the media root');
    }
    return absolute;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
