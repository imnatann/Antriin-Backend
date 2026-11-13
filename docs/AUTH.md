# Auth API pilot

Status: authentication is implemented behind an OTP delivery port. No real email or WhatsApp provider is configured in this repository; the default adapter returns `503` and never exposes a code. Production activation requires complete secrets and a reviewed delivery adapter. Authentication does not grant domain permissions by itself; the exported `AuthGuard` establishes the current user and session for domain authorization.

## Endpoints

All endpoints use the `/api/v1` prefix and JSON bodies. The global Nest validation pipe rejects unknown fields.

| Method and path                                             | Access | Behavior                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/otp-challenges`                                 | Public | Request a login OTP with `channel` set to `email` or `phone`, `destination`, and optional `displayName`. Email is normalized to lowercase; phone must be E.164. The `phone` channel is an adapter contract; it does not mean a WhatsApp provider is implemented. |
| `POST /auth/otp-challenges/:challengeId/verify`             | Public | Accept `{ "code": "123456" }` and consume the login challenge once. Success creates an account if needed and returns an opaque bearer session. A new account without a supplied display name uses `Pengguna Antriin`.                                            |
| `POST /auth/campus-email-verifications`                     | Bearer | Request a separate campus-email OTP for the authenticated user. Only active campus domains with `verified_at` set are accepted.                                                                                                                                  |
| `POST /auth/campus-email-verifications/:challengeId/verify` | Bearer | Consume the campus email challenge for the same authenticated user. After OTP proof, the email is linked as a verified login identity for that same account; the campus-verification claim remains a separate record used for review eligibility.                |
| `GET /auth/campus-email-verifications/current`              | Bearer | Return whether the current user has a campus verification and its campus/time when present.                                                                                                                                                                      |
| `POST /auth/sessions/refresh`                               | Bearer | Rotate the current, unexpired bearer token. The previous token is revoked in the same transaction.                                                                                                                                                               |
| `DELETE /auth/sessions/current`                             | Bearer | Revoke the current session.                                                                                                                                                                                                                                      |

Errors use stable codes such as `otp_cooldown`, `otp_invalid`, `otp_expired`, `otp_locked`, `otp_delivery_unavailable`, `session_invalid`, and `auth_not_configured`. Login challenge responses do not indicate whether the identity already has an account. No endpoint returns an OTP, and auth code does not log an OTP, bearer token, email, or phone number.

## Security and pilot defaults

| Setting                            |        Default |     Bounds |
| ---------------------------------- | -------------: | ---------: |
| `AUTH_OTP_TTL_SECONDS`             |    300 seconds |     60–600 |
| `AUTH_OTP_MAX_ATTEMPTS`            |              5 |       1–10 |
| `AUTH_OTP_RESEND_COOLDOWN_SECONDS` |     60 seconds |     30–300 |
| `AUTH_SESSION_TTL_SECONDS`         | 86,400 seconds | 300–86,400 |
| `AUTH_OTP_DELIVERY_MAX_ATTEMPTS`   |              5 |       1–10 |

These are configurable pilot security defaults, not permanent product policy. A phone OTP provider is not included. Delivery retries use a durable outbox with a lease and exponential delay. A failed delivery never makes the challenge verifiable; a later worker may retry the outbox before expiry. The outbox stores the delivery payload encrypted and clears that payload after success, terminal failure, expiry, or replacement. The challenge retains only the encrypted destination and keyed OTP hash.

The application needs these secrets:

- `AUTH_SECRET`: at least 32 UTF-8 bytes. Used as the HMAC key for destination lookup, OTP verification, and session-token lookup.
- `AUTH_ENCRYPTION_KEY`: base64 encoding of exactly 32 random bytes. Used for AES-256-GCM encryption of destinations and short-lived delivery payloads.

For example, generate separate values with a secret manager or `openssl rand -base64 32`; do not commit the generated values. Development can still start without auth secrets, but auth requests return `503 auth_not_configured`. Production configuration must reject missing/invalid secrets and must not bind a development capturing adapter.

The bearer token is 256 bits of random opaque data. PostgreSQL stores only its HMAC. Refresh locks the current session and atomically revokes it while inserting the replacement. Sessions expire after 24 hours by default. OTP identity keys and codes are keyed HMACs; the six-digit code is never persisted in plaintext. Challenge verification uses a row lock and increments attempts transactionally. Challenge creation serializes resend checks per normalized identity.

An atomic Redis window additionally limits OTP challenge creation to 10 requests per IP in 10 minutes and OTP verification to 60 per IP in 10 minutes. The IP is HMAC-keyed before it enters a Redis key; the guard fails closed with 503 if Redis is unavailable. Device-based limits and provider-specific abuse controls remain for later adapter/edge work.

Campus domain rows are keyed to a campus, globally unique by lowercase domain, active, and require `verified_at` before use. Domain-management and domain-ownership verification endpoints are not part of this auth task; administrators must provision only verified domains. Each user currently has at most one campus-email verification. Review this limit before allowing account email changes or multiple campuses per user.

## Database and integration boundary

The auth schema definitions live in `src/database/schema/auth.ts`; root owns migration generation/integration. Auth queries use `DatabaseService.pool`, so every table and column named in that schema must be included in the migration before endpoints are enabled. Required tables are `auth_identities`, `campus_email_domains`, `auth_otp_challenges`, `auth_otp_deliveries`, `auth_sessions`, and `campus_email_verifications`.

The OTP delivery outbox is committed with the challenge before any provider call. `AuthService.drainOtpDeliveries()` is available for a worker dispatcher; it claims rows with leases/`SKIP LOCKED`, calls the injected delivery port outside DB transactions, and records retry/permanent failure state. The current maintenance worker is not wired to invoke this method, so a real/sandbox adapter must be integrated with a dispatcher before delivery is considered operational.

HTTP and PostgreSQL integration tests are gated by `TEST_DATABASE_URL`; they must never load `.env` or fall back to `DATABASE_URL`. Use an isolated test database with the auth migration applied.
