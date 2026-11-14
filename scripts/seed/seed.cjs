#!/usr/bin/env node
/**
 * Pilot seed runner.
 *
 * Idempotent: re-running updates the same rows and mints fresh sessions.
 * Runs inside the api container so it reads the deployed env:
 *
 *   docker exec -i antriin-api-1 node - < scripts/seed/seed.cjs
 *
 * Or against a local database:
 *
 *   npm run db:seed
 *
 * Prints credentials and buyer quickstart values as JSON on stdout.
 * Treat that output as a secret: it contains live bearer tokens.
 */
'use strict';

const { withTransaction } = require('./lib/db.cjs');
const { loadAuthContext } = require('./lib/auth.cjs');
const fixtures = require('./data/fixtures.cjs');

const steps = {
  campus: require('./steps/campus.cjs'),
  accounts: require('./steps/accounts.cjs'),
  tenant: require('./steps/tenant.cjs'),
  catalog: require('./steps/catalog.cjs'),
  availability: require('./steps/availability.cjs'),
  wallet: require('./steps/wallet.cjs'),
  risk: require('./steps/risk.cjs'),
};

async function loadBuyerQuickstart(client, { tenant, campus, menu }) {
  const slot = await client.query(
    `select id, version, starts_at
       from pickup_slots
      where tenant_id = $1 and status = 'open' and starts_at > now()
      order by starts_at
      limit 1`,
    [tenant.id],
  );
  const items = await client.query(
    `select i.id, i.name, i.price_minor::text as price_minor,
            (select json_agg(json_build_object('id', c.id, 'name', c.name))
               from menu_option_groups g
               join menu_option_choices c on c.group_id = g.id and c.status = 'active'
              where g.menu_item_id = i.id and g.status = 'active') as options
       from menu_items i
      where i.tenant_id = $1 and i.status = 'active'
      order by i.name`,
    [tenant.id],
  );
  const counts = await client.query(
    `select
       (select count(*) from users)::int as users,
       (select count(*) from tenant_memberships where tenant_id = $1 and status = 'active')::int as tenant_members,
       (select count(*) from campus_memberships where campus_id = $2 and status = 'active')::int as campus_members,
       (select count(*) from menu_items where tenant_id = $1 and status = 'active')::int as menu_items,
       (select count(*) from pickup_slots where tenant_id = $1 and status = 'open' and starts_at > now())::int as open_slots`,
    [tenant.id, campus.id],
  );
  return {
    counts: counts.rows[0],
    slot: slot.rows[0]
      ? {
          slotId: slot.rows[0].id,
          version: slot.rows[0].version,
          startsAt: new Date(slot.rows[0].starts_at).toISOString(),
        }
      : null,
    menu: items.rows,
    expectedMenuCount: menu.length,
  };
}

async function main() {
  const auth = loadAuthContext();
  const summary = await withTransaction(async (client) => {
    const run = async (name, step, context) => {
      try {
        return await step.run(client, context);
      } catch (error) {
        throw new Error(`step "${name}" failed: ${error.message}`, {
          cause: error,
        });
      }
    };
    const campus = await run('campus', steps.campus, fixtures);
    const accounts = await run('accounts', steps.accounts, {
      ...fixtures,
      auth,
    });
    const tenant = await run('tenant', steps.tenant, fixtures);
    const catalog = await run('catalog', steps.catalog, fixtures);
    const availability = await run(
      'availability',
      steps.availability,
      fixtures,
    );
    const wallets = await run('wallet', steps.wallet, fixtures);
    const risk = await run('risk', steps.risk, fixtures);
    const quickstart = await loadBuyerQuickstart(client, fixtures);
    return {
      campus,
      accounts,
      tenant,
      catalog,
      availability,
      wallets,
      risk,
      quickstart,
    };
  });

  if (summary.quickstart.menu.length !== summary.quickstart.expectedMenuCount)
    throw new Error(
      `Expected ${summary.quickstart.expectedMenuCount} active menu items, found ${summary.quickstart.menu.length}`,
    );
  if (!summary.quickstart.slot)
    throw new Error('No bookable pickup slot was seeded');
  if (summary.quickstart.counts.open_slots < 1)
    throw new Error('No open pickup slot remains after seeding');

  const buyer = summary.accounts.find((account) => account.role === 'buyer');
  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        campus: summary.campus,
        tenant: { id: summary.tenant.tenantId, ...fixtures.tenant },
        counts: summary.quickstart.counts,
        accounts: summary.accounts,
        wallets: summary.wallets,
        risk: summary.risk,
        buyerQuickstart: {
          authorizationHeader: `Bearer ${buyer.sessionToken}`,
          tenantId: fixtures.tenant.id,
          slotId: summary.quickstart.slot.slotId,
          expectedSlotVersion: summary.quickstart.slot.version,
          slotStartsAt: summary.quickstart.slot.startsAt,
          menu: summary.quickstart.menu,
        },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`seed failed: ${error.message}\n`);
  process.exit(1);
});
