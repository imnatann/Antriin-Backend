import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import { WalletService } from '../src/modules/wallet/wallet.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe(
  'Wallet ledger PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let wallet: WalletService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 12 });
      await pool.query('select 1');
      wallet = new WalletService({ pool } as unknown as DatabaseService);
    });

    after(async () => {
      await pool?.end();
    });

    it('posts a balanced transfer once and replays only identical input', async () => {
      const fixture = await createFixture(pool, wallet);
      const input = transfer(fixture, {
        amountMinor: '25',
        idempotencyKey: randomUUID(),
        referenceId: randomUUID(),
      });

      const first = await wallet.postTransfer(input);
      const replay = await wallet.postTransfer(input);
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(replay.transactionId, first.transactionId);
      assert.equal(
        (await wallet.getBalance(fixture.userId, 'IDR'))[0].balanceMinor,
        '25',
      );

      await assert.rejects(
        wallet.postTransfer({ ...input, amountMinor: '26' }),
        (error: unknown) => hasErrorCode(error, 'IDEMPOTENCY_KEY_REUSED'),
      );
      const entries = await pool.query<{
        direction: string;
        amount_minor: string;
      }>(
        `select direction, amount_minor::text from ledger_entries where transaction_id = $1`,
        [first.transactionId],
      );
      assert.deepEqual(
        entries.rows
          .map((entry) => [entry.direction, entry.amount_minor])
          .sort(),
        [
          ['credit', '25'],
          ['debit', '25'],
        ],
      );
      const reconciliation = await pool.query<{
        projected: string;
        ledger: string;
      }>(
        `select a.balance_minor::text as projected,
                coalesce(sum(case e.direction when 'credit' then e.amount_minor else -e.amount_minor end), 0)::text as ledger
           from wallet_accounts a
           left join ledger_entries e on e.account_id = a.id
          where a.id = any($1::uuid[])
          group by a.id`,
        [[fixture.systemAccountId, fixture.walletAccountId]],
      );
      assert.equal(reconciliation.rows.length, 2);
      assert.ok(
        reconciliation.rows.every((row) => row.projected === row.ledger),
      );
      const outbox = await pool.query(
        'select 1 from wallet_outbox_events where aggregate_id = $1',
        [first.transactionId],
      );
      assert.equal(outbox.rowCount, 1);
    });

    it('reads zero without creating an account and rejects unknown users', async () => {
      const id = randomUUID();
      const user = await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [`Read-only wallet test ${id}`],
      );
      const userId = user.rows[0].id;
      assert.deepEqual(await wallet.getBalance(userId, 'IDR'), [
        { accountId: null, currency: 'IDR', balanceMinor: '0' },
      ]);
      const accountCount = await pool.query(
        'select 1 from wallet_accounts where owner_user_id = $1',
        [userId],
      );
      assert.equal(accountCount.rowCount, 0);
      await assert.rejects(
        wallet.getBalance(randomUUID(), 'IDR'),
        /User account was not found/,
      );
      await assert.rejects(
        wallet.listTransactions(randomUUID()),
        /User account was not found/,
      );
    });

    it('uses row locks so parallel debits cannot overdraw a wallet', async () => {
      const fixture = await createFixture(pool, wallet);
      await wallet.postTransfer(
        transfer(fixture, {
          amountMinor: '100',
          idempotencyKey: randomUUID(),
          referenceId: randomUUID(),
          source: fixture.systemAccountId,
          destination: fixture.walletAccountId,
        }),
      );
      const debit = (suffix: string) =>
        transfer(fixture, {
          amountMinor: '80',
          idempotencyKey: randomUUID(),
          referenceId: `${randomUUID()}-${suffix}`,
          source: fixture.walletAccountId,
          destination: fixture.systemAccountId,
        });

      const results = await Promise.allSettled([
        wallet.postTransfer(debit('a')),
        wallet.postTransfer(debit('b')),
      ]);
      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === 'rejected').length,
        1,
      );
      const [balance] = await wallet.getBalance(fixture.userId, 'IDR');
      assert.equal(balance.balanceMinor, '20');
    });

    it('rejects duplicate references even when the idempotency key changes', async () => {
      const fixture = await createFixture(pool, wallet);
      const referenceId = randomUUID();
      await wallet.postTransfer(
        transfer(fixture, {
          amountMinor: '1',
          idempotencyKey: randomUUID(),
          referenceId,
        }),
      );
      await assert.rejects(
        wallet.postTransfer(
          transfer(fixture, {
            amountMinor: '1',
            idempotencyKey: randomUUID(),
            referenceId,
          }),
        ),
        (error: unknown) =>
          hasErrorCode(error, 'LEDGER_REFERENCE_ALREADY_POSTED'),
      );
    });

    it('composes wallet creation and posting into a caller-owned transaction', async () => {
      const id = randomUUID();
      const user = await pool.query<{ id: string }>(
        'insert into users (display_name) values ($1) returning id',
        [`Ledger composition test ${id}`],
      );
      const userId = user.rows[0].id;
      const client = await pool.connect();
      try {
        await client.query('begin');
        const [emptyBalance] = await wallet.getBalance(userId, 'IDR', client);
        assert.equal(emptyBalance.accountId, null);
        assert.equal(emptyBalance.balanceMinor, '0');
        const account = await wallet.getOrCreateWallet(userId, 'IDR', client);
        const system = await wallet.ensureSystemAccount(
          `test-composition:${id}`,
          'IDR',
          client,
        );
        await wallet.postTransfer(
          {
            idempotencyScope: `test.composition.${id}`,
            idempotencyKey: randomUUID(),
            reference: { namespace: 'test-fixture', id: randomUUID() },
            currency: 'IDR',
            amountMinor: '9',
            debitAccountId: system.accountId,
            creditAccountId: account.accountId,
            actor: { type: 'service', id: 'test-fixture' },
            reason: 'controlled composition test fixture',
          },
          client,
        );
        const visibleOnOtherConnection = await pool.query(
          'select 1 from ledger_transactions where idempotency_scope = $1',
          [`test.composition.${id}`],
        );
        assert.equal(visibleOnOtherConnection.rowCount, 0);
        await client.query('rollback');
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
      const rolledBack = await pool.query(
        `select 1 from wallet_accounts where owner_user_id = $1 and currency = 'IDR'`,
        [userId],
      );
      assert.equal(rolledBack.rowCount, 0);
    });

    it('rolls back an unbalanced direct journal and rejects later entry mutation', async () => {
      const fixture = await createFixture(pool, wallet);
      const initialBalance = (
        await pool.query<{ balance_minor: string }>(
          'select balance_minor::text from wallet_accounts where id = $1',
          [fixture.systemAccountId],
        )
      ).rows[0].balance_minor;
      const transactionId = randomUUID();
      const key = randomUUID();
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into ledger_transactions
             (id, currency, idempotency_scope, idempotency_key, request_hash,
              actor_type, actor_id, reason, metadata)
           values ($1, 'IDR', $2, $3, $4, 'service', 'test-fixture', 'unbalanced-test', '{}'::jsonb)`,
          [transactionId, `test.unbalanced.${fixture.id}`, key, 'a'.repeat(64)],
        );
        await client.query(
          `insert into ledger_entries (transaction_id, account_id, direction, amount_minor)
           values ($1, $2, 'debit', '1')`,
          [transactionId, fixture.systemAccountId],
        );
        await client.query(
          `insert into wallet_outbox_events
             (event_type, aggregate_type, aggregate_id, payload)
           values ('ledger.transfer.posted', 'ledger_transaction', $1, $2::jsonb)`,
          [transactionId, JSON.stringify({ transactionId, currency: 'IDR' })],
        );
        await assert.rejects(client.query('commit'));
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }

      const afterRollback = await pool.query<{ balance_minor: string }>(
        'select balance_minor::text from wallet_accounts where id = $1',
        [fixture.systemAccountId],
      );
      assert.equal(afterRollback.rows[0].balance_minor, initialBalance);
      const persisted = await pool.query(
        'select 1 from ledger_transactions where id = $1',
        [transactionId],
      );
      assert.equal(persisted.rowCount, 0);

      const posted = await wallet.postTransfer(
        transfer(fixture, {
          amountMinor: '1',
          idempotencyKey: randomUUID(),
          referenceId: randomUUID(),
        }),
      );
      await assert.rejects(
        pool.query(
          'update ledger_entries set amount_minor = 2 where transaction_id = $1',
          [posted.transactionId],
        ),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '55000',
      );
      await assert.rejects(
        pool.query('update ledger_transactions set reason = $2 where id = $1', [
          posted.transactionId,
          'tampered',
        ]),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '55000',
      );
      const lateAccount = await wallet.ensureSystemAccount(
        `test-late-entry:${fixture.id}`,
        'IDR',
      );
      await assert.rejects(
        pool.query(
          `insert into ledger_entries (transaction_id, account_id, direction, amount_minor)
           values ($1, $2, 'debit', '1')`,
          [posted.transactionId, lateAccount.accountId],
        ),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '55000',
      );
      const projectionClient = await pool.connect();
      try {
        await projectionClient.query('begin');
        await projectionClient.query(
          "set local antriin.wallet_projection = 'on'",
        );
        await assert.rejects(
          projectionClient.query(
            'update wallet_accounts set balance_minor = balance_minor + 1 where id = $1',
            [fixture.walletAccountId],
          ),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '55000',
        );
      } finally {
        await projectionClient.query('rollback').catch(() => undefined);
        projectionClient.release();
      }
    });

    it('rejects fractional minor units at the database boundary', async () => {
      const fixture = await createFixture(pool, wallet);
      const transactionId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into ledger_transactions
             (id, currency, idempotency_scope, idempotency_key, request_hash,
              actor_type, actor_id, reason, metadata)
           values ($1, 'IDR', $2, $3, $4, 'service', 'test-fixture', 'fraction-test', '{}'::jsonb)`,
          [
            transactionId,
            `test.fraction.${fixture.id}`,
            randomUUID(),
            'b'.repeat(64),
          ],
        );
        await assert.rejects(
          client.query(
            `insert into ledger_entries (transaction_id, account_id, direction, amount_minor)
             values ($1, $2, 'debit', '1.5')`,
            [transactionId, fixture.systemAccountId],
          ),
        );
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
      const result = await pool.query(
        'select 1 from ledger_transactions where id = $1',
        [transactionId],
      );
      assert.equal(result.rowCount, 0);
    });
  },
);

