'use strict';

const { ensureWallet } = require('../lib/wallet.cjs');

/**
 * Buyer wallets. Balance is posted through the ledger (double entry), never
 * written to wallet_accounts directly; the transaction is tagged as demo seed.
 */
async function run(client, { accounts }) {
  const funded = [];
  for (const [index, account] of accounts.entries()) {
    if (!account.fundMinor) continue;
    const wallet = await ensureWallet(client, {
      userId: account.id,
      fundMinor: account.fundMinor,
      key: index + 1,
    });
    funded.push({
      role: account.key,
      userId: account.id,
      walletAccountId: wallet.accountId,
      balanceMinor: account.fundMinor,
    });
  }
  return funded;
}

module.exports = { run };
