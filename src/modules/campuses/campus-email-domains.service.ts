import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { uuidPattern } from '../notifications/outbox.service';

/** D7: response timestamps are the DB microsecond UTC strings themselves. */
const SQL_TS = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const DOMAIN_COLUMNS = [
  'd.id::text as id',
  'd.domain',
  'd.active',
  `${SQL_TS('d.verified_at')} as verified_at`,
  `${SQL_TS('d.created_at')} as created_at`,
  `${SQL_TS('d.updated_at')} as updated_at`,
].join(', ');

const DOMAIN_MAX_LENGTH = 253;
const LABEL_MAX_LENGTH = 63;
const DOMAIN_UNIQUE_CONSTRAINT = 'campus_email_domains_domain_unique';

export type CampusEmailDomainView = {
  id: string;
  domain: string;
  active: boolean;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type DomainRow = {
  id: string;
  domain: string;
  active: boolean;
  verified_at: string | null;
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
 * There is no automated DNS ownership check yet. The verify endpoint records
 * that a campus manager has confirmed ownership of the domain outside this
 * system; that manual attestation is the only thing it stores, and it is
 * always audited with the manager's reason.
 */
@Injectable()
export class CampusEmailDomainsService {
  constructor(
    private readonly database: DatabaseService,
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
        const inserted = await tx.query<DomainRow>(
          `insert into campus_email_domains
             (campus_id, domain, active, verified_at, created_at, updated_at)
           values ($1, $2, true, null, now(), now())
           returning id::text as id, domain, active,
                     ${SQL_TS('verified_at')} as verified_at,
                     ${SQL_TS('created_at')} as created_at,
                     ${SQL_TS('updated_at')} as updated_at`,
          [campusId, domain],
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
          returning id::text as id, domain, active,
                    ${SQL_TS('verified_at')} as verified_at,
                    ${SQL_TS('created_at')} as created_at,
                    ${SQL_TS('updated_at')} as updated_at`,
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
        returning id::text as id, domain, active,
                  ${SQL_TS('verified_at')} as verified_at,
                  ${SQL_TS('created_at')} as created_at,
                  ${SQL_TS('updated_at')} as updated_at`,
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

function toView(row: DomainRow): CampusEmailDomainView {
  return {
    id: row.id,
    domain: row.domain,
    active: row.active,
    verifiedAt: row.verified_at,
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
