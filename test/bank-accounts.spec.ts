import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { BankAccountsService } from '../src/modules/payouts/bank-accounts.service';
import {
  decryptAccountNumber,
  hashAccountNumber,
} from '../src/modules/payouts/bank-account.crypto';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const ENCRYPTION_KEY = randomBytes(32).toString('base64');

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    AUTH_ENCRYPTION_KEY: ENCRYPTION_KEY,
    ...overrides,
  };
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error('missing config ' + key);
      return values[key];
    },
    get: (key: string) => values[key],
  } as unknown as ConfigService;
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
  const pickupId = await mkUser('Pickup');
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
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role, permissions, status)
     values ($1, $2, 'pickup', $3::text[], 'active')`,
    [tenantId, pickupId, ['tenant.orders.read', 'tenant.orders.handover']],
  );
  return { tag, campusId, tenantId, ownerId, kitchenId, pickupId, outsiderId };
}

function httpCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'response' in error
    ? (error as { response: { code?: string } }).response?.code
    : undefined;
}

function uniqueNumber(): string {
  return (
    '88' + randomBytes(5).toString('hex').replace(/[a-f]/g, '9').slice(0, 8)
  );
}

describe(
  'Bank accounts PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let db: DatabaseService;
    let access: AccessService;
    let audit: AuditService;
    let accounts: BankAccountsService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      access = new AccessService(db);
      audit = new AuditService(db, access);
      accounts = new BankAccountsService(db, access, audit, makeConfig());
    });
    after(async () => {
      await pool?.end();
    });

    it('stores the number encrypted + keyed-hash and returns only the masked form', async () => {
      const env = await createEnv(pool);
      const number = uniqueNumber();
      const view = await accounts.createBankAccount(env.ownerId, env.tenantId, {
        bankCode: 'BCA',
        accountNumber: number,
        accountHolderName: 'Owner Name',
      });
      assert.equal(view.verificationStatus, 'pending');
      assert.equal(view.status, 'active');
      assert.equal(view.isDefault, true);
      assert.equal(view.accountNumberMasked, '****' + number.slice(-4));
      assert.ok(!JSON.stringify(view).includes(number), 'no plaintext number');

      const stored = await pool.query<{
        account_number_ciphertext: string;
        account_number_hash: string;
        account_number_masked: string;
      }>(
        `select account_number_ciphertext, account_number_hash,
                account_number_masked
           from bank_accounts where id = $1`,
        [view.id],
      );
      const row = stored.rows[0];
      assert.notEqual(row.account_number_ciphertext, number);
      assert.equal(
        decryptAccountNumber(
          Buffer.from(ENCRYPTION_KEY, 'base64'),
          row.account_number_ciphertext,
        ),
        number,
        'ciphertext decrypts back to the number',
      );
      assert.match(row.account_number_hash, /^[a-f0-9]{64}$/);
      // The dedupe hash is keyed, not a plain SHA-256 of the number.
      const plainSha = createHmac('sha256', '').update(number).digest('hex');
      assert.notEqual(row.account_number_hash, plainSha);
      assert.equal(
        row.account_number_hash,
        hashAccountNumber(
          createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'base64'))
            .update('antriin.bank_account.dedupe.v1', 'utf8')
            .digest(),
          number,
        ),
      );
      assert.equal(row.account_number_masked, '****' + number.slice(-4));
      assert.ok(!row.account_number_ciphertext.includes(number));

      const auditRow = await pool.query(
        `select 1 from audit_events
          where action = 'tenant.bank_account.created' and target_id = $1`,
        [view.id],
      );
      assert.equal(auditRow.rowCount, 1);
    });

    it('rejects a duplicate active account and an unsupported bank code', async () => {
      const env = await createEnv(pool);
      const number = uniqueNumber();
      await accounts.createBankAccount(env.ownerId, env.tenantId, {
        bankCode: 'BNI',
        accountNumber: number,
        accountHolderName: 'Owner Name',
      });
      await assert.rejects(
        accounts.createBankAccount(env.ownerId, env.tenantId, {
          bankCode: 'BNI',
          accountNumber: number,
          accountHolderName: 'Owner Name',
        }),
        (error: unknown) => httpCode(error) === 'BANK_ACCOUNT_ALREADY_EXISTS',
      );
      await assert.rejects(
        accounts.createBankAccount(env.ownerId, env.tenantId, {
          bankCode: 'NOT_A_BANK',
          accountNumber: uniqueNumber(),
          accountHolderName: 'Owner Name',
        }),
        (error: unknown) => httpCode(error) === 'BANK_ACCOUNT_BANK_UNSUPPORTED',
      );
      await assert.rejects(
        accounts.createBankAccount(env.ownerId, env.tenantId, {
          bankCode: 'BNI',
          accountNumber: '12ab',
          accountHolderName: 'Owner Name',
        }),
        (error: unknown) => httpCode(error) === 'BANK_ACCOUNT_NUMBER_INVALID',
      );
    });

    it('replaces an account with a new pending row and disables the previous one', async () => {
      const env = await createEnv(pool);
      const oldNumber = uniqueNumber();
      const old = await accounts.createBankAccount(env.ownerId, env.tenantId, {
        bankCode: 'BCA',
        accountNumber: oldNumber,
        accountHolderName: 'Owner Name',
      });
      const replacement = await accounts.replaceBankAccount(
        env.ownerId,
        env.tenantId,
        old.id,
        {
          bankCode: 'MANDIRI',
          accountNumber: uniqueNumber(),
          accountHolderName: 'Owner Name',
        },
      );
      assert.notEqual(replacement.id, old.id);
      assert.equal(replacement.verificationStatus, 'pending');
      assert.equal(replacement.status, 'active');
      assert.equal(replacement.isDefault, true, 'default follows the owner');

      const previous = await pool.query<{
        status: string;
        is_default: boolean;
      }>('select status, is_default from bank_accounts where id = $1', [
        old.id,
      ]);
      assert.equal(previous.rows[0].status, 'disabled');
      assert.equal(previous.rows[0].is_default, false);
      const rows = await pool.query(
        'select 1 from bank_accounts where tenant_id = $1',
        [env.tenantId],
      );
      assert.equal(rows.rowCount, 2, 'history is kept, nothing is deleted');
      const auditRow = await pool.query(
        `select 1 from audit_events
          where action = 'tenant.bank_account.replaced' and target_id = $1`,
        [replacement.id],
      );
      assert.equal(auditRow.rowCount, 1);

      // The same number may be registered again once the old row is disabled.
      const again = await accounts.createBankAccount(
        env.ownerId,
        env.tenantId,
        {
          bankCode: 'BCA',
          accountNumber: oldNumber,
          accountHolderName: 'Owner Name',
        },
      );
      assert.equal(again.accountNumberMasked, '****' + oldNumber.slice(-4));
      // A disabled account can no longer be replaced.
      await assert.rejects(
        accounts.replaceBankAccount(env.ownerId, env.tenantId, old.id, {
          bankCode: 'BCA',
          accountNumber: uniqueNumber(),
          accountHolderName: 'Owner Name',
        }),
        (error: unknown) => httpCode(error) === 'BANK_ACCOUNT_NOT_ACTIVE',
      );
    });

    it('disables an account without deleting it, idempotently', async () => {
      const env = await createEnv(pool);
      const view = await accounts.createBankAccount(env.ownerId, env.tenantId, {
        bankCode: 'BRI',
        accountNumber: uniqueNumber(),
        accountHolderName: 'Owner Name',
      });
      const disabled = await accounts.disableBankAccount(
        env.ownerId,
        env.tenantId,
        view.id,
      );
      assert.equal(disabled.status, 'disabled');
      const replay = await accounts.disableBankAccount(
        env.ownerId,
        env.tenantId,
        view.id,
      );
      assert.equal(replay.status, 'disabled');
      const row = await pool.query(
        'select 1 from bank_accounts where id = $1',
        [view.id],
      );
      assert.equal(row.rowCount, 1);
    });

    it('keeps the verification endpoint disabled with 503 (D18 Q4)', async () => {
      const env = await createEnv(pool);
      const view = await accounts.createBankAccount(env.ownerId, env.tenantId, {
        bankCode: 'BTN',
        accountNumber: uniqueNumber(),
        accountHolderName: 'Owner Name',
      });
      await assert.rejects(
        accounts.requestVerification(env.ownerId, env.tenantId, view.id),
        (error: unknown) =>
          httpCode(error) === 'BANK_ACCOUNT_VERIFICATION_DISABLED',
      );
      const still = await pool.query<{ verification_status: string }>(
        'select verification_status from bank_accounts where id = $1',
        [view.id],
      );
      assert.equal(still.rows[0].verification_status, 'pending');
    });

    it('denies kitchen and pickup staff and outsiders (owner-only permission)', async () => {
      const env = await createEnv(pool);
      const view = await accounts.createBankAccount(env.ownerId, env.tenantId, {
        bankCode: 'BCA',
        accountNumber: uniqueNumber(),
        accountHolderName: 'Owner Name',
      });
      for (const actor of [env.kitchenId, env.pickupId]) {
        await assert.rejects(
          accounts.listBankAccounts(actor, env.tenantId),
          /Tenant finance access denied/,
        );
        await assert.rejects(
          accounts.createBankAccount(actor, env.tenantId, {
            bankCode: 'BCA',
            accountNumber: uniqueNumber(),
            accountHolderName: 'Staff',
          }),
          /Tenant finance access denied/,
        );
        await assert.rejects(
          accounts.requestVerification(actor, env.tenantId, view.id),
          /Tenant finance access denied/,
        );
      }
      await assert.rejects(
        accounts.listBankAccounts(env.outsiderId, env.tenantId),
        /Tenant access denied/,
      );
      // A tenant owner cannot reach another tenant's account (404, no leak).
      const other = await createEnv(pool);
      await assert.rejects(
        accounts.disableBankAccount(other.ownerId, other.tenantId, view.id),
        /Bank account was not found/,
      );
    });

    it('never exposes ciphertext or the full number in list results', async () => {
      const env = await createEnv(pool);
      const number = uniqueNumber();
      await accounts.createBankAccount(env.ownerId, env.tenantId, {
        bankCode: 'BCA',
        accountNumber: number,
        accountHolderName: 'Owner Name',
      });
      const list = await accounts.listBankAccounts(env.ownerId, env.tenantId);
      assert.equal(list.length, 1);
      const serialized = JSON.stringify(list);
      assert.ok(!serialized.includes(number));
      assert.ok(!serialized.includes('ciphertext'));
      assert.ok(!serialized.includes('hash'));
      assert.equal(list[0].accountNumberMasked, '****' + number.slice(-4));
    });

    it('fails closed with 503 when the encryption key is missing', async () => {
      const env = await createEnv(pool);
      const broken = new BankAccountsService(
        db,
        access,
        audit,
        makeConfig({ AUTH_ENCRYPTION_KEY: undefined }),
      );
      await assert.rejects(
        broken.createBankAccount(env.ownerId, env.tenantId, {
          bankCode: 'BCA',
          accountNumber: uniqueNumber(),
          accountHolderName: 'Owner Name',
        }),
        (error: unknown) =>
          httpCode(error) === 'BANK_ACCOUNT_ENCRYPTION_DISABLED',
      );
      assert.equal(
        (
          await pool.query('select 1 from bank_accounts where tenant_id = $1', [
            env.tenantId,
          ])
        ).rowCount,
        0,
      );
    });

    it('authorizes before touching crypto material (F8)', async () => {
      const env = await createEnv(pool);
      // A service whose encryption key is missing AND whose caller is not a
      // member: the 403 must win over both the 400 (bad input) and the 503
      // (missing key), because authorization is a server-side decision and the
      // crypto path must never run for an unauthorized caller.
      const keyless = new BankAccountsService(
        db,
        access,
        audit,
        makeConfig({ AUTH_ENCRYPTION_KEY: undefined }),
      );
      await assert.rejects(
        keyless.createBankAccount(env.outsiderId, env.tenantId, {
          bankCode: 'BCA',
          accountNumber: uniqueNumber(),
          accountHolderName: 'Owner Name',
        }),
        /Tenant access denied/,
      );
      await assert.rejects(
        keyless.createBankAccount(env.outsiderId, env.tenantId, {
          bankCode: 'NOT_A_BANK',
          accountNumber: 'x',
          accountHolderName: '',
        }),
        /Tenant access denied/,
        'invalid input from a non-member is still a 403',
      );
      const existing = await accounts.createBankAccount(
        env.ownerId,
        env.tenantId,
        {
          bankCode: 'BCA',
          accountNumber: uniqueNumber(),
          accountHolderName: 'Owner Name',
        },
      );
      await assert.rejects(
        keyless.replaceBankAccount(env.outsiderId, env.tenantId, existing.id, {
          bankCode: 'BCA',
          accountNumber: uniqueNumber(),
          accountHolderName: 'Owner Name',
        }),
        /Tenant access denied/,
      );
      // Nothing was written by any of the rejected calls.
      assert.equal(
        (
          await pool.query('select 1 from bank_accounts where tenant_id = $1', [
            env.tenantId,
          ])
        ).rowCount,
        1,
      );
    });

    it('refuses to verify a disabled account (F8)', async () => {
      const env = await createEnv(pool);
      const view = await accounts.createBankAccount(env.ownerId, env.tenantId, {
        bankCode: 'BCA',
        accountNumber: uniqueNumber(),
        accountHolderName: 'Owner Name',
      });
      await accounts.disableBankAccount(env.ownerId, env.tenantId, view.id);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await assert.rejects(
          accounts.markVerified(client, env.tenantId, view.id, {
            verifiedByUserId: env.ownerId,
            method: 'manual_campus',
          }),
          (error: unknown) => httpCode(error) === 'BANK_ACCOUNT_NOT_ACTIVE',
        );
        await client.query('rollback');
      } finally {
        client.release();
      }
      // Verification status and account status stay consistent.
      const row = await pool.query<{
        verification_status: string;
        status: string;
        verified_at: string | null;
      }>(
        'select verification_status, status, verified_at from bank_accounts where id = $1',
        [view.id],
      );
      assert.equal(row.rows[0].status, 'disabled');
      assert.equal(row.rows[0].verification_status, 'pending');
      assert.equal(row.rows[0].verified_at, null);
      assert.equal(
        (
          await pool.query(
            "select 1 from audit_events where action = 'tenant.bank_account.verified' and target_id = $1",
            [view.id],
          )
        ).rowCount,
        0,
        'a rejected verification writes no audit row',
      );
    });

    it('verifies only through the controlled service path and audits it', async () => {
      const env = await createEnv(pool);
      const view = await accounts.createBankAccount(env.ownerId, env.tenantId, {
        bankCode: 'BCA',
        accountNumber: uniqueNumber(),
        accountHolderName: 'Owner Name',
      });
      const client = await pool.connect();
      try {
        await client.query('begin');
        const verified = await accounts.markVerified(
          client,
          env.tenantId,
          view.id,
          {
            verifiedByUserId: env.ownerId,
            method: 'manual_campus',
          },
        );
        assert.equal(verified.verificationStatus, 'verified');
        assert.ok(verified.verifiedAt);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      const auditRow = await pool.query(
        `select 1 from audit_events
          where action = 'tenant.bank_account.verified' and target_id = $1`,
        [view.id],
      );
      assert.equal(auditRow.rowCount, 1);
    });
  },
);
