import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { environmentSchema } from '../src/config/environment';

const base = {
  CORS_ORIGINS: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
  REDIS_HOST: '127.0.0.1',
};
describe('Environment security boundary', () => {
  it('allows development health with auth disabled but requires production keys', () => {
    assert.equal(environmentSchema.validate(base).error, undefined);
    for (const keys of [{}, { AUTH_SECRET: '', AUTH_ENCRYPTION_KEY: '' }]) {
      assert.ok(
        environmentSchema.validate({ ...base, NODE_ENV: 'production', ...keys })
          .error,
      );
    }
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
        AUTH_SECRET: keys.AUTH_SECRET,
        AUTH_ENCRYPTION_KEY: '',
      }).error,
    );
    assert.equal(
      environmentSchema.validate({ ...base, NODE_ENV: 'production', ...keys })
        .error,
      undefined,
    );
    assert.ok(
      environmentSchema.validate({
        ...base,
        ...keys,
        AUTH_ENCRYPTION_KEY: 'not-a-key',
      }).error,
    );
    assert.ok(
      environmentSchema.validate({
        ...base,
        ...keys,
        AUTH_SESSION_TTL_SECONDS: 86401,
      }).error,
    );
  });
});
