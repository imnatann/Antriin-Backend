import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

/**
 * Schema integrity tests for migration 0009 (settlements, bank accounts,
 * payouts) - review F1 in docs/reviews/wave1-settlements-payouts.md and the
 * acceptance criteria of design T1 (docs/design/settlement-payout.md §2.5
 * points 1-10).
 *
 * Every constraint is exercised against a real PostgreSQL 17 by attempting a
 * violating statement and asserting the exact SQLSTATE + constraint name, plus
 * a positive control proving valid data still inserts. Fixtures are synthetic
 * and disposable (TEST_DATABASE_URL only).
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const hex64 = (): string => sha256(randomUUID());

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
    `expected ${code} (${allowed.join(' | ')}) but the statement succeeded: ${sqlText.slice(0, 240)}`,
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

interface World {
  campusId: string;
  ownerUserId: string;
  verifierUserId: string;
  otherUserId: string;
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
  const user = async (label: string): Promise<string> =>
    one(
      `insert into users (display_name) values (${q(`${label} ${suffix}`)}) returning id`,
    );
  const ownerUserId = await user('Owner');
  const verifierUserId = await user('Verifier');
  const otherUserId = await user('Other');
  return { campusId, ownerUserId, verifierUserId, otherUserId };
}

async function insertTenant(pool: Pool, w: World): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `insert into tenants (campus_id, name, location, status)
     values ('${w.campusId}', ${q('Tenant ' + randomUUID())}, 'Kantin Uji', 'open')
     returning id`,
  );
  return res.rows[0].id;
}

/**
 * Two disposable system accounts used only to satisfy the ledger's balanced
 * transfer guard (drizzle/0003): every fixture transaction posts one debit and
 * one credit of 1 minor unit, so the deferred balance trigger accepts it.
 */
let fixtureDebitAccountId = '';
let fixtureCreditAccountId = '';

async function createFixtureLedgerAccounts(pool: Pool): Promise<void> {
  const account = async (label: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `insert into wallet_accounts (account_type, system_key, currency)
         values ('system', $1, 'IDR') returning id`,
        ['schema-0009-' + label + '-' + randomUUID()],
      )
    ).rows[0].id;
  fixtureDebitAccountId = await account('debit');
  fixtureCreditAccountId = await account('credit');
}

/**
 * A posted, balanced ledger transaction (required by the deferred trigger
 * `ledger_transactions_balanced_at_commit`, so the four steps run in ONE
 * database transaction: create -> entries -> outbox -> post).
 */
async function insertLedgerTx(pool: Pool): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const transaction = await client.query<{ id: string }>(
      `insert into ledger_transactions
         (currency, idempotency_scope, idempotency_key, request_hash,
          actor_type, actor_id, reason)
       values ('IDR', $1, $2, $3, 'service', 'schema-integrity-0009', 'fixture')
       returning id`,
      ['schema-0009-' + randomUUID(), randomUUID(), sha256(randomUUID())],
    );
    const transactionId = transaction.rows[0].id;
    await client.query(
      `insert into ledger_entries (transaction_id, account_id, direction, amount_minor)
       values ($1, $2, 'debit', 1), ($1, $3, 'credit', 1)`,
      [transactionId, fixtureDebitAccountId, fixtureCreditAccountId],
    );
    await client.query(
      `insert into wallet_outbox_events
         (event_type, aggregate_type, aggregate_id, payload)
       values ('ledger.transfer.posted', 'ledger_transaction', $1, $2::jsonb)`,
      [transactionId, JSON.stringify({ transactionId, currency: 'IDR' })],
    );
    await client.query(
      'update ledger_transactions set posted_at = now() where id = $1',
      [transactionId],
    );
    await client.query('commit');
    return transactionId;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface OrderFixture {
  tenantId: string;
  orderId: string;
  paymentId: string;
  amountMinor: string;
}

