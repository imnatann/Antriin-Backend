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
import { SandboxRefundAdapter } from '../src/modules/refunds/refund.adapter';
import {
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
  return { wallet, access, audit, outbox, config, orders, refunds, cases };
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
  const otherBuyerId = await mkUser('OtherBuyer');
  const adminId = await mkUser('CampusAdmin');
  const reviewerId = await mkUser('CaseReviewer');
  const tenantStaffId = await mkUser('TenantStaff');
  const readOnlyStaffId = await mkUser('PickupStaff');
  const reporterOnlyId = await mkUser('ReporterOnly');
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
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1, $2, 'pickup', $3::text[], 'active')",
    [tenantId, readOnlyStaffId, ['tenant.orders.read']],
  );
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1, $2, 'kitchen', $3::text[], 'active')",
    [tenantId, reporterOnlyId, ['tenant.incidents.report']],
  );
  return {
    tag,
    campusId,
    tenantId,
    buyerId,
    otherBuyerId,
    adminId,
    reviewerId,
    tenantStaffId,
    readOnlyStaffId,
    reporterOnlyId,
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
    idempotencyScope: 'test.cases.funding',
    idempotencyKey: randomUUID(),
    reference: { namespace: 'test-fixture', id: randomUUID() },
    currency: 'IDR',
    amountMinor: '100000',
    debitAccountId: funder.accountId,
    creditAccountId: buyerWallet.accountId,
    actor: { type: 'service', id: 'test-fixture' },
    reason: 'cases fixture funding',
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
    idempotencyScope: 'test.cases.checkout',
    idempotencyKey: randomUUID(),
    reference: { namespace: 'test-order-payment', id: randomUUID() },
    currency: 'IDR',
    amountMinor,
    debitAccountId: buyerWallet.accountId,
    creditAccountId: escrow.accountId,
    actor: { type: 'service', id: 'test-fixture' },
    reason: 'cases fixture order payment',
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

async function countRows(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const result = await pool.query<{ n: number }>(sql, params);
  return result.rows[0].n;
}

function httpCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'response' in error
    ? ((error as { response: { code?: string } }).response?.code ?? undefined)
    : undefined;
}

