# Pilot seed

Idempotent demo data for a fresh Antriin database: one campus, one tenant with
staff memberships, a menu, open pickup slots, demo buyer wallets and one bearer
session per demo account.

OTP delivery is not configured on the pilot host, so login through
`POST /api/v1/auth/otp-challenges` cannot complete. The seed mints sessions
directly with `AUTH_SECRET` / `AUTH_ENCRYPTION_KEY`, using the same HMAC and
AES-256-GCM construction as `AuthService`.

## Run against the pilot host

From this repository:

```sh
tar -c scripts/seed | ssh root@<host> 'tar -x -C /opt/antriin'
ssh root@<host> 'docker cp /opt/antriin/scripts/seed antriin-api-1:/tmp/seed'
ssh root@<host> 'docker exec -e NODE_PATH=/app/node_modules antriin-api-1 node /tmp/seed/seed.cjs' > seed-output.json
chmod 600 seed-output.json
```

Against a local database (`.env` must point at it):

```sh
npm run db:seed > seed-output.json
```

`seed-output.json` contains live bearer tokens. Do not commit it; it is
gitignored through the `seed-output*.json` pattern.

## What it creates

| Step                     | Rows                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `steps/campus.cjs`       | campus `Kampus Demo Antriin`, verified domain `demo.ac.id`                                            |
| `steps/accounts.cjs`     | 5 users, email identities, campus verifications, sessions                                             |
| `steps/tenant.cjs`       | tenant `Kantin Demo Sehat`, owner/kitchen/pickup + campus admin memberships, weekly hours 07:00-21:00 |
| `steps/catalog.cjs`      | 2 categories, 4 menu items, 1 option group with 4 choices                                             |
| `steps/availability.cjs` | 24 open pickup slots (4 days x 6 hours), capacity 10                                                  |
| `steps/wallet.cjs`       | buyer wallet funded through a balanced demo ledger transaction                                        |

## Accounts

| Role         | Email                  | Phone            | Campus email verified | Wallet     |
| ------------ | ---------------------- | ---------------- | --------------------- | ---------- |
| buyer        | `pembeli@demo.ac.id`   | `+6281200000001` | yes                   | Rp 200.000 |
| owner        | `pemilik@antriin.demo` | `+6281200000002` | no                    | -          |
| kitchen      | `dapur@antriin.demo`   | `+6281200000003` | no                    | -          |
| pickup       | `pickup@antriin.demo`  | `+6281200000004` | no                    | -          |
| campus_admin | `admin@demo.ac.id`     | `+6281200000005` | yes                   | -          |

Email and phone are both login identities on the same account: either one lands
you in the same user. Login is not role-specific, so a tenant owner signs in
through the same endpoint as a buyer and gets tenant access from their
`tenant_memberships` row.

The wallet balance is posted as a ledger transfer from the system account
`seed.demo.clearing`, with idempotency scope `seed.demo`. It is demo money, not
a provider top-up: no provider event, no `topup_intents` row. Re-running the
seed does not add balance again.

Re-running also revokes the previously issued sessions and prints new tokens,
so an old `seed-output.json` stops working.

## Buyer smoke test

`seed-output.json` -> `buyerQuickstart` holds the header, tenant, slot and menu
IDs. Checkout:

```sh
curl -sS http://<host>:3000/api/v1/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"tenantId":"'$TENANT_ID'","slotId":"'$SLOT_ID'","expectedSlotVersion":'$VERSION',
       "items":[{"menuItemId":"'$ITEM_ID'","quantity":1,"optionIds":[]}]}'
```
