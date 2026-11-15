import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { UsersService, pseudonymFor } from '../src/modules/users/users.service';
import { WalletService } from '../src/modules/wallet/wallet.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const MICRO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const testSecret = randomBytes(48).toString('base64url');
const testEncryptionKey = randomBytes(32).toString('base64');

class CapturingOtpDelivery {
  async send(): Promise<void> {}
}

function authConfig(): ConfigService {
  const values: Record<string, string | number> = {
    AUTH_SECRET: testSecret,
    AUTH_ENCRYPTION_KEY: testEncryptionKey,
    AUTH_OTP_TTL_SECONDS: 300,
    AUTH_OTP_MAX_ATTEMPTS: 5,
    AUTH_OTP_RESEND_COOLDOWN_SECONDS: 60,
    AUTH_SESSION_TTL_SECONDS: 86400,
    AUTH_OTP_DELIVERY_MAX_ATTEMPTS: 5,
  };
  return {
    get: <T>(key: string, fallback?: T): T | undefined =>
      (values[key] as T | undefined) ?? fallback,
  } as unknown as ConfigService;
}

function sessionTokenHash(token: string): string {
  return createHmac('sha256', Buffer.from(testSecret, 'utf8'))
    .update('session:' + token, 'utf8')
    .digest('hex');
}

function codeOf(error: unknown): string | undefined {
  const response = (error as { getResponse?: () => unknown }).getResponse?.();
  return typeof response === 'object' && response !== null
    ? (response as { code?: string }).code
    : undefined;
}

