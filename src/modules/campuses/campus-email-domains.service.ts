import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { uuidPattern } from '../notifications/outbox.service';
import {
  DNS_LOOKUP_TIMEOUT_MS,
  DNS_RESOLVER,
  withTimeout,
  type DnsResolver,
} from './dns-resolver';

/** D7: response timestamps are the DB microsecond UTC strings themselves. */
const SQL_TS = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const DOMAIN_COLUMNS = [
  'd.id::text as id',
  'd.domain',
  'd.active',
  'd.dns_token',
  `${SQL_TS('d.verified_at')} as verified_at`,
  `${SQL_TS('d.dns_verified_at')} as dns_verified_at`,
  `${SQL_TS('d.dns_checked_at')} as dns_checked_at`,
  'd.dns_last_error',
  `${SQL_TS('d.created_at')} as created_at`,
  `${SQL_TS('d.updated_at')} as updated_at`,
].join(', ');

/**
 * Same columns without the `d.` alias: INSERT ... RETURNING has no table alias,
 * so reusing the aliased list there fails with 42P01 (undefined table "d").
 */
const DOMAIN_COLUMNS_PLAIN = DOMAIN_COLUMNS.replaceAll('d.', '');

/** The record a campus must publish: TXT at `_antriin-challenge.<domain>`. */
const DNS_RECORD_PREFIX = '_antriin-challenge.';
const DNS_VALUE_PREFIX = 'antriin-verify=';
const DNS_ERROR_MAX_LENGTH = 300;

const DOMAIN_MAX_LENGTH = 253;
const LABEL_MAX_LENGTH = 63;
const DOMAIN_UNIQUE_CONSTRAINT = 'campus_email_domains_domain_unique';

