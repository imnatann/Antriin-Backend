'use strict';

const { id, NAMESPACE } = require('../lib/ids.cjs');

/** Campus plus the verified campus email domain that unlocks campus verification. */
async function run(client, { campus }) {
  await client.query(
    `insert into campuses (id, name, timezone, status)
     values ($1, $2, $3, 'active')
     on conflict (id) do update
       set name = excluded.name, timezone = excluded.timezone,
           status = 'active', updated_at = now()`,
    [campus.id, campus.name, campus.timezone],
  );

  await client.query(
    `insert into campus_email_domains
       (id, campus_id, domain, active, verified_at)
     values ($1, $2, $3, true, now())
     on conflict (domain) do update
       set campus_id = excluded.campus_id, active = true,
           verified_at = now(), updated_at = now()`,
    [id(NAMESPACE.campusDomain, 1), campus.id, campus.emailDomain],
  );

  return { campusId: campus.id, emailDomain: campus.emailDomain };
}

module.exports = { run };
