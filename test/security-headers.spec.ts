import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { helmetOptions } from '../src/common/security-headers';

/**
 * The pilot serves plain HTTP with no TLS proxy. helmet's default
 * upgrade-insecure-requests would rewrite /docs assets to https:// and break
 * Swagger UI silently, so this pins the directive off until TLS is terminated.
 */
describe('Security headers', () => {
  let app: ReturnType<typeof Fastify>;

  before(async () => {
    app = Fastify();
    await app.register(helmet, helmetOptions);
    app.get('/probe', () => ({ ok: true }));
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('does not upgrade insecure subresource requests', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe' });
    const csp = String(response.headers['content-security-policy'] ?? '');
    assert.ok(csp.length > 0, 'CSP header must be present');
    assert.equal(
      csp.includes('upgrade-insecure-requests'),
      false,
      'plain-HTTP deployment must not emit upgrade-insecure-requests',
    );
  });

  it('keeps the rest of the default policy intact', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe' });
    const csp = String(response.headers['content-security-policy'] ?? '');
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
    ])
      assert.ok(csp.includes(directive), 'missing ' + directive);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  });
});
