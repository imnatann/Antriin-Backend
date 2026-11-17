import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { environmentSchema } from '../src/config/environment';

const base = {
  CORS_ORIGINS: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
  REDIS_HOST: '127.0.0.1',
};
// Email OTP needs a real provider once NODE_ENV=production. `AUTH_OTP_DEV_ECHO`
// is the only sanctioned way around it, so fixtures that expect a valid
// production config carry this pair.
const resend = {
  RESEND_API_KEY: 're_test_key_0123456789',
  AUTH_OTP_FROM_EMAIL: 'no-reply@antriin.test',
};
describe('Xendit payment mode boundary', () => {
  const keys = {
    AUTH_SECRET: randomBytes(32).toString('hex'),
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ...resend,
  };
  const xendit = {
    PAYMENTS_PROVIDER_MODE: 'xendit',
    XENDIT_SECRET_KEY: 'xnd_development_abcdef123456',
    XENDIT_CALLBACK_TOKEN: 'callback-token-0123456789',
  };

  it('refuses a live Xendit key in every environment', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      const result = environmentSchema.validate({
        ...base,
        ...keys,
        NODE_ENV,
        ...xendit,
        XENDIT_SECRET_KEY: 'xnd_production_abcdef123456',
      });
      assert.ok(result.error, NODE_ENV + ' must reject a live key');
    }
  });

  it('accepts a test key under NODE_ENV=production', () => {
    assert.equal(
      environmentSchema.validate({
        ...base,
        ...keys,
        NODE_ENV: 'production',
        ...xendit,
      }).error,
      undefined,
      'a pilot host runs production NODE_ENV with a sandbox key',
    );
  });

  it('still refuses the local stub under NODE_ENV=production', () => {
    assert.ok(
      environmentSchema.validate({
        ...base,
        ...keys,
        NODE_ENV: 'production',
        PAYMENTS_PROVIDER_MODE: 'sandbox',
      }).error,
    );
  });

  it('requires the callback token whenever Xendit is selected', () => {
    assert.ok(
      environmentSchema.validate({
        ...base,
        ...keys,
        ...xendit,
        XENDIT_CALLBACK_TOKEN: '',
      }).error,
    );
  });
});

describe('Environment security boundary', () => {
  it('allows development health with auth disabled but requires production keys', () => {
    assert.equal(environmentSchema.validate(base).error, undefined);
    for (const keys of [
      { ...resend },
      { ...resend, AUTH_SECRET: '', AUTH_ENCRYPTION_KEY: '' },
    ]) {
      assert.ok(
        environmentSchema.validate({ ...base, NODE_ENV: 'production', ...keys })
          .error,
      );
    }
  });

  it('requires an email OTP provider in production unless codes are echoed to the log', () => {
    const keys = {
      AUTH_SECRET: randomBytes(32).toString('hex'),
      AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    };
    assert.ok(
      environmentSchema.validate({ ...base, NODE_ENV: 'production', ...keys })
        .error,
    );
    assert.ok(
      environmentSchema.validate({
        ...base,
        NODE_ENV: 'production',
        ...keys,
        AUTH_OTP_FROM_EMAIL: resend.AUTH_OTP_FROM_EMAIL,
      }).error,
      'a sender address alone is not enough',
    );
    assert.ok(
      environmentSchema.validate({
        ...base,
        NODE_ENV: 'production',
        ...keys,
        ...resend,
        RESEND_API_KEY: 'xnd_development_wrong',
      }).error,
      'only a Resend key is accepted',
    );
    assert.equal(
      environmentSchema.validate({
        ...base,
        NODE_ENV: 'production',
        ...keys,
        ...resend,
      }).error,
      undefined,
    );
    assert.equal(
      environmentSchema.validate({
        ...base,
        NODE_ENV: 'production',
        ...keys,
        AUTH_OTP_DEV_ECHO: true,
      }).error,
      undefined,
    );
  });
  it('rejects malformed encryption keys and excessive session lifetimes', () => {
    const keys = {
      AUTH_SECRET: randomBytes(32).toString('hex'),
      AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    };
    assert.ok(
      environmentSchema.validate({
        ...base,
        NODE_ENV: 'production',
        ...resend,
        AUTH_SECRET: keys.AUTH_SECRET,
        AUTH_ENCRYPTION_KEY: '',
      }).error,
    );
    assert.equal(
      environmentSchema.validate({
        ...base,
        NODE_ENV: 'production',
        ...keys,
        ...resend,
      }).error,
      undefined,
    );
    assert.ok(
      environmentSchema.validate({
        ...base,
        ...keys,
        ...resend,
        AUTH_ENCRYPTION_KEY: 'not-a-key',
      }).error,
    );
    assert.ok(
      environmentSchema.validate({
        ...base,
        ...keys,
        ...resend,
        AUTH_SESSION_TTL_SECONDS: 86401,
      }).error,
    );
  });
});