function sqlState(code: string) {
  return (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code;
}

type CaseInsert = {
  status?: string;
  category?: string;
  subject?: string;
  decisionReason?: string | null;
  decidedByUserId?: string | null;
  decidedAt?: Date | null;
};

function insertCaseRow(pool: Pool, env: Env, overrides: CaseInsert = {}) {
  return pool.query(
    `insert into cases
       (campus_id, tenant_id, opened_by_user_id, category, status, subject, details,
        decision_reason, decided_by_user_id, decided_at, version, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, '', $7, $8, $9, 1, now(), now())`,
    [
      env.campusId,
      env.tenantId,
      env.buyerId,
      overrides.category ?? 'other',
      overrides.status ?? 'reported',
      overrides.subject ?? 'Subject',
      overrides.decisionReason ?? null,
      overrides.decidedByUserId ?? null,
      overrides.decidedAt ?? null,
    ],
  );
}

describe(
  'Cases slice PostgreSQL integration',
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

    it('lets a buyer open a case about their own order and audits the report', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const view = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
        category: 'quality',
        subject: '  Item arrived cold  ',
        details: '  The soup was cold at pickup  ',
      });
      assert.equal(view.status, 'reported');
      assert.equal(view.category, 'quality');
      assert.equal(view.subject, 'Item arrived cold');
      assert.equal(view.details, 'The soup was cold at pickup');
      assert.equal(view.orderId, order.orderId);
      assert.equal(view.campusId, env.campusId);
      assert.equal(view.tenantId, env.tenantId);
      assert.equal(view.buyerId, env.buyerId);
      assert.equal(view.openedByUserId, env.buyerId);
      assert.equal(view.version, 1);
      assert.equal(view.decisionReason, null);
      assert.equal(view.decidedAt, null);
      assert.equal(view.decidedByUserId, null);
      assert.equal(typeof view.createdAt, 'string');
      assert.ok(view.createdAt.includes('T'));

      const audit = await pool.query<{
        actor_user_id: string;
        scope_type: string;
        scope_id: string;
        reason: string;
        metadata: Record<string, unknown>;
      }>(
        "select actor_user_id::text, scope_type, scope_id::text, reason, metadata from audit_events where target_type = 'case' and target_id = $1 and action = 'campus.cases.reported'",
        [view.id],
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].actor_user_id, env.buyerId);
      assert.equal(audit.rows[0].scope_type, 'campus');
      assert.equal(audit.rows[0].scope_id, env.campusId);
      assert.equal(audit.rows[0].reason, 'Item arrived cold');
      assert.equal(audit.rows[0].metadata.category, 'quality');
      assert.equal(audit.rows[0].metadata.openedByRole, 'buyer');
      assert.equal(audit.rows[0].metadata.tenantId, env.tenantId);

      const notify = await pool.query<{ recipient_ids: string[] }>(
        'select recipient_ids from outbox_events where event_key = $1',
        ['case:' + view.id + ':reported'],
      );
      assert.equal(notify.rowCount, 1);
      assert.deepEqual(
        [...notify.rows[0].recipient_ids].sort(),
        [env.adminId, env.reviewerId].sort(),
      );

      // A reported case is only a report: the order is untouched.
      const orderRow = await pool.query<{ status: string }>(
        'select status from orders where id = $1',
        [order.orderId],
      );
      assert.equal(orderRow.rows[0].status, 'paid_awaiting_tenant');
    });

    it("hides another buyer's order behind 404 and creates no case", async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const input = { category: 'other', subject: 'Not my order' };
      await assert.rejects(
        svc.cases.openBuyerCase(env.otherBuyerId, order.orderId, input),
        /Order was not found/,
      );
      await assert.rejects(
        svc.cases.openBuyerCase(env.buyerId, randomUUID(), input),
        /Order was not found/,
      );
      assert.equal(
        await countRows(
          pool,
          'select count(*)::int as n from cases where order_id = $1',
          [order.orderId],
        ),
        0,
      );
    });

    it('lets tenant staff open a case with tenant.incidents.report and rejects other tenants', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const view = await svc.cases.openTenantCase(
        env.tenantStaffId,
        env.tenantId,
        {
          category: 'no_show',
          subject: 'Buyer did not show up',
          details: 'Waited 20 minutes past the slot',
          orderId: order.orderId,
        },
      );
      assert.equal(view.openedByUserId, env.tenantStaffId);
      assert.equal(view.buyerId, env.buyerId);
      assert.equal(view.orderId, order.orderId);
      assert.equal(view.campusId, env.campusId);
      const audit = await pool.query<{ metadata: Record<string, unknown> }>(
        "select metadata from audit_events where target_type = 'case' and target_id = $1 and action = 'campus.cases.reported'",
        [view.id],
      );
      assert.equal(audit.rows[0].metadata.openedByRole, 'tenant');

      // Staff without tenant.incidents.report cannot report.
      await assert.rejects(
        svc.cases.openTenantCase(env.readOnlyStaffId, env.tenantId, {
          category: 'other',
          subject: 'No permission',
        }),
        /Tenant permission denied/,
      );
      // Staff of another tenant cannot write into this tenant.
      const other = await createEnv(pool);
      const otherOrder = await createOrder(pool, svc.wallet, other);
      await assert.rejects(
        svc.cases.openTenantCase(other.tenantStaffId, env.tenantId, {
          category: 'other',
          subject: 'Cross tenant',
        }),
        /Tenant access denied/,
      );
      // An order of another tenant cannot be attached.
      await assert.rejects(
        svc.cases.openTenantCase(env.tenantStaffId, env.tenantId, {
          category: 'other',
          subject: 'Foreign order',
          orderId: otherOrder.orderId,
        }),
        /Order was not found for this tenant/,
      );
      // Validation is server-side, before any write.
      await assert.rejects(
        svc.cases.openTenantCase(env.tenantStaffId, env.tenantId, {
          category: 'refund',
          subject: 'Bad category',
        }),
        (error: unknown) => httpCode(error) === 'CASE_CATEGORY_INVALID',
      );
      await assert.rejects(
        svc.cases.openTenantCase(env.tenantStaffId, env.tenantId, {
          category: 'other',
          subject: '   ',
        }),
        (error: unknown) => httpCode(error) === 'CASE_SUBJECT_INVALID',
      );
      await assert.rejects(
        svc.cases.openTenantCase(env.tenantStaffId, env.tenantId, {
          category: 'other',
          subject: 'Too long',
          details: 'x'.repeat(4001),
        }),
        (error: unknown) => httpCode(error) === 'CASE_DETAILS_TOO_LONG',
      );
    });

    it('lets campus staff open a case in their campus only', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const view = await svc.cases.openCampusCase(env.adminId, env.campusId, {
        category: 'schedule',
        subject: 'Preparation ran late',
        tenantId: env.tenantId,
        orderId: order.orderId,
      });
      assert.equal(view.openedByUserId, env.adminId);
      assert.equal(view.campusId, env.campusId);
      assert.equal(view.tenantId, env.tenantId);
      assert.equal(view.buyerId, env.buyerId);
      const audit = await pool.query<{ metadata: Record<string, unknown> }>(
        "select metadata from audit_events where target_type = 'case' and target_id = $1 and action = 'campus.cases.reported'",
        [view.id],
      );
      assert.equal(audit.rows[0].metadata.openedByRole, 'campus');

      const other = await createEnv(pool);
      // A tenant of another campus is not reachable from this campus.
      await assert.rejects(
        svc.cases.openCampusCase(other.adminId, other.campusId, {
          category: 'other',
          subject: 'Foreign tenant',
          tenantId: env.tenantId,
        }),
        /Tenant was not found for this campus/,
      );
      // No campus membership -> 403, existence is not leaked.
      await assert.rejects(
        svc.cases.openCampusCase(other.adminId, env.campusId, {
          category: 'other',
          subject: 'Foreign campus',
          tenantId: env.tenantId,
        }),
        /Campus access denied/,
      );
      await assert.rejects(
        svc.cases.openCampusCase(env.outsiderId, env.campusId, {
          category: 'other',
          subject: 'No membership',
          tenantId: env.tenantId,
        }),
        /Campus access denied/,
      );
    });

    it('walks reported -> under_review -> awaiting_information -> resolved with an audit trail', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const opened = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
        category: 'order_issue',
        subject: 'Missing side item',
      });

      const underReview = await svc.cases.decideCase(
        env.adminId,
        env.campusId,
        opened.id,
        { status: 'under_review', reason: 'Reviewing with the tenant' },
      );
      assert.equal(underReview.case.status, 'under_review');
      assert.equal(underReview.case.version, 2);
      assert.equal(underReview.case.decisionReason, null);
      assert.equal(underReview.case.decidedAt, null);
      assert.equal(underReview.case.decidedByUserId, null);
      assert.equal(underReview.refund, null);

      const awaiting = await svc.cases.decideCase(
        env.adminId,
        env.campusId,
        opened.id,
        {
          status: 'awaiting_information',
          reason: 'Waiting for the buyer photo',
        },
      );
      assert.equal(awaiting.case.status, 'awaiting_information');
      assert.equal(awaiting.case.version, 3);

      const resolved = await svc.cases.decideCase(
        env.adminId,
        env.campusId,
        opened.id,
        { status: 'resolved', reason: 'Tenant delivered the missing item' },
      );
      assert.equal(resolved.case.status, 'resolved');
      assert.equal(resolved.case.version, 4);
      assert.equal(
        resolved.case.decisionReason,
        'Tenant delivered the missing item',
      );
      assert.equal(resolved.case.decidedByUserId, env.adminId);
      assert.ok(resolved.case.decidedAt);
      assert.equal(resolved.refund, null);

      // A resolution is not a cancellation: no refund and no order change.
      assert.equal(
        await countRows(
          pool,
          'select count(*)::int as n from refunds where case_id = $1',
          [opened.id],
        ),
        0,
      );
      const orderRow = await pool.query<{ status: string }>(
        'select status from orders where id = $1',
        [order.orderId],
      );
      assert.equal(orderRow.rows[0].status, 'paid_awaiting_tenant');

      const audits = await pool.query<{ action: string }>(
        "select action from audit_events where target_type = 'case' and target_id = $1",
        [opened.id],
      );
      assert.deepEqual(audits.rows.map((row) => row.action).sort(), [
        'campus.cases.decided',
        'campus.cases.reported',
        'campus.cases.status_changed',
        'campus.cases.status_changed',
      ]);
      const notify = await pool.query(
        'select 1 from outbox_events where event_key = $1',
        ['case:' + opened.id + ':resolved'],
      );
      assert.equal(notify.rowCount, 1);
    });

    it('rejects a decision without a reason or with an unknown status before writing', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const opened = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
        category: 'other',
        subject: 'Reason required',
      });
      await assert.rejects(
        svc.cases.decideCase(env.adminId, env.campusId, opened.id, {
          status: 'under_review',
          reason: '   ',
        }),
        (error: unknown) => httpCode(error) === 'CASE_REASON_REQUIRED',
      );
      await assert.rejects(
        svc.cases.decideCase(env.adminId, env.campusId, opened.id, {
          status: 'reported',
          reason: 'Not a decision target',
        }),
        (error: unknown) => httpCode(error) === 'CASE_STATUS_INVALID',
      );
      const row = await pool.query<{ status: string; version: number }>(
        'select status, version from cases where id = $1',
        [opened.id],
      );
      assert.equal(row.rows[0].status, 'reported');
      assert.equal(row.rows[0].version, 1);
    });

    it('approved_cancel cancels the order and queues one pending full refund without moving money', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const balanceBefore = (await svc.wallet.getBalance(env.buyerId, 'IDR'))[0]
        .balanceMinor;
      const opened = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
        category: 'no_show',
        subject: 'Tenant closed before the slot',
      });

      const result = await svc.cases.decideCase(
        env.adminId,
        env.campusId,
        opened.id,
        {
          status: 'approved_cancel',
          reason: 'Tenant closed early; full refund approved',
        },
      );
      assert.equal(result.case.status, 'approved_cancel');
      assert.equal(result.case.version, 2);
      assert.equal(result.case.decidedByUserId, env.adminId);
      assert.ok(result.case.decidedAt);
      assert.equal(
        result.case.decisionReason,
        'Tenant closed early; full refund approved',
      );
      const refund = result.refund;
      assert.ok(refund, 'approved_cancel must return the pending refund');
      assert.equal(refund.status, 'requested');
      assert.equal(refund.amountMinor, order.amountMinor);
      assert.equal(refund.currency, 'IDR');
      assert.equal(refund.buyerId, env.buyerId);
      assert.equal(refund.caseId, opened.id);
      assert.equal(refund.orderId, order.orderId);
      assert.equal(refund.orderPaymentId, order.orderPaymentId);

      const refundRow = await pool.query<{
        status: string;
        provider: string;
        attempt_count: number;
      }>('select status, provider, attempt_count from refunds where id = $1', [
        refund.id,
      ]);
      assert.equal(refundRow.rows[0].status, 'requested');
      assert.equal(refundRow.rows[0].provider, 'sandbox');
      assert.equal(refundRow.rows[0].attempt_count, 0);
      assert.equal(
        await countRows(
          pool,
          "select count(*)::int as n from refund_request_outbox where refund_id = $1 and status = 'pending'",
          [refund.id],
        ),
        1,
      );

      const orderRow = await pool.query<{
        status: string;
        cancelled_at: Date | null;
        version: number;
      }>('select status, cancelled_at, version from orders where id = $1', [
        order.orderId,
      ]);
      assert.equal(orderRow.rows[0].status, 'cancelled');
      assert.ok(orderRow.rows[0].cancelled_at);
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
      assert.equal(
        await countRows(
          pool,
          "select count(*)::int as n from order_events where order_id = $1 and event_type = 'order.cancelled'",
          [order.orderId],
        ),
        1,
      );

      // No money moves on the decision: only a later provider success credits.
      // The escrow system account is shared with every other suite running in
      // parallel, so this is scoped to the order's own refund instead of the
      // whole account balance.
      assert.equal(
        (await svc.wallet.getBalance(env.buyerId, 'IDR'))[0].balanceMinor,
        balanceBefore,
      );
      assert.equal(
        await countRows(
          pool,
          'select count(*)::int as n from refunds where order_id = $1 and ledger_transaction_id is not null',
          [order.orderId],
        ),
        0,
        'a pending refund must not have a ledger transaction yet',
      );

      const caseAudit = await pool.query<{ metadata: Record<string, unknown> }>(
        "select metadata from audit_events where target_type = 'case' and target_id = $1 and action = 'campus.cases.decided'",
        [opened.id],
      );
      assert.equal(caseAudit.rowCount, 1);
      assert.equal(caseAudit.rows[0].metadata.to, 'approved_cancel');
      assert.equal(caseAudit.rows[0].metadata.refundId, refund.id);
      assert.equal(
        await countRows(
          pool,
          "select count(*)::int as n from audit_events where target_type = 'refund' and target_id = $1 and action = 'campus.refunds.initiated'",
          [refund.id],
        ),
        1,
      );
    });

    it('refuses approved_cancel without campus.refunds.initiate and rolls everything back', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const opened = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
        category: 'payment',
        subject: 'Double charge complaint',
      });
      // The reviewer may review (campus.cases.decide) but may not initiate money.
      const reviewing = await svc.cases.decideCase(
        env.reviewerId,
        env.campusId,
        opened.id,
        { status: 'under_review', reason: 'Reviewer triage' },
      );
      assert.equal(reviewing.case.status, 'under_review');

      await assert.rejects(
        svc.cases.decideCase(env.reviewerId, env.campusId, opened.id, {
          status: 'approved_cancel',
          reason: 'No refund permission',
        }),
        /Campus permission denied/,
      );

      const row = await pool.query<{ status: string; version: number }>(
        'select status, version from cases where id = $1',
        [opened.id],
      );
      assert.equal(row.rows[0].status, 'under_review');
      assert.equal(row.rows[0].version, 2);
      const orderRow = await pool.query<{ status: string }>(
        'select status from orders where id = $1',
        [order.orderId],
      );
      assert.equal(orderRow.rows[0].status, 'paid_awaiting_tenant');
      assert.equal(
        await countRows(
          pool,
          'select count(*)::int as n from refunds where order_id = $1',
          [order.orderId],
        ),
        0,
      );
      assert.equal(
        await countRows(
          pool,
          "select count(*)::int as n from audit_events where target_type = 'case' and target_id = $1 and action = 'campus.cases.decided'",
          [opened.id],
        ),
        0,
      );
    });

    it('rejects a second terminal decision with 409 and no second effect', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const opened = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
        category: 'other',
        subject: 'Terminal decision',
      });
      const first = await svc.cases.decideCase(
        env.adminId,
        env.campusId,
        opened.id,
        { status: 'declined', reason: 'No evidence provided' },
      );
      assert.equal(first.case.status, 'declined');
      assert.equal(first.case.version, 2);
      await assert.rejects(
        svc.cases.decideCase(env.adminId, env.campusId, opened.id, {
          status: 'resolved',
          reason: 'Second decision attempt',
        }),
        (error: unknown) => httpCode(error) === 'CASE_ALREADY_DECIDED',
      );
      const row = await pool.query<{
        status: string;
        version: number;
        decision_reason: string;
      }>('select status, version, decision_reason from cases where id = $1', [
        opened.id,
      ]);
      assert.equal(row.rows[0].status, 'declined');
      assert.equal(row.rows[0].version, 2);
      assert.equal(row.rows[0].decision_reason, 'No evidence provided');
      assert.equal(
        await countRows(
          pool,
          "select count(*)::int as n from audit_events where target_type = 'case' and target_id = $1 and action = 'campus.cases.decided'",
          [opened.id],
        ),
        1,
      );
    });

    it('requires an order-linked case for approved_cancel', async () => {
      const env = await createEnv(pool);
      const opened = await svc.cases.openTenantCase(
        env.tenantStaffId,
        env.tenantId,
        { category: 'other', subject: 'Tenant-wide operational issue' },
      );
      await assert.rejects(
        svc.cases.decideCase(env.adminId, env.campusId, opened.id, {
          status: 'approved_cancel',
          reason: 'Cancellation without an order',
        }),
        (error: unknown) => httpCode(error) === 'CASE_ORDER_REQUIRED',
      );
      const row = await pool.query<{ status: string }>(
        'select status from cases where id = $1',
        [opened.id],
      );
      assert.equal(row.rows[0].status, 'reported');
    });

    it('does not refund a post-handover case and only records the human decision', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env, {
        status: 'completed',
      });
      const balanceBefore = (await svc.wallet.getBalance(env.buyerId, 'IDR'))[0]
        .balanceMinor;
      const opened = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
        category: 'quality',
        subject: 'Cold after pickup',
      });
      await assert.rejects(
        svc.cases.decideCase(env.adminId, env.campusId, opened.id, {
          status: 'approved_cancel',
          reason: 'Buyer complaint after handover',
        }),
        (error: unknown) => httpCode(error) === 'ORDER_CANCEL_CONFLICT',
      );
      // Nothing changed: the case is still reported, the order still completed,
      // and no refund row exists (no automatic post-pickup refund).
      const caseRow = await pool.query<{ status: string; version: number }>(
        'select status, version from cases where id = $1',
        [opened.id],
      );
      assert.equal(caseRow.rows[0].status, 'reported');
      assert.equal(caseRow.rows[0].version, 1);
      const orderRow = await pool.query<{ status: string }>(
        'select status from orders where id = $1',
        [order.orderId],
      );
      assert.equal(orderRow.rows[0].status, 'completed');
      assert.equal(
        await countRows(
          pool,
          'select count(*)::int as n from refunds where order_id = $1',
          [order.orderId],
        ),
        0,
      );
      assert.equal(
        (await svc.wallet.getBalance(env.buyerId, 'IDR'))[0].balanceMinor,
        balanceBefore,
      );

      // The case can still be closed by a human decision, without money.
      const resolved = await svc.cases.decideCase(
        env.adminId,
        env.campusId,
        opened.id,
        {
          status: 'resolved',
          reason: 'Explained handling; no refund after pickup',
        },
      );
      assert.equal(resolved.case.status, 'resolved');
      assert.equal(resolved.refund, null);
      assert.equal(
        await countRows(
          pool,
          'select count(*)::int as n from refunds where order_id = $1',
          [order.orderId],
        ),
        0,
      );
    });

    it('refuses approved_cancel while the refunds provider is disabled and rolls back the case', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const opened = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
        category: 'other',
        subject: 'Provider disabled',
      });
      const disabled = buildServices(db, { REFUNDS_PROVIDER_MODE: 'disabled' });
      assert.equal(disabled.refunds.providerMode(), 'disabled');
      await assert.rejects(
        disabled.cases.decideCase(env.adminId, env.campusId, opened.id, {
          status: 'approved_cancel',
          reason: 'Provider is off',
        }),
        (error: unknown) => httpCode(error) === 'REFUNDS_PROVIDER_DISABLED',
      );
      const caseRow = await pool.query<{ status: string; version: number }>(
        'select status, version from cases where id = $1',
        [opened.id],
      );
      assert.equal(caseRow.rows[0].status, 'reported');
      assert.equal(caseRow.rows[0].version, 1);
      const orderRow = await pool.query<{ status: string }>(
        'select status from orders where id = $1',
        [order.orderId],
      );
      assert.equal(orderRow.rows[0].status, 'paid_awaiting_tenant');
      assert.equal(
        await countRows(
          pool,
          'select count(*)::int as n from refunds where order_id = $1',
          [order.orderId],
        ),
        0,
      );
    });

    it('enforces the decision/status CHECK constraints in PostgreSQL', async () => {
      const env = await createEnv(pool);
      const reject = sqlState('23514');
      // Positive controls: a reported row and a complete decided row are valid.
      await insertCaseRow(pool, env, { status: 'reported' });
      const decidedOk = await insertCaseRow(pool, env, {
        status: 'resolved',
        decisionReason: 'Resolved with the buyer',
        decidedByUserId: env.adminId,
        decidedAt: new Date(),
      });
      assert.equal(decidedOk.rowCount, 1);

      // Decided statuses require decided_at, decided_by and a reason.
      await assert.rejects(
        insertCaseRow(pool, env, { status: 'resolved' }),
        reject,
      );
      await assert.rejects(
        insertCaseRow(pool, env, {
          status: 'declined',
          decidedAt: new Date(),
          decidedByUserId: env.adminId,
        }),
        reject,
      );
      await assert.rejects(
        insertCaseRow(pool, env, {
          status: 'approved_cancel',
          decisionReason: 'Missing decider',
          decidedAt: new Date(),
        }),
        reject,
      );
      // Non-decided statuses must keep the decision columns empty.
      await assert.rejects(
        insertCaseRow(pool, env, {
          status: 'under_review',
          decidedAt: new Date(),
        }),
        reject,
      );
      await assert.rejects(
        insertCaseRow(pool, env, {
          status: 'awaiting_information',
          decidedByUserId: env.adminId,
        }),
        reject,
      );
      // Enumerations and subject guard.
      await assert.rejects(
        insertCaseRow(pool, env, { category: 'refund' }),
        reject,
      );
      await assert.rejects(
        insertCaseRow(pool, env, { status: 'cancelled' }),
        reject,
      );
      await assert.rejects(
        insertCaseRow(pool, env, { subject: '   ' }),
        reject,
      );
    });

    it('scopes buyer reads to cases about their own orders', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const own = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
        category: 'other',
        subject: 'My own case',
      });
      const other = await createEnv(pool);
      const otherOrder = await createOrder(pool, svc.wallet, other);
      const foreign = await svc.cases.openBuyerCase(
        other.buyerId,
        otherOrder.orderId,
        { category: 'other', subject: 'Someone else case' },
      );

      const page = await svc.cases.listBuyerCases(env.buyerId, {});
      assert.ok(page.items.some((item) => item.id === own.id));
      assert.ok(!page.items.some((item) => item.id === foreign.id));
      assert.ok(page.items.every((item) => item.buyerId === env.buyerId));

      assert.equal(
        (await svc.cases.getBuyerCase(env.buyerId, own.id)).id,
        own.id,
      );
      await assert.rejects(
        svc.cases.getBuyerCase(env.otherBuyerId, own.id),
        /Case was not found/,
      );
      await assert.rejects(
        svc.cases.getBuyerCase(env.buyerId, foreign.id),
        /Case was not found/,
      );
    });

    it('scopes tenant and campus reads to their own membership scope', async () => {
      const env = await createEnv(pool);
      const other = await createEnv(pool);
      const ownOrder = await createOrder(pool, svc.wallet, env);
      const ownCase = await svc.cases.openBuyerCase(
        env.buyerId,
        ownOrder.orderId,
        { category: 'other', subject: 'Own scope case' },
      );
      const otherOrder = await createOrder(pool, svc.wallet, other);
      const otherCase = await svc.cases.openBuyerCase(
        other.buyerId,
        otherOrder.orderId,
        { category: 'other', subject: 'Other scope case' },
      );

      const tenantPage = await svc.cases.listTenantCases(
        env.tenantStaffId,
        env.tenantId,
        {},
      );
      assert.ok(tenantPage.items.some((item) => item.id === ownCase.id));
      assert.ok(!tenantPage.items.some((item) => item.id === otherCase.id));
      assert.ok(
        tenantPage.items.every((item) => item.tenantId === env.tenantId),
      );
      assert.equal(
        (
          await svc.cases.getTenantCase(
            env.tenantStaffId,
            env.tenantId,
            ownCase.id,
          )
        ).id,
        ownCase.id,
      );
      await assert.rejects(
        svc.cases.getTenantCase(env.tenantStaffId, env.tenantId, otherCase.id),
        /Case was not found/,
      );
      await assert.rejects(
        svc.cases.listTenantCases(other.tenantStaffId, env.tenantId, {}),
        /Tenant access denied/,
      );
      // tenant.incidents.report alone cannot read the tenant case list.
      await assert.rejects(
        svc.cases.listTenantCases(env.reporterOnlyId, env.tenantId, {}),
        /Tenant permission denied/,
      );

      const campusPage = await svc.cases.listCampusCases(
        env.adminId,
        env.campusId,
        {},
      );
      assert.ok(campusPage.items.some((item) => item.id === ownCase.id));
      assert.ok(
        campusPage.items.every((item) => item.campusId === env.campusId),
      );
      assert.equal(
        (await svc.cases.getCampusCase(env.adminId, env.campusId, ownCase.id))
          .id,
        ownCase.id,
      );
      await assert.rejects(
        svc.cases.getCampusCase(env.adminId, env.campusId, otherCase.id),
        /Case was not found/,
      );
      await assert.rejects(
        svc.cases.listCampusCases(other.adminId, env.campusId, {}),
        /Campus access denied/,
      );
      await assert.rejects(
        svc.cases.listCampusCases(env.outsiderId, env.campusId, {}),
        /Campus access denied/,
      );
    });

    it('pages and filters campus cases with a stable cursor', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const ids: string[] = [];
      for (const subject of ['Case one', 'Case two', 'Case three']) {
        const view = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
          category: 'other',
          subject,
        });
        ids.push(view.id);
      }
      await svc.cases.decideCase(env.adminId, env.campusId, ids[0], {
        status: 'under_review',
        reason: 'Filter fixture',
      });

      const first = await svc.cases.listCampusCases(env.adminId, env.campusId, {
        limit: 2,
      });
      assert.equal(first.items.length, 2);
      assert.ok(first.nextCursor);
      const second = await svc.cases.listCampusCases(
        env.adminId,
        env.campusId,
        { limit: 2, cursor: first.nextCursor ?? '' },
      );
      assert.equal(second.items.length, 1);
      assert.equal(second.nextCursor, null);
      const seen = [...first.items, ...second.items].map((item) => item.id);
      assert.equal(new Set(seen).size, 3);
      assert.deepEqual([...seen].sort(), [...ids].sort());

      const filtered = await svc.cases.listCampusCases(
        env.adminId,
        env.campusId,
        { status: 'under_review' },
      );
      assert.deepEqual(
        filtered.items.map((item) => item.id),
        [ids[0]],
      );

      await assert.rejects(
        svc.cases.listCampusCases(env.adminId, env.campusId, { limit: 0 }),
        /limit must be an integer/,
      );
      await assert.rejects(
        svc.cases.listCampusCases(env.adminId, env.campusId, {
          status: 'cancelled',
        }),
        /Invalid case status filter/,
      );
      await assert.rejects(
        svc.cases.listCampusCases(env.adminId, env.campusId, {
          cursor: 'not-a-cursor',
        }),
        /Invalid case list cursor/,
      );
    });

    it('serializes concurrent approved_cancel decisions into exactly one refund', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const opened = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
        category: 'no_show',
        subject: 'Concurrent decision',
      });
      const results = await Promise.allSettled([
        svc.cases.decideCase(env.adminId, env.campusId, opened.id, {
          status: 'approved_cancel',
          reason: 'race A',
        }),
        svc.cases.decideCase(env.adminId, env.campusId, opened.id, {
          status: 'approved_cancel',
          reason: 'race B',
        }),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter((result) => result.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(
        httpCode((rejected[0] as PromiseRejectedResult).reason),
        'CASE_ALREADY_DECIDED',
      );
      const winner = fulfilled[0] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof svc.cases.decideCase>>
      >;
      assert.equal(winner.value.case.status, 'approved_cancel');
      assert.equal(winner.value.case.version, 2);
      const winnerRefund = winner.value.refund;
      assert.ok(winnerRefund);

      assert.equal(
        await countRows(
          pool,
          'select count(*)::int as n from refunds where order_id = $1',
          [order.orderId],
        ),
        1,
      );
      assert.equal(
        await countRows(
          pool,
          "select count(*)::int as n from order_events where order_id = $1 and event_type = 'order.cancelled'",
          [order.orderId],
        ),
        1,
      );
      assert.equal(
        await countRows(
          pool,
          'select count(*)::int as n from refund_request_outbox where refund_id = $1',
          [winnerRefund.id],
        ),
        1,
      );
      const slot = await pool.query<{ reserved_count: number }>(
        'select reserved_count from pickup_slots where id = $1',
        [order.slotId],
      );
      assert.equal(slot.rows[0].reserved_count, 0, 'capacity returned once');
      assert.equal(
        await countRows(
          pool,
          'select count(*)::int as n from refunds where order_id = $1 and ledger_transaction_id is not null',
          [order.orderId],
        ),
        0,
        'the decision queues a refund but never credits it',
      );
      assert.equal(
        (await svc.wallet.getBalance(env.buyerId, 'IDR'))[0].balanceMinor,
        '50000',
      );
    });

    // Review F7 / D7: mutation responses carry the DB's microsecond value.
    it('returns DB microsecond timestamps instead of millisecond ISO strings', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const pattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
      const view = await svc.cases.openBuyerCase(env.buyerId, order.orderId, {
        category: 'other',
        subject: 'timestamp shape',
      });
      assert.match(view.createdAt, pattern);
      assert.match(view.updatedAt, pattern);
      const inserted = await pool.query<{
        created_at: string;
        updated_at: string;
      }>(
        `select to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
                to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
           from cases where id = $1`,
        [view.id],
      );
      assert.equal(
        view.createdAt,
        inserted.rows[0].created_at,
        'the exact DB value, never a re-serialized Date',
      );
      assert.equal(view.updatedAt, inserted.rows[0].updated_at);

      const decided = await svc.cases.decideCase(
        env.adminId,
        env.campusId,
        view.id,
        { status: 'resolved', reason: 'resolved with the buyer' },
      );
      assert.match(decided.case.decidedAt ?? '', pattern);
      assert.match(decided.case.updatedAt, pattern);
      const decidedRow = await pool.query<{ decided_at: string }>(
        `select to_char(decided_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as decided_at
           from cases where id = $1`,
        [view.id],
      );
      assert.equal(decided.case.decidedAt, decidedRow.rows[0].decided_at);
    });

    // Review F11: the order scope is read INSIDE the insert transaction, so a
    // concurrent cancellation cannot interleave between the check and the
    // insert and leave a case bound to a scope that changed underneath it.
    it('opens no case while a concurrent cancellation holds the order row', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, svc.wallet, env);
      const cancelling = await pool.connect();
      try {
        await cancelling.query('begin');
        await cancelling.query(
          "update orders set status = 'cancelled', cancelled_at = now(), version = version + 1, updated_at = now() where id = $1",
          [order.orderId],
        );
        let settled = false;
        // Never-rejecting promise: an early assertion failure must not leak an
        // unhandled rejection.
        const opening = svc.cases
          .openBuyerCase(env.buyerId, order.orderId, {
            category: 'other',
            subject: 'Concurrent cancellation',
          })
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        void opening.then(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(
          settled,
          false,
          'opening a case must serialize against the cancellation (FOR SHARE)',
        );
        assert.equal(
          await countRows(
            pool,
            'select count(*)::int as n from cases where order_id = $1',
            [order.orderId],
          ),
          0,
          'no case row may be committed while the order is mid-cancellation',
        );
        await cancelling.query('commit');
        const outcome = await opening;
        assert.ok(outcome.ok, 'the case opens once the cancellation committed');
        if (outcome.ok) {
          assert.equal(outcome.value.orderId, order.orderId);
          assert.equal(outcome.value.buyerId, env.buyerId);
          assert.equal(outcome.value.campusId, env.campusId);
          assert.equal(outcome.value.tenantId, env.tenantId);
        }
        assert.equal(
          await countRows(
            pool,
            'select count(*)::int as n from cases where order_id = $1',
            [order.orderId],
          ),
          1,
          'exactly one case, never an orphan duplicate',
        );
      } finally {
        await cancelling.query('rollback').catch(() => undefined);
        cancelling.release();
      }
    });
  },
);
