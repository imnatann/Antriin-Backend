export const AUTH_OTP_DELIVERY = Symbol('AUTH_OTP_DELIVERY');

export const AUTH_SECURITY_DEFAULTS = Object.freeze({
  otpTtlSeconds: 300,
  otpMaxAttempts: 5,
  otpResendCooldownSeconds: 60,
  sessionTtlSeconds: 24 * 60 * 60,
  otpDeliveryMaxAttempts: 5,
});

export type OtpChannel = 'email' | 'phone';

export interface OtpDeliveryMessage {
  challengeId: string;
  channel: OtpChannel;
  destination: string;
  code: string;
}

export interface OtpDeliveryPort {
  send(message: OtpDeliveryMessage): Promise<void>;
}
