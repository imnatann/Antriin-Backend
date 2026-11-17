import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue, RepeatOptions } from 'bullmq';
import {
  DELIVER_OTP_DELIVERIES_EVERY_MS,
  DELIVER_OTP_DELIVERIES_JOB,
  EXPIRE_TOPUP_INTENTS_EVERY_MS,
  EXPIRE_TOPUP_INTENTS_JOB,
  MAINTENANCE_SCHEDULE_TIMEZONE,
  PURGE_ORDER_IDEMPOTENCY_CRON,
  PURGE_ORDER_IDEMPOTENCY_JOB,
  RUN_REPORT_EXPORTS_EVERY_MS,
  RUN_REPORT_EXPORTS_JOB,
  RUN_RISK_DETECTORS_EVERY_MS,
  RUN_RISK_DETECTORS_JOB,
  SWEEP_MEDIA_TOMBSTONES_CRON,
  SWEEP_MEDIA_TOMBSTONES_JOB,
} from './maintenance-jobs.constants';
import { MAINTENANCE_QUEUE } from './queue-names';

export type MaintenanceSchedule = {
  /** Job scheduler id; stable across restarts so upserting cannot duplicate. */
  id: string;
  jobName: string;
  repeat: Omit<RepeatOptions, 'key'>;
};

/**
 * The repeatable maintenance work a worker registers on startup:
 *
 * - top-up expiry every 60s (a pending intent should stop being payable
 *   promptly once it has expired),
 * - risk detectors every 15 minutes (evidence, not a realtime decision),
 * - the two daily retention sweeps off-peak in UTC.
 */
export const MAINTENANCE_SCHEDULES: readonly MaintenanceSchedule[] = [
  {
    id: EXPIRE_TOPUP_INTENTS_JOB,
    jobName: EXPIRE_TOPUP_INTENTS_JOB,
    repeat: { every: EXPIRE_TOPUP_INTENTS_EVERY_MS },
  },
  {
    id: RUN_RISK_DETECTORS_JOB,
    jobName: RUN_RISK_DETECTORS_JOB,
    repeat: { every: RUN_RISK_DETECTORS_EVERY_MS },
  },
  {
    id: RUN_REPORT_EXPORTS_JOB,
    jobName: RUN_REPORT_EXPORTS_JOB,
    repeat: { every: RUN_REPORT_EXPORTS_EVERY_MS },
  },
  {
    id: DELIVER_OTP_DELIVERIES_JOB,
    jobName: DELIVER_OTP_DELIVERIES_JOB,
    repeat: { every: DELIVER_OTP_DELIVERIES_EVERY_MS },
  },
  {
    id: PURGE_ORDER_IDEMPOTENCY_JOB,
    jobName: PURGE_ORDER_IDEMPOTENCY_JOB,
    repeat: {
      pattern: PURGE_ORDER_IDEMPOTENCY_CRON,
      tz: MAINTENANCE_SCHEDULE_TIMEZONE,
    },
  },
  {
    id: SWEEP_MEDIA_TOMBSTONES_JOB,
    jobName: SWEEP_MEDIA_TOMBSTONES_JOB,
    repeat: {
      pattern: SWEEP_MEDIA_TOMBSTONES_CRON,
      tz: MAINTENANCE_SCHEDULE_TIMEZONE,
    },
  },
];

/**
 * Registers the repeatable jobs when the worker starts.
 *
 * `upsertJobScheduler` is idempotent per scheduler id, so a worker restart (or
 * a second worker) updates the existing schedule instead of adding a duplicate
 * one. Registration failing is not fatal: the worker still accepts work, and
 * the next start retries, so a Redis hiccup cannot take the whole process down.
 */
@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceScheduler.name);

  constructor(@InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.register();
    } catch {
      this.logger.warn(
        'Scheduled maintenance jobs could not be registered; they will be retried on the next worker start',
      );
    }
  }

  async register(): Promise<void> {
    for (const schedule of MAINTENANCE_SCHEDULES) {
      await this.queue.upsertJobScheduler(schedule.id, schedule.repeat, {
        name: schedule.jobName,
        data: {},
        opts: {
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 100 },
        },
      });
    }
  }
}
