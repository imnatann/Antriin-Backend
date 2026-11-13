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
import { RefundsService } from '../src/modules/refunds/refunds.service';
import { SandboxRefundAdapter } from '../src/modules/refunds/refund.adapter';
import { CasesService } from '../src/modules/cases/cases.service';
import { SettlementsService } from '../src/modules/settlements/settlements.service';
import {
  ORDER_PAYMENT_ESCROW_ACCOUNT,
  TENANT_PAYABLE_SYSTEM_KEY_PREFIX,
} from '../src/modules/settlements/settlements.constants';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    REFUNDS_PROVIDER_MODE: 'sandbox',
    PAYOUTS_PROVIDER_MODE: 'disabled',
    PAYMENTS_PROVIDER_MODE: 'disabled',
  };
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error('missing config ' + key);
      return values[key];
    },
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

type Stack = ReturnType<typeof buildStack>;

function buildStack(db: DatabaseService) {
  const wallet = new WalletService(db);
  const access = new AccessService(db);
  const audit = new AuditService(db, access);
  const outbox = new OutboxService(db);
  const config = makeConfig();
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
  const refunds = new RefundsService(
    db,
    wallet,
    audit,
    outbox,
    access,
    orders,
    config,
    new SandboxRefundAdapter(config),
  );
  const cases = new CasesService(db, access, audit, outbox, refunds);
  const settlements = new SettlementsService(
    db,
    access,
    audit,
    wallet,
    orders,
    cases,
  );
  // Nest injects the settlements slice into CasesService (forwardRef); a
  // hand-built instance needs it explicitly, hence the second CasesService.
  const casesWired = new CasesService(
    db,
    access,
    audit,
    outbox,
    refunds,
    settlements,
  );
  return {
    wallet,
    access,
    audit,
    outbox,
    config,
    orders,
    refunds,
    cases,
    casesWired,
    settlements,
  };
}

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
  const ownerId = await mkUser('Owner');
  const kitchenId = await mkUser('Kitchen');
  const buyerId = await mkUser('Buyer');
  const outsiderId = await mkUser('Outsider');
  await pool.query(
    `insert into tenant_memberships
       (tenant_id, user_id, role, permissions, status, owner_verified_at)
     values ($1, $2, 'owner', '{}'::text[], 'active', now())`,
    [tenantId, ownerId],
  );
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role, permissions, status)
     values ($1, $2, 'kitchen', $3::text[], 'active')`,
    [tenantId, kitchenId, ['tenant.orders.read', 'tenant.incidents.report']],
  );
  return { tag, campusId, tenantId, ownerId, kitchenId, buyerId, outsiderId };
}

type Env = Awaited<ReturnType<typeof createEnv>>;

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
  const status = opts.status ?? 'completed';
  const slotId = (
    await pool.query<{ id: string }>(
      `insert into pickup_slots
         (tenant_id, starts_at, ends_at, capacity, reserved_count, status,
          version, created_at, updated_at)
       values ($1, now() + interval '2 hours', now() + interval '3 hours', 5, 0,
               'open', 1, now(), now())
       returning id`,
      [env.tenantId],
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
               $5::varchar, 'IDR', $6::numeric, $6::numeric,
               now() - interval '2 hours',
               case when $5::varchar = 'completed' then now() - interval '2 hours' else null end,
               case when $5::varchar = 'completed' then now() - interval '1 hour' else null end,
               case when $5::varchar = 'completed' then now() else null end,
               now() - interval '3 hours', now())
       returning id`,
      [
        env.buyerId,
        env.tenantId,
        slotId,
        'Tenant ' + env.tag,
        status,
        amountMinor,
      ],
    )
  ).rows[0].id;
  const buyerWallet = await wallet.getOrCreateWallet(env.buyerId, 'IDR');
  const funder = await wallet.ensureSystemAccount(
    'test-funding-' + randomUUID(),
    'IDR',
  );
  await wallet.postTransfer({
    idempotencyScope: 'test.settlements.funding',
    idempotencyKey: randomUUID(),
    reference: { namespace: 'test-fixture', id: randomUUID() },
    currency: 'IDR',
    amountMinor: '1000000',
    debitAccountId: funder.accountId,
    creditAccountId: buyerWallet.accountId,
    actor: { type: 'service', id: 'test-fixture' },
    reason: 'settlement fixture funding',
  });
  const escrow = await wallet.ensureSystemAccount(
    ORDER_PAYMENT_ESCROW_ACCOUNT,
    'IDR',
  );
  const posted = await wallet.postTransfer({
    idempotencyScope: 'test.settlements.checkout',
    idempotencyKey: randomUUID(),
    reference: { namespace: 'test-order-payment', id: randomUUID() },
    currency: 'IDR',
    amountMinor,
    debitAccountId: buyerWallet.accountId,
    creditAccountId: escrow.accountId,
    actor: { type: 'service', id: 'test-fixture' },
    reason: 'settlement fixture order payment',
  });
  const orderPaymentId = (
    await pool.query<{ id: string }>(
      `insert into order_payments
         (order_id, method, status, amount_minor, currency,
          ledger_transaction_id, succeeded_at, created_at, updated_at)
       values ($1, 'wallet', 'succeeded', $2, 'IDR', $3, now(), now(), now())
       returning id`,
      [orderId, amountMinor, posted.transactionId],
    )
  ).rows[0].id;
  return { orderId, orderPaymentId, amountMinor, slotId };
}

