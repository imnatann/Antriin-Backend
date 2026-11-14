'use strict';

/**
 * Open pickup slots for the next `days` days at the given tenant-local hours,
 * skipping weekdays the tenant is closed. Slots must fit inside the operating
 * window (AvailabilityService re-checks this on every booking), so the fixture
 * hours stay well inside the seeded 07:00-21:00 window.
 */
async function run(client, { tenant, campus, slots }) {
  const closedWeekdays = tenant.closedWeekdays;

  const result = await client.query(
    `insert into pickup_slots
       (tenant_id, starts_at, ends_at, capacity, reserved_count, status, updated_at)
     select $1,
            ((now() at time zone $2)::date + day_offset + make_interval(hours => hour_offset))
              at time zone $2,
            ((now() at time zone $2)::date + day_offset + make_interval(hours => hour_offset + 1))
              at time zone $2,
            $3, 0, 'open', now()
       from generate_series(1, $4) as day_offset,
            unnest($5::int[]) as hour_offset
      where extract(dow from ((now() at time zone $2)::date + day_offset))
              <> all ($6::int[])
     on conflict (tenant_id, starts_at, ends_at) do update
       set capacity = excluded.capacity, status = 'open', updated_at = now()
     returning id`,
    [
      tenant.id,
      campus.timezone,
      slots.capacity,
      slots.days,
      slots.hours,
      closedWeekdays,
    ],
  );

  // Slots seeded on a closed weekday are unusable; close the untouched ones.
  const closed = await client.query(
    `update pickup_slots
        set status = 'closed', updated_at = now()
      where tenant_id = $1 and status = 'open' and reserved_count = 0
        and extract(dow from (starts_at at time zone $2)) = any ($3::int[])`,
    [tenant.id, campus.timezone, closedWeekdays],
  );

  const open = await client.query(
    `select count(*)::int as open_slots, min(starts_at) as next_slot
       from pickup_slots
      where tenant_id = $1 and status = 'open' and starts_at > now()`,
    [tenant.id],
  );

  return {
    upsertedSlots: result.rowCount,
    closedSlots: closed.rowCount,
    openSlots: open.rows[0].open_slots,
    nextSlot: open.rows[0].next_slot
      ? new Date(open.rows[0].next_slot).toISOString()
      : null,
  };
}

module.exports = { run };