type Fixture = {
  id: string;
  userId: string;
  walletAccountId: string;
  systemAccountId: string;
};

async function createFixture(
  pool: Pool,
  wallet: WalletService,
): Promise<Fixture> {
  const id = randomUUID();
  const user = await pool.query<{ id: string }>(
    `insert into users (display_name) values ($1) returning id`,
    [`Ledger test ${id}`],
  );
  const userId = user.rows[0].id;
  const userAccount = await wallet.getOrCreateWallet(userId, 'IDR');
  const systemAccount = await wallet.ensureSystemAccount(
    `test-clearing:${id}`,
    'IDR',
  );
  return {
    id,
    userId,
    walletAccountId: userAccount.accountId,
    systemAccountId: systemAccount.accountId,
  };
}

function transfer(
  fixture: Fixture,
  options: {
    amountMinor: string;
    idempotencyKey: string;
    referenceId: string;
    source?: string;
    destination?: string;
  },
) {
  return {
    idempotencyScope: `test.wallet.${fixture.id}`,
    idempotencyKey: options.idempotencyKey,
    reference: { namespace: 'test-fixture', id: options.referenceId },
    currency: 'IDR',
    amountMinor: options.amountMinor,
    debitAccountId: options.source ?? fixture.systemAccountId,
    creditAccountId: options.destination ?? fixture.walletAccountId,
    actor: { type: 'service' as const, id: 'test-fixture' },
    reason: 'controlled integration test fixture',
    metadata: { fixtureId: fixture.id },
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof error.response === 'object' &&
    error.response !== null &&
    'code' in error.response &&
    error.response.code === code
  );
}
