'use strict';

const crypto = require('node:crypto');
const { id, NAMESPACE } = require('./ids.cjs');

/**
 * Mirrors AuthService: session tokens are HMAC-SHA256(AUTH_SECRET, 'session:'+token)
 * and identity hashes are HMAC-SHA256(AUTH_SECRET, 'identity:<channel>:<dest>').
 * OTP delivery is not configured on the pilot host, so the seed mints sessions
 * directly instead of walking the login flow.
 */
function loadAuthContext(env = process.env) {
  const secret = env.AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32)
    throw new Error('AUTH_SECRET missing or shorter than 32 bytes');
  const keyText = env.AUTH_ENCRYPTION_KEY;
  if (!keyText) throw new Error('AUTH_ENCRYPTION_KEY is not set');
  const encryptionKey = Buffer.from(keyText, 'base64');
  if (encryptionKey.length !== 32)
    throw new Error('AUTH_ENCRYPTION_KEY must decode to 32 bytes');
  const sessionTtlSeconds = Number(env.AUTH_SESSION_TTL_SECONDS || 86400);
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 300)
    throw new Error('AUTH_SESSION_TTL_SECONDS must be an integer >= 300');
  return { secret, encryptionKey, sessionTtlSeconds };
}

const hash = (secret, value) =>
  crypto.createHmac('sha256', secret).update(value, 'utf8').digest('hex');

const identityHash = (secret, channel, destination) =>
  hash(secret, `identity:${channel}:${destination}`);

/** AES-256-GCM with a 12-byte IV, matching AuthService.encrypt(). */
function encrypt(encryptionKey, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

async function mintSession(client, auth, userId, index) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + auth.sessionTtlSeconds * 1000);
  await client.query(
    `insert into auth_sessions (id, user_id, token_hash, expires_at)
     values ($1, $2, $3, $4)
     on conflict (id) do update
       set user_id = excluded.user_id, token_hash = excluded.token_hash,
           expires_at = excluded.expires_at, revoked_at = null,
           rotated_to_session_id = null, updated_at = now()`,
    [
      id(NAMESPACE.session, index),
      userId,
      hash(auth.secret, `session:${token}`),
      expiresAt,
    ],
  );
  return { sessionToken: token, expiresAt: expiresAt.toISOString() };
}

module.exports = { loadAuthContext, hash, identityHash, encrypt, mintSession };
