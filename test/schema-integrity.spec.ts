import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

/**
 * Schema integrity tests for migration 0007 (task-6, decisions D12 +
 * docs/reviews/schema-wave1.md R1-01..R1-22). Every new FK / UNIQUE / PK /
 * CHECK added by 0007 is exercised against a real PostgreSQL 17 by attempting
 * a violating statement and asserting the exact SQLSTATE + constraint name,
 * plus positive controls proving valid data still inserts.
 *
 * Fixtures are synthetic and disposable (TEST_DATABASE_URL only). Timestamps
 * are produced by SQL now() expressions (microsecond precision, D7) instead of
 * JS Date serialization.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;

interface World {
  suffix: string;
  campusId: string;
  tenantAId: string;
  tenantBId: string;
  buyerId: string;
  otherUserId: string;
  staffUserId: string;
  buyerWalletId: string;
  otherWalletId: string;
  slotA1Id: string;
  slotA2Id: string;
  slotB1Id: string;
  slotB2Id: string;
  categoryIdA: string;
}

async function createWorld(pool: Pool): Promise<World> {
  const suffix = randomUUID();
  const one = async (sqlText: string): Promise<string> => {
    const res = await pool.query<{ id: string }>(sqlText);
    return res.rows[0].id;
  };
  const campusId = await one(
    `insert into campuses (name, timezone, status) values (${q(`Campus ${suffix}`)}, 'Asia/Jakarta', 'active') returning id`,
  );
  const tenant = async (label: string): Promise<string> =>
    one(
      `insert into tenants (campus_id, name, location, status) values ('${campusId}', ${q(`Tenant ${label} ${suffix}`)}, 'Kantin Utara', 'open') returning id`,
    );
  const tenantAId = await tenant('A');
  const tenantBId = await tenant('B');
  const user = async (label: string): Promise<string> =>
    one(
      `insert into users (display_name) values (${q(`${label} ${suffix}`)}) returning id`,
    );
  const buyerId = await user('Buyer');
  const otherUserId = await user('Other');
  const staffUserId = await user('Staff');
  const wallet = async (ownerId: string): Promise<string> =>
    one(
      `insert into wallet_accounts (account_type, owner_user_id, currency, balance_minor) values ('wallet', '${ownerId}', 'IDR', '0') returning id`,
    );
  const buyerWalletId = await wallet(buyerId);
  const otherWalletId = await wallet(otherUserId);
  const slot = async (tenantId: string, offsetHours: number): Promise<string> =>
    one(
      `insert into pickup_slots (tenant_id, starts_at, ends_at, capacity, status)
       values ('${tenantId}', now() + interval '${offsetHours} hours', now() + interval '${offsetHours + 1} hours', 5, 'open') returning id`,
    );
  const slotA1Id = await slot(tenantAId, 24);
  const slotA2Id = await slot(tenantAId, 26);
  const slotB1Id = await slot(tenantBId, 24);
  const slotB2Id = await slot(tenantBId, 26);
  const categoryIdA = await one(
    `insert into menu_categories (tenant_id, name, status) values ('${tenantAId}', ${q(`Cat ${suffix}`)}, 'active') returning id`,
  );
  return {
    suffix,
    campusId,
    tenantAId,
    tenantBId,
    buyerId,
    otherUserId,
    staffUserId,
    buyerWalletId,
    otherWalletId,
    slotA1Id,
    slotA2Id,
    slotB1Id,
    slotB2Id,
    categoryIdA,
  };
}

type Overrides = Record<string, string>;

function buildInsert(
  table: string,
  values: Overrides,
  returning = 'id',
): string {
  const cols = Object.keys(values).join(', ');
  const vals = Object.values(values).join(', ');
  return `insert into ${table} (${cols}) values (${vals}) returning ${returning}`;
}

async function insertOrder(
  pool: Pool,
  w: World,
  overrides: Overrides = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    buildInsert('orders', {
      buyer_id: `'${w.buyerId}'::uuid`,
      tenant_id: `'${w.tenantAId}'::uuid`,
      pickup_slot_id: `'${w.slotA1Id}'::uuid`,
      tenant_name_snapshot: q(`Tenant A ${w.suffix}`),
      tenant_timezone_snapshot: "'Asia/Jakarta'",
      pickup_starts_at: "now() + interval '24 hours'",
      pickup_ends_at: "now() + interval '25 hours'",
      currency: "'IDR'",
      subtotal_minor: "'1000'",
      total_minor: "'1000'",
      ...overrides,
    }),
  );
  return res.rows[0].id;
}

async function insertReservation(
  pool: Pool,
  w: World,
  orderId: string,
  overrides: Overrides = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    buildInsert('slot_reservations', {
      tenant_id: `'${w.tenantAId}'::uuid`,
      slot_id: `'${w.slotA1Id}'::uuid`,
      order_id: `'${orderId}'::uuid`,
      ...overrides,
    }),
  );
  return res.rows[0].id;
}

async function insertProposal(
  pool: Pool,
  w: World,
  orderId: string,
  overrides: Overrides = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    buildInsert('schedule_proposals', {
      order_id: `'${orderId}'::uuid`,
      tenant_id: `'${w.tenantAId}'::uuid`,
      buyer_id: `'${w.buyerId}'::uuid`,
      old_slot_id: `'${w.slotA1Id}'::uuid`,
      proposed_slot_id: `'${w.slotA2Id}'::uuid`,
      old_starts_at: "now() + interval '24 hours'",
      old_ends_at: "now() + interval '25 hours'",
      proposed_starts_at: "now() + interval '26 hours'",
      proposed_ends_at: "now() + interval '27 hours'",
      expected_slot_version: '1',
      expected_order_version: '1',
      reason: "'tenant unavailable'",
      created_by_user_id: `'${w.staffUserId}'::uuid`,
      expires_at: "now() + interval '10 minutes'",
      ...overrides,
    }),
  );
  return res.rows[0].id;
}

async function insertCredential(
  pool: Pool,
  orderId: string,
  overrides: Overrides = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    buildInsert('pickup_credentials', {
      order_id: `'${orderId}'::uuid`,
      code_hash: q(sha256(randomUUID())),
      code_ciphertext: "'v1:test-ciphertext'",
      expires_at: "now() + interval '2 hours'",
      ...overrides,
    }),
  );
  return res.rows[0].id;
}

async function insertIdempotency(
  pool: Pool,
  w: World,
  orderId: string,
  overrides: Overrides = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    buildInsert('order_request_idempotency', {
      actor_user_id: `'${w.buyerId}'::uuid`,
      route_name: "'checkout.create'",
      key_hash: q(sha256(randomUUID())),
      request_hash: q(sha256(randomUUID())),
      order_id: `'${orderId}'::uuid`,
      response_body: "'{}'::jsonb",
      ...overrides,
    }),
  );
  return res.rows[0].id;
}

async function insertEvent(
  pool: Pool,
  orderId: string,
  version: number,
  overrides: Overrides = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    buildInsert('order_events', {
      order_id: `'${orderId}'::uuid`,
      version: String(version),
      event_type: "'order.created'",
      actor_service: "'schema-integrity-test'",
      reason: "'fixture'",
      ...overrides,
    }),
  );
  return res.rows[0].id;
}

async function insertOrderItem(
  pool: Pool,
  orderId: string,
  overrides: Overrides = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    buildInsert('order_items', {
      order_id: `'${orderId}'::uuid`,
      source_menu_item_id: `'${randomUUID()}'::uuid`,
      source_category_id: `'${randomUUID()}'::uuid`,
      name_snapshot: "'Nasi Goreng'",
      description_snapshot: "''",
      menu_version: '1',
      quantity: '2',
      base_unit_price_minor: "'500'",
      unit_price_minor: "'500'",
      line_total_minor: "'1000'",
      ...overrides,
    }),
  );
  return res.rows[0].id;
}

async function insertTopup(
  pool: Pool,
  w: World,
  overrides: Overrides = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    buildInsert('topup_intents', {
      user_id: `'${w.buyerId}'::uuid`,
      wallet_account_id: `'${w.buyerWalletId}'::uuid`,
      provider: "'sandbox'",
      provider_reference: q(`ref-${randomUUID()}`),
      idempotency_key: q(`key-${randomUUID()}`),
      request_hash: q(sha256(randomUUID())),
      amount_minor: "'10000'",
      currency: "'IDR'",
      ...overrides,
    }),
  );
  return res.rows[0].id;
}

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

async function expectViolation(
  pool: Pool,
  sqlText: string,
  code: string,
  constraint: string | string[],
): Promise<PgError> {
  const allowed = Array.isArray(constraint) ? constraint : [constraint];
  let captured: PgError | null = null;
  try {
    await pool.query(sqlText);
  } catch (error) {
    captured = error as PgError;
  }
  assert.ok(
    captured,
    `expected ${code} (${allowed.join(' | ')}) but the statement succeeded: ${sqlText.slice(0, 200)}`,
  );
  assert.equal(
    captured.code,
    code,
    `wrong SQLSTATE for [${allowed.join(' | ')}]: ${captured.message}`,
  );
  assert.ok(
    captured.constraint !== undefined && allowed.includes(captured.constraint),
    `wrong constraint: got ${captured.constraint ?? 'none'}, expected one of ${allowed.join(' | ')} (${captured.message})`,
  );
  return captured;
}

describe(
  'Schema 0007 integrity against PostgreSQL',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let w: World;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
      await pool.query('select 1');
      w = await createWorld(pool);
    });

    after(async () => {
      await pool?.end();
    });

    it('0007 structure exists in pg_constraint/pg_indexes (R1-01..R1-17)', async () => {
      const expected: Array<[string, string]> = [
        // contype 'f' = foreign key
        ['orders_tenant_slot_fk', 'f'],
        ['slot_reservations_order_fk', 'f'],
        ['schedule_proposals_tenant_order_fk', 'f'],
        ['schedule_proposals_tenant_proposed_slot_fk', 'f'],
        ['schedule_proposals_tenant_old_slot_fk', 'f'],
        ['order_handovers_tenant_order_fk', 'f'],
        ['order_handovers_order_credential_fk', 'f'],
        ['topup_intents_user_wallet_fk', 'f'],
        ['order_events_request_fk', 'f'],
        // contype 'u' = unique constraint (composite FK targets, D12.3)
        ['orders_tenant_id_id_uq', 'u'],
        ['orders_buyer_id_id_uq', 'u'],
        ['pickup_credentials_order_id_id_uq', 'u'],
        ['wallet_accounts_owner_id_uq', 'u'],
        // contype 'p' = primary key (R1-17)
        ['tenant_operating_hours_pk', 'p'],
        ['tenant_operating_hour_overrides_pk', 'p'],
        // contype 'c' = check
        ['orders_status_timestamps_check', 'c'],
        ['orders_timestamps_monotonic_check', 'c'],
        ['orders_total_equals_subtotal_check', 'c'],
        ['orders_positive_totals_check', 'c'],
        ['order_items_line_total_check', 'c'],
        ['order_items_quantity_check', 'c'],
        ['schedule_proposals_expires_at_check', 'c'],
        ['schedule_proposals_decided_at_check', 'c'],
        ['topup_intents_expires_at_check', 'c'],
        ['topup_intents_succeeded_at_check', 'c'],
        ['menu_items_archived_at_check', 'c'],
        ['slot_reservations_consumed_at_check', 'c'],
        ['pickup_credentials_expires_at_check', 'c'],
        ['pickup_credentials_consume_revoke_check', 'c'],
        ['order_events_type_check', 'c'],
      ];
      const found = await pool.query<{
        conname: string;
        contype: string;
        def: string;
      }>(
        `select con.conname, con.contype, pg_get_constraintdef(con.oid) as def
           from pg_constraint con
           join pg_class rel on rel.oid = con.conrelid
          where con.conname = any($1::text[])`,
        [expected.map(([name]) => name)],
      );
      const byName = new Map(found.rows.map((r) => [r.conname, r]));
      for (const [name, contype] of expected) {
        const row = byName.get(name);
        assert.ok(row, `missing constraint ${name}`);
        assert.equal(row.contype, contype, `wrong contype for ${name}`);
      }
      // Widened closed enums / bounds (R1-15, R1-22).
      const eventTypes = byName.get('order_events_type_check')?.def ?? '';
      for (const type of [
        'order.created',
        'order.status_changed',
        'order.cancelled',
        'order.declined',
        'schedule_proposal.created',
        'schedule_proposal.decided',
        'pickup_credential.issued',
        'pickup_credential.revoked',
      ]) {
        assert.ok(eventTypes.includes(type), `event_type enum missing ${type}`);
      }
      assert.match(
        byName.get('order_items_quantity_check')?.def ?? '',
        />= 1\).*<= 999/,
        'quantity bound must be 1..999 (R1-22)',
      );
      // Composite FK shapes + RESTRICT semantics.
      const tenantSlot = byName.get('orders_tenant_slot_fk')?.def ?? '';
      assert.ok(tenantSlot.includes('(tenant_id, pickup_slot_id)'));
      assert.ok(tenantSlot.includes('pickup_slots(tenant_id, id)'));
      assert.ok(tenantSlot.includes('ON DELETE RESTRICT'));
      const userWallet = byName.get('topup_intents_user_wallet_fk')?.def ?? '';
      assert.ok(userWallet.includes('(user_id, wallet_account_id)'));
      assert.ok(userWallet.includes('wallet_accounts(owner_user_id, id)'));

      const indexes = await pool.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes where indexname = any($1::text[])`,
        [
          [
            'orders_order_number_uq',
            'order_events_order_request_idx',
            'order_request_idempotency_expires_idx',
          ],
        ],
      );
      const idxByName = new Map(
        indexes.rows.map((r) => [r.indexname, r.indexdef]),
      );
      assert.match(
        idxByName.get('orders_order_number_uq') ?? '',
        /UNIQUE INDEX/,
      );
      assert.ok(
        (idxByName.get('order_events_order_request_idx') ?? '').includes(
          'order_id, request_id',
        ),
      );
      assert.match(
        idxByName.get('order_request_idempotency_expires_idx') ?? '',
        /WHERE.*expires_at.*IS NOT NULL/i,
        'R1-16 cleanup index must be partial',
      );

      const columns = await pool.query<{
        table_name: string;
        column_name: string;
        is_nullable: string;
        data_type: string;
      }>(
        `select table_name, column_name, is_nullable, data_type
           from information_schema.columns
          where (table_name, column_name) in (
            ('orders','order_number'), ('orders','paid_at'), ('orders','cancelled_at'),
            ('orders','declined_at'), ('order_items','notes'),
            ('slot_reservations','consumed_at'), ('slot_reservations','updated_at'),
            ('topup_intents','expires_at'), ('topup_intents','succeeded_at'),
            ('menu_items','image_ref'), ('menu_items','archived_at'),
            ('order_request_idempotency','expires_at'), ('order_events','request_id'),
            ('tenant_operating_hours','created_at'),
            ('tenant_operating_hour_overrides','created_at'))`,
      );
      assert.equal(columns.rowCount, 15, 'all 15 new columns must exist');
      const col = (t: string, c: string) =>
        columns.rows.find((r) => r.table_name === t && r.column_name === c);
      assert.equal(col('orders', 'order_number')?.is_nullable, 'YES');
      assert.equal(col('order_items', 'notes')?.is_nullable, 'NO');
      assert.equal(col('slot_reservations', 'updated_at')?.is_nullable, 'NO');
      assert.equal(
        col('tenant_operating_hours', 'created_at')?.is_nullable,
        'NO',
      );
      assert.equal(col('order_events', 'request_id')?.data_type, 'uuid');
    });

    it('R1-01: order cannot reference a slot of another tenant', async () => {
      await expectViolation(
        pool,
        buildInsert('orders', {
          buyer_id: `'${w.buyerId}'::uuid`,
          tenant_id: `'${w.tenantAId}'::uuid`,
          pickup_slot_id: `'${w.slotB1Id}'::uuid`,
          tenant_name_snapshot: q(`Tenant A ${w.suffix}`),
          tenant_timezone_snapshot: "'Asia/Jakarta'",
          pickup_starts_at: "now() + interval '24 hours'",
          pickup_ends_at: "now() + interval '25 hours'",
          currency: "'IDR'",
          subtotal_minor: "'1000'",
          total_minor: "'1000'",
        }),
        '23503',
        'orders_tenant_slot_fk',
      );
      // Nonexistent slot is rejected by the same FK.
      await expectViolation(
        pool,
        buildInsert('orders', {
          buyer_id: `'${w.buyerId}'::uuid`,
          tenant_id: `'${w.tenantAId}'::uuid`,
          pickup_slot_id: `'${randomUUID()}'::uuid`,
          tenant_name_snapshot: q(`Tenant A ${w.suffix}`),
          tenant_timezone_snapshot: "'Asia/Jakarta'",
          pickup_starts_at: "now() + interval '24 hours'",
          pickup_ends_at: "now() + interval '25 hours'",
          currency: "'IDR'",
          subtotal_minor: "'1000'",
          total_minor: "'1000'",
        }),
        '23503',
        'orders_tenant_slot_fk',
      );
      // Positive control: matching tenant slot inserts.
      const orderId = await insertOrder(pool, w);
      assert.ok(orderId);
    });

    it('R1-02: slot reservation must reference a real order and keeps it undeletable', async () => {
      await expectViolation(
        pool,
        buildInsert('slot_reservations', {
          tenant_id: `'${w.tenantAId}'::uuid`,
          slot_id: `'${w.slotA1Id}'::uuid`,
          order_id: `'${randomUUID()}'::uuid`,
        }),
        '23503',
        'slot_reservations_order_fk',
      );
      const orderId = await insertOrder(pool, w);
      const reservationId = await insertReservation(pool, w, orderId);
      assert.ok(reservationId);
      // ON DELETE RESTRICT: the order cannot be deleted while reserved.
      await expectViolation(
        pool,
        `delete from orders where id = '${orderId}'::uuid`,
        '23503',
        'slot_reservations_order_fk',
      );
    });

    it('R1-03: proposals and handovers stay inside the order tenant', async () => {
      const orderId = await insertOrder(pool, w);
      // Proposal whose tenant differs from the order's tenant.
      await expectViolation(
        pool,
        buildInsert('schedule_proposals', {
          order_id: `'${orderId}'::uuid`,
          tenant_id: `'${w.tenantBId}'::uuid`,
          buyer_id: `'${w.buyerId}'::uuid`,
          old_slot_id: `'${w.slotB1Id}'::uuid`,
          proposed_slot_id: `'${w.slotB2Id}'::uuid`,
          old_starts_at: "now() + interval '24 hours'",
          old_ends_at: "now() + interval '25 hours'",
          proposed_starts_at: "now() + interval '26 hours'",
          proposed_ends_at: "now() + interval '27 hours'",
          expected_slot_version: '1',
          expected_order_version: '1',
          reason: "'cross tenant attempt'",
          created_by_user_id: `'${w.staffUserId}'::uuid`,
          expires_at: "now() + interval '10 minutes'",
        }),
        '23503',
        'schedule_proposals_tenant_order_fk',
      );
      // Proposal pointing at another tenant's slot.
      await expectViolation(
        pool,
        buildInsert('schedule_proposals', {
          order_id: `'${orderId}'::uuid`,
          tenant_id: `'${w.tenantAId}'::uuid`,
          buyer_id: `'${w.buyerId}'::uuid`,
          old_slot_id: `'${w.slotA1Id}'::uuid`,
          proposed_slot_id: `'${w.slotB1Id}'::uuid`,
          old_starts_at: "now() + interval '24 hours'",
          old_ends_at: "now() + interval '25 hours'",
          proposed_starts_at: "now() + interval '24 hours'",
          proposed_ends_at: "now() + interval '25 hours'",
          expected_slot_version: '1',
          expected_order_version: '1',
          reason: "'foreign slot attempt'",
          created_by_user_id: `'${w.staffUserId}'::uuid`,
          expires_at: "now() + interval '10 minutes'",
        }),
        '23503',
        'schedule_proposals_tenant_proposed_slot_fk',
      );
      // Positive control: consistent proposal.
      assert.ok(await insertProposal(pool, w, orderId));

      // Handover recorded by another tenant.
      const credentialId = await insertCredential(pool, orderId);
      await expectViolation(
        pool,
        buildInsert('order_handovers', {
          order_id: `'${orderId}'::uuid`,
          credential_id: `'${credentialId}'::uuid`,
          tenant_id: `'${w.tenantBId}'::uuid`,
          actor_user_id: `'${w.staffUserId}'::uuid`,
        }),
        '23503',
        'order_handovers_tenant_order_fk',
      );
      // Handover using a credential that belongs to a different order.
      const otherOrderId = await insertOrder(pool, w);
      const otherCredentialId = await insertCredential(pool, otherOrderId);
      await expectViolation(
        pool,
        buildInsert('order_handovers', {
          order_id: `'${orderId}'::uuid`,
          credential_id: `'${otherCredentialId}'::uuid`,
          tenant_id: `'${w.tenantAId}'::uuid`,
          actor_user_id: `'${w.staffUserId}'::uuid`,
        }),
        '23503',
        'order_handovers_order_credential_fk',
      );
      // Positive control: matching order + credential + tenant.
      const handover = await pool.query<{ id: string }>(
        buildInsert('order_handovers', {
          order_id: `'${orderId}'::uuid`,
          credential_id: `'${credentialId}'::uuid`,
          tenant_id: `'${w.tenantAId}'::uuid`,
          actor_user_id: `'${w.staffUserId}'::uuid`,
        }),
      );
      assert.ok(handover.rows[0].id);
    });

    it('R1-04: top-up cannot credit a wallet owned by another user', async () => {
      await expectViolation(
        pool,
        buildInsert('topup_intents', {
          user_id: `'${w.otherUserId}'::uuid`,
          wallet_account_id: `'${w.buyerWalletId}'::uuid`,
          provider: "'sandbox'",
          provider_reference: q(`ref-${randomUUID()}`),
          idempotency_key: q(`key-${randomUUID()}`),
          request_hash: q(sha256(randomUUID())),
          amount_minor: "'10000'",
          currency: "'IDR'",
        }),
        '23503',
        'topup_intents_user_wallet_fk',
      );
      // A system wallet (owner NULL) can never match a user top-up either.
      const systemWallet = await pool.query<{ id: string }>(
        `insert into wallet_accounts (account_type, system_key, currency, balance_minor)
         values ('system', ${q(`sys-${randomUUID()}`)}, 'IDR', '0') returning id`,
      );
      await expectViolation(
        pool,
        buildInsert('topup_intents', {
          user_id: `'${w.buyerId}'::uuid`,
          wallet_account_id: `'${systemWallet.rows[0].id}'::uuid`,
          provider: "'sandbox'",
          provider_reference: q(`ref-${randomUUID()}`),
          idempotency_key: q(`key-${randomUUID()}`),
          request_hash: q(sha256(randomUUID())),
          amount_minor: "'10000'",
          currency: "'IDR'",
        }),
        '23503',
        'topup_intents_user_wallet_fk',
      );
      // Positive control: own wallet.
      assert.ok(await insertTopup(pool, w));
    });

    it('R1-05: order status and transition timestamps must agree', async () => {
      // paid_awaiting_tenant may not carry production timestamps.
      await expectViolation(
        pool,
        buildInsert('orders', {
          buyer_id: `'${w.buyerId}'::uuid`,
          tenant_id: `'${w.tenantAId}'::uuid`,
          pickup_slot_id: `'${w.slotA1Id}'::uuid`,
          tenant_name_snapshot: q(`Tenant A ${w.suffix}`),
          tenant_timezone_snapshot: "'Asia/Jakarta'",
          pickup_starts_at: "now() + interval '24 hours'",
          pickup_ends_at: "now() + interval '25 hours'",
          currency: "'IDR'",
          subtotal_minor: "'1000'",
          total_minor: "'1000'",
          confirmed_at: 'now()',
        }),
        '23514',
        'orders_status_timestamps_check',
      );
      const orderBase: Overrides = {
        buyer_id: `'${w.buyerId}'::uuid`,
        tenant_id: `'${w.tenantAId}'::uuid`,
        pickup_slot_id: `'${w.slotA1Id}'::uuid`,
        tenant_name_snapshot: q(`Tenant A ${w.suffix}`),
        tenant_timezone_snapshot: "'Asia/Jakarta'",
        pickup_starts_at: "now() + interval '24 hours'",
        pickup_ends_at: "now() + interval '25 hours'",
        currency: "'IDR'",
        subtotal_minor: "'1000'",
        total_minor: "'1000'",
      };
      // confirmed requires confirmed_at and paid_at.
      await expectViolation(
        pool,
        buildInsert('orders', {
          ...orderBase,
          status: "'confirmed'",
          confirmed_at: 'now()',
        }),
        '23514',
        'orders_status_timestamps_check',
      );
      // completed additionally requires ready_at and completed_at.
      await expectViolation(
        pool,
        buildInsert('orders', {
          ...orderBase,
          status: "'completed'",
          paid_at: 'now()',
          confirmed_at: 'now()',
        }),
        '23514',
        'orders_status_timestamps_check',
      );
      // cancelled / declined require their terminal timestamp.
      await expectViolation(
        pool,
        buildInsert('orders', { ...orderBase, status: "'cancelled'" }),
        '23514',
        'orders_status_timestamps_check',
      );
      await expectViolation(
        pool,
        buildInsert('orders', { ...orderBase, status: "'declined'" }),
        '23514',
        'orders_status_timestamps_check',
      );
      // Monotonicity: preparing_at before confirmed_at is rejected.
      await expectViolation(
        pool,
        buildInsert('orders', {
          ...orderBase,
          status: "'preparing'",
          paid_at: "now() - interval '2 hours'",
          confirmed_at: "now() - interval '1 hour'",
          preparing_at: "now() - interval '3 hours'",
        }),
        '23514',
        'orders_timestamps_monotonic_check',
      );
      // Positive control: a fully consistent completed order (created_at is
      // pinned in the past so the monotonic chain holds).
      const completedId = await insertOrder(pool, w, {
        status: "'completed'",
        created_at: "now() - interval '4 hours'",
        paid_at: "now() - interval '3 hours'",
        confirmed_at: "now() - interval '2 hours'",
        preparing_at: "now() - interval '90 minutes'",
        ready_at: "now() - interval '1 hour'",
        completed_at: "now() - interval '30 minutes'",
      });
      assert.ok(completedId);
    });

    it('R1-06: proposal expiry and decision invariants hold', async () => {
      const orderId = await insertOrder(pool, w);
      await expectViolation(
        pool,
        buildInsert('schedule_proposals', {
          order_id: `'${orderId}'::uuid`,
          tenant_id: `'${w.tenantAId}'::uuid`,
          buyer_id: `'${w.buyerId}'::uuid`,
          old_slot_id: `'${w.slotA1Id}'::uuid`,
          proposed_slot_id: `'${w.slotA2Id}'::uuid`,
          old_starts_at: "now() + interval '24 hours'",
          old_ends_at: "now() + interval '25 hours'",
          proposed_starts_at: "now() + interval '26 hours'",
          proposed_ends_at: "now() + interval '27 hours'",
          expected_slot_version: '1',
          expected_order_version: '1',
          reason: "'expired before created'",
          created_by_user_id: `'${w.staffUserId}'::uuid`,
          created_at: 'now()',
          expires_at: 'now()',
        }),
        '23514',
        'schedule_proposals_expires_at_check',
      );
      // Decided status without decided_at.
      await expectViolation(
        pool,
        buildInsert('schedule_proposals', {
          order_id: `'${orderId}'::uuid`,
          tenant_id: `'${w.tenantAId}'::uuid`,
          buyer_id: `'${w.buyerId}'::uuid`,
          old_slot_id: `'${w.slotA1Id}'::uuid`,
          proposed_slot_id: `'${w.slotA2Id}'::uuid`,
          old_starts_at: "now() + interval '24 hours'",
          old_ends_at: "now() + interval '25 hours'",
          proposed_starts_at: "now() + interval '26 hours'",
          proposed_ends_at: "now() + interval '27 hours'",
          expected_slot_version: '1',
          expected_order_version: '1',
          status: "'accepted'",
          reason: "'accepted without decision time'",
          created_by_user_id: `'${w.staffUserId}'::uuid`,
          expires_at: "now() + interval '10 minutes'",
        }),
        '23514',
        'schedule_proposals_decided_at_check',
      );
      // Pending proposal must not carry decided_at.
      await expectViolation(
        pool,
        buildInsert('schedule_proposals', {
          order_id: `'${orderId}'::uuid`,
          tenant_id: `'${w.tenantAId}'::uuid`,
          buyer_id: `'${w.buyerId}'::uuid`,
          old_slot_id: `'${w.slotA1Id}'::uuid`,
          proposed_slot_id: `'${w.slotA2Id}'::uuid`,
          old_starts_at: "now() + interval '24 hours'",
          old_ends_at: "now() + interval '25 hours'",
          proposed_starts_at: "now() + interval '26 hours'",
          proposed_ends_at: "now() + interval '27 hours'",
          expected_slot_version: '1',
          expected_order_version: '1',
          reason: "'pending but decided'",
          created_by_user_id: `'${w.staffUserId}'::uuid`,
          expires_at: "now() + interval '10 minutes'",
          decided_at: 'now()',
        }),
        '23514',
        'schedule_proposals_decided_at_check',
      );
      // Positive control: decided proposal with decided_at.
      const decidedId = await insertProposal(pool, w, orderId, {
        status: "'accepted'",
        decided_at: 'now()',
      });
      assert.ok(decidedId);
    });

    it('R1-07: money arithmetic is enforced (line total, total=subtotal, total>0)', async () => {
      const orderId = await insertOrder(pool, w);
      // line_total != unit_price * quantity.
      await expectViolation(
        pool,
        buildInsert('order_items', {
          order_id: `'${orderId}'::uuid`,
          source_menu_item_id: `'${randomUUID()}'::uuid`,
          source_category_id: `'${randomUUID()}'::uuid`,
          name_snapshot: "'Nasi Goreng'",
          description_snapshot: "''",
          menu_version: '1',
          quantity: '2',
          base_unit_price_minor: "'500'",
          unit_price_minor: "'500'",
          line_total_minor: "'1001'",
        }),
        '23514',
        'order_items_line_total_check',
      );
      // Positive control: exact arithmetic (also proves R1-12 notes default).
      const itemId = await insertOrderItem(pool, orderId);
      const item = await pool.query<{ notes: string }>(
        `select notes from order_items where id = '${itemId}'::uuid`,
      );
      assert.equal(
        item.rows[0].notes,
        '',
        'order_items.notes must default to empty string',
      );
      // total != subtotal.
      await expectViolation(
        pool,
        buildInsert('orders', {
          buyer_id: `'${w.buyerId}'::uuid`,
          tenant_id: `'${w.tenantAId}'::uuid`,
          pickup_slot_id: `'${w.slotA1Id}'::uuid`,
          tenant_name_snapshot: q(`Tenant A ${w.suffix}`),
          tenant_timezone_snapshot: "'Asia/Jakarta'",
          pickup_starts_at: "now() + interval '24 hours'",
          pickup_ends_at: "now() + interval '25 hours'",
          currency: "'IDR'",
          subtotal_minor: "'1000'",
          total_minor: "'999'",
        }),
        '23514',
        'orders_total_equals_subtotal_check',
      );
      // Zero-total order is rejected in the pilot (D12.5).
      await expectViolation(
        pool,
        buildInsert('orders', {
          buyer_id: `'${w.buyerId}'::uuid`,
          tenant_id: `'${w.tenantAId}'::uuid`,
          pickup_slot_id: `'${w.slotA1Id}'::uuid`,
          tenant_name_snapshot: q(`Tenant A ${w.suffix}`),
          tenant_timezone_snapshot: "'Asia/Jakarta'",
          pickup_starts_at: "now() + interval '24 hours'",
          pickup_ends_at: "now() + interval '25 hours'",
          currency: "'IDR'",
          subtotal_minor: "'0'",
          total_minor: "'0'",
        }),
        '23514',
        'orders_positive_totals_check',
      );
      // R1-22: quantity bound is 1..999 at DB level.
      await expectViolation(
        pool,
        buildInsert('order_items', {
          order_id: `'${orderId}'::uuid`,
          source_menu_item_id: `'${randomUUID()}'::uuid`,
          source_category_id: `'${randomUUID()}'::uuid`,
          name_snapshot: "'Nasi Goreng'",
          description_snapshot: "''",
          menu_version: '1',
          quantity: '1000',
          base_unit_price_minor: "'10'",
          unit_price_minor: "'10'",
          line_total_minor: "'10000'",
        }),
        '23514',
        'order_items_quantity_check',
      );
      assert.ok(
        await insertOrderItem(pool, orderId, {
          quantity: '999',
          base_unit_price_minor: "'10'",
          unit_price_minor: "'10'",
          line_total_minor: "'9990'",
        }),
      );
    });

    it('R1-08: top-up lifecycle timestamps are constrained', async () => {
      await expectViolation(
        pool,
        buildInsert('topup_intents', {
          user_id: `'${w.buyerId}'::uuid`,
          wallet_account_id: `'${w.buyerWalletId}'::uuid`,
          provider: "'sandbox'",
          provider_reference: q(`ref-${randomUUID()}`),
          idempotency_key: q(`key-${randomUUID()}`),
          request_hash: q(sha256(randomUUID())),
          amount_minor: "'10000'",
          currency: "'IDR'",
          created_at: 'now()',
          expires_at: "now() - interval '1 minute'",
        }),
        '23514',
        'topup_intents_expires_at_check',
      );
      await expectViolation(
        pool,
        buildInsert('topup_intents', {
          user_id: `'${w.buyerId}'::uuid`,
          wallet_account_id: `'${w.buyerWalletId}'::uuid`,
          provider: "'sandbox'",
          provider_reference: q(`ref-${randomUUID()}`),
          idempotency_key: q(`key-${randomUUID()}`),
          request_hash: q(sha256(randomUUID())),
          amount_minor: "'10000'",
          currency: "'IDR'",
          status: "'pending'",
          succeeded_at: 'now()',
        }),
        '23514',
        'topup_intents_succeeded_at_check',
      );
      // Positive control: succeeded intent with both timestamps consistent.
      const succeededId = await insertTopup(pool, w, {
        status: "'succeeded'",
        succeeded_at: 'now()',
        expires_at: "now() + interval '15 minutes'",
      });
      assert.ok(succeededId);
    });

    it('R1-10: order_number is nullable-unique until wave 2 backfill', async () => {
      const first = await insertOrder(pool, w);
      const second = await insertOrder(pool, w);
      // Randomized per run: the suite may execute repeatedly on the same
      // disposable database and rows are never deleted (FK RESTRICT).
      const orderNumber = `ORD-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      await pool.query(
        `update orders set order_number = '${orderNumber}' where id = '${first}'::uuid`,
      );
      await expectViolation(
        pool,
        `update orders set order_number = '${orderNumber}' where id = '${second}'::uuid`,
        '23505',
        'orders_order_number_uq',
      );
      // NULLs stay distinct: two orders without a number coexist.
      const nulls = await pool.query(
        `select count(*)::int as n from orders where id = any($1::uuid[]) and order_number is null`,
        [[second]],
      );
      assert.equal(nulls.rows[0].n, 1);
    });

    it('R1-11: menu_items.archived_at is set exactly for archived items', async () => {
      const base = {
        tenant_id: `'${w.tenantAId}'::uuid`,
        category_id: `'${w.categoryIdA}'::uuid`,
        price_minor: "'1000'",
      };
      // Archived without archived_at.
      await expectViolation(
        pool,
        buildInsert('menu_items', {
          ...base,
          name: q(`Archived no ts ${randomUUID()}`),
          status: "'archived'",
        }),
        '23514',
        'menu_items_archived_at_check',
      );
      // Non-archived carrying archived_at.
      await expectViolation(
        pool,
        buildInsert('menu_items', {
          ...base,
          name: q(`Active with ts ${randomUUID()}`),
          status: "'active'",
          archived_at: 'now()',
        }),
        '23514',
        'menu_items_archived_at_check',
      );
      // Positive controls.
      const archived = await pool.query<{ id: string }>(
        buildInsert('menu_items', {
          ...base,
          name: q(`Archived ok ${randomUUID()}`),
          status: "'archived'",
          archived_at: 'now()',
          image_ref: "'https://cdn.example/menu/nasi-goreng.jpg'",
        }),
      );
      assert.ok(archived.rows[0].id);
      // Reactivation must clear archived_at (bidirectional rule).
      await expectViolation(
        pool,
        `update menu_items set status = 'active' where id = '${archived.rows[0].id}'::uuid`,
        '23514',
        'menu_items_archived_at_check',
      );
      const reactivated = await pool.query(
        `update menu_items set status = 'active', archived_at = null where id = '${archived.rows[0].id}'::uuid returning id`,
      );
      assert.equal(reactivated.rowCount, 1);
    });

    it('R1-13: reservation consumed state mirrors released_at pattern', async () => {
      const orderId = await insertOrder(pool, w);
      await expectViolation(
        pool,
        buildInsert('slot_reservations', {
          tenant_id: `'${w.tenantAId}'::uuid`,
          slot_id: `'${w.slotA1Id}'::uuid`,
          order_id: `'${orderId}'::uuid`,
          status: "'consumed'",
        }),
        '23514',
        'slot_reservations_consumed_at_check',
      );
      const reservationId = await insertReservation(pool, w, orderId, {
        status: "'consumed'",
        consumed_at: 'now()',
      });
      const row = await pool.query<{ updated_at: string; consumed_at: string }>(
        `select updated_at, consumed_at from slot_reservations where id = '${reservationId}'::uuid`,
      );
      assert.ok(row.rows[0].updated_at, 'updated_at must default to now()');
      assert.ok(row.rows[0].consumed_at);
      // consumed_at on a non-consumed reservation is rejected.
      const otherOrderId = await insertOrder(pool, w);
      await expectViolation(
        pool,
        buildInsert('slot_reservations', {
          tenant_id: `'${w.tenantAId}'::uuid`,
          slot_id: `'${w.slotA1Id}'::uuid`,
          order_id: `'${otherOrderId}'::uuid`,
          status: "'reserved'",
          consumed_at: 'now()',
        }),
        '23514',
        'slot_reservations_consumed_at_check',
      );
      // Regression: the 0006 released_at invariant still holds.
      const thirdOrderId = await insertOrder(pool, w);
      await expectViolation(
        pool,
        buildInsert('slot_reservations', {
          tenant_id: `'${w.tenantAId}'::uuid`,
          slot_id: `'${w.slotA1Id}'::uuid`,
          order_id: `'${thirdOrderId}'::uuid`,
          status: "'released'",
        }),
        '23514',
        'slot_reservations_released_at_check',
      );
    });

    it('R1-14: pickup credential expiry and consume/revoke exclusivity', async () => {
      const orderId = await insertOrder(pool, w);
      await expectViolation(
        pool,
        buildInsert('pickup_credentials', {
          order_id: `'${orderId}'::uuid`,
          code_hash: q(sha256(randomUUID())),
          code_ciphertext: "'v1:test-ciphertext'",
          created_at: 'now()',
          expires_at: 'now()',
        }),
        '23514',
        'pickup_credentials_expires_at_check',
      );
      await expectViolation(
        pool,
        buildInsert('pickup_credentials', {
          order_id: `'${orderId}'::uuid`,
          code_hash: q(sha256(randomUUID())),
          code_ciphertext: "'v1:test-ciphertext'",
          expires_at: "now() + interval '2 hours'",
          consumed_at: 'now()',
          revoked_at: 'now()',
        }),
        '23514',
        'pickup_credentials_consume_revoke_check',
      );
      // Positive controls: consumed only, revoked only.
      const consumedCredential = await insertCredential(pool, orderId, {
        consumed_at: 'now()',
      });
      assert.ok(consumedCredential);
      const secondOrderId = await insertOrder(pool, w);
      assert.ok(
        await insertCredential(pool, secondOrderId, { revoked_at: 'now()' }),
      );
    });

    it('R1-15: order_events enum widened and request_id correlates idempotency', async () => {
      const orderId = await insertOrder(pool, w);
      await expectViolation(
        pool,
        buildInsert('order_events', {
          order_id: `'${orderId}'::uuid`,
          version: '1',
          event_type: "'order.teleported'",
          actor_service: "'schema-integrity-test'",
          reason: "'unknown type'",
        }),
        '23514',
        'order_events_type_check',
      );
      // All 8 enum values are accepted.
      const types = [
        'order.created',
        'order.status_changed',
        'order.cancelled',
        'order.declined',
        'schedule_proposal.created',
        'schedule_proposal.decided',
        'pickup_credential.issued',
        'pickup_credential.revoked',
      ];
      for (let i = 0; i < types.length; i += 1) {
        const id = await insertEvent(pool, orderId, i + 1, {
          event_type: q(types[i]),
        });
        assert.ok(id, `event type ${types[i]} must be accepted`);
      }
      // request_id must reference a real idempotency record.
      await expectViolation(
        pool,
        buildInsert('order_events', {
          order_id: `'${orderId}'::uuid`,
          version: '100',
          event_type: "'order.status_changed'",
          actor_service: "'schema-integrity-test'",
          reason: "'dangling request id'",
          request_id: `'${randomUUID()}'::uuid`,
        }),
        '23503',
        'order_events_request_fk',
      );
      // R1-16 + positive control: idempotency record with expiry, correlated event.
      const requestId = await insertIdempotency(pool, w, orderId, {
        expires_at: "now() + interval '30 days'",
      });
      const correlated = await insertEvent(pool, orderId, 101, {
        request_id: `'${requestId}'::uuid`,
      });
      assert.ok(correlated);
      // ON DELETE RESTRICT: the idempotency record cannot be deleted while referenced.
      await expectViolation(
        pool,
        `delete from order_request_idempotency where id = '${requestId}'::uuid`,
        '23503',
        'order_events_request_fk',
      );
    });

    it('R1-17: operating hours reject duplicates through the composite PK', async () => {
      await pool.query(
        buildInsert(
          'tenant_operating_hours',
          {
            tenant_id: `'${w.tenantAId}'::uuid`,
            weekday: '1',
            is_open: 'false',
          },
          'tenant_id',
        ),
      );
      await expectViolation(
        pool,
        buildInsert(
          'tenant_operating_hours',
          {
            tenant_id: `'${w.tenantAId}'::uuid`,
            weekday: '1',
            is_open: 'false',
          },
          'tenant_id',
        ),
        '23505',
        // The legacy unique index (0006) and the new PK (0007) both enforce
        // uniqueness; PostgreSQL reports whichever index it checks first.
        [
          'tenant_operating_hours_pk',
          'tenant_operating_hours_tenant_weekday_uq',
        ],
      );
      await pool.query(
        buildInsert(
          'tenant_operating_hour_overrides',
          {
            tenant_id: `'${w.tenantAId}'::uuid`,
            local_date: "'2026-12-25'",
            is_closed: 'false',
            opens_at: "'08:00:00'",
            closes_at: "'17:00:00'",
            reason: "'holiday schedule'",
          },
          'tenant_id',
        ),
      );
      await expectViolation(
        pool,
        buildInsert(
          'tenant_operating_hour_overrides',
          {
            tenant_id: `'${w.tenantAId}'::uuid`,
            local_date: "'2026-12-25'",
            is_closed: 'true',
            reason: "'duplicate'",
          },
          'tenant_id',
        ),
        '23505',
        [
          'tenant_operating_hour_overrides_pk',
          'tenant_operating_overrides_tenant_date_uq',
        ],
      );
      // created_at defaults exist (R1-17).
      const hours = await pool.query<{ created_at: string }>(
        `select created_at from tenant_operating_hours where tenant_id = '${w.tenantAId}'::uuid and weekday = 1`,
      );
      assert.ok(hours.rows[0].created_at);
      const overrides = await pool.query<{ created_at: string }>(
        `select created_at from tenant_operating_hour_overrides where tenant_id = '${w.tenantAId}'::uuid and local_date = '2026-12-25'`,
      );
      assert.ok(overrides.rows[0].created_at);
      // Weekday bound from 0006 still applies (0=Sunday..6=Saturday, D12.9).
      await expectViolation(
        pool,
        buildInsert(
          'tenant_operating_hours',
          {
            tenant_id: `'${w.tenantAId}'::uuid`,
            weekday: '7',
            is_open: 'false',
          },
          'tenant_id',
        ),
        '23514',
        'tenant_operating_hours_weekday_check',
      );
    });
  },
);