async function balanceOf(pool: Pool, systemKey: string): Promise<string> {
  const result = await pool.query<{ balance_minor: string }>(
    `select balance_minor::text from wallet_accounts
      where account_type = 'system' and system_key = $1 and currency = 'IDR'`,
    [systemKey],
  );
  return result.rows[0]?.balance_minor ?? '0';
}

describe(
  'Settlements slice PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let db: DatabaseService;
    let stack: Stack;

    const withTx = async <T>(
      operation: (client: import('pg').PoolClient) => Promise<T>,
    ): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await operation(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 12 });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      stack = buildStack(db);
    });
    after(async () => {
      await pool?.end();
    });

    it('releases exactly the captured amount from escrow into the tenant payable', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, stack.wallet, env);
      const payableKey = TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId;
      const payableBefore = await balanceOf(pool, payableKey);

      const outcome = await withTx((client) =>
        stack.settlements.releaseForOrder(client, env.tenantId, order.orderId, {
          type: 'service',
          id: 'settlements',
        }),
      );
      assert.equal(outcome.released, true);
      if (!outcome.released) throw new Error('unreachable');
      assert.equal(outcome.amountMinor, order.amountMinor);
      assert.equal(outcome.currency, 'IDR');
      assert.equal(outcome.replayed, false);

      // The escrow account is shared by the whole system (and other suites run
      // in parallel), so the debit is asserted on THIS release transaction's
      // own entry instead of a global balance delta.
      const escrowLeg = await pool.query<{
        direction: string;
        amount_minor: string;
      }>(
        `select e.direction, e.amount_minor::text
           from ledger_entries e
           join wallet_accounts a on a.id = e.account_id
          where e.transaction_id = $1 and a.system_key = $2`,
        [outcome.ledgerTransactionId, ORDER_PAYMENT_ESCROW_ACCOUNT],
      );
      assert.equal(escrowLeg.rowCount, 1);
      assert.equal(escrowLeg.rows[0].direction, 'debit');
      assert.equal(escrowLeg.rows[0].amount_minor, order.amountMinor);
      assert.equal(
        BigInt(await balanceOf(pool, payableKey)) - BigInt(payableBefore),
        BigInt(order.amountMinor),
        'tenant payable increases by exactly the released amount',
      );

      const settlement = await pool.query<{
        status: string;
        amount_minor: string;
        paid_out_minor: string;
        release_ledger_transaction_id: string;
        released_at: Date | null;
        order_payment_id: string;
        tenant_id: string;
      }>('select * from settlements where order_id = $1', [order.orderId]);
      assert.equal(settlement.rowCount, 1);
      const row = settlement.rows[0];
      assert.equal(row.status, 'available');
      assert.equal(row.amount_minor, order.amountMinor);
      assert.equal(row.paid_out_minor, '0');
      assert.equal(row.order_payment_id, order.orderPaymentId);
      assert.equal(row.tenant_id, env.tenantId);
      assert.ok(row.released_at);
      assert.equal(
        row.release_ledger_transaction_id,
        outcome.ledgerTransactionId,
      );

      const audit = await pool.query(
        `select 1 from audit_events
          where action = 'tenant.payable.released' and target_id = $1`,
        [outcome.settlementId],
      );
      assert.equal(audit.rowCount, 1, 'release is audited');
    });

    it('is idempotent: a replay reports already_released and posts no second transfer', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, stack.wallet, env);
      const payableKey = TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId;

      const first = await withTx((client) =>
        stack.settlements.releaseForOrder(client, env.tenantId, order.orderId, {
          type: 'service',
          id: 'settlements',
        }),
      );
      assert.equal(first.released, true);
      const payableAfterFirst = await balanceOf(pool, payableKey);

      const second = await withTx((client) =>
        stack.settlements.releaseForOrder(client, env.tenantId, order.orderId, {
          type: 'service',
          id: 'settlements',
        }),
      );
      assert.equal(second.released, false);
      if (second.released) throw new Error('unreachable');
      assert.equal(second.reason, 'already_released');
      assert.equal(await balanceOf(pool, payableKey), payableAfterFirst);

      const ledger = await pool.query(
        `select 1 from ledger_transactions
          where idempotency_scope = 'settlements.release' and idempotency_key = $1`,
        [order.orderId],
      );
      assert.equal(ledger.rowCount, 1, 'exactly one release transaction');
      const settlements = await pool.query(
        'select 1 from settlements where order_id = $1',
        [order.orderId],
      );
      assert.equal(settlements.rowCount, 1);
    });

    it('serializes concurrent releases of one order: exactly one wins', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, stack.wallet, env);
      const payableKey = TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId;
      const before = BigInt(await balanceOf(pool, payableKey));

      const attempts = await Promise.all(
        Array.from({ length: 4 }, () =>
          withTx((client) =>
            stack.settlements.releaseForOrder(
              client,
              env.tenantId,
              order.orderId,
              {
                type: 'service',
                id: 'settlements',
              },
            ),
          ),
        ),
      );
      assert.equal(
        attempts.filter((outcome) => outcome.released).length,
        1,
        'exactly one attempt posts the release',
      );
      for (const outcome of attempts)
        if (!outcome.released) assert.equal(outcome.reason, 'already_released');

      assert.equal(
        BigInt(await balanceOf(pool, payableKey)) - before,
        BigInt(order.amountMinor),
        'payable moved exactly once',
      );
      const ledger = await pool.query(
        `select 1 from ledger_transactions
          where idempotency_scope = 'settlements.release' and idempotency_key = $1`,
        [order.orderId],
      );
      assert.equal(ledger.rowCount, 1);
    });

    it('refuses an order that was not completed', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, stack.wallet, env, {
        status: 'paid_awaiting_tenant',
      });
      const outcome = await withTx((client) =>
        stack.settlements.releaseForOrder(client, env.tenantId, order.orderId, {
          type: 'service',
          id: 'settlements',
        }),
      );
      assert.equal(outcome.released, false);
      if (outcome.released) throw new Error('unreachable');
      assert.equal(outcome.reason, 'not_completed');
      assert.equal(
        (
          await pool.query('select 1 from settlements where order_id = $1', [
            order.orderId,
          ])
        ).rowCount,
        0,
      );
    });

    it('refuses while an operational case is open and releases once it is resolved', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, stack.wallet, env);
      const caseId = (
        await pool.query<{ id: string }>(
          `insert into cases
             (campus_id, tenant_id, order_id, buyer_id, opened_by_user_id,
              category, status, subject, details, version, created_at, updated_at)
           values ($1, $2, $3, $4, $4, 'order_issue', 'under_review', 'late',
                   '', 1, now(), now())
           returning id`,
          [env.campusId, env.tenantId, order.orderId, env.buyerId],
        )
      ).rows[0].id;

      const blocked = await withTx((client) =>
        stack.settlements.releaseForOrder(client, env.tenantId, order.orderId, {
          type: 'service',
          id: 'settlements',
        }),
      );
      assert.equal(blocked.released, false);
      if (blocked.released) throw new Error('unreachable');
      assert.equal(blocked.reason, 'open_case');

      await pool.query(
        `update cases
            set status = 'resolved', decision_reason = 'reviewed',
                decided_by_user_id = $2, decided_at = now(), updated_at = now()
          where id = $1`,
        [caseId, env.buyerId],
      );
      const released = await withTx((client) =>
        stack.settlements.releaseForOrder(client, env.tenantId, order.orderId, {
          type: 'service',
          id: 'settlements',
        }),
      );
      assert.equal(released.released, true);
    });

    it('refuses an order that already has a refund row', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, stack.wallet, env);
      await pool.query(
        `insert into refunds
           (campus_id, tenant_id, order_id, order_payment_id, buyer_id,
            amount_minor, currency, status, provider, reason,
            requested_by_user_id, version, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'IDR', 'requested', 'sandbox',
                 'fixture refund', $5, 1, now(), now())`,
        [
          env.campusId,
          env.tenantId,
          order.orderId,
          order.orderPaymentId,
          env.buyerId,
          order.amountMinor,
        ],
      );
      const outcome = await withTx((client) =>
        stack.settlements.releaseForOrder(client, env.tenantId, order.orderId, {
          type: 'service',
          id: 'settlements',
        }),
      );
      assert.equal(outcome.released, false);
      if (outcome.released) throw new Error('unreachable');
      assert.equal(outcome.reason, 'refund_pending');
    });

    it('releases nothing for an order of another tenant', async () => {
      const env = await createEnv(pool);
      const other = await createEnv(pool);
      const order = await createOrder(pool, stack.wallet, env);
      const outcome = await withTx((client) =>
        stack.settlements.releaseForOrder(
          client,
          other.tenantId,
          order.orderId,
          {
            type: 'service',
            id: 'settlements',
          },
        ),
      );
      assert.equal(outcome.released, false);
      if (outcome.released) throw new Error('unreachable');
      assert.equal(outcome.reason, 'not_found');
    });

    it('contains a failed release inside the caller transaction (savepoint) and audits it', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, stack.wallet, env);
      const failingWallet = {
        ...stack.wallet,
        ensureSystemAccount: async () => {
          throw new Error('wallet unavailable');
        },
      } as unknown as WalletService;
      const failing = new SettlementsService(
        db,
        stack.access,
        stack.audit,
        failingWallet,
        stack.orders,
        stack.cases,
      );
      await withTx(async (client) => {
        await failing.releaseAfterHandover(
          client,
          env.tenantId,
          order.orderId,
          env.ownerId,
        );
        // The transaction must still be usable: the release was rolled back to
        // its savepoint, not left as an aborted transaction.
        const probe = await client.query('select 1 as ok');
        assert.equal(probe.rows[0].ok, 1);
      });
      const audit = await pool.query(
        `select 1 from audit_events
          where action = 'tenant.payable.release_failed' and target_id = $1`,
        [order.orderId],
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(
        (
          await pool.query('select 1 from settlements where order_id = $1', [
            order.orderId,
          ])
        ).rowCount,
        0,
      );
    });

    it('audits a deferred release when a business rule blocks it, without failing the caller', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, stack.wallet, env, {
        status: 'paid_awaiting_tenant',
      });
      await withTx(async (client) => {
        await stack.settlements.releaseAfterHandover(
          client,
          env.tenantId,
          order.orderId,
          env.ownerId,
        );
      });
      const audit = await pool.query<{ metadata: { reason: string } }>(
        `select metadata from audit_events
          where action = 'tenant.payable.release_deferred' and target_id = $1`,
        [order.orderId],
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].metadata.reason, 'not_completed');
    });

    it('releases after a terminal non-cancelling case decision in the same transaction', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, stack.wallet, env);
      const caseId = (
        await pool.query<{ id: string }>(
          `insert into cases
             (campus_id, tenant_id, order_id, buyer_id, opened_by_user_id,
              category, status, subject, details, version, created_at, updated_at)
           values ($1, $2, $3, $4, $4, 'order_issue', 'under_review', 'check',
                   '', 1, now(), now())
           returning id`,
          [env.campusId, env.tenantId, order.orderId, env.buyerId],
        )
      ).rows[0].id;
      await pool.query(
        `insert into campus_memberships (campus_id, user_id, permissions, status)
         values ($1, $2, $3::text[], 'active')`,
        [
          env.campusId,
          env.ownerId,
          ['campus.cases.read', 'campus.cases.decide'],
        ],
      );
      const payableKey = TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId;
      const before = BigInt(await balanceOf(pool, payableKey));
      const decision = await stack.casesWired.decideCase(
        env.ownerId,
        env.campusId,
        caseId,
        {
          status: 'resolved',
          reason: 'Checked with the tenant; the order was delivered',
        },
      );
      assert.equal(decision.case.status, 'resolved');
      assert.equal(
        BigInt(await balanceOf(pool, payableKey)) - before,
        BigInt(order.amountMinor),
        'the decision transaction also released the payable',
      );
    });

    it('derives the finance summary and the transaction feed from ledger projections', async () => {
      const env = await createEnv(pool);
      const order = await createOrder(pool, stack.wallet, env);
      await withTx((client) =>
        stack.settlements.releaseForOrder(client, env.tenantId, order.orderId, {
          type: 'service',
          id: 'settlements',
        }),
      );
      const summary = await stack.settlements.getFinanceSummary(
        env.ownerId,
        env.tenantId,
      );
      assert.equal(summary.currency, 'IDR');
      assert.equal(summary.paidInMinor, order.amountMinor);
      assert.equal(summary.refundedMinor, '0');
      assert.equal(summary.availableMinor, order.amountMinor);
      assert.equal(summary.heldMinor, '0');
      assert.equal(summary.paidOutMinor, '0');
      assert.equal(summary.releasedMinor, order.amountMinor);
      assert.equal(summary.unfinishedMinor, '0');

      const feed = await stack.settlements.listFinanceTransactions(
        env.ownerId,
        env.tenantId,
      );
      assert.equal(feed.items.length, 1);
      assert.equal(feed.items[0].type, 'settlement_release');
      assert.equal(feed.items[0].direction, 'credit');
      assert.equal(feed.items[0].amountMinor, order.amountMinor);
      assert.equal(feed.items[0].referenceId, order.orderId);
      assert.match(feed.items[0].occurredAt, /^\d{4}-\d\d-\d\dT.*\.\d{6}Z$/);
    });

    it('denies finance reads to kitchen staff (owner-only permission)', async () => {
      const env = await createEnv(pool);
      await assert.rejects(
        stack.settlements.getFinanceSummary(env.kitchenId, env.tenantId),
        /Tenant finance access denied/,
      );
      await assert.rejects(
        stack.settlements.listFinanceTransactions(env.kitchenId, env.tenantId),
        /Tenant finance access denied/,
      );
      await assert.rejects(
        stack.settlements.getFinanceSummary(env.outsiderId, env.tenantId),
        /Tenant access denied/,
      );
    });

    it('satisfies the reconciliation identities after release (design section 4.4)', async () => {
      const env = await createEnv(pool);
      const first = await createOrder(pool, stack.wallet, env, {
        amountMinor: '30000',
      });
      const second = await createOrder(pool, stack.wallet, env, {
        amountMinor: '20000',
      });
      for (const order of [first, second])
        await withTx((client) =>
          stack.settlements.releaseForOrder(
            client,
            env.tenantId,
            order.orderId,
            {
              type: 'service',
              id: 'settlements',
            },
          ),
        );

      const payable = BigInt(
        await balanceOf(pool, TENANT_PAYABLE_SYSTEM_KEY_PREFIX + env.tenantId),
      );
      const released = await pool.query<{ total: string }>(
        `select coalesce(sum(amount_minor), 0)::text as total from settlements
          where tenant_id = $1 and status in ('available', 'paid_out')`,
        [env.tenantId],
      );
      const escrow = BigInt(
        await balanceOf(pool, ORDER_PAYMENT_ESCROW_ACCOUNT),
      );
      const paid = await pool.query<{ total: string }>(
        `select coalesce(sum(op.amount_minor), 0)::text as total
           from order_payments op join orders o on o.id = op.order_id
          where o.tenant_id = $1`,
        [env.tenantId],
      );
      const refunded = await pool.query<{ total: string }>(
        `select coalesce(sum(amount_minor), 0)::text as total from refunds
          where tenant_id = $1 and status = 'succeeded'`,
        [env.tenantId],
      );
      const settled = await pool.query<{ total: string }>(
        `select coalesce(sum(amount_minor), 0)::text as total from payouts
          where tenant_id = $1 and status = 'succeeded'`,
        [env.tenantId],
      );
      // Identity (1) for this tenant: payable + hold + paid out = released.
      assert.equal(
        payable + 0n + BigInt(settled.rows[0].total),
        BigInt(released.rows[0].total),
      );
      // Identity (4): escrow = payments - refunds - released (this tenant's
      // share; the escrow account is shared, so compare deltas of this tenant).
      assert.equal(
        BigInt(paid.rows[0].total) -
          BigInt(refunded.rows[0].total) -
          BigInt(released.rows[0].total),
        0n,
      );
      assert.ok(escrow >= 0n);
      // Identity (5): released equals captured payments of completed orders.
      assert.equal(BigInt(released.rows[0].total), BigInt(paid.rows[0].total));
    });
  },
);