export type CampusEmailDomainView = {
  id: string;
  domain: string;
  active: boolean;
  /** TXT value the campus publishes to prove ownership of the domain. */
  dnsToken: string;
  /** Manager attestation: what makes auth accept the domain. */
  verifiedAt: string | null;
  /** Proof from DNS that the campus controls the domain. */
  dnsVerifiedAt: string | null;
  dnsCheckedAt: string | null;
  dnsLastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type DomainRow = {
  id: string;
  domain: string;
  active: boolean;
  dns_token: string;
  verified_at: string | null;
  dns_verified_at: string | null;
  dns_checked_at: string | null;
  dns_last_error: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Campus email domain registry (REQUIREMENTS §3.2, docs/ACCESS.md).
 *
 * AuthService accepts a campus email only when the domain row is active AND
 * verified (src/modules/auth/auth.service.ts), so this slice must never
 * pre-verify anything it creates: a new domain is born active but UNVERIFIED.
 *
 * Two independent facts are recorded and they are never conflated:
 *  - `verified_at` is the manager's attestation (POST .../verify). It is the
 *    single switch auth reads, and it proves nothing about ownership.
 *  - `dns_verified_at` is proof of ownership from a TXT record the campus
 *    published (POST .../dns-verify). It does not by itself enable the domain;
 *    a manager still has to activate it.
 * Both are always audited with the actor and a reason.
 */
@Injectable()
export class CampusEmailDomainsService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list(
    actorUserId: string,
    campusId: string,
  ): Promise<CampusEmailDomainView[]> {
    assertUuid(actorUserId, 'user');
    assertUuid(campusId, 'campus');
    return this.withTransaction(async (tx) => {
      await this.requireManage(actorUserId, campusId, tx);
      const result = await tx.query<DomainRow>(
        `select ${DOMAIN_COLUMNS}
           from campus_email_domains d
          where d.campus_id = $1
          order by d.domain, d.id`,
        [campusId],
      );
      return result.rows.map(toView);
    });
  }

  /**
   * Registers a domain for a campus. The value is trimmed and lowercased
   * before validation because the database enforces lowercase domains; the
   * row starts active but with verified_at NULL, so auth keeps rejecting it
   * until a manager verifies it.
   */
  async create(
    actorUserId: string,
    campusId: string,
    input: { domain: string; reason: string },
  ): Promise<CampusEmailDomainView> {
    assertUuid(actorUserId, 'user');
    assertUuid(campusId, 'campus');
    const domain = normalizeDomain(input.domain);
    const reason = normalizeReason(input.reason);
    return this.withTransaction(async (tx) => {
      await this.requireManage(actorUserId, campusId, tx);
      let row: DomainRow;
      try {
        // The token is generated here, never supplied by the client: it is the
        // value the campus must publish in DNS, so the client must not be able
        // to choose a value it already controls elsewhere.
        const dnsToken = randomBytes(16).toString('hex');
        const inserted = await tx.query<DomainRow>(
          `insert into campus_email_domains
             (campus_id, domain, active, verified_at, dns_token, created_at, updated_at)
           values ($1, $2, true, null, $3, now(), now())
           returning ${DOMAIN_COLUMNS_PLAIN}`,
          [campusId, domain, dnsToken],
        );
        row = inserted.rows[0];
      } catch (error) {
        if (isUniqueViolation(error, DOMAIN_UNIQUE_CONSTRAINT))
          throw new ConflictException({
            code: 'EMAIL_DOMAIN_TAKEN',
            message: 'This email domain is already registered',
          });
        throw error;
      }
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'campus',
        scopeId: campusId,
        action: 'campus.email_domain_created',
        targetType: 'email_domain',
        targetId: row.id,
        reason,
        metadata: { domain: row.domain, active: row.active },
      });
      return toView(row);
    });
  }

  /**
   * Records the manager's manual ownership verification.
   *
   * IMPORTANT: this performs NO DNS lookup and no automated domain ownership
   * proof. It attests that the campus manager verified the domain outside the
   * system, which is why the action is always audited with a reason. Calling
   * it again on an already verified domain is idempotent: verified_at and
   * updated_at are returned unchanged.
   */
  async verify(
    actorUserId: string,
    campusId: string,
    domainId: string,
    input: { reason: string },
  ): Promise<CampusEmailDomainView> {
    assertUuid(actorUserId, 'user');
    assertUuid(campusId, 'campus');
    assertUuid(domainId, 'email domain');
    const reason = normalizeReason(input.reason);
    return this.withTransaction(async (tx) => {
      await this.requireManage(actorUserId, campusId, tx);
      const current = await this.lockDomain(tx, campusId, domainId);
      let row = current;
      if (current.verified_at === null) {
        const updated = await tx.query<DomainRow>(
          `update campus_email_domains d
              set verified_at = now(), updated_at = now()
            where d.id = $1 and d.campus_id = $2
          returning ${DOMAIN_COLUMNS}`,
          [domainId, campusId],
        );
        row = updated.rows[0];
      }
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'campus',
        scopeId: campusId,
        action: 'campus.email_domain_verified',
        targetType: 'email_domain',
        targetId: row.id,
        reason,
        metadata: {
          domain: row.domain,
          alreadyVerified: current.verified_at !== null,
        },
      });
      return toView(row);
    });
  }

  /**
   * Proves domain ownership by DNS, the check the attestation endpoint cannot
   * perform.
   *
   * The campus publishes a TXT record at `_antriin-challenge.<domain>` whose
   * value is `antriin-verify=<dnsToken>`, and this method reads it. A match
   * stamps `dns_verified_at`; a miss records the reason in `dns_last_error`
   * and answers 409 so the client can show what was looked for.
   *
   * Deliberately does NOT set `verified_at`: that column is the switch auth
   * reads to accept the domain for reviewer eligibility, and a DNS proof and a
   * manager's decision to activate are separate facts. A campus that proved
   * ownership still calls the attestation endpoint to turn the domain on. This
   * keeps a DNS glitch from silently changing who may post reviews.
   */
  async dnsVerify(
    actorUserId: string,
    campusId: string,
    domainId: string,
    input: { reason: string },
  ): Promise<CampusEmailDomainView> {
    assertUuid(actorUserId, 'user');
    assertUuid(campusId, 'campus');
    assertUuid(domainId, 'email domain');
    const reason = normalizeReason(input.reason);

    const current = await this.withTransaction(async (tx) => {
      await this.requireManage(actorUserId, campusId, tx);
      return this.lockDomain(tx, campusId, domainId);
    });

    const recordName = `${DNS_RECORD_PREFIX}${current.domain}`;
    const expected = `${DNS_VALUE_PREFIX}${current.dns_token}`;
    let matched = false;
    let failure: string | null = null;
    try {
      const records = await withTimeout(
        this.dns.resolveTxt(recordName),
        DNS_LOOKUP_TIMEOUT_MS,
      );
      // TXT answers arrive split into chunks; a single value may span several.
      matched = records.some((chunks) => chunks.join('') === expected);
      if (!matched) {
        failure =
          records.length === 0
            ? `No TXT record found at ${recordName}`
            : `TXT record at ${recordName} does not contain the expected value`;
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      // A missing record is a legitimate "not yet published" answer; anything
      // else means the lookup itself did not happen, and claiming failure
      // would be a claim we cannot make.
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        failure = `No TXT record found at ${recordName}`;
      } else {
        await this.withTransaction(async (tx) => {
          await this.requireManage(actorUserId, campusId, tx);
          await tx.query(
            `update campus_email_domains
                set dns_checked_at = now(), dns_last_error = $3, updated_at = now()
              where id = $1 and campus_id = $2`,
            [domainId, campusId, truncate(errorMessage(error))],
          );
        });
        throw new ServiceUnavailableException({
          code: 'EMAIL_DOMAIN_DNS_UNAVAILABLE',
          message: 'The DNS lookup could not be completed; try again later',
        });
      }
    }

    // The result is committed BEFORE any error is raised. Throwing inside this
    // transaction would roll back the `dns_checked_at`/`dns_last_error` write,
    // and a failed check that leaves no trace is exactly the situation the
    // columns exist to prevent: the manager would see "409" with no record of
    // when the lookup ran or what DNS actually answered.
    const { view, auditAction } = await this.withTransaction(async (tx) => {
      await this.requireManage(actorUserId, campusId, tx);
      const updated = await tx.query<DomainRow>(
        `update campus_email_domains d
            set dns_verified_at = case when $3::boolean then now() else dns_verified_at end,
                dns_checked_at = now(),
                dns_last_error = $4,
                updated_at = now()
          where d.id = $1 and d.campus_id = $2
        returning ${DOMAIN_COLUMNS}`,
        [domainId, campusId, matched, matched ? null : truncate(failure)],
      );
      const row = updated.rows[0];
      const action = matched
        ? 'campus.email_domain_dns_verified'
        : 'campus.email_domain_dns_failed';
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'campus',
        scopeId: campusId,
        action,
        targetType: 'email_domain',
        targetId: row.id,
        reason,
        metadata: {
          domain: row.domain,
          recordName,
          matched,
          checkedAt: row.dns_checked_at,
        },
      });
      return { view: toView(row), auditAction: action };
    });

    if (!matched) {
      throw new ConflictException({
        code: 'EMAIL_DOMAIN_DNS_MISMATCH',
        message:
          failure ??
          `Publish a TXT record at ${recordName} with value ${expected}`,
        recordName,
        expectedValue: expected,
        auditAction,
      });
    }
    return view;
  }

  /**
   * Activates or deactivates a domain. Deactivating immediately stops auth
   * from accepting it (auth requires active = true).
   */
  async update(
    actorUserId: string,
    campusId: string,
    domainId: string,
    input: { active?: boolean; reason: string },
  ): Promise<CampusEmailDomainView> {
    assertUuid(actorUserId, 'user');
    assertUuid(campusId, 'campus');
    assertUuid(domainId, 'email domain');
    if (typeof input.active !== 'boolean')
      throw new BadRequestException({
        code: 'EMAIL_DOMAIN_UPDATE_EMPTY',
        message: 'active is required',
      });
    const active = input.active;
    const reason = normalizeReason(input.reason);
    return this.withTransaction(async (tx) => {
      await this.requireManage(actorUserId, campusId, tx);
      const current = await this.lockDomain(tx, campusId, domainId);
      const updated = await tx.query<DomainRow>(
        `update campus_email_domains d
            set active = $3, updated_at = now()
          where d.id = $1 and d.campus_id = $2
        returning ${DOMAIN_COLUMNS}`,
        [domainId, campusId, active],
      );
      const row = updated.rows[0];
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'campus',
        scopeId: campusId,
        action: 'campus.email_domain_updated',
        targetType: 'email_domain',
        targetId: row.id,
        reason,
        metadata: {
          domain: row.domain,
          active: row.active,
          previousActive: current.active,
        },
      });
      return toView(row);
    });
  }

  /**
   * Hard-deletes a domain. The audit row keeps the domain name and the
   * manager's reason, so the registry change stays reconstructable after the
   * row is gone.
   */
  async remove(
    actorUserId: string,
    campusId: string,
    domainId: string,
    input: { reason: string },
  ): Promise<void> {
    assertUuid(actorUserId, 'user');
    assertUuid(campusId, 'campus');
    assertUuid(domainId, 'email domain');
    const reason = normalizeReason(input.reason);
    await this.withTransaction(async (tx) => {
      await this.requireManage(actorUserId, campusId, tx);
      const current = await this.lockDomain(tx, campusId, domainId);
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'campus',
        scopeId: campusId,
        action: 'campus.email_domain_deleted',
        targetType: 'email_domain',
        targetId: current.id,
        reason,
        metadata: {
          domain: current.domain,
          active: current.active,
          verifiedAt: current.verified_at,
        },
      });
      await tx.query(
        'delete from campus_email_domains where id = $1 and campus_id = $2',
        [domainId, campusId],
      );
    });
  }

  private async requireManage(
    actorUserId: string,
    campusId: string,
    tx: PoolClient,
  ): Promise<void> {
    await this.access.requireCampus(
      actorUserId,
      campusId,
      'campus.access.manage',
      tx,
    );
  }

  /** Locks one domain of THIS campus; a domain of another campus is a 404. */
  private async lockDomain(
    tx: PoolClient,
    campusId: string,
    domainId: string,
  ): Promise<DomainRow> {
    const result = await tx.query<DomainRow>(
      `select ${DOMAIN_COLUMNS}
         from campus_email_domains d
        where d.id = $1 and d.campus_id = $2
        for update`,
      [domainId, campusId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Email domain was not found');
    return row;
  }

  private async withTransaction<T>(
    operation: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    const connection = await this.database.pool.connect();
    try {
      await connection.query('begin');
      const result = await operation(connection);
      await connection.query('commit');
      return result;
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'DNS lookup failed';
}

function truncate(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= DNS_ERROR_MAX_LENGTH
    ? value
    : value.slice(0, DNS_ERROR_MAX_LENGTH);
}

function toView(row: DomainRow): CampusEmailDomainView {
  return {
    id: row.id,
    domain: row.domain,
    active: row.active,
    dnsToken: row.dns_token,
    verifiedAt: row.verified_at,
    dnsVerifiedAt: row.dns_verified_at,
    dnsCheckedAt: row.dns_checked_at,
    dnsLastError: row.dns_last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Trims and lowercases the submitted domain, then enforces hostname shape:
 * letters, digits, dots and hyphens only, at least one dot, every label 1..63
 * characters without a leading/trailing hyphen, and 253 characters at most.
 */
function normalizeDomain(value: string): string {
  const domain = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isValidHostname(domain))
    throw new BadRequestException({
      code: 'EMAIL_DOMAIN_INVALID',
      message: 'Enter a valid email domain (for example student.ac.id)',
    });
  return domain;
}

function isValidHostname(domain: string): boolean {
  if (!domain || domain.length > DOMAIN_MAX_LENGTH) return false;
  if (!domain.includes('.')) return false;
  return domain
    .split('.')
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= LABEL_MAX_LENGTH &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    );
}

function normalizeReason(value: string): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason || reason.length > 500)
    throw new BadRequestException({
      code: 'EMAIL_DOMAIN_REASON_INVALID',
      message: 'A reason of 1 to 500 characters is required',
    });
  return reason;
}

function assertUuid(value: string, name: string): void {
  if (!uuidPattern.test(value ?? ''))
    throw new BadRequestException('Invalid ' + name + ' id');
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505' &&
    (error as { constraint?: string }).constraint === constraint
  );
}
