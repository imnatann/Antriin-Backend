import type { FastifyHelmetOptions } from '@fastify/helmet';

/**
 * Helmet options shared by the API bootstrap.
 *
 * helmet's default CSP includes `upgrade-insecure-requests`, which rewrites every
 * subresource request to https://. The pilot serves plain HTTP on port 3000 with no
 * TLS proxy in front, so that directive silently breaks every external asset:
 * /docs (Swagger UI) loads its bundle over http, gets upgraded, and renders blank.
 *
 * Re-enable the directive in the same commit that puts a TLS-terminating proxy in
 * front of the API; test/security-headers.spec.ts guards the current state.
 */
export const helmetOptions: FastifyHelmetOptions = {
  contentSecurityPolicy: {
    directives: { 'upgrade-insecure-requests': null },
  },
};
