import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import {
  AccessService,
  TENANT_PERMISSIONS,
} from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { UsersService, maskPhone } from '../src/modules/users/users.service';
import { WalletService } from '../src/modules/wallet/wallet.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const MICRO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

async function createEnv(pool: Pool) {
  const tag = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      'insert into campuses (name) values ($1) returning id',
      ['Campus A ' + tag],
    )
  ).rows[0].id;
  const otherCampusId = (
    await pool.query<{ id: string }>(
      'insert into campuses (name) values ($1) returning id',
      ['Campus B ' + tag],
    )
  ).rows[0].id;
  // Two tenants with names whose alphabetical order is the reverse of creation
  // order, so the profile ordering is actually proven.
  const betaTenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusId, 'Beta ' + tag, 'Location ' + tag],
    )
  ).rows[0].id;
  const alphaTenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'closed') returning id",
      [campusId, 'Alpha ' + tag, 'Location ' + tag],
    )
  ).rows[0].id;
  const mkUser = async (
    name: string,
    options: { phone?: string; phoneVerified?: boolean } = {},
  ) =>
    (
      await pool.query<{ id: string }>(
        `insert into users (display_name, phone_e164, phone_verified_at)
         values ($1, $2, $3) returning id`,
        [
          name + ' ' + tag,
          options.phone ?? null,
          options.phoneVerified ? new Date() : null,
        ],
      )
    ).rows[0].id;

  // users.phone_e164 is unique, so each environment gets its own number.
  const phone = '+62812' + String(randomInt(0, 100_000_000)).padStart(8, '0');
  const ownerId = await mkUser('Owner', { phone, phoneVerified: true });
  const kitchenId = await mkUser('Kitchen');
  const adminId = await mkUser('CampusAdmin');
  const outsiderId = await mkUser('Outsider');

  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) values ($1, $2, 'owner', $3::text[], 'active', now())",
    [alphaTenantId, ownerId, []],
  );
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) values ($1, $2, 'owner', $3::text[], 'active', now())",
    [betaTenantId, ownerId, []],
  );
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1, $2, 'kitchen', $3::text[], 'active')",
    [alphaTenantId, kitchenId, ['tenant.orders.read']],
  );
  await pool.query(
    "insert into campus_memberships (campus_id, user_id, permissions, status) values ($1, $2, $3::text[], 'active')",
    [campusId, adminId, ['campus.risk.read']],
  );
  await pool.query(
    `insert into campus_email_verifications
       (user_id, campus_id, identity_hash, verified_at, created_at, updated_at)
     values ($1, $2, $3, now(), now(), now())`,
    [ownerId, campusId, randomUUID().replace(/-/g, '') + '00000000'],
  );
  return {
    tag,
    phone,
    campusId,
    otherCampusId,
    alphaTenantId,
    betaTenantId,
    ownerId,
    kitchenId,
    adminId,
    outsiderId,
  };
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number }).status;
}

function codeOf(error: unknown): string | undefined {
  const response = (error as { getResponse?: () => unknown }).getResponse?.();
  return typeof response === 'object' && response !== null
    ? (response as { code?: string }).code
    : undefined;
}

