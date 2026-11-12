import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import { AvailabilityService } from '../src/modules/availability/availability.service';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { TenantOperatingHoursService } from '../src/modules/tenants/tenant-operating-hours.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import {
  PermanentRefundRequestError,
  SandboxRefundAdapter,
  type RefundProviderAdapter,
  type RefundSubmissionInput,
  type RefundSubmissionResult,
} from '../src/modules/refunds/refund.adapter';
import {
  MAX_REFUND_REQUEST_ATTEMPTS,
  ORDER_PAYMENT_ESCROW_ACCOUNT,
  RefundsService,
} from '../src/modules/refunds/refunds.service';
import { CasesService } from '../src/modules/cases/cases.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    REFUNDS_PROVIDER_MODE: 'sandbox',
    PAYMENTS_PROVIDER_MODE: 'disabled',
    ...overrides,
  };
  return {
    getOrThrow: (k: string) => {
      if (!(k in values)) throw new Error('missing config ' + k);
      return values[k];
    },
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

type Services = ReturnType<typeof buildServices>;

function buildServices(
  db: DatabaseService,
  overrides: Record<string, unknown> = {},
) {
  const wallet = new WalletService(db);
  const access = new AccessService(db);
  const audit = new AuditService(db, access);
  const outbox = new OutboxService(db);
  const config = makeConfig(overrides);
  const operatingHours = new TenantOperatingHoursService(db, access, audit);
  const availability = new AvailabilityService(
    db,
    access,
    operatingHours,
    audit,
  );
  const catalog = new CatalogService(db, access, availability, audit);
  const orders = new OrdersService(
    db,
    access,
    catalog,
    availability,
    wallet,
    audit,
    outbox,
    config,
  );
  const adapter = new SandboxRefundAdapter(config);
  const refunds = new RefundsService(
    db,
    wallet,
    audit,
    outbox,
    access,
    orders,
    config,
    adapter,
  );
  const cases = new CasesService(db, access, audit, outbox, refunds);
  return {
    wallet,
    access,
    audit,
    outbox,
    config,
    orders,
    adapter,
    refunds,
    cases,
    availability,
  };
}

function refundsWithAdapter(
  svc: Services,
  adapter: RefundProviderAdapter,
  overrides: Record<string, unknown> = {},
): RefundsService {
  const db = (svc.refunds as unknown as { database: DatabaseService }).database;
  return new RefundsService(
    db,
    svc.wallet,
    svc.audit,
    svc.outbox,
    svc.access,
    svc.orders,
    makeConfig(overrides),
    adapter,
  );
}

function stubAdapter(
  handler: (
    input: RefundSubmissionInput,
  ) => RefundSubmissionResult | Promise<RefundSubmissionResult>,
  base: SandboxRefundAdapter,
): RefundProviderAdapter {
  return {
    provider: 'sandbox',
    buildProviderReference: (input) => base.buildProviderReference(input),
    submitRefund: async (input) => handler(input),
  };
}

type Env = Awaited<ReturnType<typeof createEnv>>;

async function createEnv(pool: Pool) {
  const tag = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      'insert into campuses (name) values ($1) returning id',
      ['Campus ' + tag],
    )
  ).rows[0].id;
  const tenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusId, 'Tenant ' + tag, 'Location ' + tag],
    )
  ).rows[0].id;
  const mkUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [name + ' ' + tag],
      )
    ).rows[0].id;
  const buyerId = await mkUser('Buyer');
  const adminId = await mkUser('CampusAdmin');
  const reviewerId = await mkUser('CaseReviewer');
  const tenantStaffId = await mkUser('TenantStaff');
  const outsiderId = await mkUser('Outsider');
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [
      campusId,
      adminId,
      [
        'campus.cases.read',
        'campus.cases.decide',
        'campus.refunds.initiate',
        'campus.transactions.read',
      ],
    ],
  );
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [campusId, reviewerId, ['campus.cases.read', 'campus.cases.decide']],
  );
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1, $2, 'kitchen', $3::text[], 'active')",
    [
      tenantId,
      tenantStaffId,
      ['tenant.orders.read', 'tenant.incidents.report'],
    ],
  );
  return {
    tag,
    campusId,
    tenantId,
    buyerId,
    adminId,
    reviewerId,
    tenantStaffId,
    outsiderId,
  };
}

