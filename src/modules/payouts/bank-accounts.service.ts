import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { uuidPattern } from '../notifications/outbox.service';
import {
  bankAccountKeys,
  encryptAccountNumber,
  hashAccountNumber,
  maskAccountNumber,
  normalizeAccountNumber,
} from './bank-account.crypto';
import {
  BANK_ACCOUNT_ERROR_CODES,
  BANK_CODES,
  MAX_ACCOUNT_HOLDER_LENGTH,
  PAYOUT_AUDIT_ACTIONS,
} from './payouts.constants';

/** D7: response timestamps are the DB microsecond UTC strings themselves. */
const SQL_TS = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type BankAccountView = {
  id: string;
  tenantId: string;
  bankCode: string;
  accountNumberMasked: string;
  accountHolderName: string;
  verificationStatus: 'pending' | 'verified' | 'rejected';
  verifiedAt: string | null;
  status: 'active' | 'disabled';
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type BankAccountRow = {
  id: string;
  tenant_id: string;
  bank_code: string;
  account_number_masked: string;
  account_holder_name: string;
  verification_status: 'pending' | 'verified' | 'rejected';
  verified_at: string | null;
  status: 'active' | 'disabled';
  is_default: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};

const BANK_ACCOUNT_COLUMNS = [
  'id::text',
  'tenant_id::text',
  'bank_code',
  'account_number_masked',
  'account_holder_name',
  'verification_status',
  `${SQL_TS('verified_at')} as verified_at`,
  'status',
  'is_default',
  'version',
  `${SQL_TS('created_at')} as created_at`,
  `${SQL_TS('updated_at')} as updated_at`,
].join(', ');

export type CreateBankAccountInput = {
  bankCode: string;
  accountNumber: string;
  accountHolderName: string;
  isDefault?: boolean;
};

/**
 * Tenant payout accounts.
 *
 * - Only the verified owner reaches these methods: AccessService rejects every
 *   non-owner role for tenant.bank_account.manage, so kitchen/pickup staff get
 *   403 (REQUIREMENTS section 3.8.4).
 * - A new account is born 'pending' with verification_status 'pending'.
 * - Changing an account creates a NEW row and DISABLES the previous one, so
 *   history stays auditable and an existing payout keeps its destination
 *   snapshot (REQUIREMENTS section 3.8.5).
 * - The verification endpoint is disabled by decision Q4 (503); accounts can
 *   only become 'verified' through the controlled, service-only path
 *   markVerified, which is never exposed over HTTP.
 * - The ciphertext, the dedupe hash and the full number never leave this
 *   service: every response uses the masked value only.
 */
@Injectable()
export class BankAccountsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async listBankAccounts(
    actorUserId: string,
    tenantId: string,
    options: { status?: 'active' | 'disabled' } = {},
  ): Promise<BankAccountView[]> {
    this.assertUuid(actorUserId, 'user id');
    this.assertUuid(tenantId, 'tenant id');
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      'tenant.bank_account.manage',
    );
    const values: unknown[] = [tenantId];
    let where = 'tenant_id = $1';
    if (options.status) {
      values.push(options.status);
      where += ' and status = $2';
    }
    const result = await this.database.pool.query<BankAccountRow>(
      `select ${BANK_ACCOUNT_COLUMNS} from bank_accounts
        where ${where}
        order by status asc, created_at desc, id desc`,
      values,
    );
    return result.rows.map((row) => toView(row));
  }

  async createBankAccount(
    actorUserId: string,
    tenantId: string,
    input: CreateBankAccountInput,
  ): Promise<BankAccountView> {
    this.assertUuid(actorUserId, 'user id');
    this.assertUuid(tenantId, 'tenant id');

    return this.withTransaction(undefined, async (tx) => {
      // F8: authorization runs BEFORE normalization/encryption so a non-member
      // receives 403 instead of a validation error (400) or a key error (503).
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.bank_account.manage',
        tx,
      );
      const details = this.normalizeInput(input);
      const keys = bankAccountKeys(this.config);
      const existingDefault = await tx.query<{ id: string }>(
        `select id::text from bank_accounts
          where tenant_id = $1 and status = 'active' and is_default`,
        [tenantId],
      );
      const isDefault =
        input.isDefault === true || existingDefault.rows.length === 0;
      if (input.isDefault === true) await this.clearDefault(tx, tenantId);
      const id = await this.insertAccount(tx, {
        tenantId,
        ownerUserId: actorUserId,
        createdByUserId: actorUserId,
        isDefault,
        details,
        keys,
      });
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: PAYOUT_AUDIT_ACTIONS.bankAccountCreated,
        targetType: 'bank_account',
        targetId: id,
        reason: 'Tenant owner registered a payout bank account',
        metadata: {
          bankCode: details.bankCode,
          accountNumberMasked: details.masked,
          isDefault,
        },
      });
      return this.loadView(tx, tenantId, id);
    });
  }

  /**
   * Replace an account: the old row is disabled (never deleted) and a new
   * pending row is created. Existing payouts keep their snapshot because they
   * store bank_code/masked/holder at request time.
   */
  async replaceBankAccount(
    actorUserId: string,
    tenantId: string,
    accountId: string,
    input: CreateBankAccountInput,
  ): Promise<BankAccountView> {
    this.assertUuid(actorUserId, 'user id');
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(accountId, 'bank account id');

    return this.withTransaction(undefined, async (tx) => {
      // F8: same rule as create - authorize first, then touch crypto material.
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.bank_account.manage',
        tx,
      );
      const details = this.normalizeInput(input);
      const keys = bankAccountKeys(this.config);
      const previous = await tx.query<{
        id: string;
        is_default: boolean;
        status: string;
      }>(
        `select id::text, is_default, status from bank_accounts
          where id = $1 and tenant_id = $2 for update`,
        [accountId, tenantId],
      );
      const current = previous.rows[0];
      if (!current) throw new NotFoundException('Bank account was not found');
      if (current.status !== 'active')
        throw new ConflictException({
          code: BANK_ACCOUNT_ERROR_CODES.notActive,
          message: 'Only an active bank account can be replaced',
        });
      // Disable first: the partial unique index on the active number must be
      // free before the replacement row is inserted (same-number replace).
      await tx.query(
        `update bank_accounts
            set status = 'disabled', is_default = false,
                version = version + 1, updated_at = now()
          where id = $1`,
        [accountId],
      );
      if (current.is_default) await this.clearDefault(tx, tenantId);
      const id = await this.insertAccount(tx, {
        tenantId,
        ownerUserId: actorUserId,
        createdByUserId: actorUserId,
        isDefault: current.is_default,
        details,
        keys,
      });
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: PAYOUT_AUDIT_ACTIONS.bankAccountReplaced,
        targetType: 'bank_account',
        targetId: id,
        reason: 'Tenant owner replaced the payout bank account',
        metadata: {
          previousAccountId: accountId,
          bankCode: details.bankCode,
          accountNumberMasked: details.masked,
        },
      });
      return this.loadView(tx, tenantId, id);
    });
  }

  /** Disable (never delete) an account; a replay is idempotent. */
  async disableBankAccount(
    actorUserId: string,
    tenantId: string,
    accountId: string,
  ): Promise<BankAccountView> {
    this.assertUuid(actorUserId, 'user id');
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(accountId, 'bank account id');
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.bank_account.manage',
        tx,
      );
      const locked = await tx.query<{ status: string }>(
        `select status from bank_accounts
          where id = $1 and tenant_id = $2 for update`,
        [accountId, tenantId],
      );
      const row = locked.rows[0];
      if (!row) throw new NotFoundException('Bank account was not found');
      if (row.status === 'disabled')
        return this.loadView(tx, tenantId, accountId);
      await tx.query(
        `update bank_accounts
            set status = 'disabled', is_default = false,
                version = version + 1, updated_at = now()
          where id = $1`,
        [accountId],
      );
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: PAYOUT_AUDIT_ACTIONS.bankAccountDisabled,
        targetType: 'bank_account',
        targetId: accountId,
        reason: 'Tenant owner disabled the payout bank account',
        metadata: {},
      });
      return this.loadView(tx, tenantId, accountId);
    });
  }

  /**
   * Q4: the verification mechanism (provider name match vs manual campus
   * review) is NOT decided, so this endpoint stays off. Authorization runs
   * first, so staff still receive 403 instead of a misleading 503.
   */
  async requestVerification(
    actorUserId: string,
    tenantId: string,
    accountId: string,
  ): Promise<never> {
    this.assertUuid(actorUserId, 'user id');
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(accountId, 'bank account id');
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      'tenant.bank_account.manage',
    );
    throw new ServiceUnavailableException({
      code: BANK_ACCOUNT_ERROR_CODES.verificationDisabled,
      message:
        'Bank account verification is not enabled; a controlled verification path must be decided first',
    });
  }

  /**
   * Controlled, service-only verification path (D18 Q4). Deliberately not
   * exposed over HTTP: an operator/test harness calls it inside an explicit
   * transaction. It records who verified the account, by which method, and
   * writes the immutable audit row.
   *
   * F8: only an ACTIVE account may become verified. Verifying a disabled row
   * would leave verification status and account status contradicting each
   * other (and could make a payout target look proven while it is off), so a
   * disabled account is a stable 409 BANK_ACCOUNT_NOT_ACTIVE.
   */
  async markVerified(
    client: PoolClient,
    tenantId: string,
    accountId: string,
    input: { verifiedByUserId: string; method: 'manual_campus' | 'provider' },
  ): Promise<BankAccountView> {
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(accountId, 'bank account id');
    this.assertUuid(input.verifiedByUserId, 'verifier id');
    const locked = await client.query<{
      verification_status: string;
      status: string;
    }>(
      `select verification_status, status from bank_accounts
        where id = $1 and tenant_id = $2 for update`,
      [accountId, tenantId],
    );
    const row = locked.rows[0];
    if (!row) throw new NotFoundException('Bank account was not found');
    if (row.status !== 'active')
      throw new ConflictException({
        code: BANK_ACCOUNT_ERROR_CODES.notActive,
        message: 'Only an active bank account can be verified',
      });
    if (row.verification_status !== 'verified') {
      await client.query(
        `update bank_accounts
            set verification_status = 'verified',
                verified_at = now(),
                verified_by_user_id = $2,
                verification_method = $3,
                version = version + 1,
                updated_at = now()
          where id = $1`,
        [accountId, input.verifiedByUserId, input.method],
      );
      await this.audit.append(client, {
        actor: { userId: input.verifiedByUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: PAYOUT_AUDIT_ACTIONS.bankAccountVerified,
        targetType: 'bank_account',
        targetId: accountId,
        reason: 'Payout bank account verified through the controlled path',
        metadata: { method: input.method },
      });
    }
    return this.loadView(client, tenantId, accountId);
  }

  /** Masked view of one account (never exposes ciphertext/hash). */
  async loadView(
    client: Pick<PoolClient, 'query'>,
    tenantId: string,
    accountId: string,
  ): Promise<BankAccountView> {
    const result = await client.query<BankAccountRow>(
      `select ${BANK_ACCOUNT_COLUMNS} from bank_accounts
        where id = $1 and tenant_id = $2`,
      [accountId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Bank account was not found');
    return toView(row);
  }

  private normalizeInput(input: CreateBankAccountInput): {
    bankCode: string;
    normalized: string;
    masked: string;
    accountHolderName: string;
  } {
    const bankCode = (input.bankCode ?? '').trim().toUpperCase();
    if (!(BANK_CODES as readonly string[]).includes(bankCode))
      throw new BadRequestException({
        code: BANK_ACCOUNT_ERROR_CODES.bankUnsupported,
        message: 'bankCode must be one of: ' + BANK_CODES.join(', '),
      });
    const accountHolderName = (input.accountHolderName ?? '').trim();
    if (
      !accountHolderName ||
      accountHolderName.length > MAX_ACCOUNT_HOLDER_LENGTH
    )
      throw new BadRequestException({
        code: 'BANK_ACCOUNT_HOLDER_INVALID',
        message: 'accountHolderName must be 1 to 200 characters',
      });
    const normalized = normalizeAccountNumber(input.accountNumber);
    return {
      bankCode,
      normalized,
      masked: maskAccountNumber(normalized),
      accountHolderName,
    };
  }

  private async clearDefault(tx: PoolClient, tenantId: string): Promise<void> {
    await tx.query(
      `update bank_accounts
          set is_default = false, version = version + 1, updated_at = now()
        where tenant_id = $1 and is_default`,
      [tenantId],
    );
  }

  private async insertAccount(
    tx: PoolClient,
    input: {
      tenantId: string;
      ownerUserId: string;
      createdByUserId: string;
      isDefault: boolean;
      details: {
        bankCode: string;
        normalized: string;
        masked: string;
        accountHolderName: string;
      };
      keys: { encryptionKey: Buffer; dedupeKey: Buffer };
    },
  ): Promise<string> {
    const ciphertext = encryptAccountNumber(
      input.keys.encryptionKey,
      input.details.normalized,
    );
    const hash = hashAccountNumber(
      input.keys.dedupeKey,
      input.details.normalized,
    );
    try {
      const inserted = await tx.query<{ id: string }>(
        `insert into bank_accounts
           (tenant_id, owner_user_id, bank_code, account_holder_name,
            account_number_ciphertext, account_number_hash,
            account_number_masked, verification_status, status, is_default,
            created_by_user_id, version, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'pending', 'active', $8, $2, 1,
                 now(), now())
         returning id::text`,
        [
          input.tenantId,
          input.ownerUserId,
          input.details.bankCode,
          input.details.accountHolderName,
          ciphertext,
          hash,
          input.details.masked,
          input.isDefault,
        ],
      );
      return inserted.rows[0].id;
    } catch (error) {
      if (isUniqueViolation(error, 'bank_accounts_tenant_number_uq'))
        throw new ConflictException({
          code: BANK_ACCOUNT_ERROR_CODES.alreadyExists,
          message: 'This bank account is already registered and active',
        });
      if (isUniqueViolation(error, 'bank_accounts_one_default_uq'))
        throw new ConflictException({
          code: BANK_ACCOUNT_ERROR_CODES.alreadyExists,
          message: 'Another default bank account is already active',
        });
      throw error;
    }
  }

  private assertUuid(value: string, field: string): void {
    if (!uuidPattern.test(value ?? ''))
      throw new BadRequestException('Invalid ' + field);
  }

  private async withTransaction<T>(
    client: PoolClient | undefined,
    operation: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (client) return operation(client);
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

function toView(row: BankAccountRow): BankAccountView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    bankCode: row.bank_code,
    accountNumberMasked: row.account_number_masked,
    accountHolderName: row.account_holder_name,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    status: row.status,
    isDefault: row.is_default,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === '23505' &&
    (error as { constraint?: string }).constraint === constraint
  );
}
