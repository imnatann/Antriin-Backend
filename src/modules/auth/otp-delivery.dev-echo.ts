import { Injectable, Logger } from '@nestjs/common';
import {
  type OtpDeliveryMessage,
  type OtpDeliveryPort,
} from './auth.constants';

/**
 * Pilot-only OTP delivery: writes the code to the application log instead of
 * sending it, so the login flow runs end to end (challenge -> delivery ->
 * verify) without an email/SMS provider.
 *
 * `AUTH_OTP_DEV_ECHO` is the only switch. It is deliberately independent of
 * NODE_ENV: the pilot host runs with NODE_ENV=production so the payment,
 * payout and refund guards stay closed, yet still needs a working login.
 *
 * The code is a live login credential for its TTL window. Anyone who can read
 * the container log can sign in as any seeded account, so enable this only on
 * a host you control and turn it off before real users exist.
 */
@Injectable()
export class DevEchoOtpDelivery implements OtpDeliveryPort {
  private readonly logger = new Logger('AuthOtpDelivery');

  constructor() {
    this.logger.warn(
      'OTP codes are written to the application log (AUTH_OTP_DEV_ECHO=true); disable before real users exist',
    );
  }

  async send(message: OtpDeliveryMessage): Promise<void> {
    this.logger.log(
      `otp code issued channel=${message.channel} destination=${maskDestination(
        message.destination,
      )} challengeId=${message.challengeId} code=${message.code}`,
    );
  }
}

/** Keeps the full address out of the log; the code is the part you need. */
function maskDestination(destination: string): string {
  const at = destination.indexOf('@');
  if (at > 0) {
    const local = destination.slice(0, at);
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}***@${destination.slice(at + 1)}`;
  }
  return `${destination.slice(0, 4)}***`;
}