async function createOrder(
  pool: Pool,
  wallet: WalletService,
  env: Env,
  opts: {
    status?: 'paid_awaiting_tenant' | 'completed';
    amountMinor?: string;
  } = {},
) {
  const amountMinor = opts.amountMinor ?? '50000';
  const status = opts.status ?? 'paid_awaiting_tenant';
  const slotId = (
    await pool.query<{ id: string }>(
      `insert into pickup_slots
       (tenant_id, starts_at, ends_at, capacity, reserved_count, status, version, created_at, updated_at)
     values ($1, now() + interval '2 hours', now() + interval '3 hours', 5, 1, 'open', 1, now(), now())
     returning id`,
      [env.tenantId],
    )
  ).rows[0].id;
  const buyerWallet = await wallet.getOrCreateWallet(env.buyerId, 'IDR');
  const funder = await wallet.ensureSystemAccount(
    'test-funding-' + randomUUID(),
    'IDR',
  );
  await wallet.postTransfer({
    idempotencyScope: 'test.refunds.funding',
    idempotencyKey: randomUUID(),
    reference: { namespace: 'test-fixture', id: randomUUID() },
    currency: 'IDR',
    amountMinor: '100000',
    debitAccountId: funder.accountId,
    creditAccountId: buyerWallet.accountId,
    actor: { type: 'service', id: 'test-fixture' },
    reason: 'refund fixture funding',
  });
  let orderId: string;
  if (status === 'completed') {
    orderId = (
      await pool.query<{ id: string }>(
        `insert into orders
         (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot, tenant_timezone_snapshot,
          pickup_starts_at, pickup_ends_at, status, currency, subtotal_minor, total_minor,
          paid_at, confirmed_at, ready_at, completed_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'Asia/Jakarta', now() - interval '1 hour', now(), 'completed', 'IDR',
               $5, $5, now() - interval '2 hours', now() - interval '2 hours',
               now() - interval '1 hour', now(), now() - interval '3 hours', now())
       returning id`,
        [env.buyerId, env.tenantId, slotId, 'Tenant ' + env.tag, amountMinor],
      )
    ).rows[0].id;
  } else {
    orderId = (
      await pool.query<{ id: string }>(
        `insert into orders
         (buyer_id, tenant_id, pickup_slot_id, tenant_name_snapshot, tenant_timezone_snapshot,
          pickup_starts_at, pickup_ends_at, status, currency, subtotal_minor, total_minor,
          paid_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'Asia/Jakarta', now() + interval '2 hours', now() + interval '3 hours',
               'paid_awaiting_tenant', 'IDR', $5, $5, now(), now(), now())
       returning id`,
        [env.buyerId, env.tenantId, slotId, 'Tenant ' + env.tag, amountMinor],
      )
    ).rows[0].id;
  }
  const escrow = await wallet.ensureSystemAccount(
    ORDER_PAYMENT_ESCROW_ACCOUNT,
    'IDR',
  );
  const posted = await wallet.postTransfer({
    idempotencyScope: 'test.refunds.checkout',
    idempotencyKey: randomUUID(),
    reference: { namespace: 'test-order-payment', id: randomUUID() },
    currency: 'IDR',
    amountMinor,
    debitAccountId: buyerWallet.accountId,
    creditAccountId: escrow.accountId,
    actor: { type: 'service', id: 'test-fixture' },
    reason: 'refund fixture order payment',
  });
  const orderPaymentId = (
    await pool.query<{ id: string }>(
      `insert into order_payments
       (order_id, method, status, amount_minor, currency, ledger_transaction_id, succeeded_at, created_at, updated_at)
     values ($1, 'wallet', 'succeeded', $2, 'IDR', $3, now(), now(), now())
     returning id`,
      [orderId, amountMinor, posted.transactionId],
    )
  ).rows[0].id;
  if (status === 'completed') {
    await pool.query(
      `insert into slot_reservations (tenant_id, slot_id, order_id, status, created_at, consumed_at, updated_at)
       values ($1, $2, $3, 'consumed', now() - interval '2 hours', now(), now())`,
      [env.tenantId, slotId, orderId],
    );
    await pool.query(
      'update pickup_slots set reserved_count = 0 where id = $1',
      [slotId],
    );
  } else {
    await pool.query(
      `insert into slot_reservations (tenant_id, slot_id, order_id, status, created_at, updated_at)
       values ($1, $2, $3, 'reserved', now(), now())`,
      [env.tenantId, slotId, orderId],
    );
  }
  return {
    orderId,
    slotId,
    orderPaymentId,
    amountMinor,
    escrowAccountId: escrow.accountId,
    buyerWalletAccountId: buyerWallet.accountId,
  };
}

