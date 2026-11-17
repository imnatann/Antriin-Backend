import 'reflect-metadata';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { createOtpDelivery } from '../src/modules/auth/otp-delivery.factory';
import { DevEchoOtpDelivery } from '../src/modules/auth/otp-delivery.dev-echo';
import { ResendOtpDelivery } from '../src/modules/auth/otp-delivery.resend';

const config = (values: Record<string, unknown>) => new ConfigService(values);

describe('OTP delivery adapter selection', () => {
  it('stays unavailable by default', () => {
    const adapter = createOtpDelivery(
      config({ NODE_ENV: 'development', AUTH_OTP_DEV_ECHO: false }),
    );
    assert.equal(adapter instanceof DevEchoOtpDelivery, false);
  });

  it('stays unavailable when the flag is absent', () => {
    const adapter = createOtpDelivery(config({ NODE_ENV: 'production' }));
    assert.equal(adapter instanceof DevEchoOtpDelivery, false);
  });

  it('selects the log-echo adapter when explicitly enabled', () => {
    const adapter = createOtpDelivery(
      config({ NODE_ENV: 'development', AUTH_OTP_DEV_ECHO: true }),
    );
    assert.equal(adapter instanceof DevEchoOtpDelivery, true);
  });

  it('honours the flag in production, so a pilot host can keep its guards closed', () => {
    const adapter = createOtpDelivery(
      config({ NODE_ENV: 'production', AUTH_OTP_DEV_ECHO: true }),
    );
    assert.equal(adapter instanceof DevEchoOtpDelivery, true);
  });

  it('treats the flag as off unless it is the boolean true', () => {
    const adapter = createOtpDelivery(
      config({ NODE_ENV: 'development', AUTH_OTP_DEV_ECHO: 'true' }),
    );
    assert.equal(adapter instanceof DevEchoOtpDelivery, false);
  });

  it('selects Resend when the API key is present, even over the dev echo flag', () => {
    const adapter = createOtpDelivery(
      config({
        NODE_ENV: 'production',
        RESEND_API_KEY: 're_test_key',
        AUTH_OTP_FROM_EMAIL: 'no-reply@antriin.test',
        AUTH_OTP_DEV_ECHO: true,
      }),
    );
    assert.equal(adapter instanceof ResendOtpDelivery, true);
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

describe('Resend OTP delivery', () => {
  const realFetch = globalThis.fetch;
  const sent: { url: string; init: RequestInit }[] = [];
  let nextResponse = () => new Response('{"id":"x"}', { status: 200 });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return nextResponse();
  }) as typeof fetch;

  const adapter = new ResendOtpDelivery({
    apiKey: 're_test_key',
    from: 'no-reply@antriin.test',
  });
  const message = {
    challengeId: '00000000-0000-4000-8000-000000000001',
    channel: 'email' as const,
    destination: 'user@example.test',
    code: '123456',
  };

  it('posts the code to the recipient over the REST API', async () => {
    sent.length = 0;
    await adapter.send(message);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.resend.com/emails');
    const headers = sent[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer re_test_key');
    const body = JSON.parse(String(sent[0].init.body)) as {
      from: string;
      to: string[];
      text: string;
    };
    assert.equal(body.from, 'no-reply@antriin.test');
    assert.deepEqual(body.to, ['user@example.test']);
    assert.ok(body.text.includes('123456'));
  });

  it('surfaces a provider rejection so the outbox can back off', async () => {
    nextResponse = () => new Response('{"message":"bad"}', { status: 422 });
    await assert.rejects(() => adapter.send(message), /RESEND_HTTP_422/);
    nextResponse = () => new Response('{"id":"x"}', { status: 200 });
  });

  it('refuses a channel it cannot deliver', async () => {
    sent.length = 0;
    await assert.rejects(
      () => adapter.send({ ...message, channel: 'phone' }),
      (error: { response?: { code?: string } }) =>
        error.response?.code === 'otp_delivery_channel_unsupported',
    );
    assert.equal(sent.length, 0);
  });

  after(() => {
    globalThis.fetch = realFetch;
  });
});
