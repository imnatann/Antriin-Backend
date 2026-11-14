import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type OtpDeliveryMessage,
  type OtpDeliveryPort,
} from './auth.constants';

/**
 * Pilot-only OTP delivery: writes the code to the application log instead of
 * sending it. Selected when `AUTH_OTP_DEV_ECHO=true` and NODE_ENV is not
 * production, so the login flow runs end to end (challenge -> delivery ->
 * verify) without an email/SMS provider.
 *
 * The code is a live login credential for its TTL window. Keep LOG_LEVEL at
 * `info` or lower only on hosts you control, and never enable this in
 * production.
 */
@Injectable()
export class DevEchoOtpDelivery implements OtpDeliveryPort {
  private readonly logger = new Logger('AuthOtpDelivery');

  constructor(private readonly config: ConfigService) {}

  async send(message: OtpDeliveryMessage): Promise<void> {
    if (this.config.get<string>('NODE_ENV') === 'production')
      throw new ServiceUnavailableException({
        code: 'otp_delivery_unavailable',
        message: 'OTP delivery is not configured',
      });
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
