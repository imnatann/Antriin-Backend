import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { createOtpDelivery } from '../src/modules/auth/otp-delivery.factory';
import { DevEchoOtpDelivery } from '../src/modules/auth/otp-delivery.dev-echo';

const config = (values: Record<string, unknown>) => new ConfigService(values);

describe('OTP delivery adapter selection', () => {
  it('stays unavailable by default', () => {
    const adapter = createOtpDelivery(
      config({ NODE_ENV: 'development', AUTH_OTP_DEV_ECHO: false }),
    );
    assert.equal(adapter instanceof DevEchoOtpDelivery, false);
  });

  it('selects the log-echo adapter when explicitly enabled outside production', () => {
    const adapter = createOtpDelivery(
      config({ NODE_ENV: 'development', AUTH_OTP_DEV_ECHO: true }),
    );
    assert.equal(adapter instanceof DevEchoOtpDelivery, true);
  });

  it('refuses the log-echo adapter in production even when enabled', () => {
    const adapter = createOtpDelivery(
      config({ NODE_ENV: 'production', AUTH_OTP_DEV_ECHO: true }),
    );
    assert.equal(adapter instanceof DevEchoOtpDelivery, false);
  });

  it('treats the flag as off unless it is the boolean true', () => {
    const adapter = createOtpDelivery(
      config({ NODE_ENV: 'development', AUTH_OTP_DEV_ECHO: 'true' }),
    );
    assert.equal(adapter instanceof DevEchoOtpDelivery, false);
  });

  it('unavailable adapter reports the documented error code', async () => {
    const adapter = createOtpDelivery(config({ NODE_ENV: 'production' }));
    await assert.rejects(
      () =>
        adapter.send({
          challengeId: '00000000-0000-4000-8000-000000000001',
          channel: 'email',
          destination: 'a@b.co',
          code: '123456',
        }),
      (error: { response?: { code?: string } }) =>
        error.response?.code === 'otp_delivery_unavailable',
    );
  });
});
