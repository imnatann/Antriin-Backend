import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import {
  EXPIRE_TOPUP_INTENTS_JOB,
  MAINTENANCE_HEALTHCHECK_JOB,
  PURGE_ORDER_IDEMPOTENCY_JOB,
  RUN_REPORT_EXPORTS_JOB,
  RUN_RISK_DETECTORS_JOB,
  SWEEP_MEDIA_TOMBSTONES_JOB,
} from './maintenance-jobs.constants';
import type { MediaTombstoneSweepSummary } from './media-tombstone-sweep.job';
import { SweepMediaTombstonesJob } from './media-tombstone-sweep.job';
import type { OrderIdempotencyPurgeSummary } from './order-idempotency-purge.job';
import { PurgeOrderIdempotencyJob } from './order-idempotency-purge.job';
import { MAINTENANCE_QUEUE } from './queue-names';
import type { ReportExportJobSummary } from './report-export.job';
import { ReportExportJob } from './report-export.job';
import type { RiskDetectorJobSummary } from './risk-detector.job';
import { RiskDetectorJob } from './risk-detector.job';
import type { TopupExpirySummary } from './topup-expiry.job';
import { ExpireTopupIntentsJob } from './topup-expiry.job';

export type MaintenanceJobSummary =
  | { status: string }
  | TopupExpirySummary
  | OrderIdempotencyPurgeSummary
  | MediaTombstoneSweepSummary
  | RiskDetectorJobSummary
  | ReportExportJobSummary;

/**
 * Processor for the 'maintenance' queue.
 *
 * Every job it accepts is idempotent, batched and bounded, so a repeated
 * delivery (BullMQ retry, worker restart, a second instance) converges on the
 * same state. A failure is thrown to BullMQ, which owns retry/backoff: the
 * process itself stays up, and only an unknown job name is treated as
 * unrecoverable. Each completed pass logs one structured JSON summary line.
 */
@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private readonly topupExpiry: ExpireTopupIntentsJob,
    private readonly idempotencyPurge: PurgeOrderIdempotencyJob,
    private readonly mediaTombstones: SweepMediaTombstonesJob,
    private readonly riskDetectors: RiskDetectorJob,
    private readonly reportExports: ReportExportJob,
  ) {
    super();
  }

  async process(job: Job): Promise<MaintenanceJobSummary> {
    const startedAt = Date.now();
    const summary = await this.dispatch(job.name);
    this.logger.log(
      JSON.stringify({
        job: job.name,
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        durationMs: Date.now() - startedAt,
        summary,
      }),
    );
    // Detector failures are reported per category; the pass is retried as a
    // whole, and the dedupe keys keep the successful findings untouched.
    if (hasDetectorFailures(summary) && summary.failures.length > 0)
      throw new Error(
        'Risk detector run had ' +
          String(summary.failures.length) +
          ' failing detector(s)',
      );
    return summary;
  }

  private async dispatch(name: string): Promise<MaintenanceJobSummary> {
    switch (name) {
      case MAINTENANCE_HEALTHCHECK_JOB:
        return { status: 'ok' };
      case EXPIRE_TOPUP_INTENTS_JOB:
        return this.topupExpiry.run();
      case PURGE_ORDER_IDEMPOTENCY_JOB:
        return this.idempotencyPurge.run();
      case SWEEP_MEDIA_TOMBSTONES_JOB:
        return this.mediaTombstones.run();
      case RUN_RISK_DETECTORS_JOB:
        return this.riskDetectors.run();
      case RUN_REPORT_EXPORTS_JOB:
        return this.reportExports.run();
      default:
        // Only a genuinely unknown job name is unrecoverable: retrying cannot
        // change what the job is.
        throw new UnrecoverableError('Unsupported maintenance job');
    }
  }
}

function hasDetectorFailures(
  summary: MaintenanceJobSummary,
): summary is RiskDetectorJobSummary {
  return 'failures' in summary;
}
