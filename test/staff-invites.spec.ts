import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import {
  AccessService,
  TENANT_PERMISSIONS,
} from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import {
  StaffInvitesService,
  INVITE_TTL_DAYS,
} from '../src/modules/invites/staff-invites.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const MICRO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

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
  const otherTenantId = (
    await pool.query<{ id: string }>(
      "insert into tenants (campus_id, name, location, status) values ($1, $2, $3, 'open') returning id",
      [campusId, 'Other ' + tag, 'Location ' + tag],
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
  const otherOwnerId = await mkUser('OtherOwner');
  const kitchenId = await mkUser('Kitchen');
  const inviteeId = await mkUser('Invitee');
  const secondInviteeId = await mkUser('SecondInvitee');

  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) values ($1, $2, 'owner', $3::text[], 'active', now())",
    [tenantId, ownerId, []],
  );
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) values ($1, $2, 'owner', $3::text[], 'active', now())",
    [otherTenantId, otherOwnerId, []],
  );
  await pool.query(
    "insert into tenant_memberships (tenant_id, user_id, role, permissions, status) values ($1, $2, 'kitchen', $3::text[], 'active')",
    [tenantId, kitchenId, ['tenant.orders.read']],
  );

  return {
    tag,
    campusId,
    tenantId,
    otherTenantId,
    ownerId,
    otherOwnerId,
    kitchenId,
    inviteeId,
    secondInviteeId,
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function expectRefusal(
  operation: Promise<unknown>,
  status: number,
  code?: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assert.equal(statusOf(error), status, 'expected HTTP ' + String(status));
    // Access denials carry no domain code; every invitation refusal does.
    assert.equal(codeOf(error), code);
    return;
  }
  assert.fail('expected the call to be refused with ' + String(code ?? status));
}

