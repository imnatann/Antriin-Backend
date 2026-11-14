'use strict';

const crypto = require('node:crypto');
const { id, NAMESPACE } = require('./ids.cjs');

const DEMO_SCOPE = 'seed.demo';
const CLEARING_KEY = 'seed.demo.clearing';
const CURRENCY = 'IDR';

/**
 * Creates the wallet account at zero balance (a trigger rejects a non-zero
 * initial balance) and, when `fundMinor` is set, posts one balanced ledger
 * transaction so the projection trigger owns the balance.
 *
 * The posting is marked as demo data through the idempotency scope and the
 * transaction reason; it is never presented as a real top-up.
 */
async function ensureWallet(client, { userId, fundMinor, key }) {
  const walletId = id(NAMESPACE.wallet, key);
  await client.query(
    `insert into wallet_accounts (id, account_type, owner_user_id, currency)
     values ($1, 'wallet', $2, $3)
     on conflict do nothing`,
    [walletId, userId, CURRENCY],
  );
  const wallet = await client.query(
    `select id from wallet_accounts
      where owner_user_id = $1 and currency = $2 and account_type = 'wallet'`,
    [userId, CURRENCY],
  );
  const accountId = wallet.rows[0].id;
  if (!fundMinor) return { accountId, fundedMinor: '0' };

  const clearing = await ensureClearingAccount(client);
  const transactionId = id(NAMESPACE.ledgerTransaction, key);
  const idempotencyKey = `seed-buyer-${key}`;
  const requestHash = crypto
    .createHash('sha256')
    .update(`${accountId}:${fundMinor}:${CURRENCY}`)
    .digest('hex');

  const inserted = await client.query(
    `insert into ledger_transactions
       (id, currency, idempotency_scope, idempotency_key, request_hash,
        actor_type, actor_id, reason, metadata)
     values ($1, $2, $3, $4, $5, 'service', 'seed', $6, $7::jsonb)
     on conflict (idempotency_scope, idempotency_key) do nothing
     returning id`,
    [
      transactionId,
      CURRENCY,
      DEMO_SCOPE,
      idempotencyKey,
      requestHash,
      'Demo seed: pilot wallet funding, not a real top-up',
      JSON.stringify({ seeded: true }),
    ],
  );
  if (inserted.rowCount === 0)
    return { accountId, fundedMinor: '0', alreadyFunded: true };

  await client.query(
    `insert into ledger_entries (id, transaction_id, account_id, direction, amount_minor)
     values ($1, $2, $3, 'debit', $4), ($5, $2, $6, 'credit', $4)`,
    [
      id(NAMESPACE.ledgerEntry, key * 2 - 1),
      transactionId,
      clearing.accountId,
      fundMinor,
      id(NAMESPACE.ledgerEntry, key * 2),
      accountId,
    ],
  );
  await client.query(
    `insert into wallet_outbox_events
       (id, event_type, aggregate_type, aggregate_id, payload)
     values ($1, 'ledger.transfer.posted', 'ledger_transaction', $2, $3::jsonb)`,
    [
      id(NAMESPACE.walletOutbox, key),
      transactionId,
      JSON.stringify({ transactionId, currency: CURRENCY }),
    ],
  );
  await client.query(
    `update ledger_transactions set posted_at = now() where id = $1`,
    [transactionId],
  );
  return { accountId, fundedMinor: fundMinor };
}

async function ensureClearingAccount(client) {
  const existing = await client.query(
    `select id from wallet_accounts
      where account_type = 'system' and system_key = $1 and currency = $2`,
    [CLEARING_KEY, CURRENCY],
  );
  if (existing.rows[0]) return { accountId: existing.rows[0].id };
  const accountId = id(NAMESPACE.clearingAccount, 1);
  await client.query(
    `insert into wallet_accounts (id, account_type, system_key, currency)
     values ($1, 'system', $2, $3)
     on conflict do nothing`,
    [accountId, CLEARING_KEY, CURRENCY],
  );
  const created = await client.query(
    `select id from wallet_accounts
      where account_type = 'system' and system_key = $1 and currency = $2`,
    [CLEARING_KEY, CURRENCY],
  );
  return { accountId: created.rows[0].id };
}

module.exports = { ensureWallet, CURRENCY };
