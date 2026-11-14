import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CampusSettlementsService } from '../src/modules/settlements/campus-settlements.service';
import {
  ORDER_PAYMENT_ESCROW_ACCOUNT,
  TENANT_PAYABLE_SYSTEM_KEY_PREFIX,
} from '../src/modules/settlements/settlements.constants';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

type Env = Awaited<ReturnType<typeof createEnv>>;

async function createEnv(pool: Pool) {
  const tag = randomUUID().slice(0, 8);
  const campusA = (
    await pool.query<{ id: string }>(
      "insert into campuses (name, status) values ($1, 'active') returning id",
      ['Kampus Settle A ' + tag],
    )
  ).rows[0].id;
  const campusB = (
    await pool.query<{ id: string }>(
      "insert into campuses (name, status) values ($1, 'active') returning id",
      ['Kampus Settle B ' + tag],
    )
  ).rows[0].id;
  const tenantA1 = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusA, 'Tenant A1 ' + tag, 'Lokasi A1'],
    )
  ).rows[0].id;
  const tenantA2 = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusA, 'Tenant A2 ' + tag, 'Lokasi A2'],
    )
  ).rows[0].id;
  const tenantB = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusB, 'Tenant B ' + tag, 'Lokasi B'],
    )
  ).rows[0].id;
  const mkUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        "insert into users (display_name, status) values ($1, 'active') returning id",
        [name],
      )
    ).rows[0].id;
  const adminA = await mkUser('Admin Settle A ' + tag);
  const viewerA = await mkUser('Viewer Settle A ' + tag);
  const adminB = await mkUser('Admin Settle B ' + tag);
  const buyer = await mkUser('Buyer Settle ' + tag);
  await pool.query(
    `insert into campus_memberships (campus_id, user_id, permissions, status)
     values ($1, $2, $3::text[], 'active'),
            ($1, $4, $5::text[], 'active'),
            ($6, $7, $3::text[], 'active')`,
    [
      campusA,
      adminA,
      ['campus.payouts.read'],
      viewerA,
      ['campus.transactions.read'],
      campusB,
      adminB,
    ],
  );
  await pool.query(
    `insert into tenant_memberships
       (tenant_id, user_id, role, permissions, status, owner_verified_at)
     values ($1, $2, 'owner', '{}'::text[], 'active', now())`,
    [tenantA1, buyer],
  );
  return {
    tag,
    campusA,
    campusB,
    tenantA1,
    tenantA2,
    tenantB,
    adminA,
    viewerA,
    adminB,
    buyer,
  };
}

/**
 * Creates one settlement of the requested status with a real ledger
 * transaction for its release leg: the settlements CHECK constraints reject
 * an 'available'/'paid_out' row without one.
 */
async function createSettlement(
  pool: Pool,
  wallet: WalletService,
  env: Env,
  options: {
    tenantId?: string;
    amountMinor?: string;
    status?: 'pending' | 'available' | 'paid_out';
    createdAt?: Date;
  } = {},
): Promise<{ settlementId: string; orderId: string; amountMinor: string }> {
  const tenantId = options.tenantId ?? env.tenantA1;
  const amountMinor = options.amountMinor ?? '50000';
  const status = options.status ?? 'available';
  const createdAt = options.createdAt ?? new Date();
  const slotId = (
    await pool.query<{ id: string }>(
      `insert into pickup_slots
         (tenant_id, starts_at, ends_at, capacity, reserved_count, status,
          version, created_at, updated_at)
       values ($1, now() + interval '2 hours', now() + interval '3 hours', 5, 0,
               'open', 1, now(), now())
       returning id`,
      [tenantId],
    )
  ).rows[0].id;
  const orderId = (
    await pool.query<{ id: string }>(
      `insert into orders
         (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot,
          tenant_timezone_snapshot, pickup_starts_at, pickup_ends_at, status,
          currency, subtotal_minor, total_minor, paid_at, confirmed_at, ready_at,
          completed_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'Asia/Jakarta', now() - interval '1 hour', now(),
               'completed', 'IDR', $5::numeric, $5::numeric,
               now() - interval '2 hours', now() - interval '2 hours',
               now() - interval '1 hour', now(), $6, now())
       returning id`,
      [
        env.buyer,
        tenantId,
        slotId,
        'Tenant ' + env.tag,
        amountMinor,
        createdAt,
      ],
    )
  ).rows[0].id;
  const escrow = await wallet.ensureSystemAccount(
    ORDER_PAYMENT_ESCROW_ACCOUNT,
    'IDR',
  );
  const paymentTx = await wallet.postTransfer({
    idempotencyScope: 'test.campus-settlements.payment',
    idempotencyKey: randomUUID(),
    reference: { namespace: 'test-order-payment', id: orderId },
    currency: 'IDR',
    amountMinor,
    debitAccountId: (
      await wallet.ensureSystemAccount('test-funding-' + randomUUID(), 'IDR')
    ).accountId,
    creditAccountId: escrow.accountId,
    actor: { type: 'service', id: 'test-fixture' },
    reason: 'campus settlement fixture payment',
  });
  const orderPaymentId = (
    await pool.query<{ id: string }>(
      `insert into order_payments
         (order_id, method, status, amount_minor, currency,
          ledger_transaction_id, succeeded_at, created_at, updated_at)
       values ($1, 'wallet', 'succeeded', $2::numeric, 'IDR', $3, now(), $4, now())
       returning id`,
      [orderId, amountMinor, paymentTx.transactionId, createdAt],
    )
  ).rows[0].id;

  let releaseTransactionId: string | null = null;
  if (status !== 'pending') {
    const payable = await wallet.ensureSystemAccount(
      TENANT_PAYABLE_SYSTEM_KEY_PREFIX + tenantId,
      'IDR',
    );
    const releaseTx = await wallet.postTransfer({
      idempotencyScope: 'test.campus-settlements.release',
      idempotencyKey: randomUUID(),
      reference: { namespace: 'settlement_release', id: orderId },
      currency: 'IDR',
      amountMinor,
      debitAccountId: escrow.accountId,
      creditAccountId: payable.accountId,
      actor: { type: 'service', id: 'test-fixture' },
      reason: 'campus settlement fixture release',
    });
    releaseTransactionId = releaseTx.transactionId;
  }
  const settlementId = (
    await pool.query<{ id: string }>(
      `insert into settlements
         (tenant_id, order_id, order_payment_id, amount_minor, currency, status,
          paid_out_minor, release_ledger_transaction_id, released_at,
          created_at, updated_at)
       values ($1, $2, $3, $4::numeric, 'IDR', $5::varchar, $6::numeric, $7,
               case when $5::varchar = 'pending' then null else now() end, $8,
               now())
       returning id`,
      [
        tenantId,
        orderId,
        orderPaymentId,
        amountMinor,
        status,
        status === 'paid_out' ? amountMinor : '0',
        releaseTransactionId,
        createdAt,
      ],
    )
  ).rows[0].id;
  return { settlementId, orderId, amountMinor };
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number }).status;
}

