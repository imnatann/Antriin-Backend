import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type OtpDeliveryPort } from './auth.constants';
import { DevEchoOtpDelivery } from './otp-delivery.dev-echo';
import { ResendOtpDelivery } from './otp-delivery.resend';

class UnavailableOtpDelivery implements OtpDeliveryPort {
  async send(): Promise<void> {
    throw new ServiceUnavailableException({
      code: 'otp_delivery_unavailable',
      message: 'OTP delivery is not configured',
    });
  }
}

export function createOtpDelivery(config: ConfigService): OtpDeliveryPort {
  const apiKey = config.get<string>('RESEND_API_KEY');
  if (apiKey)
    return new ResendOtpDelivery({
      apiKey,
      from: config.getOrThrow<string>('AUTH_OTP_FROM_EMAIL'),
    });
  return config.get<boolean>('AUTH_OTP_DEV_ECHO') === true
    ? new DevEchoOtpDelivery()
    : new UnavailableOtpDelivery();
}
