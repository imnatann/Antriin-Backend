import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type OtpDeliveryPort } from './auth.constants';
import { DevEchoOtpDelivery } from './otp-delivery.dev-echo';

class UnavailableOtpDelivery implements OtpDeliveryPort {
  async send(): Promise<void> {
    throw new ServiceUnavailableException({
      code: 'otp_delivery_unavailable',
      message: 'OTP delivery is not configured',
    });
  }
}

/**
 * Picks the OTP adapter. The log-echo adapter is opt-in (`AUTH_OTP_DEV_ECHO`)
 * and is refused in production, so a misconfigured host cannot silently write
 * login codes into the log.
 */
export function createOtpDelivery(config: ConfigService): OtpDeliveryPort {
  const enabled =
    config.get<boolean>('AUTH_OTP_DEV_ECHO') === true &&
    config.get<string>('NODE_ENV') !== 'production';
  return enabled
    ? new DevEchoOtpDelivery(config)
    : new UnavailableOtpDelivery();
}