function codeOf(error: unknown): string | undefined {
  return (error as { response?: { code?: string } }).response?.code;
}

const MICRO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

describe('Campus settlements read model', { skip: !testDatabaseUrl }, () => {
  let pool: Pool;
  let wallet: WalletService;
  let campusSettlements: CampusSettlementsService;

  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
    await pool.query('select 1');
    const db = { pool } as unknown as DatabaseService;
    wallet = new WalletService(db);
    campusSettlements = new CampusSettlementsService(db, new AccessService(db));
  });
  after(async () => {
    await pool?.end();
  });

  it('lists only the settlements of the campus tenants inside the window', async () => {
    const env = await createEnv(pool);
    const inside = await createSettlement(pool, wallet, env, {
      tenantId: env.tenantA1,
      amountMinor: '50000',
      createdAt: new Date('2026-03-10T08:00:00Z'),
    });
    const newest = await createSettlement(pool, wallet, env, {
      tenantId: env.tenantA2,
      amountMinor: '25000',
      createdAt: new Date('2026-03-12T08:00:00Z'),
    });
    await createSettlement(pool, wallet, env, {
      tenantId: env.tenantB,
      amountMinor: '99000',
      createdAt: new Date('2026-03-11T08:00:00Z'),
    });
    await createSettlement(pool, wallet, env, {
      tenantId: env.tenantA1,
      amountMinor: '7000',
      createdAt: new Date('2026-01-05T08:00:00Z'),
    });

    const page = await campusSettlements.listCampusSettlements(
      env.adminA,
      env.campusA,
      { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
    );
    assert.deepEqual(
      page.items.map((row) => row.settlementId),
      [newest.settlementId, inside.settlementId],
    );
    assert.equal(page.nextCursor, null);
    const [first, second] = page.items;
    assert.equal(first.tenantId, env.tenantA2);
    assert.match(first.tenantName, /^Tenant A2 /);
    assert.equal(first.amountMinor, '25000');
    assert.equal(first.paidOutMinor, '0');
    assert.equal(first.currency, 'IDR');
    assert.equal(first.status, 'available');
    assert.match(first.createdAt, MICRO_UTC);
    assert.match(first.releasedAt ?? '', MICRO_UTC);
    assert.equal(second.orderId, inside.orderId);
    assert.equal(second.amountMinor, '50000');
  });

  it('filters by settlement status and by tenant', async () => {
    const env = await createEnv(pool);
    await createSettlement(pool, wallet, env, {
      tenantId: env.tenantA1,
      amountMinor: '40000',
      status: 'available',
      createdAt: new Date('2026-03-05T08:00:00Z'),
    });
    const paidOut = await createSettlement(pool, wallet, env, {
      tenantId: env.tenantA1,
      amountMinor: '60000',
      status: 'paid_out',
      createdAt: new Date('2026-03-06T08:00:00Z'),
    });
    const otherTenant = await createSettlement(pool, wallet, env, {
      tenantId: env.tenantA2,
      amountMinor: '30000',
      status: 'available',
      createdAt: new Date('2026-03-07T08:00:00Z'),
    });
    const range = {
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
    };

    const paidOutPage = await campusSettlements.listCampusSettlements(
      env.adminA,
      env.campusA,
      { ...range, status: 'paid_out' },
    );
    assert.deepEqual(
      paidOutPage.items.map((row) => row.settlementId),
      [paidOut.settlementId],
    );
    assert.equal(paidOutPage.items[0].paidOutMinor, '60000');
    assert.equal(paidOutPage.items[0].status, 'paid_out');

    const tenantPage = await campusSettlements.listCampusSettlements(
      env.adminA,
      env.campusA,
      { ...range, tenantId: env.tenantA2 },
    );
    assert.deepEqual(
      tenantPage.items.map((row) => row.settlementId),
      [otherTenant.settlementId],
    );

    await assert.rejects(
      campusSettlements.listCampusSettlements(env.adminA, env.campusA, {
        ...range,
        status: 'refunded',
      }),
      (error) =>
        statusOf(error) === 400 &&
        codeOf(error) === 'SETTLEMENT_STATUS_INVALID',
    );
  });

  it('pages with an opaque (created_at, id) cursor', async () => {
    const env = await createEnv(pool);
    const created = [];
    for (const day of ['2026-03-02', '2026-03-03', '2026-03-04']) {
      created.push(
        await createSettlement(pool, wallet, env, {
          tenantId: env.tenantA1,
          amountMinor: '10000',
          createdAt: new Date(day + 'T08:00:00Z'),
        }),
      );
    }
    const range = {
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
      limit: 2,
    };
    const firstPage = await campusSettlements.listCampusSettlements(
      env.adminA,
      env.campusA,
      range,
    );
    assert.equal(firstPage.items.length, 2);
    assert.deepEqual(
      firstPage.items.map((row) => row.settlementId),
      [created[2].settlementId, created[1].settlementId],
    );
    assert.equal(typeof firstPage.nextCursor, 'string');

    const secondPage = await campusSettlements.listCampusSettlements(
      env.adminA,
      env.campusA,
      { ...range, cursor: firstPage.nextCursor ?? undefined },
    );
    assert.deepEqual(
      secondPage.items.map((row) => row.settlementId),
      [created[0].settlementId],
    );
    assert.equal(secondPage.nextCursor, null);

    await assert.rejects(
      campusSettlements.listCampusSettlements(env.adminA, env.campusA, {
        ...range,
        cursor: 'not-a-cursor',
      }),
      (error) => statusOf(error) === 400,
    );
    await assert.rejects(
      campusSettlements.listCampusSettlements(env.adminA, env.campusA, {
        ...range,
        limit: 101,
      }),
      (error) => statusOf(error) === 400,
    );
  });

  it('requires campus.payouts.read on that campus', async () => {
    const env = await createEnv(pool);
    await createSettlement(pool, wallet, env, {
      createdAt: new Date('2026-03-05T08:00:00Z'),
    });
    const range = {
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
    };
    // A campus member without campus.payouts.read.
    await assert.rejects(
      campusSettlements.listCampusSettlements(env.viewerA, env.campusA, range),
      (error) => statusOf(error) === 403,
    );
    // A campus manager of a different campus.
    await assert.rejects(
      campusSettlements.listCampusSettlements(env.adminB, env.campusA, range),
      (error) => statusOf(error) === 403,
    );
    // A tenant owner has no campus permission at all.
    await assert.rejects(
      campusSettlements.listCampusSettlements(env.buyer, env.campusA, range),
      (error) => statusOf(error) === 403,
    );
    const own = await campusSettlements.listCampusSettlements(
      env.adminA,
      env.campusA,
      range,
    );
    assert.equal(own.items.length, 1);
  });

  it('rejects a missing, inverted or oversized window', async () => {
    const env = await createEnv(pool);
    await assert.rejects(
      campusSettlements.listCampusSettlements(env.adminA, env.campusA, {
        from: '',
        to: '2026-04-01T00:00:00.000Z',
      }),
      (error) =>
        statusOf(error) === 400 && codeOf(error) === 'REPORT_RANGE_REQUIRED',
    );
    await assert.rejects(
      campusSettlements.listCampusSettlements(env.adminA, env.campusA, {
        from: '2026-04-01T00:00:00.000Z',
        to: '2026-03-01T00:00:00.000Z',
      }),
      (error) =>
        statusOf(error) === 400 && codeOf(error) === 'REPORT_RANGE_INVALID',
    );
    await assert.rejects(
      campusSettlements.listCampusSettlements(env.adminA, env.campusA, {
        from: '2025-01-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      }),
      (error) =>
        statusOf(error) === 400 && codeOf(error) === 'REPORT_RANGE_TOO_LARGE',
    );
    await assert.rejects(
      campusSettlements.listCampusSettlements(env.adminA, 'not-a-uuid', {
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-04-01T00:00:00.000Z',
      }),
      (error) => statusOf(error) === 400,
    );
  });
});