async function createOrderFixture(
  pool: Pool,
  w: World,
  options: { amountMinor?: string; status?: string } = {},
): Promise<OrderFixture> {
  const tenantId = await insertTenant(pool, w);
  const amountMinor = options.amountMinor ?? '50000';
  const status = options.status ?? 'completed';
  const slot = await pool.query<{ id: string }>(
    `insert into pickup_slots
       (tenant_id, starts_at, ends_at, capacity, reserved_count, status, version,
        created_at, updated_at)
     values ($1, now() + interval '2 hours', now() + interval '3 hours', 5, 0,
             'open', 1, now(), now())
     returning id`,
    [tenantId],
  );
  const orderId = (
    await pool.query<{ id: string }>(
      `insert into orders
         (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot,
          tenant_timezone_snapshot, pickup_starts_at, pickup_ends_at, status,
          currency, subtotal_minor, total_minor, paid_at, confirmed_at, ready_at,
          completed_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'Asia/Jakarta', now() - interval '1 hour', now(),
               $5::varchar, 'IDR', $6::numeric, $6::numeric,
               now() - interval '3 hours',
               case when $5::varchar = 'completed' then now() - interval '3 hours' else null end,
               case when $5::varchar = 'completed' then now() - interval '2 hours' else null end,
               case when $5::varchar = 'completed' then now() - interval '1 hour' else null end,
               now() - interval '4 hours', now())
       returning id`,
      [w.otherUserId, tenantId, slot.rows[0].id, 'Tenant', status, amountMinor],
    )
  ).rows[0].id;
  const ledgerTxId = await insertLedgerTx(pool);
  const paymentId = (
    await pool.query<{ id: string }>(
      `insert into order_payments
         (order_id, method, status, amount_minor, currency, ledger_transaction_id,
          succeeded_at, created_at, updated_at)
       values ($1, 'wallet', 'succeeded', $2::numeric, 'IDR', $3, now(), now(), now())
       returning id`,
      [orderId, amountMinor, ledgerTxId],
    )
  ).rows[0].id;
  return { tenantId, orderId, paymentId, amountMinor };
}

async function insertSettlement(
  pool: Pool,
  fixture: OrderFixture,
  overrides: Overrides = {},
): Promise<string> {
  const releaseTxId = await insertLedgerTx(pool);
  const res = await pool.query<{ id: string }>(
    buildInsert('settlements', {
      tenant_id: `'${fixture.tenantId}'::uuid`,
      order_id: `'${fixture.orderId}'::uuid`,
      order_payment_id: `'${fixture.paymentId}'::uuid`,
      amount_minor: `'${fixture.amountMinor}'`,
      currency: "'IDR'",
      status: "'available'",
      paid_out_minor: "'0'",
      release_ledger_transaction_id: `'${releaseTxId}'::uuid`,
      released_at: 'now()',
      created_at: 'now()',
      updated_at: 'now()',
      ...overrides,
    }),
  );
  return res.rows[0].id;
}

async function insertBankAccount(
  pool: Pool,
  w: World,
  tenantId: string,
  overrides: Overrides = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    buildInsert('bank_accounts', {
      tenant_id: `'${tenantId}'::uuid`,
      owner_user_id: `'${w.ownerUserId}'::uuid`,
      bank_code: "'BCA'",
      account_holder_name: "'Owner Name'",
      account_number_ciphertext: "'v1:test-ciphertext'",
      account_number_hash: q(hex64()),
      account_number_masked: "'****1234'",
      verification_status: "'pending'",
      status: "'active'",
      is_default: 'false',
      created_by_user_id: `'${w.ownerUserId}'::uuid`,
      version: '1',
      created_at: 'now()',
      updated_at: 'now()',
      ...overrides,
    }),
  );
  return res.rows[0].id;
}

interface PayoutOptions {
  status?: 'requested' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  amountMinor?: string;
  /** 'settle' = succeeded leg, 'release' = failed/cancelled leg, 'none' = open. */
  legs?: 'settle' | 'release' | 'none';
  tenantId?: string;
  bankAccountId?: string;
}

async function insertPayout(
  pool: Pool,
  w: World,
  tenantId: string,
  bankAccountId: string,
  options: PayoutOptions = {},
  overrides: Overrides = {},
): Promise<string> {
  const status = options.status ?? 'failed';
  const legs =
    options.legs ??
    (status === 'succeeded'
      ? 'settle'
      : status === 'requested' || status === 'processing'
        ? 'none'
        : 'release');
  const holdTxId = await insertLedgerTx(pool);
  const values: Overrides = {
    tenant_id: `'${options.tenantId ?? tenantId}'::uuid`,
    bank_account_id: `'${options.bankAccountId ?? bankAccountId}'::uuid`,
    bank_code: "'BCA'",
    account_number_masked: "'****1234'",
    account_holder_name: "'Owner Name'",
    amount_minor: `'${options.amountMinor ?? '10000'}'`,
    currency: "'IDR'",
    status: `'${status}'`,
    provider: "'sandbox'",
    hold_ledger_transaction_id: `'${holdTxId}'::uuid`,
    requested_by_user_id: `'${w.ownerUserId}'::uuid`,
    requested_at: 'now()',
    version: '1',
    created_at: 'now()',
    updated_at: 'now()',
  };
  if (status === 'processing') values.processing_at = 'now()';
  if (status === 'succeeded') values.succeeded_at = 'now()';
  if (status === 'failed') values.failed_at = 'now()';
  if (status === 'cancelled') values.cancelled_at = 'now()';
  if (legs === 'settle')
    values.settle_ledger_transaction_id = `'${await insertLedgerTx(pool)}'::uuid`;
  if (legs === 'release')
    values.release_ledger_transaction_id = `'${await insertLedgerTx(pool)}'::uuid`;
  const res = await pool.query<{ id: string }>(
    buildInsert('payouts', { ...values, ...overrides }),
  );
  return res.rows[0].id;
}