async function escrowBalance(pool: Pool): Promise<bigint> {
  const row = await pool.query<{ balance_minor: string }>(
    "select balance_minor::text from wallet_accounts where account_type = 'system' and system_key = $1 and currency = 'IDR'",
    [ORDER_PAYMENT_ESCROW_ACCOUNT],
  );
  return row.rows[0] ? BigInt(row.rows[0].balance_minor) : BigInt(0);
}

function httpCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'response' in error
    ? ((error as { response: { code?: string } }).response?.code ?? undefined)
    : undefined;
}

describe(
  'Refunds slice PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let db: DatabaseService;
    let svc: Services;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 12 });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      svc = buildServices(db);
    });
    after(async () => {
      await pool?.end();
    });

    it('creates no refund without an authorized campus decision', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      await assert.rejects(
        svc.refunds.initiateCancellationRefund({
          actorUserId: env.outsiderId,
          campusId: env.campusId,
          orderId: order.orderId,
          reason: 'outsider attempt',
        }),
        /Campus access denied/,
      );
      await assert.rejects(
        svc.refunds.initiateCancellationRefund({
          actorUserId: env.reviewerId,
          campusId: env.campusId,
          orderId: order.orderId,
          reason: 'reviewer without refunds.initiate',
        }),
        /Campus permission denied/,
      );
      const rows = await pool.query(
        'select id from refunds where order_id = $1',
        [order.orderId],
      );
      assert.equal(rows.rowCount, 0);
      const orderRow = await pool.query<{ status: string }>(
        'select status from orders where id = $1',
        [order.orderId],
      );
      assert.equal(orderRow.rows[0].status, 'paid_awaiting_tenant');
    });

    it('refuses everything while the provider mode is disabled', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const disabled = refundsWithAdapter(svc, svc.adapter, {
        REFUNDS_PROVIDER_MODE: 'disabled',
      });
      await assert.rejects(
        disabled.initiateCancellationRefund({
          actorUserId: env.adminId,
          campusId: env.campusId,
          orderId: order.orderId,
          reason: 'should be refused',
        }),
        (error: unknown) => httpCode(error) === 'REFUNDS_PROVIDER_DISABLED',
      );
      const production = refundsWithAdapter(svc, svc.adapter, {
        NODE_ENV: 'production',
        REFUNDS_PROVIDER_MODE: 'sandbox',
      });
      assert.equal(production.providerMode(), 'disabled');
      const rows = await pool.query(
        'select id from refunds where order_id = $1',
        [order.orderId],
      );
      assert.equal(rows.rowCount, 0);
    });

    it('cancels the order and stores a pending full refund WITHOUT moving money', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const escrowBefore = await escrowBalance(pool);
      const view = await svc.refunds.initiateCancellationRefund({
        actorUserId: env.adminId,
        campusId: env.campusId,
        orderId: order.orderId,
        reason: 'Tenant could not fulfil the order',
      });
      assert.equal(view.status, 'requested');
      assert.equal(
        view.amountMinor,
        '50000',
        'full captured amount, never client input',
      );
      assert.equal(view.currency, 'IDR');
      assert.equal(view.buyerId, env.buyerId);
      assert.equal(view.orderPaymentId, order.orderPaymentId);
      assert.equal(view.campusId, env.campusId);
      // no money moved
      const balance = await svc.wallet.getBalance(env.buyerId, 'IDR');
      assert.equal(balance[0].balanceMinor, '50000');
      assert.equal(await escrowBalance(pool), escrowBefore);
      // order cancelled + reservation released + capacity restored
      const orderRow = await pool.query<{
        status: string;
        cancelled_at: Date | null;
        version: number;
      }>('select status, cancelled_at, version from orders where id = $1', [
        order.orderId,
      ]);
      assert.equal(orderRow.rows[0].status, 'cancelled');
      assert.ok(orderRow.rows[0].cancelled_at);
      assert.equal(orderRow.rows[0].version, 2);
      const reservation = await pool.query<{
        status: string;
        released_at: Date | null;
      }>(
        'select status, released_at from slot_reservations where order_id = $1',
        [order.orderId],
      );
      assert.equal(reservation.rows[0].status, 'released');
      assert.ok(reservation.rows[0].released_at);
      const slot = await pool.query<{ reserved_count: number }>(
        'select reserved_count from pickup_slots where id = $1',
        [order.slotId],
      );
      assert.equal(slot.rows[0].reserved_count, 0);
      const event = await pool.query(
        "select 1 from order_events where order_id = $1 and event_type = 'order.cancelled'",
        [order.orderId],
      );
      assert.equal(event.rowCount, 1);
      // audit + notification outbox + provider request outbox
      const auditRow = await pool.query(
        "select 1 from audit_events where target_type = 'refund' and target_id = $1 and action = 'campus.refunds.initiated'",
        [view.id],
      );
      assert.equal(auditRow.rowCount, 1);
      const outboxRow = await pool.query(
        'select id from outbox_events where event_key = $1',
        ['refund:' + view.id + ':requested'],
      );
      assert.equal(outboxRow.rowCount, 1);
      const requestRow = await pool.query<{ status: string; attempts: number }>(
        'select status, attempts from refund_request_outbox where refund_id = $1',
        [view.id],
      );
      assert.equal(requestRow.rows[0].status, 'pending');
      assert.equal(requestRow.rows[0].attempts, 0);
    });

    it('rejects a second refund decision for the same order (409, single row)', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      await svc.refunds.initiateCancellationRefund({
        actorUserId: env.adminId,
        campusId: env.campusId,
        orderId: order.orderId,
        reason: 'first decision',
      });
      await assert.rejects(
        svc.refunds.initiateCancellationRefund({
          actorUserId: env.adminId,
          campusId: env.campusId,
          orderId: order.orderId,
          reason: 'second decision',
        }),
        (error: unknown) => httpCode(error) === 'ORDER_CANCEL_CONFLICT',
      );
      const rows = await pool.query(
        'select count(*)::int as n from refunds where order_id = $1',
        [order.orderId],
      );
      assert.equal(rows.rows[0].n, 1);
    });

    it('serializes concurrent decisions into exactly one refund', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const results = await Promise.allSettled([
        svc.refunds.initiateCancellationRefund({
          actorUserId: env.adminId,
          campusId: env.campusId,
          orderId: order.orderId,
          reason: 'race A',
        }),
        svc.refunds.initiateCancellationRefund({
          actorUserId: env.adminId,
          campusId: env.campusId,
          orderId: order.orderId,
          reason: 'race B',
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      assert.equal(fulfilled.length, 1);
      const rows = await pool.query(
        'select count(*)::int as n from refunds where order_id = $1',
        [order.orderId],
      );
      assert.equal(rows.rows[0].n, 1);
      const events = await pool.query(
        "select count(*)::int as n from order_events where order_id = $1 and event_type = 'order.cancelled'",
        [order.orderId],
      );
      assert.equal(events.rows[0].n, 1, 'single cancellation event');
      const slot = await pool.query<{ reserved_count: number }>(
        'select reserved_count from pickup_slots where id = $1',
        [order.slotId],
      );
      assert.equal(
        slot.rows[0].reserved_count,
        0,
        'capacity returned exactly once',
      );
    });
    it('processor success credits the buyer exactly once with a balanced ledger', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const escrowBefore = await escrowBalance(pool);
      const view = await svc.refunds.initiateCancellationRefund({
        actorUserId: env.adminId,
        campusId: env.campusId,
        orderId: order.orderId,
        reason: 'operational cancellation',
      });
      const result = await svc.refunds.processRefundRequest(view.id);
      assert.equal(result.outcome, 'succeeded');
      const balance = await svc.wallet.getBalance(env.buyerId, 'IDR');
      assert.equal(
        balance[0].balanceMinor,
        '100000',
        'buyer restored to 50000 + 50000 refund',
      );
      assert.equal(
        (await escrowBalance(pool)) - escrowBefore,
        BigInt(-50000),
        'escrow paid the refund',
      );
      const row = await pool.query<{
        status: string;
        succeeded_at: Date | null;
        ledger_transaction_id: string | null;
        provider_reference: string | null;
      }>(
        'select status, succeeded_at, ledger_transaction_id, provider_reference from refunds where id = $1',
        [view.id],
      );
      assert.equal(row.rows[0].status, 'succeeded');
      assert.ok(row.rows[0].succeeded_at);
      assert.ok(row.rows[0].ledger_transaction_id);
      assert.ok((row.rows[0].provider_reference ?? '').startsWith('sbx-rfd-'));
      const entries = await pool.query<{
        direction: string;
        amount_minor: string;
        account_id: string;
      }>(
        `select e.direction, e.amount_minor::text, e.account_id::text
           from ledger_entries e
           join ledger_transactions tx on tx.id = e.transaction_id
          where tx.reference_namespace = 'refund' and tx.reference_id = $1`,
        [view.id],
      );
      assert.equal(entries.rowCount, 2);
      assert.deepEqual(entries.rows.map((e) => e.direction).sort(), [
        'credit',
        'debit',
      ]);
      assert.ok(entries.rows.every((e) => e.amount_minor === '50000'));
      const credit = entries.rows.find((e) => e.direction === 'credit');
      assert.equal(
        credit?.account_id,
        order.buyerWalletAccountId,
        'credit lands in the buyer wallet',
      );
      const eventRow = await pool.query<{
        event_type: string;
        processed_at: Date | null;
      }>(
        'select event_type, processed_at from refund_provider_events where refund_id = $1',
        [view.id],
      );
      assert.equal(eventRow.rowCount, 1);
      assert.equal(eventRow.rows[0].event_type, 'refund.succeeded');
      assert.ok(eventRow.rows[0].processed_at);
      const outboxRow = await pool.query<{
        status: string;
        processed_at: Date | null;
        lease_until: Date | null;
      }>(
        'select status, processed_at, lease_until from refund_request_outbox where refund_id = $1',
        [view.id],
      );
      assert.equal(outboxRow.rows[0].status, 'done');
      assert.ok(outboxRow.rows[0].processed_at);
      assert.equal(outboxRow.rows[0].lease_until, null);
      const auditRow = await pool.query(
        "select 1 from audit_events where target_type = 'refund' and target_id = $1 and action = 'refund.succeeded'",
        [view.id],
      );
      assert.equal(auditRow.rowCount, 1);
      const notify = await pool.query(
        'select id from outbox_events where event_key = $1',
        ['refund:' + view.id + ':succeeded'],
      );
      assert.equal(notify.rowCount, 1);
    });

    it('replayed provider requests never credit twice', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const view = await svc.refunds.initiateCancellationRefund({
        actorUserId: env.adminId,
        campusId: env.campusId,
        orderId: order.orderId,
        reason: 'replay test',
      });
      assert.equal(
        (await svc.refunds.processRefundRequest(view.id)).outcome,
        'succeeded',
      );
      const replay1 = await svc.refunds.processRefundRequest(view.id);
      assert.equal(replay1.outcome, 'skipped');
      // hostile replay: force the outbox row back to pending and reprocess
      await pool.query(
        "update refund_request_outbox set status = 'pending', lease_until = null, next_attempt_at = now(), updated_at = now() where refund_id = $1",
        [view.id],
      );
      const replay2 = await svc.refunds.processRefundRequest(view.id);
      assert.equal(
        replay2.outcome,
        'skipped',
        'settled refund short-circuits before the adapter',
      );
      const balance = await svc.wallet.getBalance(env.buyerId, 'IDR');
      assert.equal(balance[0].balanceMinor, '100000', 'exactly one credit');
      const credits = await pool.query(
        `select count(*)::int as n from ledger_entries e
           join ledger_transactions tx on tx.id = e.transaction_id
          where tx.reference_namespace = 'refund' and tx.reference_id = $1 and e.direction = 'credit'`,
        [view.id],
      );
      assert.equal(credits.rows[0].n, 1);
      const events = await pool.query(
        'select count(*)::int as n from refund_provider_events where refund_id = $1',
        [view.id],
      );
      assert.equal(events.rows[0].n, 1);
      const outboxRow = await pool.query<{ status: string }>(
        'select status from refund_request_outbox where refund_id = $1',
        [view.id],
      );
      assert.equal(outboxRow.rows[0].status, 'done');
    });

    it('failed provider outcome records the failure without any credit', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const escrowBefore = await escrowBalance(pool);
      const view = await svc.refunds.initiateCancellationRefund({
        actorUserId: env.adminId,
        campusId: env.campusId,
        orderId: order.orderId,
        reason: 'failure path',
      });
      const failing = refundsWithAdapter(
        svc,
        stubAdapter(
          (input) => ({
            status: 'failed',
            providerReference: input.providerReference,
            occurredAt: new Date(),
            errorCode: 'PROVIDER_REJECTED',
          }),
          svc.adapter,
        ),
      );
      const result = await failing.processRefundRequest(view.id);
      assert.equal(result.outcome, 'failed');
      const balance = await svc.wallet.getBalance(env.buyerId, 'IDR');
      assert.equal(balance[0].balanceMinor, '50000', 'no credit on failure');
      assert.equal(await escrowBalance(pool), escrowBefore);
      const row = await pool.query<{
        status: string;
        failed_at: Date | null;
        succeeded_at: Date | null;
        ledger_transaction_id: string | null;
        last_error: string | null;
      }>(
        'select status, failed_at, succeeded_at, ledger_transaction_id, last_error from refunds where id = $1',
        [view.id],
      );
      assert.equal(row.rows[0].status, 'failed');
      assert.ok(row.rows[0].failed_at);
      assert.equal(row.rows[0].succeeded_at, null);
      assert.equal(row.rows[0].ledger_transaction_id, null);
      assert.equal(row.rows[0].last_error, 'PROVIDER_REJECTED');
      const eventRow = await pool.query<{ event_type: string }>(
        'select event_type from refund_provider_events where refund_id = $1',
        [view.id],
      );
      assert.equal(eventRow.rows[0].event_type, 'refund.failed');
      const auditRow = await pool.query(
        "select 1 from audit_events where target_type = 'refund' and target_id = $1 and action = 'refund.failed'",
        [view.id],
      );
      assert.equal(auditRow.rowCount, 1);
    });

    it('pending outcomes defer with backoff and escalate to needs_assistance at the cap', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const view = await svc.refunds.initiateCancellationRefund({
        actorUserId: env.adminId,
        campusId: env.campusId,
        orderId: order.orderId,
        reason: 'pending path',
      });
      const pending = refundsWithAdapter(
        svc,
        stubAdapter(
          (input) => ({
            status: 'pending',
            providerReference: input.providerReference,
            occurredAt: new Date(),
          }),
          svc.adapter,
        ),
      );
      for (let attempt = 1; attempt < MAX_REFUND_REQUEST_ATTEMPTS; attempt++) {
        const deferred = await pending.processRefundRequest(view.id);
        assert.equal(
          deferred.outcome,
          'deferred',
          'attempt ' + attempt + ' defers',
        );
        const outboxRow = await pool.query<{
          status: string;
          next_attempt_at: Date;
          last_error: string | null;
          attempts: number;
        }>(
          'select status, next_attempt_at, last_error, attempts from refund_request_outbox where refund_id = $1',
          [view.id],
        );
        assert.equal(outboxRow.rows[0].status, 'pending');
        assert.equal(outboxRow.rows[0].attempts, attempt);
        assert.equal(outboxRow.rows[0].last_error, 'PROVIDER_PENDING');
        assert.ok(
          outboxRow.rows[0].next_attempt_at.getTime() > Date.now(),
          'backoff schedules the next attempt',
        );
        const refundRow = await pool.query<{ status: string }>(
          'select status from refunds where id = $1',
          [view.id],
        );
        assert.equal(refundRow.rows[0].status, 'processing');
        await pool.query(
          'update refund_request_outbox set next_attempt_at = now() where refund_id = $1',
          [view.id],
        );
      }
      const escalated = await pending.processRefundRequest(view.id);
      assert.equal(escalated.outcome, 'needs_assistance');
      const finalRow = await pool.query<{
        status: string;
        last_error: string | null;
        succeeded_at: Date | null;
      }>('select status, last_error, succeeded_at from refunds where id = $1', [
        view.id,
      ]);
      assert.equal(finalRow.rows[0].status, 'needs_assistance');
      assert.equal(finalRow.rows[0].last_error, 'PROVIDER_PENDING_TIMEOUT');
      assert.equal(finalRow.rows[0].succeeded_at, null);
      const outboxFinal = await pool.query<{ status: string }>(
        'select status from refund_request_outbox where refund_id = $1',
        [view.id],
      );
      assert.equal(outboxFinal.rows[0].status, 'dead');
      const balance = await svc.wallet.getBalance(env.buyerId, 'IDR');
      assert.equal(
        balance[0].balanceMinor,
        '50000',
        'pending/needs_assistance never credits',
      );
      const auditRow = await pool.query(
        "select 1 from audit_events where target_type = 'refund' and target_id = $1 and action = 'refund.needs_assistance'",
        [view.id],
      );
      assert.equal(auditRow.rowCount, 1);
    });

    it('transient errors defer; permanent errors escalate without credit', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const view = await svc.refunds.initiateCancellationRefund({
        actorUserId: env.adminId,
        campusId: env.campusId,
        orderId: order.orderId,
        reason: 'error paths',
      });
      const transient = refundsWithAdapter(
        svc,
        stubAdapter(() => {
          throw new Error('network blip');
        }, svc.adapter),
      );
      const deferred = await transient.processRefundRequest(view.id);
      assert.equal(deferred.outcome, 'deferred');
      const outboxRow = await pool.query<{
        status: string;
        last_error: string | null;
      }>(
        'select status, last_error from refund_request_outbox where refund_id = $1',
        [view.id],
      );
      assert.equal(outboxRow.rows[0].status, 'pending');
      assert.equal(outboxRow.rows[0].last_error, 'PROVIDER_REQUEST_FAILED');
      const refundRow = await pool.query<{ status: string }>(
        'select status from refunds where id = $1',
        [view.id],
      );
      assert.equal(
        refundRow.rows[0].status,
        'requested',
        'refund untouched by a transient error',
      );
      await pool.query(
        'update refund_request_outbox set next_attempt_at = now() where refund_id = $1',
        [view.id],
      );
      const permanent = refundsWithAdapter(
        svc,
        stubAdapter(() => {
          throw new PermanentRefundRequestError(
            'PROVIDER_CONTRACT_MISSING',
            'no contract',
          );
        }, svc.adapter),
      );
      const escalated = await permanent.processRefundRequest(view.id);
      assert.equal(escalated.outcome, 'needs_assistance');
      const finalRefund = await pool.query<{
        status: string;
        last_error: string | null;
      }>('select status, last_error from refunds where id = $1', [view.id]);
      assert.equal(finalRefund.rows[0].status, 'needs_assistance');
      assert.equal(finalRefund.rows[0].last_error, 'PROVIDER_CONTRACT_MISSING');
      const balance = await svc.wallet.getBalance(env.buyerId, 'IDR');
      assert.equal(balance[0].balanceMinor, '50000');
    });

    it('skips an actively leased row and takes over an expired lease', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const view = await svc.refunds.initiateCancellationRefund({
        actorUserId: env.adminId,
        campusId: env.campusId,
        orderId: order.orderId,
        reason: 'lease fencing',
      });
      await pool.query(
        "update refund_request_outbox set status = 'processing', attempts = 1, lease_until = now() + interval '60 seconds', updated_at = now() where refund_id = $1",
        [view.id],
      );
      const skipped = await svc.refunds.processRefundRequest(view.id);
      assert.equal(skipped.outcome, 'skipped');
      if (skipped.outcome === 'skipped') assert.equal(skipped.reason, 'leased');
      await pool.query(
        "update refund_request_outbox set lease_until = now() - interval '10 seconds' where refund_id = $1",
        [view.id],
      );
      const takenOver = await svc.refunds.processRefundRequest(view.id);
      assert.equal(
        takenOver.outcome,
        'succeeded',
        'expired lease is taken over and completed',
      );
    });

    it('scopes the buyer refund read to their own order', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const view = await svc.refunds.initiateCancellationRefund({
        actorUserId: env.adminId,
        campusId: env.campusId,
        orderId: order.orderId,
        reason: 'scoped read',
      });
      const own = await svc.refunds.getRefundForOrder(
        env.buyerId,
        order.orderId,
      );
      assert.equal(own?.id, view.id);
      await assert.rejects(
        svc.refunds.getRefundForOrder(env.outsiderId, order.orderId),
        /Order was not found/,
      );
      await assert.rejects(
        svc.refunds.getRefundForOrder(env.buyerId, randomUUID()),
        /Order was not found/,
      );
    });

    it('scopes the campus refund list to permissioned campus staff', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const view = await svc.refunds.initiateCancellationRefund({
        actorUserId: env.adminId,
        campusId: env.campusId,
        orderId: order.orderId,
        reason: 'campus list scope',
      });
      const listed = await svc.refunds.listCampusRefunds(
        env.adminId,
        env.campusId,
        {},
      );
      assert.ok(listed.items.some((item) => item.id === view.id));
      assert.ok(listed.items.every((item) => item.campusId === env.campusId));
      await assert.rejects(
        svc.refunds.listCampusRefunds(env.reviewerId, env.campusId, {}),
        /Campus permission denied/,
      );
      await assert.rejects(
        svc.refunds.listCampusRefunds(env.outsiderId, env.campusId, {}),
        /Campus access denied/,
      );
      const otherEnv = await createEnv(pool);
      const otherList = await svc.refunds.listCampusRefunds(
        otherEnv.adminId,
        otherEnv.campusId,
        {},
      );
      assert.ok(
        !otherList.items.some((item) => item.id === view.id),
        'no cross-campus leakage',
      );
    });

    it('rejects initiating a refund for an order of another campus (404)', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const otherEnv = await createEnv(pool);
      await assert.rejects(
        svc.refunds.initiateCancellationRefund({
          actorUserId: otherEnv.adminId,
          campusId: otherEnv.campusId,
          orderId: order.orderId,
          reason: 'cross campus attempt',
        }),
        /Order was not found for this campus/,
      );
      const orderRow = await pool.query<{ status: string }>(
        'select status from orders where id = $1',
        [order.orderId],
      );
      assert.equal(orderRow.rows[0].status, 'paid_awaiting_tenant');
      const rows = await pool.query(
        'select id from refunds where order_id = $1',
        [order.orderId],
      );
      assert.equal(rows.rowCount, 0);
    });
  },
);