describe(
  'Staff invitations PostgreSQL integration',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let invites: StaffInvitesService;
    let db: DatabaseService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      await pool.query('select 1');
      db = { pool } as unknown as DatabaseService;
      const access = new AccessService(db);
      const audit = new AuditService(db, access);
      invites = new StaffInvitesService(db, access, audit);
    });

    after(async () => {
      await pool?.end();
    });

    it('issues an invitation, stores only the token hash and creates the membership on acceptance', async () => {
      const env = await createEnv(pool);
      const created = await invites.createInvite(env.ownerId, env.tenantId, {
        userId: env.inviteeId,
        role: 'kitchen',
        permissions: ['tenant.orders.read', 'tenant.orders.prepare'],
      });

      // The raw token is returned once, never stored.
      assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(created.status, 'pending');
      assert.equal(created.role, 'kitchen');
      assert.deepEqual(created.permissions, [
        'tenant.orders.read',
        'tenant.orders.prepare',
      ]);
      assert.equal(created.invitedUserId, env.inviteeId);
      assert.equal(created.invitedBy, env.ownerId);
      assert.match(created.createdAt, MICRO_UTC);
      assert.match(created.expiresAt, MICRO_UTC);

      const stored = await pool.query<{
        token_hash: string;
        permissions: string[];
        days: number;
        audit_count: string;
      }>(
        `select i.token_hash, i.permissions,
                extract(day from (i.expires_at - i.created_at))::int as days,
                (select count(*) from audit_events a
                  where a.action = 'tenant.staff.invite.created'
                    and a.target_id = i.id)::text as audit_count
           from tenant_staff_invites i where i.id = $1`,
        [created.id],
      );
      const row = stored.rows[0];
      assert.equal(row.token_hash, sha256(created.token));
      assert.notEqual(row.token_hash, created.token);
      assert.equal(row.token_hash.length, 64);
      assert.deepEqual(row.permissions, [
        'tenant.orders.read',
        'tenant.orders.prepare',
      ]);
      assert.equal(row.days, INVITE_TTL_DAYS);
      assert.equal(row.audit_count, '1');

      const accepted = await invites.acceptInvite(env.inviteeId, created.token);
      assert.equal(accepted.inviteId, created.id);
      assert.equal(accepted.tenantId, env.tenantId);
      assert.equal(accepted.role, 'kitchen');
      assert.deepEqual(accepted.permissions, [
        'tenant.orders.read',
        'tenant.orders.prepare',
      ]);
      assert.match(accepted.acceptedAt, MICRO_UTC);

      const membership = await pool.query<{
        id: string;
        role: string;
        permissions: string[];
        status: string;
      }>(
        'select id::text, role, permissions::text[] as permissions, status from tenant_memberships where tenant_id = $1 and user_id = $2',
        [env.tenantId, env.inviteeId],
      );
      assert.equal(membership.rows[0].id, accepted.membershipId);
      assert.equal(membership.rows[0].role, 'kitchen');
      assert.equal(membership.rows[0].status, 'active');
      assert.deepEqual(membership.rows[0].permissions, [
        'tenant.orders.read',
        'tenant.orders.prepare',
      ]);

      // Access trail for the campus audit feed plus the invite audit row.
      const trail = await pool.query<{ action: string }>(
        'select action from access_audit_events where membership_id = $1',
        [accepted.membershipId],
      );
      assert.deepEqual(
        trail.rows.map((entry) => entry.action),
        ['grant'],
      );
      const audit = await pool.query<{ count: string }>(
        "select count(*)::text from audit_events where action = 'tenant.staff.invite.accepted' and target_id = $1",
        [created.id],
      );
      assert.equal(audit.rows[0].count, '1');

      // The invite itself can only be redeemed once.
      await expectRefusal(
        invites.acceptInvite(env.inviteeId, created.token),
        409,
        'INVITE_ALREADY_ACCEPTED',
      );
    });

    it('refuses a stale ownership hold with a distinct code for every refusal', async () => {
      const env = await createEnv(pool);

      // Wrong user: the token names one account, so another account is refused.
      const forOne = await invites.createInvite(env.ownerId, env.tenantId, {
        userId: env.inviteeId,
        role: 'pickup',
        permissions: ['tenant.orders.handover'],
      });
      await expectRefusal(
        invites.acceptInvite(env.secondInviteeId, forOne.token),
        403,
        'INVITE_USER_MISMATCH',
      );
      const stillPending = await invites.acceptInvite(
        env.inviteeId,
        forOne.token,
      );
      assert.equal(stillPending.role, 'pickup');

      // Unknown token, and a token whose shape is not a token at all.
      await expectRefusal(
        invites.acceptInvite(
          env.inviteeId,
          randomBytes(32).toString('base64url'),
        ),
        404,
        'INVITE_NOT_FOUND',
      );
      await expectRefusal(
        invites.acceptInvite(env.inviteeId, 'not-a-token'),
        404,
        'INVITE_NOT_FOUND',
      );

      // Revoked.
      const revoked = await invites.createInvite(env.ownerId, env.tenantId, {
        userId: env.secondInviteeId,
        role: 'kitchen',
        permissions: ['tenant.orders.read'],
      });
      const revokedView = await invites.revokeInvite(
        env.ownerId,
        env.tenantId,
        revoked.id,
      );
      assert.equal(revokedView.status, 'revoked');
      assert.match(revokedView.revokedAt ?? '', MICRO_UTC);
      await expectRefusal(
        invites.acceptInvite(env.secondInviteeId, revoked.token),
        409,
        'INVITE_REVOKED',
      );

      // Expired: written directly so no test has to wait for the clock.
      const thirdInvitee = (
        await pool.query<{ id: string }>(
          'insert into users (display_name) values ($1) returning id',
          ['Expired invitee ' + env.tag],
        )
      ).rows[0].id;
      const expiredToken = randomBytes(32).toString('base64url');
      await pool.query(
        `insert into tenant_staff_invites
           (tenant_id, invited_user_id, invited_by, role, permissions,
            token_hash, expires_at, created_at, updated_at)
         values ($1, $2, $3, 'kitchen', '["tenant.orders.read"]'::jsonb, $4,
                 now() - interval '1 hour', now() - interval '8 days', now())`,
        [env.tenantId, thirdInvitee, env.ownerId, sha256(expiredToken)],
      );
      await expectRefusal(
        invites.acceptInvite(thirdInvitee, expiredToken),
        409,
        'INVITE_EXPIRED',
      );

      // The expired invitation is still visible as expired, never as pending.
      const open = await invites.listInvites(env.ownerId, env.tenantId, {});
      const expiredView = open.items.find(
        (item) => item.invitedUserId === thirdInvitee,
      );
      assert.equal(expiredView?.status, 'expired');
      assert.ok(
        open.items.every((item) => item.status !== 'accepted'),
        'accepted invitations are not part of the open list',
      );
    });

    it('revokes only once and never revokes an accepted invitation', async () => {
      const env = await createEnv(pool);
      const created = await invites.createInvite(env.ownerId, env.tenantId, {
        userId: env.inviteeId,
        role: 'kitchen',
        permissions: ['tenant.orders.read'],
      });
      const first = await invites.revokeInvite(
        env.ownerId,
        env.tenantId,
        created.id,
      );
      const revokedAt = first.revokedAt;
      const again = await invites.revokeInvite(
        env.ownerId,
        env.tenantId,
        created.id,
      );
      assert.equal(again.status, 'revoked');
      assert.equal(again.revokedAt, revokedAt, 'replay is a no-op');

      const other = await invites.createInvite(env.ownerId, env.tenantId, {
        userId: env.secondInviteeId,
        role: 'kitchen',
        permissions: ['tenant.orders.read'],
      });
      await invites.acceptInvite(env.secondInviteeId, other.token);
      await expectRefusal(
        invites.revokeInvite(env.ownerId, env.tenantId, other.id),
        409,
        'INVITE_ALREADY_ACCEPTED',
      );
    });

    it('refuses invitations the actor may not issue', async () => {
      const env = await createEnv(pool);

      // Kitchen staff do not hold tenant.staff.manage.
      await expectRefusal(
        invites.createInvite(env.kitchenId, env.tenantId, {
          userId: env.inviteeId,
          role: 'kitchen',
          permissions: ['tenant.orders.read'],
        }),
        403,
      );

      // A verified owner of a different tenant is not an actor here.
      await expectRefusal(
        invites.createInvite(env.otherOwnerId, env.tenantId, {
          userId: env.inviteeId,
          role: 'kitchen',
          permissions: ['tenant.orders.read'],
        }),
        403,
      );

      // Role/tenant isolation on reads too.
      await expectRefusal(
        invites.listInvites(env.kitchenId, env.tenantId, {}),
        403,
      );
      await expectRefusal(
        invites.listInvites(env.otherOwnerId, env.tenantId, {}),
        403,
      );

      // Nothing was written by any refused call.
      const rows = await pool.query<{ count: string }>(
        'select count(*)::text from tenant_staff_invites where tenant_id = $1',
        [env.tenantId],
      );
      assert.equal(rows.rows[0].count, '0');
    });

    it('rejects a role or permission the invitation must not carry', async () => {
      const env = await createEnv(pool);

      await expectRefusal(
        invites.createInvite(env.ownerId, env.tenantId, {
          userId: env.inviteeId,
          role: 'owner',
          permissions: [],
        }),
        400,
        'INVITE_ROLE_INVALID',
      );
      await expectRefusal(
        invites.createInvite(env.ownerId, env.tenantId, {
          userId: env.inviteeId,
          role: 'kitchen',
          permissions: ['tenant.finance.read'],
        }),
        400,
        'INVITE_PERMISSION_INVALID',
      );
      await expectRefusal(
        invites.createInvite(env.ownerId, env.tenantId, {
          userId: env.inviteeId,
          role: 'pickup',
          permissions: ['tenant.orders.read', 'tenant.orders.read'],
        }),
        400,
        'INVITE_PERMISSION_INVALID',
      );
      await expectRefusal(
        invites.createInvite(env.ownerId, env.tenantId, {
          userId: env.ownerId,
          role: 'kitchen',
          permissions: ['tenant.orders.read'],
        }),
        403,
        'INVITE_SELF_FORBIDDEN',
      );

      // Kitchen cannot be handed a handover permission, pickup cannot accept.
      await expectRefusal(
        invites.createInvite(env.ownerId, env.tenantId, {
          userId: env.inviteeId,
          role: 'kitchen',
          permissions: ['tenant.orders.handover'],
        }),
        400,
        'INVITE_PERMISSION_INVALID',
      );

      const none = await pool.query<{ count: string }>(
        'select count(*)::text from tenant_staff_invites where tenant_id = $1',
        [env.tenantId],
      );
      assert.equal(none.rows[0].count, '0');
    });

    it('refuses an inviter who does not hold the permissions being granted', async () => {
      const env = await createEnv(pool);
      // Today only owners hold tenant.staff.manage, and an owner holds every
      // tenant permission, so this branch is unreachable through the routes.
      // It still has to hold: a future non-owner manager must not be able to
      // hand out more than they have.
      const limited = new StaffInvitesService(
        db,
        {
          requireTenant: async () => ({
            tenantId: env.tenantId,
            campusId: env.campusId,
            userId: env.ownerId,
            membershipId: randomUUID(),
            role: 'kitchen',
            permissions: ['tenant.orders.read'],
          }),
        } as unknown as AccessService,
        new AuditService(db, new AccessService(db)),
      );
      await expectRefusal(
        limited.createInvite(env.ownerId, env.tenantId, {
          userId: env.inviteeId,
          role: 'kitchen',
          permissions: ['tenant.orders.prepare'],
        }),
        403,
        'INVITE_PERMISSION_EXCEEDS_ACTOR',
      );
    });

    it('refuses duplicates, unknown users and a second open invitation', async () => {
      const env = await createEnv(pool);
      await invites.createInvite(env.ownerId, env.tenantId, {
        userId: env.inviteeId,
        role: 'kitchen',
        permissions: ['tenant.orders.read'],
      });
      await expectRefusal(
        invites.createInvite(env.ownerId, env.tenantId, {
          userId: env.inviteeId,
          role: 'kitchen',
          permissions: ['tenant.orders.read'],
        }),
        409,
        'INVITE_ALREADY_PENDING',
      );

      await expectRefusal(
        invites.createInvite(env.ownerId, env.tenantId, {
          userId: env.kitchenId,
          role: 'kitchen',
          permissions: ['tenant.orders.read'],
        }),
        409,
        'INVITE_USER_ALREADY_STAFF',
      );

      await expectRefusal(
        invites.createInvite(env.ownerId, env.tenantId, {
          userId: randomUUID(),
          role: 'kitchen',
          permissions: ['tenant.orders.read'],
        }),
        404,
        'INVITE_USER_NOT_FOUND',
      );

      // A closed account cannot be invited either.
      await pool.query("update users set status = 'closed' where id = $1", [
        env.secondInviteeId,
      ]);
      await expectRefusal(
        invites.createInvite(env.ownerId, env.tenantId, {
          userId: env.secondInviteeId,
          role: 'kitchen',
          permissions: ['tenant.orders.read'],
        }),
        404,
        'INVITE_USER_NOT_FOUND',
      );
    });

    it('lists invitations without ever exposing the token and filters by state', async () => {
      const env = await createEnv(pool);
      const accepted = await invites.createInvite(env.ownerId, env.tenantId, {
        userId: env.inviteeId,
        role: 'kitchen',
        permissions: ['tenant.orders.read'],
      });
      await invites.acceptInvite(env.inviteeId, accepted.token);
      const pending = await invites.createInvite(env.ownerId, env.tenantId, {
        userId: env.secondInviteeId,
        role: 'pickup',
        permissions: ['tenant.orders.handover'],
      });

      const open = await invites.listInvites(env.ownerId, env.tenantId, {});
      assert.equal(open.meta.count, 1);
      assert.equal(open.items[0].id, pending.id);
      assert.equal(open.items[0].status, 'pending');
      assert.ok(
        !('token' in open.items[0]) && !('token_hash' in open.items[0]),
        'the list projection carries no token material',
      );

      const all = await invites.listInvites(env.ownerId, env.tenantId, {
        state: 'all',
      });
      assert.deepEqual(all.items.map((item) => item.status).sort(), [
        'accepted',
        'pending',
      ]);

      const onlyAccepted = await invites.listInvites(
        env.ownerId,
        env.tenantId,
        { state: 'accepted' },
      );
      assert.equal(onlyAccepted.items.length, 1);
      assert.equal(onlyAccepted.items[0].id, accepted.id);

      await expectRefusal(
        invites.listInvites(env.ownerId, env.tenantId, {
          state: 'nonsense' as never,
        }),
        400,
        'INVITE_STATE_INVALID',
      );
      await expectRefusal(
        invites.listInvites(env.ownerId, env.tenantId, { limit: 0 }),
        400,
        'INVITE_LIMIT_INVALID',
      );

      // Every tenant keeps its own invitations.
      const other = await invites.listInvites(
        env.otherOwnerId,
        env.otherTenantId,
        {},
      );
      assert.deepEqual(other.items, []);
    });

    it('refuses acceptance when the tenant is archived', async () => {
      const env = await createEnv(pool);
      const created = await invites.createInvite(env.ownerId, env.tenantId, {
        userId: env.inviteeId,
        role: 'kitchen',
        permissions: ['tenant.orders.read'],
      });
      await pool.query("update tenants set status = 'archived' where id = $1", [
        env.tenantId,
      ]);
      await expectRefusal(
        invites.acceptInvite(env.inviteeId, created.token),
        409,
        'INVITE_TENANT_UNAVAILABLE',
      );
      const membership = await pool.query<{ count: string }>(
        'select count(*)::text from tenant_memberships where tenant_id = $1 and user_id = $2',
        [env.tenantId, env.inviteeId],
      );
      assert.equal(membership.rows[0].count, '0');
    });

    it('serialises two simultaneous redemptions of the same token', async () => {
      const env = await createEnv(pool);
      const created = await invites.createInvite(env.ownerId, env.tenantId, {
        userId: env.inviteeId,
        role: 'kitchen',
        permissions: ['tenant.orders.read'],
      });
      const results = await Promise.allSettled([
        invites.acceptInvite(env.inviteeId, created.token),
        invites.acceptInvite(env.inviteeId, created.token),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter((result) => result.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      const refusal = (rejected[0] as PromiseRejectedResult).reason as unknown;
      assert.equal(codeOf(refusal), 'INVITE_ALREADY_ACCEPTED');

      const memberships = await pool.query<{ count: string }>(
        'select count(*)::text from tenant_memberships where tenant_id = $1 and user_id = $2',
        [env.tenantId, env.inviteeId],
      );
      assert.equal(memberships.rows[0].count, '1');
    });

    it('reuses the existing membership row when the invitee had one revoked', async () => {
      const env = await createEnv(pool);
      await pool.query(
        "insert into tenant_memberships (tenant_id, user_id, role, permissions, status, revoked_at) values ($1, $2, 'pickup', $3::text[], 'revoked', now())",
        [env.tenantId, env.inviteeId, ['tenant.orders.handover']],
      );
      const created = await invites.createInvite(env.ownerId, env.tenantId, {
        userId: env.inviteeId,
        role: 'kitchen',
        permissions: ['tenant.orders.read'],
      });
      const accepted = await invites.acceptInvite(env.inviteeId, created.token);
      const row = await pool.query<{
        id: string;
        role: string;
        status: string;
        revoked_at: Date | null;
      }>(
        'select id::text, role, status, revoked_at from tenant_memberships where tenant_id = $1 and user_id = $2',
        [env.tenantId, env.inviteeId],
      );
      assert.equal(row.rows.length, 1);
      assert.equal(row.rows[0].id, accepted.membershipId);
      assert.equal(row.rows[0].role, 'kitchen');
      assert.equal(row.rows[0].status, 'active');
      assert.equal(row.rows[0].revoked_at, null);
    });

    it('issues only one invitation when two owners create one concurrently', async () => {
      const env = await createEnv(pool);
      const results = await Promise.allSettled([
        invites.createInvite(env.ownerId, env.tenantId, {
          userId: env.inviteeId,
          role: 'kitchen',
          permissions: ['tenant.orders.read'],
        }),
        invites.createInvite(env.ownerId, env.tenantId, {
          userId: env.inviteeId,
          role: 'kitchen',
          permissions: ['tenant.orders.read'],
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(
        codeOf((rejected[0] as PromiseRejectedResult).reason),
        'INVITE_ALREADY_PENDING',
      );
      const rows = await pool.query<{ count: string }>(
        `select count(*)::text from tenant_staff_invites
           where tenant_id = $1 and invited_user_id = $2
             and accepted_at is null and revoked_at is null`,
        [env.tenantId, env.inviteeId],
      );
      assert.equal(rows.rows[0].count, '1');
    });

    it('keeps every owner-only permission out of both staff roles', async () => {
      const env = await createEnv(pool);
      const ownerOnly = [
        'tenant.finance.read',
        'tenant.bank_account.manage',
        'tenant.payout.request',
        'tenant.staff.manage',
        'tenant.settings.manage',
      ];
      // Each code is a real catalogue entry, so this is not testing a typo.
      for (const permission of ownerOnly)
        assert.ok(TENANT_PERMISSIONS.includes(permission as never));
      for (const permission of ownerOnly) {
        for (const role of ['kitchen', 'pickup']) {
          await expectRefusal(
            invites.createInvite(env.ownerId, env.tenantId, {
              userId: env.inviteeId,
              role,
              permissions: [permission],
            }),
            400,
            'INVITE_PERMISSION_INVALID',
          );
        }
      }
      const rows = await pool.query<{ count: string }>(
        'select count(*)::text from tenant_staff_invites where tenant_id = $1',
        [env.tenantId],
      );
      assert.equal(rows.rows[0].count, '0');
    });
  },
);