describe(
  'Schema 0009 integrity against PostgreSQL',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let w: World;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
      await pool.query('select 1');
      w = await createWorld(pool);
      await createFixtureLedgerAccounts(pool);
    });

    after(async () => {
      await pool?.end();
    });

    it('0009 structure exists in pg_constraint/pg_indexes (design §2.5 1-10)', async () => {
      const expected: Array<[string, string]> = [
        // unique constraints (composite FK targets, D12.3 pattern)
        ['settlements_one_per_order_uq', 'u'],
        ['settlements_tenant_id_id_uq', 'u'],
        ['bank_accounts_tenant_id_id_uq', 'u'],
        ['payouts_tenant_id_id_uq', 'u'],
        ['payout_allocations_payout_settlement_uq', 'u'],
        ['payout_attempts_payout_attempt_uq', 'u'],
        ['payout_provider_events_provider_event_uq', 'u'],
        ['payout_events_payout_version_uq', 'u'],
        // foreign keys
        ['settlements_tenant_order_fk', 'f'],
        ['settlements_order_payment_fk', 'f'],
        ['payouts_bank_account_id_bank_accounts_id_fk', 'f'],
        ['payout_allocations_tenant_payout_fk', 'f'],
        ['payout_allocations_tenant_settlement_fk', 'f'],
        // checks
        ['settlements_amount_check', 'c'],
        ['settlements_paid_out_check', 'c'],
        ['settlements_status_timestamps_check', 'c'],
        ['bank_accounts_verification_check', 'c'],
        ['bank_accounts_hash_check', 'c'],
        ['payouts_amount_check', 'c'],
        ['payouts_ledger_legs_check', 'c'],
        ['payouts_timestamps_check', 'c'],
        ['payout_attempts_no_check', 'c'],
        ['payout_attempts_finished_check', 'c'],
        ['payout_events_actor_check', 'c'],
        ['payout_events_version_check', 'c'],
      ];
      const found = await pool.query<{
        conname: string;
        contype: string;
        def: string;
      }>(
        `select con.conname, con.contype, pg_get_constraintdef(con.oid) as def
           from pg_constraint con
          where con.conname = any($1::text[])`,
        [expected.map(([name]) => name)],
      );
      const byName = new Map(found.rows.map((row) => [row.conname, row]));
      for (const [name, contype] of expected) {
        const row = byName.get(name);
        assert.ok(row, 'missing constraint ' + name);
        assert.equal(row.contype, contype, 'wrong contype for ' + name);
      }

      // Composite FKs really are composite (tenant isolation in the DB).
      const tenantOrder = byName.get('settlements_tenant_order_fk')?.def ?? '';
      assert.ok(tenantOrder.includes('(tenant_id, order_id)'));
      assert.ok(tenantOrder.includes('orders(tenant_id, id)'));
      assert.ok(tenantOrder.includes('ON DELETE RESTRICT'));
      const orderPayment =
        byName.get('settlements_order_payment_fk')?.def ?? '';
      assert.ok(orderPayment.includes('(order_id, order_payment_id)'));
      assert.ok(orderPayment.includes('order_payments(order_id, id)'));
      const allocationPayout =
        byName.get('payout_allocations_tenant_payout_fk')?.def ?? '';
      assert.ok(allocationPayout.includes('(tenant_id, payout_id)'));
      assert.ok(allocationPayout.includes('payouts(tenant_id, id)'));
      const allocationSettlement =
        byName.get('payout_allocations_tenant_settlement_fk')?.def ?? '';
      assert.ok(allocationSettlement.includes('(tenant_id, settlement_id)'));
      assert.ok(allocationSettlement.includes('settlements(tenant_id, id)'));

      // The "one live payout" and dedupe guards are PARTIAL unique indexes.
      const indexes = await pool.query<{
        indexname: string;
        indexdef: string;
      }>(
        `select indexname, indexdef from pg_indexes
          where indexname = any($1::text[])`,
        [
          [
            'payouts_one_active_per_tenant_uq',
            'payouts_provider_reference_uq',
            'bank_accounts_one_default_uq',
            'bank_accounts_tenant_number_uq',
            'payout_request_outbox_payout_uq',
          ],
        ],
      );
      const idx = new Map(
        indexes.rows.map((row) => [row.indexname, row.indexdef]),
      );
      const oneActive = idx.get('payouts_one_active_per_tenant_uq') ?? '';
      assert.match(oneActive, /UNIQUE INDEX/);
      assert.match(oneActive, /WHERE .*status.*requested.*processing/i);
      assert.match(
        idx.get('payouts_provider_reference_uq') ?? '',
        /WHERE .*provider_reference.*IS NOT NULL/i,
      );
      assert.match(
        idx.get('bank_accounts_one_default_uq') ?? '',
        /WHERE .*is_default.*status.*active/i,
      );
      assert.match(
        idx.get('bank_accounts_tenant_number_uq') ?? '',
        /WHERE .*status.*active/i,
      );
    });

    it('settlements: exactly one settlement per order', async () => {
      const fixture = await createOrderFixture(pool, w);
      const first = await insertSettlement(pool, fixture);
      assert.ok(first);
      await expectViolation(
        pool,
        buildInsert('settlements', {
          tenant_id: `'${fixture.tenantId}'::uuid`,
          order_id: `'${fixture.orderId}'::uuid`,
          order_payment_id: `'${fixture.paymentId}'::uuid`,
          amount_minor: `'${fixture.amountMinor}'`,
          currency: "'IDR'",
          status: "'available'",
          paid_out_minor: "'0'",
          release_ledger_transaction_id: `'${await insertLedgerTx(pool)}'::uuid`,
          released_at: 'now()',
        }),
        '23505',
        'settlements_one_per_order_uq',
      );
      // Positive control: a DIFFERENT order of the same tenant still inserts.
      const other = await createOrderFixture(pool, w, {
        amountMinor: '7000',
      });
      assert.ok(await insertSettlement(pool, other));
      assert.equal(
        (
          await pool.query('select 1 from settlements where order_id = $1', [
            fixture.orderId,
          ])
        ).rowCount,
        1,
      );
    });

    it('settlements: cannot point at another tenant order or payment', async () => {
      const mine = await createOrderFixture(pool, w);
      const foreign = await createOrderFixture(pool, w);
      const releaseTxId = await insertLedgerTx(pool);
      // Tenant of order B + order of tenant A: the composite FK rejects it.
      await expectViolation(
        pool,
        buildInsert('settlements', {
          tenant_id: `'${foreign.tenantId}'::uuid`,
          order_id: `'${mine.orderId}'::uuid`,
          order_payment_id: `'${mine.paymentId}'::uuid`,
          amount_minor: "'1000'",
          currency: "'IDR'",
          status: "'available'",
          paid_out_minor: "'0'",
          release_ledger_transaction_id: `'${releaseTxId}'::uuid`,
          released_at: 'now()',
        }),
        '23503',
        'settlements_tenant_order_fk',
      );
      // Correct tenant + order, but a payment that belongs to another order.
      await expectViolation(
        pool,
        buildInsert('settlements', {
          tenant_id: `'${mine.tenantId}'::uuid`,
          order_id: `'${mine.orderId}'::uuid`,
          order_payment_id: `'${foreign.paymentId}'::uuid`,
          amount_minor: "'1000'",
          currency: "'IDR'",
          status: "'available'",
          paid_out_minor: "'0'",
          release_ledger_transaction_id: `'${releaseTxId}'::uuid`,
          released_at: 'now()',
        }),
        '23503',
        'settlements_order_payment_fk',
      );
      // Positive control: the matching triple inserts.
      assert.ok(await insertSettlement(pool, mine));
    });

    it('settlements: amount is a positive integer minor unit', async () => {
      const fixture = await createOrderFixture(pool, w);
      const base: Overrides = {
        tenant_id: `'${fixture.tenantId}'::uuid`,
        order_id: `'${fixture.orderId}'::uuid`,
        order_payment_id: `'${fixture.paymentId}'::uuid`,
        currency: "'IDR'",
        status: "'available'",
        paid_out_minor: "'0'",
        release_ledger_transaction_id: `'${await insertLedgerTx(pool)}'::uuid`,
        released_at: 'now()',
      };
      for (const amount of ['0', '-1', '100.5']) {
        await expectViolation(
          pool,
          buildInsert('settlements', {
            ...base,
            amount_minor: q(amount),
          }),
          '23514',
          'settlements_amount_check',
        );
      }
      // Currency is fixed to IDR in the pilot.
      await expectViolation(
        pool,
        buildInsert('settlements', {
          ...base,
          amount_minor: "'1000'",
          currency: "'USD'",
        }),
        '23514',
        'settlements_currency_check',
      );
      // Positive control: 1 minor unit is valid.
      assert.ok(await insertSettlement(pool, fixture, { amount_minor: "'1'" }));
    });

    it('settlements: status and timestamps are bidirectional', async () => {
      const availableNoRelease = await createOrderFixture(pool, w);
      const base: Overrides = {
        tenant_id: `'${availableNoRelease.tenantId}'::uuid`,
        order_id: `'${availableNoRelease.orderId}'::uuid`,
        order_payment_id: `'${availableNoRelease.paymentId}'::uuid`,
        amount_minor: "'1000'",
        currency: "'IDR'",
        paid_out_minor: "'0'",
        release_ledger_transaction_id: `'${await insertLedgerTx(pool)}'::uuid`,
        released_at: 'now()',
      };
      // 'available' requires released_at.
      await expectViolation(
        pool,
        buildInsert('settlements', {
          ...base,
          status: "'available'",
          released_at: 'null',
        }),
        '23514',
        'settlements_status_timestamps_check',
      );
      // 'available' requires the release ledger leg.
      await expectViolation(
        pool,
        buildInsert('settlements', {
          ...base,
          status: "'available'",
          release_ledger_transaction_id: 'null',
        }),
        '23514',
        'settlements_status_timestamps_check',
      );
      // 'available' must NOT be fully paid out (that is 'paid_out').
      await expectViolation(
        pool,
        buildInsert('settlements', {
          ...base,
          status: "'available'",
          paid_out_minor: "'1000'",
        }),
        '23514',
        'settlements_status_timestamps_check',
      );
      // 'paid_out' requires paid_out_minor = amount_minor.
      await expectViolation(
        pool,
        buildInsert('settlements', {
          ...base,
          status: "'paid_out'",
          paid_out_minor: "'0'",
        }),
        '23514',
        'settlements_status_timestamps_check',
      );
      // paid_out_minor can never exceed amount_minor.
      await expectViolation(
        pool,
        buildInsert('settlements', {
          ...base,
          status: "'paid_out'",
          paid_out_minor: "'1001'",
        }),
        '23514',
        ['settlements_paid_out_check', 'settlements_status_timestamps_check'],
      );
      // 'pending' may not carry a release leg or paid-out money.
      await expectViolation(
        pool,
        buildInsert('settlements', {
          ...base,
          status: "'pending'",
        }),
        '23514',
        'settlements_status_timestamps_check',
      );
      // 'voided'/'reversed' require their own terminal timestamp.
      await expectViolation(
        pool,
        buildInsert('settlements', {
          ...base,
          status: "'voided'",
        }),
        '23514',
        'settlements_status_timestamps_check',
      );

      // Positive controls: every legal status shape inserts.
      const paidOut = await createOrderFixture(pool, w);
      assert.ok(
        await insertSettlement(pool, paidOut, {
          status: "'paid_out'",
          paid_out_minor: `'${paidOut.amountMinor}'`,
        }),
      );
      const pending = await createOrderFixture(pool, w);
      assert.ok(
        await insertSettlement(pool, pending, {
          status: "'pending'",
          paid_out_minor: "'0'",
          release_ledger_transaction_id: 'null',
          released_at: 'null',
        }),
      );
      const voided = await createOrderFixture(pool, w);
      assert.ok(
        await insertSettlement(pool, voided, {
          status: "'voided'",
          paid_out_minor: "'0'",
          release_ledger_transaction_id: 'null',
          released_at: 'null',
          voided_at: 'now()',
        }),
      );
    });

    it('payouts: at most one requested/processing payout per tenant', async () => {
      const tenantId = await insertTenant(pool, w);
      const accountId = await insertBankAccount(pool, w, tenantId);
      const first = await insertPayout(pool, w, tenantId, accountId, {
        status: 'requested',
      });
      assert.ok(first);
      await expectViolation(
        pool,
        buildInsert('payouts', {
          tenant_id: `'${tenantId}'::uuid`,
          bank_account_id: `'${accountId}'::uuid`,
          bank_code: "'BCA'",
          account_number_masked: "'****1234'",
          account_holder_name: "'Owner Name'",
          amount_minor: "'10000'",
          currency: "'IDR'",
          status: "'processing'",
          provider: "'sandbox'",
          hold_ledger_transaction_id: `'${await insertLedgerTx(pool)}'::uuid`,
          requested_by_user_id: `'${w.ownerUserId}'::uuid`,
          processing_at: 'now()',
        }),
        '23505',
        'payouts_one_active_per_tenant_uq',
      );
      // Positive control: a terminal payout of the same tenant is allowed.
      assert.ok(
        await insertPayout(pool, w, tenantId, accountId, { status: 'failed' }),
      );
      assert.ok(
        await insertPayout(pool, w, tenantId, accountId, {
          status: 'cancelled',
        }),
      );
      // ... and another tenant may have its own active payout.
      const otherTenant = await insertTenant(pool, w);
      const otherAccount = await insertBankAccount(pool, w, otherTenant);
      assert.ok(
        await insertPayout(pool, w, otherTenant, otherAccount, {
          status: 'requested',
        }),
      );
    });

    it('payouts: exactly one terminal ledger leg (settle XOR release)', async () => {
      const tenantId = await insertTenant(pool, w);
      const accountId = await insertBankAccount(pool, w, tenantId);
      const holdTxId = await insertLedgerTx(pool);
      const settleTxId = await insertLedgerTx(pool);
      const releaseTxId = await insertLedgerTx(pool);
      const base: Overrides = {
        tenant_id: `'${tenantId}'::uuid`,
        bank_account_id: `'${accountId}'::uuid`,
        bank_code: "'BCA'",
        account_number_masked: "'****1234'",
        account_holder_name: "'Owner Name'",
        amount_minor: "'10000'",
        currency: "'IDR'",
        provider: "'sandbox'",
        hold_ledger_transaction_id: `'${holdTxId}'::uuid`,
        requested_by_user_id: `'${w.ownerUserId}'::uuid`,
      };
      // Two terminal legs at once.
      await expectViolation(
        pool,
        buildInsert('payouts', {
          ...base,
          status: "'succeeded'",
          succeeded_at: 'now()',
          settle_ledger_transaction_id: `'${settleTxId}'::uuid`,
          release_ledger_transaction_id: `'${releaseTxId}'::uuid`,
        }),
        '23514',
        'payouts_ledger_legs_check',
      );
      // succeeded without the settle leg.
      await expectViolation(
        pool,
        buildInsert('payouts', {
          ...base,
          status: "'succeeded'",
          succeeded_at: 'now()',
        }),
        '23514',
        'payouts_ledger_legs_check',
      );
      // failed without the release leg.
      await expectViolation(
        pool,
        buildInsert('payouts', {
          ...base,
          status: "'failed'",
          failed_at: 'now()',
        }),
        '23514',
        'payouts_ledger_legs_check',
      );
      // failed with a settle leg (money left to the provider but marked failed).
      await expectViolation(
        pool,
        buildInsert('payouts', {
          ...base,
          status: "'failed'",
          failed_at: 'now()',
          settle_ledger_transaction_id: `'${settleTxId}'::uuid`,
        }),
        '23514',
        'payouts_ledger_legs_check',
      );
      // requested with a terminal leg.
      await expectViolation(
        pool,
        buildInsert('payouts', {
          ...base,
          status: "'requested'",
          release_ledger_transaction_id: `'${releaseTxId}'::uuid`,
        }),
        '23514',
        'payouts_ledger_legs_check',
      );
      // Positive controls: the three legal shapes insert.
      assert.ok(
        await insertPayout(pool, w, tenantId, accountId, {
          status: 'succeeded',
        }),
      );
      assert.ok(
        await insertPayout(pool, w, tenantId, accountId, { status: 'failed' }),
      );
      assert.ok(
        await insertPayout(pool, w, tenantId, accountId, {
          status: 'processing',
        }),
      );
      // Status and timestamps must also agree (bidirectional).
      await expectViolation(
        pool,
        buildInsert('payouts', {
          ...base,
          status: "'succeeded'",
          settle_ledger_transaction_id: `'${settleTxId}'::uuid`,
        }),
        '23514',
        'payouts_timestamps_check',
      );
    });

    it('payouts: amount is a positive integer minor unit', async () => {
      const tenantId = await insertTenant(pool, w);
      const accountId = await insertBankAccount(pool, w, tenantId);
      for (const amount of ['0', '-5', '10.5']) {
        await expectViolation(
          pool,
          buildInsert('payouts', {
            tenant_id: `'${tenantId}'::uuid`,
            bank_account_id: `'${accountId}'::uuid`,
            bank_code: "'BCA'",
            account_number_masked: "'****1234'",
            account_holder_name: "'Owner Name'",
            amount_minor: q(amount),
            currency: "'IDR'",
            status: "'requested'",
            provider: "'sandbox'",
            hold_ledger_transaction_id: `'${await insertLedgerTx(pool)}'::uuid`,
            requested_by_user_id: `'${w.ownerUserId}'::uuid`,
          }),
          '23514',
          'payouts_amount_check',
        );
      }
      // Positive control.
      assert.ok(
        await insertPayout(pool, w, tenantId, accountId, {
          status: 'requested',
          amountMinor: '1',
        }),
      );
    });

    it('bank_accounts: verified requires verified_at, verified_by and method', async () => {
      const tenantId = await insertTenant(pool, w);
      const base: Overrides = {
        tenant_id: `'${tenantId}'::uuid`,
        owner_user_id: `'${w.ownerUserId}'::uuid`,
        bank_code: "'BCA'",
        account_holder_name: "'Owner Name'",
        account_number_ciphertext: "'v1:test-ciphertext'",
        account_number_hash: q(hex64()),
        account_number_masked: "'****1234'",
        status: "'active'",
        is_default: 'false',
        created_by_user_id: `'${w.ownerUserId}'::uuid`,
        version: '1',
      };
      // verified without any of the three verification facts.
      await expectViolation(
        pool,
        buildInsert('bank_accounts', {
          ...base,
          verification_status: "'verified'",
        }),
        '23514',
        'bank_accounts_verification_check',
      );
      // verified with only verified_at.
      await expectViolation(
        pool,
        buildInsert('bank_accounts', {
          ...base,
          verification_status: "'verified'",
          verified_at: 'now()',
        }),
        '23514',
        'bank_accounts_verification_check',
      );
      // pending carrying verification facts (the other direction).
      await expectViolation(
        pool,
        buildInsert('bank_accounts', {
          ...base,
          verification_status: "'pending'",
          verified_at: 'now()',
          verified_by_user_id: `'${w.verifierUserId}'::uuid`,
          verification_method: "'manual_campus'",
        }),
        '23514',
        'bank_accounts_verification_check',
      );
      // Positive controls: pending without facts, verified with all three.
      assert.ok(
        await insertBankAccount(pool, w, tenantId, {
          account_number_hash: q(hex64()),
        }),
      );
      assert.ok(
        await insertBankAccount(pool, w, tenantId, {
          verification_status: "'verified'",
          verified_at: 'now()',
          verified_by_user_id: `'${w.verifierUserId}'::uuid`,
          verification_method: "'manual_campus'",
          is_default: 'false',
          account_number_hash: q(hex64()),
        }),
      );
    });

    it('bank_accounts: the dedupe hash is 64 lowercase hex characters', async () => {
      const tenantId = await insertTenant(pool, w);
      for (const hash of ['not-a-hash', 'A'.repeat(64), 'a'.repeat(63), '']) {
        await expectViolation(
          pool,
          buildInsert('bank_accounts', {
            tenant_id: `'${tenantId}'::uuid`,
            owner_user_id: `'${w.ownerUserId}'::uuid`,
            bank_code: "'BCA'",
            account_holder_name: "'Owner Name'",
            account_number_ciphertext: "'v1:test-ciphertext'",
            account_number_hash: q(hash),
            account_number_masked: "'****1234'",
            verification_status: "'pending'",
            status: "'active'",
            is_default: 'false',
            created_by_user_id: `'${w.ownerUserId}'::uuid`,
            version: '1',
          }),
          '23514',
          'bank_accounts_hash_check',
        );
      }
      // Positive control: the real shape.
      assert.ok(
        await insertBankAccount(pool, w, tenantId, {
          account_number_hash: q(hex64()),
        }),
      );
    });

    it('payout_allocations: unique per (payout, settlement) and tenant-scoped', async () => {
      const fixture = await createOrderFixture(pool, w);
      const tenantId = fixture.tenantId;
      const accountId = await insertBankAccount(pool, w, tenantId);
      const payoutId = await insertPayout(pool, w, tenantId, accountId, {
        status: 'succeeded',
      });
      const settlementId = await insertSettlement(pool, fixture);
      const allocation = (overrides: Overrides = {}) =>
        buildInsert('payout_allocations', {
          tenant_id: `'${tenantId}'::uuid`,
          payout_id: `'${payoutId}'::uuid`,
          settlement_id: `'${settlementId}'::uuid`,
          amount_minor: "'1000'",
          created_at: 'now()',
          ...overrides,
        });
      assert.ok((await pool.query<{ id: string }>(allocation())).rows[0].id);
      // A payout may not allocate the same settlement twice.
      await expectViolation(
        pool,
        allocation({ amount_minor: "'2000'" }),
        '23505',
        'payout_allocations_payout_settlement_uq',
      );
      // Cross-tenant allocation: tenant B cannot reference tenant A's payout.
      const otherFixture = await createOrderFixture(pool, w);
      const otherTenant = otherFixture.tenantId;
      const otherAccount = await insertBankAccount(pool, w, otherTenant);
      const otherPayout = await insertPayout(
        pool,
        w,
        otherTenant,
        otherAccount,
        { status: 'succeeded' },
      );
      const otherSettlement = await insertSettlement(pool, otherFixture);
      await expectViolation(
        pool,
        allocation({
          tenant_id: `'${otherTenant}'::uuid`,
          settlement_id: `'${otherSettlement}'::uuid`,
        }),
        '23503',
        'payout_allocations_tenant_payout_fk',
      );
      // ... nor tenant A's settlement, even under its own payout.
      await expectViolation(
        pool,
        allocation({
          tenant_id: `'${otherTenant}'::uuid`,
          payout_id: `'${otherPayout}'::uuid`,
        }),
        '23503',
        'payout_allocations_tenant_settlement_fk',
      );
      // Positive control: tenant B may allocate its own pair.
      assert.ok(
        (
          await pool.query<{ id: string }>(
            allocation({
              tenant_id: `'${otherTenant}'::uuid`,
              payout_id: `'${otherPayout}'::uuid`,
              settlement_id: `'${otherSettlement}'::uuid`,
            }),
          )
        ).rows[0].id,
      );
    });

    it('payout_provider_events: one row per (provider, event_id)', async () => {
      const tenantId = await insertTenant(pool, w);
      const accountId = await insertBankAccount(pool, w, tenantId);
      const payoutId = await insertPayout(pool, w, tenantId, accountId, {
        status: 'succeeded',
      });
      const eventId = 'evt-' + randomUUID();
      const event = (overrides: Overrides = {}) =>
        buildInsert('payout_provider_events', {
          payout_id: `'${payoutId}'::uuid`,
          provider: "'sandbox'",
          event_id: q(eventId),
          event_type: "'payout.succeeded'",
          amount_minor: "'10000'",
          currency: "'IDR'",
          occurred_at: 'now()',
          ...overrides,
        });
      assert.ok((await pool.query<{ id: string }>(event())).rows[0].id);
      // A replay of the same provider event is rejected.
      await expectViolation(
        pool,
        event(),
        '23505',
        'payout_provider_events_provider_event_uq',
      );
      // Positive control: the same event id at another provider is distinct.
      assert.ok(
        (await pool.query<{ id: string }>(event({ provider: "'other'" })))
          .rows[0].id,
      );
      // Event type is a closed enum; the amount must be positive.
      await expectViolation(
        pool,
        event({
          event_id: q('evt-' + randomUUID()),
          event_type: "'payout.paid'",
        }),
        '23514',
        'payout_provider_events_type_check',
      );
      await expectViolation(
        pool,
        event({ event_id: q('evt-' + randomUUID()), amount_minor: "'0'" }),
        '23514',
        'payout_provider_events_amount_check',
      );
    });

    it('payout_attempts: attempt numbers start at 1', async () => {
      const tenantId = await insertTenant(pool, w);
      const accountId = await insertBankAccount(pool, w, tenantId);
      const payoutId = await insertPayout(pool, w, tenantId, accountId, {
        status: 'requested',
      });
      const attempt = (overrides: Overrides = {}) =>
        buildInsert('payout_attempts', {
          payout_id: `'${payoutId}'::uuid`,
          attempt_no: '1',
          provider: "'sandbox'",
          status: "'pending'",
          started_at: 'now()',
          ...overrides,
        });
      for (const attemptNo of ['0', '-1']) {
        await expectViolation(
          pool,
          attempt({ attempt_no: attemptNo }),
          '23514',
          'payout_attempts_no_check',
        );
      }
      // A finished attempt needs finished_at (bidirectional check).
      await expectViolation(
        pool,
        attempt({ status: "'succeeded'" }),
        '23514',
        'payout_attempts_finished_check',
      );
      // Positive controls: pending #1 and finished #2.
      assert.ok((await pool.query<{ id: string }>(attempt())).rows[0].id);
      assert.ok(
        (
          await pool.query<{ id: string }>(
            attempt({
              attempt_no: '2',
              status: "'failed'",
              finished_at: 'now()',
            }),
          )
        ).rows[0].id,
      );
      // Duplicate attempt numbers are rejected.
      await expectViolation(
        pool,
        attempt(),
        '23505',
        'payout_attempts_payout_attempt_uq',
      );
    });

    it('payout_events: exactly one actor and unique versions', async () => {
      const tenantId = await insertTenant(pool, w);
      const accountId = await insertBankAccount(pool, w, tenantId);
      const payoutId = await insertPayout(pool, w, tenantId, accountId, {
        status: 'requested',
      });
      const event = (overrides: Overrides = {}) =>
        buildInsert('payout_events', {
          payout_id: `'${payoutId}'::uuid`,
          version: '1',
          to_status: "'requested'",
          actor_user_id: `'${w.ownerUserId}'::uuid`,
          reason: "'fixture'",
          ...overrides,
        });
      // Both actor kinds at once.
      await expectViolation(
        pool,
        event({
          actor_service: "'payouts-processor'",
        }),
        '23514',
        'payout_events_actor_check',
      );
      // No actor at all.
      await expectViolation(
        pool,
        event({ actor_user_id: 'null' }),
        '23514',
        'payout_events_actor_check',
      );
      // Version must be positive.
      await expectViolation(
        pool,
        event({ version: '0' }),
        '23514',
        'payout_events_version_check',
      );
      // Positive controls: a user event and a service event insert.
      assert.ok((await pool.query<{ id: string }>(event())).rows[0].id);
      assert.ok(
        (
          await pool.query<{ id: string }>(
            event({
              version: '2',
              actor_user_id: 'null',
              actor_service: "'payouts-processor'",
            }),
          )
        ).rows[0].id,
      );
      // A duplicate version for one payout is rejected.
      await expectViolation(
        pool,
        event({
          actor_user_id: 'null',
          actor_service: "'payouts-processor'",
        }),
        '23505',
        'payout_events_payout_version_uq',
      );
    });
  },
);
