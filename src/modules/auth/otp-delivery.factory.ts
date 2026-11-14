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
 * Picks the OTP adapter. `AUTH_OTP_DEV_ECHO` is the only switch, independent of
 * NODE_ENV, so a host can keep production guards closed and still have a
 * working login. Off by default: a host that forgets to configure a real
 * provider fails closed instead of writing login codes into the log.
 */
export function createOtpDelivery(config: ConfigService): OtpDeliveryPort {
  return config.get<boolean>('AUTH_OTP_DEV_ECHO') === true
    ? new DevEchoOtpDelivery()
    : new UnavailableOtpDelivery();
}
