import { Injectable } from '@nestjs/common';
import { AuthService } from '../modules/auth/auth.service';
import { DELIVER_OTP_DELIVERIES_JOB } from './maintenance-jobs.constants';

export type OtpDeliveryDispatchSummary = {
  job: typeof DELIVER_OTP_DELIVERIES_JOB;
  sent: number;
  deferred: number;
};

/** Deliveries drained per pass; the schedule runs every 30 seconds. */
export const OTP_DELIVERY_DISPATCH_BATCH = 20;

/**
 * Retries OTP deliveries that the outbox deferred (provider down, rate limited,
 * or a challenge created by an instance whose adapter was unavailable).
 *
 * The API already drains the delivery it just queued, so this exists for the
 * ones that failed: without it a deferred delivery would sit until its
 * challenge expired. `AuthService.drainOtpDeliveries` claims rows with leases
 * and SKIP LOCKED, so this pass and the API can run concurrently without
 * sending the same code twice.
 */
@Injectable()
export class DeliverOtpDeliveriesJob {
  constructor(private readonly auth: AuthService) {}

  async run(): Promise<OtpDeliveryDispatchSummary> {
    const result = await this.auth.drainOtpDeliveries(
      OTP_DELIVERY_DISPATCH_BATCH,
    );
    return { job: DELIVER_OTP_DELIVERIES_JOB, ...result };
  }
}
