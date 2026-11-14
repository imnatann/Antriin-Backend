'use strict';

const { id, NAMESPACE } = require('../lib/ids.cjs');

const byKey = (accounts, key) => {
  const account = accounts.find((candidate) => candidate.key === key);
  if (!account) throw new Error(`Fixture account "${key}" is missing`);
  return account;
};

/** Tenant, its staff memberships, the campus admin membership and weekly hours. */
async function run(
  client,
  { campus, tenant, accounts, tenantMemberships, campusMemberships },
) {
  await client.query(
    `insert into tenants
       (id, campus_id, name, location, status, description, contact, pickup_instructions)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (id) do update
       set campus_id = excluded.campus_id, name = excluded.name,
           location = excluded.location, status = excluded.status,
           description = excluded.description, contact = excluded.contact,
           pickup_instructions = excluded.pickup_instructions,
           updated_at = now()`,
    [
      tenant.id,
      campus.id,
      tenant.name,
      tenant.location,
      tenant.status,
      tenant.description,
      tenant.contact,
      tenant.pickupInstructions,
    ],
  );

  for (const [index, membership] of tenantMemberships.entries()) {
    await client.query(
      `insert into tenant_memberships
         (id, tenant_id, user_id, role, permissions, status, owner_verified_at)
       values ($1, $2, $3, $4, $5, 'active', $6)
       on conflict (tenant_id, user_id) do update
         set role = excluded.role, permissions = excluded.permissions,
             status = 'active', revoked_at = null,
             owner_verified_at = excluded.owner_verified_at,
             updated_at = now()`,
      [
        id(NAMESPACE.tenantMembership, index + 1),
        tenant.id,
        byKey(accounts, membership.accountKey).id,
        membership.role,
        membership.permissions,
        membership.ownerVerified ? new Date() : null,
      ],
    );
  }

  for (const [index, membership] of campusMemberships.entries()) {
    await client.query(
      `insert into campus_memberships
         (id, campus_id, user_id, permissions, status)
       values ($1, $2, $3, $4, 'active')
       on conflict (campus_id, user_id) do update
         set permissions = excluded.permissions, status = 'active',
             revoked_at = null, updated_at = now()`,
      [
        id(NAMESPACE.campusMembership, index + 1),
        campus.id,
        byKey(accounts, membership.accountKey).id,
        membership.permissions,
      ],
    );
  }

  // Weekday convention: 0 = Sunday .. 6 = Saturday, tenant-local time.
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const isOpen = !tenant.closedWeekdays.includes(weekday);
    await client.query(
      `insert into tenant_operating_hours
         (tenant_id, weekday, opens_at, closes_at, is_open)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, weekday) do update
         set opens_at = excluded.opens_at, closes_at = excluded.closes_at,
             is_open = excluded.is_open, updated_at = now()`,
      [
        tenant.id,
        weekday,
        isOpen ? tenant.opensAt : null,
        isOpen ? tenant.closesAt : null,
        isOpen,
      ],
    );
  }

  return {
    tenantId: tenant.id,
    staffMemberships: tenantMemberships.length,
    campusMemberships: campusMemberships.length,
    operatingHours: `weekdays ${tenant.opensAt}-${tenant.closesAt}, closed on ${tenant.closedWeekdays.join(',')}`,
  };
}

module.exports = { run };
