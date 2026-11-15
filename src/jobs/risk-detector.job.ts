import { Injectable } from '@nestjs/common';
import type { RiskDetectorRunResult } from '../modules/risk/risk-detectors.service';
import { RiskDetectorService } from '../modules/risk/risk-detectors.service';
import { RUN_RISK_DETECTORS_JOB } from './maintenance-jobs.constants';

export type RiskDetectorJobSummary = RiskDetectorRunResult & {
  job: typeof RUN_RISK_DETECTORS_JOB;
};

/**
 * Scheduled entry point for the risk detectors.
 *
 * The detectors write evidence only (risk_signals); this job never mutates
 * order, wallet, account or tenant state. It returns the per-detector summary
 * and lets the processor log it; when any detector failed the processor throws
 * so BullMQ retries the pass with its usual backoff. Signals created by an
 * earlier successful pass stay deduplicated by their dedupe keys.
 */
@Injectable()
export class RiskDetectorJob {
  constructor(private readonly detectors: RiskDetectorService) {}

  async run(): Promise<RiskDetectorJobSummary> {
    const result = await this.detectors.runAll();
    return { job: RUN_RISK_DETECTORS_JOB, ...result };
  }
}