describe(
  'Me profile slice PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let users: UsersService;
    let wallet: WalletService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      await pool.query('select 1');
      const db = { pool } as unknown as DatabaseService;
      const access = new AccessService(db);
      const audit = new AuditService(db, access);
      wallet = new WalletService(db);
      users = new UsersService(db, audit, wallet);
    });

    after(async () => {
      await pool?.end();
    });

    it('builds the owner profile with masked phone, campus email and both tenants', async () => {
      const env = await createEnv(pool);
      const profile = await users.getProfile(env.ownerId);

      assert.equal(profile.id, env.ownerId);
      assert.match(profile.displayName, /^Owner /);
      assert.equal(profile.status, 'active');
      assert.match(profile.createdAt, MICRO_UTC);
      assert.match(profile.updatedAt, MICRO_UTC);

      // Masked: the prefix and the last four digits survive, the rest does not.
      assert.equal(profile.phone.masked, '+62812****' + env.phone.slice(-4));
      assert.equal(profile.phone.verified, true);
      const serialized = JSON.stringify(profile);
      assert.equal(serialized.includes(env.phone), false);
      assert.equal(serialized.includes(env.phone.slice(6, 10)), false);

      assert.deepEqual(profile.campusEmail, {
        verified: true,
        campusId: env.campusId,
        campusName: 'Campus A ' + env.tag,
      });

      // Ordered by tenant name, owner keeps every tenant permission.
      assert.deepEqual(
        profile.tenants.map((row) => row.tenantName),
        ['Alpha ' + env.tag, 'Beta ' + env.tag],
      );
      for (const tenant of profile.tenants) {
        assert.equal(tenant.role, 'owner');
        assert.equal(tenant.campusId, env.campusId);
        assert.equal(tenant.permissions.length, TENANT_PERMISSIONS.length);
        assert.ok(tenant.permissions.includes('tenant.settings.manage'));
      }
      assert.equal(profile.tenants[0].tenantStatus, 'closed');
      assert.deepEqual(profile.campuses, []);
      assert.deepEqual(profile.wallet, {
        currency: 'IDR',
        availableMinor: '0',
      });
    });

    it('projects staff permissions as stored and no campus membership', async () => {
      const env = await createEnv(pool);
      const profile = await users.getProfile(env.kitchenId);
      assert.equal(profile.tenants.length, 1);
      assert.equal(profile.tenants[0].role, 'kitchen');
      assert.deepEqual(profile.tenants[0].permissions, ['tenant.orders.read']);
      assert.equal(profile.tenants[0].tenantId, env.alphaTenantId);
      assert.deepEqual(profile.phone, { masked: null, verified: false });
      assert.deepEqual(profile.campusEmail, {
        verified: false,
        campusId: null,
        campusName: null,
      });
      assert.deepEqual(profile.campuses, []);
    });

    it('projects campus memberships for a campus administrator', async () => {
      const env = await createEnv(pool);
      const profile = await users.getProfile(env.adminId);
      assert.deepEqual(profile.tenants, []);
      assert.deepEqual(profile.campuses, [
        {
          campusId: env.campusId,
          campusName: 'Campus A ' + env.tag,
          permissions: ['campus.risk.read'],
        },
      ]);
    });

    it('returns an empty profile for a user without memberships', async () => {
      const env = await createEnv(pool);
      const profile = await users.getProfile(env.outsiderId);
      assert.deepEqual(profile.tenants, []);
      assert.deepEqual(profile.campuses, []);
      assert.deepEqual(profile.phone, { masked: null, verified: false });
      assert.equal(profile.campusEmail.verified, false);
      assert.deepEqual(profile.wallet, {
        currency: 'IDR',
        availableMinor: '0',
      });
    });

    it('reports the wallet balance as a minor-unit string', async () => {
      const env = await createEnv(pool);
      // The ledger guard only lets a balance change through a balanced transfer,
      // so the credit is posted instead of updating the account row directly.
      const system = await wallet.ensureSystemAccount(
        'test:me:' + env.tag,
        'IDR',
      );
      const account = await wallet.getOrCreateWallet(env.outsiderId, 'IDR');
      await wallet.postTransfer({
        idempotencyScope: 'test-me',
        idempotencyKey: 'wallet-' + env.tag,
        currency: 'IDR',
        amountMinor: '125000',
        debitAccountId: system.accountId,
        creditAccountId: account.accountId,
        actor: { type: 'service', id: 'test-me' },
        reason: 'Wallet slice test credit',
      });
      const profile = await users.getProfile(env.outsiderId);
      assert.deepEqual(profile.wallet, {
        currency: 'IDR',
        availableMinor: '125000',
      });
    });

    it('serves notification defaults without writing a row', async () => {
      const env = await createEnv(pool);
      const preferences = await users.getNotificationPreferences(
        env.outsiderId,
      );
      assert.deepEqual(preferences, {
        orderUpdates: true,
        reviewReplies: true,
        caseUpdates: true,
        pushEnabled: false,
        updatedAt: null,
      });
      const rows = await pool.query(
        'select 1 from notification_preferences where user_id = $1',
        [env.outsiderId],
      );
      assert.equal(rows.rowCount, 0);
    });

    it('applies partial preference updates without resetting other switches', async () => {
      const env = await createEnv(pool);
      const first = await users.updateNotificationPreferences(env.outsiderId, {
        orderUpdates: false,
      });
      assert.equal(first.orderUpdates, false);
      assert.equal(first.reviewReplies, true);
      assert.equal(first.caseUpdates, true);
      assert.equal(first.pushEnabled, false);
      assert.match(first.updatedAt ?? '', MICRO_UTC);

      const second = await users.updateNotificationPreferences(env.outsiderId, {
        pushEnabled: true,
      });
      assert.equal(second.orderUpdates, false);
      assert.equal(second.pushEnabled, true);
      assert.match(second.updatedAt ?? '', MICRO_UTC);
      assert.ok((second.updatedAt ?? '') >= (first.updatedAt ?? ''));

      const stored = await users.getNotificationPreferences(env.outsiderId);
      assert.equal(stored.orderUpdates, false);
      assert.equal(stored.pushEnabled, true);

      await assert.rejects(
        users.updateNotificationPreferences(env.outsiderId, {}),
        (error) =>
          statusOf(error) === 400 &&
          codeOf(error) === 'PREFERENCE_UPDATE_EMPTY',
      );
    });

    it('registers a device idempotently and stores only the token hash', async () => {
      const env = await createEnv(pool);
      const token = 'device-token-' + env.tag;
      const created = await users.registerDevice(env.outsiderId, {
        platform: 'ios',
        token,
        label: 'My phone',
      });
      assert.equal(created.platform, 'ios');
      assert.equal(created.label, 'My phone');
      assert.match(created.lastSeenAt, MICRO_UTC);
      assert.equal(JSON.stringify(created).includes(token), false);

      const stored = await pool.query<{
        token_hash: string;
        platform: string;
        label: string;
        revoked_at: Date | null;
      }>(
        'select token_hash, platform, label, revoked_at from user_devices where id = $1',
        [created.id],
      );
      assert.equal(
        stored.rows[0].token_hash,
        createHash('sha256').update(token).digest('hex'),
      );
      assert.equal(stored.rows[0].revoked_at, null);

      const again = await users.registerDevice(env.outsiderId, {
        platform: 'web',
        token,
      });
      assert.equal(again.id, created.id);
      assert.equal(again.platform, 'web');
      // An omitted label keeps the stored one.
      assert.equal(again.label, 'My phone');

      const listed = await users.listDevices(env.outsiderId);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, created.id);
    });

    it('refuses a token registered by another account', async () => {
      const env = await createEnv(pool);
      const token = 'shared-token-' + env.tag;
      await users.registerDevice(env.kitchenId, { platform: 'android', token });
      await assert.rejects(
        users.registerDevice(env.outsiderId, { platform: 'android', token }),
        (error) =>
          statusOf(error) === 409 && codeOf(error) === 'DEVICE_TOKEN_CONFLICT',
      );
    });

    it('revokes only the caller own device and hides it from the list', async () => {
      const env = await createEnv(pool);
      const token = 'revoke-token-' + env.tag;
      const device = await users.registerDevice(env.outsiderId, {
        platform: 'android',
        token,
      });

      await assert.rejects(
        users.revokeDevice(env.kitchenId, device.id),
        (error) => statusOf(error) === 404,
      );
      const untouched = await pool.query<{ revoked_at: Date | null }>(
        'select revoked_at from user_devices where id = $1',
        [device.id],
      );
      assert.equal(untouched.rows[0].revoked_at, null);

      await users.revokeDevice(env.outsiderId, device.id);
      assert.deepEqual(await users.listDevices(env.outsiderId), []);
      await assert.rejects(
        users.revokeDevice(env.outsiderId, device.id),
        (error) => statusOf(error) === 404,
      );

      // Registering the same token again reactivates the same row.
      const revived = await users.registerDevice(env.outsiderId, {
        platform: 'android',
        token,
      });
      assert.equal(revived.id, device.id);
      assert.equal((await users.listDevices(env.outsiderId)).length, 1);
    });

    it('validates and audits the display name update', async () => {
      const env = await createEnv(pool);
      for (const displayName of ['', '   ', 'x'.repeat(201)]) {
        await assert.rejects(
          users.updateProfile(env.outsiderId, { displayName }),
          (error) =>
            statusOf(error) === 400 &&
            codeOf(error) === 'PROFILE_DISPLAY_NAME_INVALID',
          JSON.stringify(displayName),
        );
      }
      const profile = await users.updateProfile(env.outsiderId, {
        displayName: '  Renamed Owner  ',
      });
      assert.equal(profile.displayName, 'Renamed Owner');
      assert.equal(profile.id, env.outsiderId);
      assert.match(profile.updatedAt, MICRO_UTC);
      assert.deepEqual(profile.tenants, []);

      const audit = await pool.query<{ action: string; reason: string }>(
        `select action, reason from audit_events
        where scope_type = 'user' and scope_id = $1 and target_id = $1`,
        [env.outsiderId],
      );
      assert.equal(audit.rows.length, 1);
      assert.equal(audit.rows[0].action, 'user.profile.updated');
    });
  },
);

describe('Phone masking', () => {
  it('keeps the prefix and the last four digits only', () => {
    assert.equal(maskPhone('+6281234560001'), '+62812****0001');
    assert.equal(maskPhone(null), null);
    assert.equal(maskPhone(''), null);
    assert.equal(maskPhone('+62812345678'), '+62812**5678');
    assert.equal(maskPhone('+62812'), '******');
  });
});