describe(
  'Account closure and data export PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let users: UsersService;
    let wallet: WalletService;
    let auth: AuthService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      await pool.query('select 1');
      const db = { pool } as unknown as DatabaseService;
      const access = new AccessService(db);
      const audit = new AuditService(db, access);
      wallet = new WalletService(db);
      users = new UsersService(db, audit, wallet);
      auth = new AuthService(db, authConfig(), new CapturingOtpDelivery());
    });

    after(async () => {
      await pool?.end();
    });

    /** Two independent accounts so "only my data" is actually provable. */
    const createAccount = async (name: string) => {
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
      const slotId = (
        await pool.query<{ id: string }>(
          `insert into pickup_slots
             (tenant_id, starts_at, ends_at, capacity, reserved_count, status)
           values ($1, now() + interval '1 day', now() + interval '1 day 1 hour',
                   10, 0, 'open')
           returning id`,
          [tenantId],
        )
      ).rows[0].id;
      const userId = (
        await pool.query<{ id: string }>(
          'insert into users (display_name) values ($1) returning id',
          [name + ' ' + tag],
        )
      ).rows[0].id;
      return { tag, campusId, tenantId, slotId, userId };
    };

    const addOrder = async (
      env: { tag: string; tenantId: string; slotId: string; userId: string },
      totalMinor: string,
    ) =>
      (
        await pool.query<{ id: string }>(
          `insert into orders
             (buyer_id, tenant_id, pickup_slot_id, order_number,
              tenant_name_snapshot, tenant_timezone_snapshot,
              pickup_starts_at, pickup_ends_at, status, currency,
              subtotal_minor, total_minor)
           values ($1, $2, $3, $4, $5, 'Asia/Jakarta',
                   now() + interval '1 day', now() + interval '1 day 1 hour',
                   'paid_awaiting_tenant', 'IDR', $6, $6)
           returning id`,
          [
            env.userId,
            env.tenantId,
            env.slotId,
            'ORD-' + randomUUID().slice(0, 8).toUpperCase(),
            'Tenant snapshot ' + env.tag.slice(0, 8),
            totalMinor,
          ],
        )
      ).rows[0].id;

    const addSession = async (env: { tag: string; userId: string }) => {
      const token = randomBytes(32).toString('base64url');
      await pool.query(
        `insert into auth_sessions (user_id, token_hash, expires_at)
         values ($1, $2, now() + interval '1 day')`,
        [env.userId, sessionTokenHash(token)],
      );
      return token;
    };

    it('closes the account, revokes sessions and keeps the financial rows', async () => {
      const env = await createAccount('Closer');
      const orderId = await addOrder(env, '25000');

      // Wallet balance comes from the real double-entry path.
      const walletAccount = await wallet.getOrCreateWallet(env.userId, 'IDR');
      const system = await wallet.ensureSystemAccount(
        'topup:qris:' + env.tag,
        'IDR',
      );
      await wallet.postTransfer({
        idempotencyScope: 'test:closure:' + env.tag,
        idempotencyKey: 'credit-1',
        currency: 'IDR',
        amountMinor: '50000',
        debitAccountId: system.accountId,
        creditAccountId: walletAccount.accountId,
        actor: { type: 'service', id: 'test' },
        reason: 'Test wallet credit',
      });

      const token = await addSession(env);
      const principal = await auth.authenticate(token);
      assert.equal(principal.userId, env.userId);

      const deviceToken = 'device-token-' + env.tag;
      await pool.query(
        `insert into user_devices (user_id, platform, token_hash, label)
         values ($1, 'ios', $2, 'phone')`,
        [
          env.userId,
          createHmac('sha256', Buffer.from(testSecret, 'utf8'))
            .update(deviceToken)
            .digest('hex'),
        ],
      );

      const closure = await users.closeAccount(env.userId, {
        reason: '  leaving the pilot  ',
      });
      assert.equal(closure.status, 'closed');
      assert.equal(closure.displayName, pseudonymFor(env.userId));
      assert.match(closure.closedAt, MICRO_UTC);
      assert.equal(closure.revokedSessions, 1);

      // Identity is pseudonymised, the row still exists.
      const storedUser = await pool.query<{
        status: string;
        display_name: string;
      }>('select status, display_name from users where id = $1', [env.userId]);
      assert.equal(storedUser.rows[0].status, 'closed');
      assert.match(storedUser.rows[0].display_name, /^Closed account /);
      assert.ok(
        !storedUser.rows[0].display_name.includes(env.tag),
        'the original name is gone',
      );

      // Sessions and push devices are unusable immediately.
      const sessions = await pool.query<{ revoked_at: Date | null }>(
        'select revoked_at from auth_sessions where user_id = $1',
        [env.userId],
      );
      assert.ok(sessions.rows.every((row) => row.revoked_at !== null));
      const devices = await pool.query<{ revoked_at: Date | null }>(
        'select revoked_at from user_devices where user_id = $1',
        [env.userId],
      );
      assert.ok(devices.rows.every((row) => row.revoked_at !== null));

      // The closed account can no longer authenticate, even with a fresh token.
      await assert.rejects(
        () => auth.authenticate(token),
        (error: unknown) => codeOf(error) === 'unauthorized',
      );
      const lateToken = await addSession(env);
      await assert.rejects(
        () => auth.authenticate(lateToken),
        (error: unknown) => codeOf(error) === 'unauthorized',
      );

      // Orders and ledger rows survive for reconciliation.
      const order = await pool.query<{ id: string; buyer_id: string }>(
        'select id::text, buyer_id::text from orders where id = $1',
        [orderId],
      );
      assert.equal(order.rows.length, 1);
      assert.equal(order.rows[0].buyer_id, env.userId);
      const ledger = await pool.query<{ count: string }>(
        'select count(*)::text from ledger_entries where account_id = $1',
        [walletAccount.accountId],
      );
      assert.equal(ledger.rows[0].count, '1');
      const balance = await wallet.getBalance(env.userId, 'IDR');
      assert.equal(balance[0].balanceMinor, '50000');

      // Durable record of what was kept and why.
      const request = await pool.query<{
        id: string;
        status: string;
        reason: string;
        retained_summary: {
          policy: string;
          closedBy: string;
          pseudonymised: string[];
          revoked: { sessions: number; devices: number };
          retained: { entity: string; count: number; reason: string }[];
        };
        requested_at: string;
        completed_at: string;
      }>(
        `select id::text, status, reason, retained_summary,
                to_char(requested_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as requested_at,
                to_char(completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as completed_at
           from account_deletion_requests where user_id = $1`,
        [env.userId],
      );
      assert.equal(request.rows.length, 1);
      const record = request.rows[0];
      assert.equal(record.id, closure.requestId);
      assert.equal(record.status, 'completed');
      assert.equal(record.reason, 'leaving the pilot');
      assert.match(record.requested_at, MICRO_UTC);
      assert.match(record.completed_at, MICRO_UTC);
      assert.match(record.retained_summary.policy, /§7\.6|reconciliation/);
      assert.equal(record.retained_summary.closedBy, 'self_service');
      assert.deepEqual(record.retained_summary.pseudonymised, [
        'users.display_name',
      ]);
      const entities = Object.fromEntries(
        record.retained_summary.retained.map((entry) => [
          entry.entity,
          entry.count,
        ]),
      );
      assert.equal(entities.orders, 1);
      assert.equal(entities.ledger_entries, 1);
      assert.equal(entities.users, 1);
      assert.ok(
        record.retained_summary.retained.every(
          (entry) => entry.reason.length > 20,
        ),
        'each retained entity carries a reason',
      );

      // The closure itself is audited.
      const audit = await pool.query<{ action: string; reason: string }>(
        `select action, reason from audit_events
           where scope_type = 'user' and scope_id = $1
             and action = 'user.account.closed'`,
        [env.userId],
      );
      assert.equal(audit.rows.length, 1);
    });

    it('is idempotent: closing twice keeps one record and revokes nothing twice', async () => {
      const env = await createAccount('Twice');
      const first = await users.closeAccount(env.userId);
      const second = await users.closeAccount(env.userId, {
        reason: 'second attempt',
      });

      assert.equal(second.requestId, first.requestId);
      assert.equal(second.closedAt, first.closedAt);
      assert.equal(second.displayName, first.displayName);
      // Nothing was revoked by the replay: the first call had revoked nothing.
      assert.equal(second.revokedSessions, 0);

      const records = await pool.query<{ count: string }>(
        'select count(*)::text from account_deletion_requests where user_id = $1',
        [env.userId],
      );
      assert.equal(records.rows[0].count, '1');

      const audits = await pool.query<{ count: string }>(
        `select count(*)::text from audit_events
           where scope_type = 'user' and scope_id = $1
             and action = 'user.account.closed'`,
        [env.userId],
      );
      assert.equal(
        audits.rows[0].count,
        '1',
        'the replay writes no second audit',
      );

      // A session created after the first closure is still refused: the auth
      // query checks users.status, so a replay is not needed to stay closed.
      const token = await addSession(env);
      await assert.rejects(
        () => auth.authenticate(token),
        (error: unknown) => codeOf(error) === 'unauthorized',
      );
      // The replay itself is a pure no-op: it revokes nothing new, so it is
      // safe to call on every client retry.
      const session = await pool.query<{ revoked_at: Date | null }>(
        'select revoked_at from auth_sessions where user_id = $1',
        [env.userId],
      );
      assert.ok(
        session.rows.some((row) => row.revoked_at === null),
        'the replay leaves the later session alone',
      );
    });

    it('exports only the caller own data and never a secret', async () => {
      const mine = await createAccount('Exporter');
      const other = await createAccount('Bystander');

      const mineOrder = await addOrder(mine, '15000');
      await addOrder(mine, '35000');
      await addOrder(other, '99000');

      const mineWallet = await wallet.getOrCreateWallet(mine.userId, 'IDR');
      const otherWallet = await wallet.getOrCreateWallet(other.userId, 'IDR');
      const system = await wallet.ensureSystemAccount(
        'topup:qris:' + mine.tag,
        'IDR',
      );
      await wallet.postTransfer({
        idempotencyScope: 'test:export:' + mine.tag,
        idempotencyKey: 'credit-mine',
        currency: 'IDR',
        amountMinor: '20000',
        debitAccountId: system.accountId,
        creditAccountId: mineWallet.accountId,
        actor: { type: 'service', id: 'test' },
        reason: 'Mine',
      });
      const second = await wallet.ensureSystemAccount(
        'topup:qris:' + other.tag,
        'IDR',
      );
      await wallet.postTransfer({
        idempotencyScope: 'test:export:' + other.tag,
        idempotencyKey: 'credit-other',
        currency: 'IDR',
        amountMinor: '777000',
        debitAccountId: second.accountId,
        creditAccountId: otherWallet.accountId,
        actor: { type: 'service', id: 'test' },
        reason: 'Other',
      });

      // A review of the caller's own completed order.
      await pool.query(
        "insert into reviews (campus_id, tenant_id, order_id, buyer_id, rating, body) values ($1, $2, $3, $4, 5, 'Great')",
        [mine.campusId, mine.tenantId, mineOrder, mine.userId],
      );
      // A notification addressed to the caller.
      const eventId = (
        await pool.query<{ id: string }>(
          `insert into outbox_events
             (event_key, request_hash, event_type, aggregate_type, aggregate_id,
              recipient_ids)
           values ($1, $2, 'order.status_changed', 'order', $3, $4::uuid[])
           returning id`,
          ['evt-' + mine.tag, 'a'.repeat(64), mineOrder, [mine.userId]],
        )
      ).rows[0].id;
      await pool.query(
        `insert into notifications (event_id, recipient_user_id, template, data)
         values ($1, $2, 'order.status_changed', $3::jsonb)`,
        [
          eventId,
          mine.userId,
          JSON.stringify({ aggregateType: 'order', aggregateId: mineOrder }),
        ],
      );

      const exported = await users.exportAccount(mine.userId);
      assert.match(exported.exportedAt, MICRO_UTC);
      assert.equal(exported.profile.id, mine.userId);
      assert.match(exported.profile.status, /^active$/);
      assert.match(exported.profile.createdAt, MICRO_UTC);

      // Orders: two of mine, none of the other account.
      assert.equal(exported.orders.total, 2);
      assert.deepEqual(exported.orders.byStatus, [
        { status: 'paid_awaiting_tenant', count: 2 },
      ]);
      assert.deepEqual(exported.orders.totalsByCurrency, [
        { currency: 'IDR', totalMinor: '50000' },
      ]);

      // Wallet and ledger: only the caller's own balance.
      assert.deepEqual(exported.wallet, [
        { currency: 'IDR', availableMinor: '20000' },
      ]);
      assert.equal(exported.transactions.count, 1);
      assert.equal(exported.transactions.truncated, false);
      assert.equal(exported.transactions.items[0].amountMinor, '20000');
      assert.equal(exported.transactions.items[0].direction, 'credit');
      assert.equal(exported.transactions.items[0].reason, 'Mine');
      assert.match(exported.transactions.items[0].createdAt, MICRO_UTC);
      assert.ok(
        exported.transactions.items.every(
          (item) => item.amountMinor !== '777000',
        ),
        "the other account's ledger never appears",
      );

      assert.equal(exported.reviews.count, 1);
      assert.equal(exported.reviews.items[0].orderId, mineOrder);
      assert.equal(exported.reviews.items[0].tenantId, mine.tenantId);
      assert.equal(exported.notifications.count, 1);
      assert.equal(exported.notifications.unread, 1);

      // No secrets: the document is plain JSON with a masked phone only.
      const serialized = JSON.stringify(exported);
      assert.ok(
        !/token|password|ciphertext|identity_hash|code_ciphertext/i.test(
          serialized,
        ),
        'no credential material is exported',
      );
      assert.ok(exported.profile.phone.masked === null);
      assert.equal(Object.keys(exported.profile).includes('phone'), true);
      assert.ok(!('phone_e164' in exported.profile));
    });

    it('exports a closed account read-only without resurrecting it', async () => {
      const env = await createAccount('ClosedExporter');
      await addOrder(env, '10000');
      await users.closeAccount(env.userId);

      const exported = await users.exportAccount(env.userId);
      assert.equal(exported.profile.status, 'closed');
      assert.match(exported.profile.displayName, /^Closed account /);
      assert.equal(exported.orders.total, 1);

      const status = await pool.query<{ status: string }>(
        'select status from users where id = $1',
        [env.userId],
      );
      assert.equal(status.rows[0].status, 'closed', 'export never writes');

      const records = await pool.query<{ count: string }>(
        'select count(*)::text from account_deletion_requests where user_id = $1',
        [env.userId],
      );
      assert.equal(records.rows[0].count, '1');
    });

    it('refuses an unknown account and an invalid id without writing anything', async () => {
      await assert.rejects(
        () => users.closeAccount(randomUUID()),
        (error: unknown) => (error as { status?: number }).status === 404,
      );
      await assert.rejects(
        () => users.exportAccount(randomUUID()),
        (error: unknown) => (error as { status?: number }).status === 404,
      );
      await assert.rejects(
        () => users.closeAccount('not-a-uuid'),
        (error: unknown) => (error as { status?: number }).status === 400,
      );
      await assert.rejects(
        () => users.closeAccount(randomUUID(), { reason: 'x'.repeat(501) }),
        (error: unknown) => codeOf(error) === 'ACCOUNT_CLOSURE_REASON_INVALID',
      );
    });
  },
);
