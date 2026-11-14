'use strict';

/** Deterministic UUIDs so re-running the seed is idempotent. */
const id = (namespace, index) =>
  `${String(namespace).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;

const NAMESPACE = Object.freeze({
  campus: 1,
  campusDomain: 2,
  user: 3,
  identity: 4,
  phoneIdentity: 19,
  campusVerification: 5,
  session: 6,
  tenant: 7,
  tenantMembership: 8,
  campusMembership: 9,
  category: 10,
  menuItem: 11,
  optionGroup: 12,
  optionChoice: 13,
  wallet: 14,
  ledgerTransaction: 15,
  ledgerEntry: 16,
  walletOutbox: 17,
  clearingAccount: 18,
});

module.exports = { id, NAMESPACE };
