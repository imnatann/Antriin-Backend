'use strict';

const { id, NAMESPACE } = require('../lib/ids.cjs');
const { identityHash, encrypt, mintSession } = require('../lib/auth.cjs');

/**
 * Creates the users, their verified login identity (email), the campus email
 * verification where the fixture asks for one, and a bearer session per account.
 * Sessions replace any previously active one so the printed token is the only
 * valid token for that account.
 */
async function run(client, { campus, accounts, auth }) {
  const issued = [];
  for (const [index, account] of accounts.entries()) {
    await client.query(
      `insert into users (id, display_name, status)
       values ($1, $2, 'active')
       on conflict (id) do update
         set display_name = excluded.display_name, status = 'active',
             updated_at = now()`,
      [account.id, account.displayName],
    );

    const identityHashValue = identityHash(auth.secret, 'email', account.email);
    await client.query(
      `insert into auth_identities
         (id, user_id, channel, identity_hash, destination_ciphertext, verified_at)
       values ($1, $2, 'email', $3, $4, now())
       on conflict (channel, identity_hash) do update
         set user_id = excluded.user_id,
             destination_ciphertext = excluded.destination_ciphertext,
             verified_at = now(), updated_at = now()`,
      [
        id(NAMESPACE.identity, index + 1),
        account.id,
        identityHashValue,
        encrypt(auth.encryptionKey, account.email),
      ],
    );

    // Optional second login identity. Login is channel-agnostic, so the same
    // account is reachable by phone as well as email.
    if (account.phone) {
      await client.query(
        `insert into auth_identities
           (id, user_id, channel, identity_hash, destination_ciphertext, verified_at)
         values ($1, $2, 'phone', $3, $4, now())
         on conflict (channel, identity_hash) do update
           set user_id = excluded.user_id,
               destination_ciphertext = excluded.destination_ciphertext,
               verified_at = now(), updated_at = now()`,
        [
          id(NAMESPACE.phoneIdentity, index + 1),
          account.id,
          identityHash(auth.secret, 'phone', account.phone),
          encrypt(auth.encryptionKey, account.phone),
        ],
      );
    }

    if (account.campusEmail) {
      await client.query(
        `insert into campus_email_verifications
           (id, user_id, campus_id, identity_hash, verified_at)
         values ($1, $2, $3, $4, now())
         on conflict (user_id) do update
           set campus_id = excluded.campus_id,
               identity_hash = excluded.identity_hash,
               verified_at = now(), updated_at = now()`,
        [
          id(NAMESPACE.campusVerification, index + 1),
          account.id,
          campus.id,
          identityHashValue,
        ],
      );
    }

    await client.query(
      `update auth_sessions
          set revoked_at = now(), updated_at = now()
        where user_id = $1 and revoked_at is null`,
      [account.id],
    );
    const session = await mintSession(client, auth, account.id, index + 1);
    issued.push({
      role: account.key,
      displayName: account.displayName,
      email: account.email,
      phone: account.phone ?? null,
      userId: account.id,
      campusEmailVerified: Boolean(account.campusEmail),
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt,
    });
  }
  return issued;
}

module.exports = { run };
