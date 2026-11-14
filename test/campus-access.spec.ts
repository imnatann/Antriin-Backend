import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { CampusAccessService } from '../src/modules/campuses/campus-access.service';
import { CampusEmailDomainsService } from '../src/modules/campuses/campus-email-domains.service';
import { AuthService } from '../src/modules/auth/auth.service';
import type { OtpDeliveryMessage } from '../src/modules/auth/auth.constants';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/**
 * Minimal OTP delivery port: the campus email challenge must be created, but
 * nothing in this slice may actually deliver a code.
 */
class CapturingOtpDelivery {
  readonly messages: OtpDeliveryMessage[] = [];

  async send(message: OtpDeliveryMessage): Promise<void> {
    this.messages.push(message);
  }
}

function authConfig(): ConfigService {
  const values: Record<string, string | number> = {
    AUTH_SECRET: 'c'.repeat(48),
    AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  return {
    get: <T>(key: string, fallback?: T): T | undefined =>
      (values[key] as T | undefined) ?? fallback,
  } as unknown as ConfigService;
}

async function createEnv(pool: Pool) {
  const tag = randomUUID().slice(0, 8);
  const campusA = (
    await pool.query<{ id: string }>(
      "insert into campuses (name, status) values ($1, 'active') returning id",
      ['Kampus Akses A ' + tag],
    )
  ).rows[0].id;
  const campusB = (
    await pool.query<{ id: string }>(
      "insert into campuses (name, status) values ($1, 'active') returning id",
      ['Kampus Akses B ' + tag],
    )
  ).rows[0].id;
  const mkUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        "insert into users (display_name, status) values ($1, 'active') returning id",
        [name],
      )
    ).rows[0].id;
  const adminA = await mkUser('Ada Admin ' + tag);
  const viewerA = await mkUser('Budi Viewer ' + tag);
  const auditorA = await mkUser('Citra Auditor ' + tag);
  const revokedA = await mkUser('Dodi Revoked ' + tag);
  const adminB = await mkUser('Eka Kampus B ' + tag);
  const outsider = await mkUser('Fajar Outsider ' + tag);
  await pool.query(
    `insert into campus_memberships
       (campus_id, user_id, permissions, status)
     values ($1, $2, $3::text[], 'active'),
            ($1, $4, $5::text[], 'active'),
            ($1, $6, $7::text[], 'active'),
            ($8, $9, $3::text[], 'active')`,
    [
      campusA,
      adminA,
      ['campus.access.manage', 'campus.transactions.read'],
      viewerA,
      ['campus.transactions.read'],
      auditorA,
      ['campus.audit.read'],
      campusB,
      adminB,
    ],
  );
  // campus_memberships_revoked_at_check: a revoked row must carry revoked_at.
  await pool.query(
    `insert into campus_memberships
       (campus_id, user_id, permissions, status, revoked_at)
     values ($1, $2, $3::text[], 'revoked', now())`,
    [campusA, revokedA, ['campus.access.manage']],
  );
  return {
    tag,
    campusA,
    campusB,
    adminA,
    viewerA,
    auditorA,
    revokedA,
    adminB,
    outsider,
  };
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number }).status;
}

function codeOf(error: unknown): string | undefined {
  return (error as { response?: { code?: string } }).response?.code;
}

