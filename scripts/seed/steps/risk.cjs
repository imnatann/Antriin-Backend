'use strict';

/**
 * Demo risk signals so the campus risk queue has something to render.
 *
 * These are illustrative rows, not detector output: no model produced them.
 * They are inserted with a fixed dedupe_key so re-running the seed never
 * duplicates them, and they deliberately stay undecided so the default
 * `state=pending` queue is non-empty.
 */
async function run(client, { campus, tenant, riskSignals }) {
  if (!riskSignals || riskSignals.length === 0) return { signals: 0 };

  const result = await client.query(
    `insert into risk_signals
       (campus_id, tenant_id, subject_type, subject_id, category, score,
        model_version, explanation, evidence, dedupe_key, occurred_at)
     select $1, $2, s.subject_type, s.subject_id, s.category, s.score,
            s.model_version, s.explanation, s.evidence::jsonb, s.dedupe_key, now()
       from jsonb_to_recordset($3::jsonb) as s(
         subject_type varchar, subject_id uuid, category varchar, score numeric,
         model_version varchar, explanation text, evidence jsonb, dedupe_key varchar)
     on conflict (dedupe_key) do nothing
     returning id`,
    [campus.id, tenant.id, JSON.stringify(riskSignals)],
  );

  const total = await client.query(
    'select count(*)::int as signals from risk_signals where campus_id = $1',
    [campus.id],
  );
  return { inserted: result.rowCount, signals: total.rows[0].signals };
}

module.exports = { run };
