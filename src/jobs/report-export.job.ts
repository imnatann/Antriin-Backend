import { Injectable } from '@nestjs/common';
import { ReportingService } from '../modules/reporting/reporting.service';
import { RUN_REPORT_EXPORTS_JOB } from './maintenance-jobs.constants';

export type ReportExportJobSummary = {
  job: typeof RUN_REPORT_EXPORTS_JOB;
  generated: number;
  failed: number;
};

/**
 * Scheduled entry point for report exports whose next_run_at has passed.
 *
 * ReportingService.runDueExports owns the transaction, the row locks and the
 * schedule arithmetic; this job is only the queue-facing wrapper so the worker
 * (and not an HTTP request) drives scheduled regeneration. A failure is thrown
 * to BullMQ so the pass is retried; rows already stamped keep their state, so a
 * retry never regenerates what succeeded.
 */
@Injectable()
export class ReportExportJob {
  constructor(private readonly reporting: ReportingService) {}

  async run(): Promise<ReportExportJobSummary> {
    const result = await this.reporting.runDueExports();
    return { job: RUN_REPORT_EXPORTS_JOB, ...result };
  }
}