describe(
  'Campus access read model and email domain registry',
  { skip: !testDatabaseUrl },
  () => {
    let pool: Pool;
    let access: AccessService;
    let campusAccess: CampusAccessService;
    let domains: CampusEmailDomainsService;
    let auth: AuthService;

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
      await pool.query('select 1');
      const db = { pool } as unknown as DatabaseService;
      access = new AccessService(db);
      const audit = new AuditService(db, access);
      campusAccess = new CampusAccessService(db, access);
      domains = new CampusEmailDomainsService(db, access, audit);
      auth = new AuthService(db, authConfig(), new CapturingOtpDelivery());
    });
    after(async () => {
      await pool?.end();
    });

    it('lists only the active members of one campus, ordered by display name', async () => {
      const env = await createEnv(pool);
      const members = await campusAccess.listMembers(env.adminA, env.campusA);
      assert.deepEqual(
        members.map((member) => member.userId),
        [env.adminA, env.viewerA, env.auditorA],
      );
      const first = members[0];
      assert.match(first.membershipId, /^[0-9a-f-]{36}$/);
      assert.equal(first.status, 'active');
      assert.deepEqual(first.permissions, [
        'campus.access.manage',
        'campus.transactions.read',
      ]);
      assert.match(first.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
      assert.match(first.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
      // The revoked member and the other campus' admin never appear.
      const userIds = members.map((member) => member.userId);
      assert.equal(userIds.includes(env.revokedA), false);
      assert.equal(userIds.includes(env.adminB), false);
    });

    it('refuses the member list without campus.access.manage on that campus', async () => {
      const env = await createEnv(pool);
      for (const actor of [
        env.viewerA,
        env.auditorA,
        env.outsider,
        env.adminB,
      ]) {
        await assert.rejects(
          campusAccess.listMembers(actor, env.campusA),
          (error) => statusOf(error) === 403,
        );
      }
    });

    it('normalizes a registered domain and refuses a global duplicate', async () => {
      const env = await createEnv(pool);
      // The domain column is globally unique, so every run needs its own name;
      // a fixed fixture would collide on the second run against the same database.
      const domainName = 'student-' + env.tag + '.ac.id';
      const created = await domains.create(env.adminA, env.campusA, {
        domain: '  Student-' + env.tag + '.AC.ID ',
        reason: 'Kampus mendaftarkan domain mahasiswa',
      });
      assert.equal(created.domain, domainName);
      assert.equal(created.active, true);
      // A new domain is NEVER pre-verified: auth keeps rejecting it.
      assert.equal(created.verifiedAt, null);

      await assert.rejects(
        domains.create(env.adminB, env.campusB, {
          domain: 'STUDENT-' + env.tag + '.ac.id',
          reason: 'Domain yang sama dari kampus lain',
        }),
        (error) =>
          statusOf(error) === 409 && codeOf(error) === 'EMAIL_DOMAIN_TAKEN',
      );

      for (const bad of [
        'nodots',
        'a..b',
        '-student.ac.id',
        'student.ac.id.',
      ]) {
        await assert.rejects(
          domains.create(env.adminA, env.campusA, {
            domain: bad,
            reason: 'Domain tidak sah',
          }),
          (error) =>
            statusOf(error) === 400 && codeOf(error) === 'EMAIL_DOMAIN_INVALID',
          bad,
        );
      }

      const listed = await domains.list(env.adminA, env.campusA);
      assert.deepEqual(
        listed.map((row) => row.domain),
        [domainName],
      );
    });

    it('keeps auth rejecting an unverified domain until a manager verifies it', async () => {
      const env = await createEnv(pool);
      const domainName = 'belum-verifikasi-' + env.tag + '.ac.id';
      const domain = await domains.create(env.adminA, env.campusA, {
        domain: domainName,
        reason: 'Pendaftaran domain baru',
      });
      const stored = await pool.query<{ verified_at: Date | null }>(
        'select verified_at from campus_email_domains where id = $1',
        [domain.id],
      );
      assert.equal(stored.rows[0].verified_at, null);

      await assert.rejects(
        auth.createCampusEmailVerification(
          env.viewerA,
          'mahasiswa@' + domainName,
        ),
        (error) => codeOf(error) === 'campus_email_domain_not_allowed',
      );

      const verified = await domains.verify(
        env.adminA,
        env.campusA,
        domain.id,
        {
          reason: 'Kepemilikan domain dicek manual lewat surat kampus',
        },
      );
      assert.notEqual(verified.verifiedAt, null);
      assert.match(
        verified.verifiedAt ?? '',
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/,
      );

      // The same gate AuthService applies now lets the address through.
      const challenge = await auth.createCampusEmailVerification(
        env.viewerA,
        'mahasiswa@' + domainName,
      );
      assert.match(challenge.challengeId, /^[0-9a-f-]{36}$/);
    });

    it('verifies idempotently without touching the first verified_at', async () => {
      const env = await createEnv(pool);
      const domain = await domains.create(env.adminA, env.campusA, {
        domain: 'idempoten-' + env.tag + '.ac.id',
        reason: 'Domain untuk uji idempotensi',
      });
      const first = await domains.verify(env.adminA, env.campusA, domain.id, {
        reason: 'Verifikasi pertama',
      });
      const second = await domains.verify(env.adminA, env.campusA, domain.id, {
        reason: 'Verifikasi ulang',
      });
      assert.equal(second.verifiedAt, first.verifiedAt);
      assert.equal(second.updatedAt, first.updatedAt);
      const audits = await pool.query<{
        metadata: { alreadyVerified: boolean };
      }>(
        `select metadata from audit_events
          where scope_type = 'campus' and scope_id = $1
            and action = 'campus.email_domain_verified' and target_id = $2
          order by occurred_at, id`,
        [env.campusA, domain.id],
      );
      assert.equal(audits.rows.length, 2);
      assert.deepEqual(
        audits.rows.map((row) => row.metadata.alreadyVerified),
        [false, true],
      );
    });

    it('stops auth from accepting the domain once it is deactivated', async () => {
      const env = await createEnv(pool);
      const domainName = 'nonaktif-' + env.tag + '.ac.id';
      const domain = await domains.create(env.adminA, env.campusA, {
        domain: domainName,
        reason: 'Domain untuk uji deaktivasi',
      });
      await domains.verify(env.adminA, env.campusA, domain.id, {
        reason: 'Verifikasi manual',
      });
      const challenge = await auth.createCampusEmailVerification(
        env.auditorA,
        'satu@' + domainName,
      );
      assert.ok(challenge.challengeId);

      const deactivated = await domains.update(
        env.adminA,
        env.campusA,
        domain.id,
        { active: false, reason: 'Domain tidak dipakai lagi' },
      );
      assert.equal(deactivated.active, false);
      assert.notEqual(deactivated.verifiedAt, null);

      await assert.rejects(
        auth.createCampusEmailVerification(env.viewerA, 'dua@' + domainName),
        (error) => codeOf(error) === 'campus_email_domain_not_allowed',
      );

      await assert.rejects(
        domains.update(env.adminA, env.campusA, domain.id, {
          reason: 'Tanpa flag active',
        }),
        (error) =>
          statusOf(error) === 400 &&
          codeOf(error) === 'EMAIL_DOMAIN_UPDATE_EMPTY',
      );
    });

    it('hard-deletes a domain and keeps the domain name in the audit trail', async () => {
      const env = await createEnv(pool);
      const domainName = 'hapus-' + env.tag + '.ac.id';
      const domain = await domains.create(env.adminA, env.campusA, {
        domain: domainName,
        reason: 'Domain untuk uji hapus',
      });
      await domains.remove(env.adminA, env.campusA, domain.id, {
        reason: 'Domain kampus sudah tidak berlaku',
      });
      const rows = await pool.query(
        'select 1 from campus_email_domains where id = $1',
        [domain.id],
      );
      assert.equal(rows.rowCount, 0);
      const audit = await pool.query<{
        action: string;
        reason: string;
        metadata: { domain: string };
        actor_user_id: string;
      }>(
        `select action, reason, metadata, actor_user_id from audit_events
          where scope_type = 'campus' and scope_id = $1 and target_id = $2
            and action = 'campus.email_domain_deleted'`,
        [env.campusA, domain.id],
      );
      assert.equal(audit.rows.length, 1);
      assert.equal(audit.rows[0].metadata.domain, domainName);
      assert.equal(audit.rows[0].reason, 'Domain kampus sudah tidak berlaku');
      assert.equal(audit.rows[0].actor_user_id, env.adminA);
    });

    it('audits every mutation and scopes a domain to its own campus', async () => {
      const env = await createEnv(pool);
      const created = await domains.create(env.adminA, env.campusA, {
        domain: 'audit-' + env.tag + '.ac.id',
        reason: 'Domain untuk uji audit',
      });
      await domains.verify(env.adminA, env.campusA, created.id, {
        reason: 'Verifikasi manual',
      });
      await domains.update(env.adminA, env.campusA, created.id, {
        active: true,
        reason: 'Aktivasi ulang',
      });
      await domains.remove(env.adminA, env.campusA, created.id, {
        reason: 'Penghapusan uji audit',
      });
      const actions = await pool.query<{ action: string }>(
        `select action from audit_events
          where scope_type = 'campus' and scope_id = $1
            and target_type = 'email_domain' and target_id = $2
          order by occurred_at, id`,
        [env.campusA, created.id],
      );
      assert.deepEqual(
        actions.rows.map((row) => row.action),
        [
          'campus.email_domain_created',
          'campus.email_domain_verified',
          'campus.email_domain_updated',
          'campus.email_domain_deleted',
        ],
      );

      // A domain of another campus is invisible through this campus' path.
      const other = await domains.create(env.adminB, env.campusB, {
        domain: 'lain-' + env.tag + '.ac.id',
        reason: 'Domain kampus lain',
      });
      await assert.rejects(
        domains.update(env.adminA, env.campusA, other.id, {
          active: false,
          reason: 'Percobaan lintas kampus',
        }),
        (error) => statusOf(error) === 404,
      );
      await assert.rejects(
        domains.remove(env.adminA, env.campusA, other.id, {
          reason: 'Percobaan hapus lintas kampus',
        }),
        (error) => statusOf(error) === 404,
      );
      const stillThere = await pool.query(
        'select 1 from campus_email_domains where id = $1',
        [other.id],
      );
      assert.equal(stillThere.rowCount, 1);
    });

    it('refuses domain mutations without campus.access.manage', async () => {
      const env = await createEnv(pool);
      await assert.rejects(
        domains.create(env.viewerA, env.campusA, {
          domain: 'ditolak-' + env.tag + '.ac.id',
          reason: 'Tanpa izin',
        }),
        (error) => statusOf(error) === 403,
      );
      await assert.rejects(
        domains.list(env.adminB, env.campusA),
        (error) => statusOf(error) === 403,
      );
      const rows = await pool.query(
        'select 1 from campus_email_domains where domain = $1',
        ['ditolak-' + env.tag + '.ac.id'],
      );
      assert.equal(rows.rowCount, 0);
    });
  },
);
