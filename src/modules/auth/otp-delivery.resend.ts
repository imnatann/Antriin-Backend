import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  type OtpDeliveryMessage,
  type OtpDeliveryPort,
} from './auth.constants';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10_000;

/** Address Resend delivers from; must be a verified sending domain. */
export interface ResendOtpOptions {
  apiKey: string;
  from: string;
}

export class ResendOtpDelivery implements OtpDeliveryPort {
  private readonly logger = new Logger('AuthOtpDelivery');

  constructor(private readonly options: ResendOtpOptions) {}

  async send(message: OtpDeliveryMessage): Promise<void> {
    if (message.channel !== 'email')
      throw new ServiceUnavailableException({
        code: 'otp_delivery_channel_unsupported',
        message: 'OTP delivery is not configured for this channel',
      });
    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [message.destination],
          subject: `${message.code} adalah kode masuk Antriin`,
          text: `Kode masuk Antriin kamu: ${message.code}\n\nKode ini hanya bisa dipakai sekali. Jangan bagikan kode ini kepada siapa pun.`,
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        'RESEND_REQUEST_FAILED: ' +
          (error instanceof Error ? error.message : 'unknown transport error'),
        { cause: error },
      );
    }
    // The response body may echo the recipient; only the status is kept.
    if (!response.ok) {
      this.logger.warn(
        `Resend rejected OTP email challenge=${message.challengeId} status=${String(response.status)}`,
      );
      throw new Error('RESEND_HTTP_' + String(response.status));
    }
  }
}
