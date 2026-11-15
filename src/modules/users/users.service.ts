import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { TENANT_PERMISSIONS } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { WalletService } from '../wallet/wallet.service';

export const DEVICE_PLATFORMS = ['ios', 'android', 'web'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * Defaults mirror the schema: a user who never opened the notification screen
 * keeps receiving order/review/case updates and has no push enabled. Reading
 * these defaults must not create the row (REQUIREMENTS §3.1.5).
 */
export const DEFAULT_NOTIFICATION_PREFERENCES = {
  orderUpdates: true,
  reviewReplies: true,
  caseUpdates: true,
  pushEnabled: false,
} as const;

const MAX_DISPLAY_NAME = 200;
const MAX_DEVICE_LABEL = 100;
const MIN_TOKEN_LENGTH = 8;
const MAX_TOKEN_LENGTH = 512;
const WALLET_CURRENCY = 'IDR';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MePhone = {
  /** Last four digits only, for example +62812****0001. Never the full number. */
  masked: string | null;
  verified: boolean;
};

export type MeCampusEmail = {
  verified: boolean;
  campusId: string | null;
  campusName: string | null;
};

export type MeWallet = { currency: 'IDR'; availableMinor: string } | null;

export type MeTenant = {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  campusId: string;
  campusName: string;
  role: string;
  permissions: string[];
};

export type MeCampus = {
  campusId: string;
  campusName: string;
  permissions: string[];
};

export type MeProfile = {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  phone: MePhone;
  campusEmail: MeCampusEmail;
  wallet: MeWallet;
  tenants: MeTenant[];
  campuses: MeCampus[];
};

export type NotificationPreferences = {
  orderUpdates: boolean;
  reviewReplies: boolean;
  caseUpdates: boolean;
  pushEnabled: boolean;
  /** Null while no row exists and the defaults above are being served. */
  updatedAt: string | null;
};

export type DeviceView = {
  id: string;
  platform: DevicePlatform;
  label: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

/** Body of POST /me/deletion; the reason is optional and only recorded. */
export type CloseAccountInput = { reason?: string };

export type AccountClosureView = {
  status: 'closed';
  /** Pseudonymised display name the account now carries. */
  displayName: string;
  closedAt: string;
  requestId: string;
  /** Sessions revoked by *this* call; 0 on an idempotent replay. */
  revokedSessions: number;
  /** The stored account_deletion_requests.retained_summary. */
  retained: Record<string, unknown>;
};

export type AccountExport = {
  exportedAt: string;
  profile: {
    id: string;
    displayName: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    phone: MePhone;
    campusEmail: MeCampusEmail;
  };
  orders: {
    total: number;
    byStatus: { status: string; count: number }[];
    totalsByCurrency: { currency: string; totalMinor: string }[];
  };
  wallet: { currency: string; availableMinor: string }[];
  transactions: {
    count: number;
    truncated: boolean;
    items: {
      id: string;
      currency: string;
      direction: 'debit' | 'credit';
      amountMinor: string;
      reason: string;
      createdAt: string;
    }[];
  };
  reviews: {
    count: number;
    items: {
      id: string;
      orderId: string;
      tenantId: string;
      tenantName: string;
      rating: number;
      body: string;
      status: string;
      createdAt: string;
      deletedAt: string | null;
    }[];
  };
  notifications: { count: number; unread: number };
};

type ClosureRow = {
  id: string;
  requested_at: string;
  completed_at: string | null;
  retained_summary: Record<string, unknown>;
};

export type UpdateProfileInput = { displayName: string };

export type UpdatePreferencesInput = {
  orderUpdates?: boolean;
  reviewReplies?: boolean;
  caseUpdates?: boolean;
  pushEnabled?: boolean;
};

export type RegisterDeviceInput = {
  platform: string;
  token: string;
  label?: string;
};

type UserRow = {
  id: string;
  display_name: string;
  status: string;
  phone_e164: string | null;
  phone_verified: boolean;
  created_at: string;
  updated_at: string;
};

type TenantRow = {
  tenant_id: string;
  tenant_name: string;
  tenant_status: string;
  campus_id: string;
  campus_name: string;
  role: string;
  permissions: string[];
};

type CampusRow = {
  campus_id: string;
  campus_name: string;
  permissions: string[];
};

type PreferenceRow = {
  order_updates: boolean;
  review_replies: boolean;
  case_updates: boolean;
  push_enabled: boolean;
  updated_at: string;
};

type DeviceRow = {
  id: string;
  platform: DevicePlatform;
  label: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

/**
 * Response timestamps are the DB microsecond UTC strings themselves (D7):
 * re-serializing through Date/toISOString truncates to milliseconds.
 */
function microUtc(column: string, alias: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${alias}`;
}

const DEVICE_COLUMNS = [
  'id::text',
  'platform',
  'label',
  microUtc('last_seen_at', 'last_seen_at'),
  microUtc('created_at', 'created_at'),
  microUtc('updated_at', 'updated_at'),
].join(', ');

/** Export caps: a whole-account export stays a bounded document. */
export const EXPORT_TRANSACTION_LIMIT = 500;
export const EXPORT_REVIEW_LIMIT = 500;
const MAX_CLOSURE_REASON = 500;

const CLOSURE_COLUMNS = [
  'id::text',
  microUtc('requested_at', 'requested_at'),
  microUtc('completed_at', 'completed_at'),
  'retained_summary',
].join(', ');

/**
 * The authenticated account's own profile (REQUIREMENTS §3.1). The actor is
 * always the session user, so no endpoint accepts a user id from the client and
 * every list below is derived from that user's own memberships.
 *
 * The phone number is masked and the raw encrypted identity destination is
 * never read: only users.phone_e164 is projected, and only its last four
 * digits survive.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
  ) {}

  async getProfile(userId: string): Promise<MeProfile> {
    this.assertUuid(userId, 'user');
    return this.withTransaction(undefined, (tx) =>
      this.readProfile(tx, userId),
    );
  }

  /** Renames the account owner's profile and returns the whole profile back. */
  async updateProfile(
    userId: string,
    input: UpdateProfileInput,
  ): Promise<MeProfile> {
    this.assertUuid(userId, 'user');
    const displayName =
      typeof input?.displayName === 'string' ? input.displayName.trim() : '';
    if (!displayName || displayName.length > MAX_DISPLAY_NAME)
      throw new BadRequestException({
        code: 'PROFILE_DISPLAY_NAME_INVALID',
        message: 'displayName must be 1 to 200 characters after trimming',
      });
    return this.withTransaction(undefined, async (tx) => {
      const updated = await tx.query(
        `update users set display_name = $2, updated_at = now()
          where id = $1
          returning id::text`,
        [userId, displayName],
      );
      if (!updated.rows[0])
        throw new NotFoundException('User account was not found');
      await this.audit.append(tx, {
        actor: { userId },
        scopeType: 'user',
        scopeId: userId,
        action: 'user.profile.updated',
        targetType: 'user',
        targetId: userId,
        reason: 'Account owner updated the profile display name',
        metadata: { field: 'displayName' },
      });
      return this.readProfile(tx, userId);
    });
  }

  /**
   * Serves the stored switches, or the documented defaults when the user never
   * saved any. Reading never writes a row.
   */
  async getNotificationPreferences(
    userId: string,
  ): Promise<NotificationPreferences> {
    this.assertUuid(userId, 'user');
    const result = await this.database.pool.query<PreferenceRow>(
      `select order_updates, review_replies, case_updates, push_enabled,
              ${microUtc('updated_at', 'updated_at')}
         from notification_preferences
        where user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row ? toPreferences(row) : defaultPreferences();
  }

  /**
   * Partial update in one upsert: a missing field keeps its stored value, and a
   * brand new row starts from the schema defaults.
   */
  async updateNotificationPreferences(
    userId: string,
    input: UpdatePreferencesInput,
  ): Promise<NotificationPreferences> {
    this.assertUuid(userId, 'user');
    const changes = normalizePreferenceChanges(input);
    return this.withTransaction(undefined, async (tx) => {
      const result = await tx.query<PreferenceRow>(
        `insert into notification_preferences
           (user_id, order_updates, review_replies, case_updates, push_enabled,
            created_at, updated_at)
         values ($1, coalesce($2::boolean, true), coalesce($3::boolean, true),
                 coalesce($4::boolean, true), coalesce($5::boolean, false),
                 now(), now())
         on conflict (user_id) do update
            set order_updates = coalesce($2::boolean, notification_preferences.order_updates),
                review_replies = coalesce($3::boolean, notification_preferences.review_replies),
                case_updates = coalesce($4::boolean, notification_preferences.case_updates),
                push_enabled = coalesce($5::boolean, notification_preferences.push_enabled),
                updated_at = now()
         returning order_updates, review_replies, case_updates, push_enabled,
                   ${microUtc('updated_at', 'updated_at')}`,
        [
          userId,
          changes.orderUpdates,
          changes.reviewReplies,
          changes.caseUpdates,
          changes.pushEnabled,
        ],
      );
      return toPreferences(result.rows[0]);
    });
  }

  /** Active (non-revoked) devices of the caller, most recently seen first. */
  async listDevices(userId: string): Promise<DeviceView[]> {
    this.assertUuid(userId, 'user');
    const result = await this.database.pool.query<DeviceRow>(
      `select ${DEVICE_COLUMNS}
         from user_devices
        where user_id = $1 and revoked_at is null
        order by last_seen_at desc, id desc`,
      [userId],
    );
    return result.rows.map(toDeviceView);
  }

  /**
   * Registers a push token for the caller. Only the SHA-256 of the token is
   * stored, so the same token registered again refreshes that device instead of
   * duplicating it; a token already owned by another account is refused.
   */
  async registerDevice(
    userId: string,
    input: RegisterDeviceInput,
  ): Promise<DeviceView> {
    this.assertUuid(userId, 'user');
    const platform = normalizePlatform(input?.platform);
    const token = normalizeToken(input?.token);
    const label = normalizeLabel(input?.label);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return this.withTransaction(undefined, async (tx) => {
      // The conditional upsert keeps a token owned by another account
      // untouched; it returns no row, which the ownership read then explains.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const upserted = await tx.query<DeviceRow>(
          `insert into user_devices
             (user_id, platform, token_hash, label, last_seen_at, revoked_at,
              created_at, updated_at)
           values ($1, $2, $3, coalesce($4, ''), now(), null, now(), now())
           on conflict (token_hash) do update
              set platform = excluded.platform,
                  label = coalesce($4, user_devices.label),
                  last_seen_at = now(),
                  revoked_at = null,
                  updated_at = now()
            where user_devices.user_id = $1
           returning ${DEVICE_COLUMNS}`,
          [userId, platform, tokenHash, label],
        );
        const row = upserted.rows[0];
        if (row) return toDeviceView(row);
        const owner = await tx.query<{ user_id: string }>(
          'select user_id::text from user_devices where token_hash = $1',
          [tokenHash],
        );
        if (owner.rows[0] && owner.rows[0].user_id !== userId)
          throw new ConflictException({
            code: 'DEVICE_TOKEN_CONFLICT',
            message: 'This device token is registered to another account',
          });
      }
      // The row disappeared between the two statements; the client may retry.
      throw new ConflictException({
        code: 'DEVICE_REGISTRATION_CONFLICT',
        message: 'The device registration could not be completed',
      });
    });
  }

  /** Soft-revokes one of the caller's own devices; anything else is a 404. */
  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    this.assertUuid(userId, 'user');
    this.assertUuid(deviceId, 'device');
    return this.withTransaction(undefined, async (tx) => {
      const revoked = await tx.query<{ id: string }>(
        `update user_devices
            set revoked_at = now(), updated_at = now()
          where id = $1 and user_id = $2 and revoked_at is null
          returning id::text`,
        [deviceId, userId],
      );
      if (!revoked.rows[0]) throw new NotFoundException('Device was not found');
      await this.audit.append(tx, {
        actor: { userId },
        scopeType: 'user',
        scopeId: userId,
        action: 'user.device.revoked',
        targetType: 'user_device',
        targetId: deviceId,
        reason: 'Account owner revoked a notification device',
      });
    });
  }

  /**
   * Self-service account closure (REQUIREMENTS §7.6 retention).
   *
   * Nothing is deleted: financial and audit rows must survive for
   * reconciliation, so the account is marked closed, its display name is
   * pseudonymised, every session and push device is revoked in the same
   * transaction, and a durable account_deletion_requests row records what was
   * kept and why. Calling it twice is safe: the second call returns the record
   * written by the first and revokes nothing.
   */
  async closeAccount(
    userId: string,
    input: CloseAccountInput = {},
  ): Promise<AccountClosureView> {
    this.assertUuid(userId, 'user');
    const reason = normalizeClosureReason(input?.reason);
    return this.withTransaction(undefined, async (tx) => {
      const current = await tx.query<{
        id: string;
        status: string;
        display_name: string;
      }>(
        'select id::text, status, display_name from users where id = $1 for update',
        [userId],
      );
      const user = current.rows[0];
      if (!user) throw new NotFoundException('User account was not found');

      let displayName = user.display_name;
      let revokedSessions = 0;
      let revokedDevices = 0;
      if (user.status !== 'closed') {
        displayName = pseudonymFor(userId);
        await tx.query(
          `update users
              set status = 'closed', display_name = $2, updated_at = now()
            where id = $1`,
          [userId, displayName],
        );
        // A closed account must not keep a usable bearer token or a push
        // destination; the auth query already rejects a closed user, this makes
        // the revocation explicit and immediate for every device.
        const sessions = await tx.query(
          `update auth_sessions
              set revoked_at = now(), updated_at = now()
            where user_id = $1 and revoked_at is null`,
          [userId],
        );
        revokedSessions = sessions.rowCount ?? 0;
        const devices = await tx.query(
          `update user_devices
              set revoked_at = now(), updated_at = now()
            where user_id = $1 and revoked_at is null`,
          [userId],
        );
        revokedDevices = devices.rowCount ?? 0;
      }

      const existing = await tx.query<ClosureRow>(
        `select ${CLOSURE_COLUMNS}
           from account_deletion_requests
          where user_id = $1 and status = 'completed'
          order by requested_at desc, id desc
          limit 1`,
        [userId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        return {
          status: 'closed' as const,
          displayName,
          closedAt: row.completed_at ?? row.requested_at,
          requestId: row.id,
          revokedSessions,
          retained: row.retained_summary,
        };
      }

      const counts = await this.closureCounts(tx, userId);
      const retained = {
        policy:
          'REQUIREMENTS §7.6: transaction and audit records survive account closure for reconciliation; the identity behind them is pseudonymised instead of deleted',
        closedBy: 'self_service',
        pseudonymised: ['users.display_name'],
        revoked: { sessions: revokedSessions, devices: revokedDevices },
        retained: [
          {
            entity: 'users',
            count: 1,
            reason:
              'The account row is kept as a closed shell so orders, reviews and ledger rows keep a valid owner; only the display name was replaced',
          },
          {
            entity: 'orders',
            count: counts.orders,
            reason:
              'Order and price snapshots are financial records; deleting them would break reconciliation and tenant sales history',
          },
          {
            entity: 'ledger_entries',
            count: counts.ledgerEntries,
            reason:
              'Wallet balance is derived from an immutable double-entry ledger that must stay reconcilable',
          },
          {
            entity: 'reviews',
            count: counts.reviews,
            reason:
              'Reviews are tied to a completed order and to tenant ratings; the row stays, the account is pseudonymised',
          },
          {
            entity: 'notifications',
            count: counts.notifications,
            reason:
              'Notification rows are linked to outbox events that must not be replayed',
          },
          {
            entity: 'audit_events',
            count: counts.auditEvents,
            reason:
              'Audit rows record consequential actions and are immutable by design',
          },
        ],
      };
      const request = await tx.query<ClosureRow>(
        `insert into account_deletion_requests
           (user_id, status, reason, retained_summary, requested_at, completed_at,
            created_at, updated_at)
         values ($1, 'completed', $2, $3::jsonb, now(), now(), now(), now())
         returning ${CLOSURE_COLUMNS}`,
        [userId, reason ?? null, JSON.stringify(retained)],
      );
      await this.audit.append(tx, {
        actor: { userId },
        scopeType: 'user',
        scopeId: userId,
        action: 'user.account.closed',
        targetType: 'user',
        targetId: userId,
        reason: 'Account owner requested account closure',
        metadata: {
          revocation: { sessions: revokedSessions, devices: revokedDevices },
          pseudonymised: ['displayName'],
          ordersRetained: counts.orders,
          ledgerEntriesRetained: counts.ledgerEntries,
        },
      });
      const row = request.rows[0];
      return {
        status: 'closed' as const,
        displayName,
        closedAt: row.completed_at ?? row.requested_at,
        requestId: row.id,
        revokedSessions,
        retained,
      };
    });
  }

  /**
   * The caller's own data as one JSON document (read-only, no secrets).
   *
   * Everything is read in a single transaction so the wallet balance and the
   * ledger transactions it is derived from cannot disagree, and the phone
   * number stays masked: an export is not a reason to hand out the raw identity
   * destination.
   */
  async exportAccount(userId: string): Promise<AccountExport> {
    this.assertUuid(userId, 'user');
    return this.withTransaction(undefined, async (tx) => {
      const userResult = await tx.query<{
        id: string;
        display_name: string;
        status: string;
        phone_e164: string | null;
        phone_verified: boolean;
        created_at: string;
        updated_at: string;
        exported_at: string;
      }>(
        `select u.id::text, u.display_name, u.status, u.phone_e164,
                (u.phone_verified_at is not null) as phone_verified,
                ${microUtc('u.created_at', 'created_at')},
                ${microUtc('u.updated_at', 'updated_at')},
                ${microUtc('now()', 'exported_at')}
           from users u
          where u.id = $1`,
        [userId],
      );
      const user = userResult.rows[0];
      if (!user) throw new NotFoundException('User account was not found');

      const campusEmail = await tx.query<{
        campus_id: string;
        campus_name: string;
      }>(
        `select c.id::text as campus_id, c.name as campus_name
           from campus_email_verifications v
           join campuses c on c.id = v.campus_id
          where v.user_id = $1`,
        [userId],
      );

      const orderTotals = await tx.query<{
        status: string;
        count: string;
        currency: string;
        total_minor: string;
      }>(
        `select status, count(*)::text as count, currency,
                coalesce(sum(total_minor), 0)::text as total_minor
           from orders
          where buyer_id = $1
          group by status, currency
          order by status asc, currency asc`,
        [userId],
      );

      const wallet = await tx.query<{
        currency: string;
        balance_minor: string;
      }>(
        `select currency, balance_minor::text
           from wallet_accounts
          where owner_user_id = $1 and account_type = 'wallet'
          order by currency asc`,
        [userId],
      );

      const transactions = await tx.query<{
        id: string;
        currency: string;
        direction: 'debit' | 'credit';
        amount_minor: string;
        reason: string;
        created_at: string;
      }>(
        `select t.id::text, t.currency, e.direction, e.amount_minor::text,
                t.reason,
                ${microUtc('t.created_at', 'created_at')}
           from wallet_accounts a
           join ledger_entries e on e.account_id = a.id
           join ledger_transactions t on t.id = e.transaction_id
          where a.owner_user_id = $1 and a.account_type = 'wallet'
          order by t.created_at desc, t.id desc
          limit $2`,
        [userId, EXPORT_TRANSACTION_LIMIT + 1],
      );

      const reviews = await tx.query<{
        id: string;
        order_id: string;
        tenant_id: string;
        tenant_name: string;
        rating: number;
        body: string;
        status: string;
        created_at: string;
        deleted_at: string | null;
      }>(
        `select r.id::text, r.order_id::text, r.tenant_id::text,
                t.name as tenant_name, r.rating, r.body, r.status,
                ${microUtc('r.created_at', 'created_at')},
                ${microUtc('r.deleted_at', 'deleted_at')}
           from reviews r
           join tenants t on t.id = r.tenant_id
          where r.buyer_id = $1
          order by r.created_at desc, r.id desc
          limit $2`,
        [userId, EXPORT_REVIEW_LIMIT],
      );

      const notifications = await tx.query<{ total: string; unread: string }>(
        `select count(*)::text as total,
                count(*) filter (where read_at is null)::text as unread
           from notifications
          where recipient_user_id = $1`,
        [userId],
      );

      const byStatus = new Map<string, number>();
      const byCurrency = new Map<string, bigint>();
      for (const row of orderTotals.rows) {
        byStatus.set(
          row.status,
          (byStatus.get(row.status) ?? 0) + Number(row.count),
        );
        byCurrency.set(
          row.currency,
          (byCurrency.get(row.currency) ?? BigInt(0)) + BigInt(row.total_minor),
        );
      }

      const transactionRows = transactions.rows.slice(
        0,
        EXPORT_TRANSACTION_LIMIT,
      );
      const email = campusEmail.rows[0];
      return {
        exportedAt: user.exported_at,
        profile: {
          id: user.id,
          displayName: user.display_name,
          status: user.status,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
          phone: {
            masked: maskPhone(user.phone_e164),
            verified: user.phone_verified,
          },
          campusEmail: {
            verified: Boolean(email),
            campusId: email?.campus_id ?? null,
            campusName: email?.campus_name ?? null,
          },
        },
        orders: {
          total: [...byStatus.values()].reduce((sum, count) => sum + count, 0),
          byStatus: [...byStatus.entries()]
            .map(([status, count]) => ({ status, count }))
            .sort((left, right) => left.status.localeCompare(right.status)),
          totalsByCurrency: [...byCurrency.entries()]
            .map(([currency, totalMinor]) => ({
              currency,
              totalMinor: totalMinor.toString(),
            }))
            .sort((left, right) => left.currency.localeCompare(right.currency)),
        },
        wallet: wallet.rows.map((row) => ({
          currency: row.currency,
          availableMinor: row.balance_minor,
        })),
        transactions: {
          count: transactionRows.length,
          truncated: transactions.rows.length > EXPORT_TRANSACTION_LIMIT,
          items: transactionRows.map((row) => ({
            id: row.id,
            currency: row.currency,
            direction: row.direction,
            amountMinor: row.amount_minor,
            reason: row.reason,
            createdAt: row.created_at,
          })),
        },
        reviews: {
          count: reviews.rows.length,
          items: reviews.rows.map((row) => ({
            id: row.id,
            orderId: row.order_id,
            tenantId: row.tenant_id,
            tenantName: row.tenant_name,
            rating: row.rating,
            body: row.body,
            status: row.status,
            createdAt: row.created_at,
            deletedAt: row.deleted_at,
          })),
        },
        notifications: {
          count: Number(notifications.rows[0]?.total ?? '0'),
          unread: Number(notifications.rows[0]?.unread ?? '0'),
        },
      };
    });
  }

  /** Counts of the rows a closure keeps, so the summary is evidence, not prose. */
  private async closureCounts(
    tx: PoolClient,
    userId: string,
  ): Promise<{
    orders: number;
    ledgerEntries: number;
    reviews: number;
    notifications: number;
    auditEvents: number;
  }> {
    const result = await tx.query<{
      orders: string;
      ledger_entries: string;
      reviews: string;
      notifications: string;
      audit_events: string;
    }>(
      `select
         (select count(*) from orders where buyer_id = $1)::text as orders,
         (select count(*)
            from ledger_entries e
            join wallet_accounts a on a.id = e.account_id
           where a.owner_user_id = $1 and a.account_type = 'wallet')::text
           as ledger_entries,
         (select count(*) from reviews where buyer_id = $1)::text as reviews,
         (select count(*) from notifications where recipient_user_id = $1)::text
           as notifications,
         (select count(*) from audit_events
           where scope_type = 'user' and scope_id = $1)::text as audit_events`,
      [userId],
    );
    const row = result.rows[0];
    return {
      orders: Number(row?.orders ?? '0'),
      ledgerEntries: Number(row?.ledger_entries ?? '0'),
      reviews: Number(row?.reviews ?? '0'),
      notifications: Number(row?.notifications ?? '0'),
      auditEvents: Number(row?.audit_events ?? '0'),
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async readProfile(
    tx: PoolClient,
    userId: string,
  ): Promise<MeProfile> {
    const userResult = await tx.query<UserRow>(
      `select u.id::text, u.display_name, u.status, u.phone_e164,
              (u.phone_verified_at is not null) as phone_verified,
              ${microUtc('u.created_at', 'created_at')},
              ${microUtc('u.updated_at', 'updated_at')}
         from users u
        where u.id = $1`,
      [userId],
    );
    const user = userResult.rows[0];
    if (!user) throw new NotFoundException('User account was not found');

    // campus_email_verifications is unique per user, so at most one row.
    const campusEmail = await tx.query<{
      campus_id: string;
      campus_name: string;
    }>(
      `select c.id::text as campus_id, c.name as campus_name
         from campus_email_verifications v
         join campuses c on c.id = v.campus_id
        where v.user_id = $1`,
      [userId],
    );
    const tenants = await tx.query<TenantRow>(
      `select t.id::text as tenant_id, t.name as tenant_name,
              t.status as tenant_status, t.campus_id::text as campus_id,
              c.name as campus_name, tm.role, tm.permissions
         from tenant_memberships tm
         join tenants t on t.id = tm.tenant_id
         join campuses c on c.id = t.campus_id
        where tm.user_id = $1 and tm.status = 'active'
        order by t.name asc, t.id asc`,
      [userId],
    );
    const campuses = await tx.query<CampusRow>(
      `select c.id::text as campus_id, c.name as campus_name, cm.permissions
         from campus_memberships cm
         join campuses c on c.id = cm.campus_id
        where cm.user_id = $1 and cm.status = 'active'
        order by c.name asc, c.id asc`,
      [userId],
    );
    const balances = await this.wallet.getBalance(userId, WALLET_CURRENCY, tx);
    const idr = balances.find((entry) => entry.currency === WALLET_CURRENCY);
    const email = campusEmail.rows[0];
    return {
      id: user.id,
      displayName: user.display_name,
      status: user.status,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      phone: {
        masked: maskPhone(user.phone_e164),
        verified: user.phone_verified,
      },
      campusEmail: {
        verified: Boolean(email),
        campusId: email?.campus_id ?? null,
        campusName: email?.campus_name ?? null,
      },
      wallet: idr
        ? { currency: WALLET_CURRENCY, availableMinor: idr.balanceMinor }
        : null,
      tenants: tenants.rows.map((row) => ({
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        tenantStatus: row.tenant_status,
        campusId: row.campus_id,
        campusName: row.campus_name,
        role: row.role,
        // An owner holds every tenant permission by definition; staff keep the
        // explicit list that was granted to them.
        permissions:
          row.role === 'owner' ? [...TENANT_PERMISSIONS] : [...row.permissions],
      })),
      campuses: campuses.rows.map((row) => ({
        campusId: row.campus_id,
        campusName: row.campus_name,
        permissions: [...row.permissions],
      })),
    };
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

  private assertUuid(value: string, name: string): void {
    if (!UUID_PATTERN.test(value ?? ''))
      throw new BadRequestException('Invalid ' + name + ' id');
  }
}

/**
 * A closed account keeps its id but loses its name: the pseudonym is stable
 * (same id -> same label) so support can still talk about one row without
 * revealing who it was.
 */
export function pseudonymFor(userId: string): string {
  const short = (userId ?? '').replace(/-/g, '').slice(0, 8);
  return 'Closed account ' + short;
}

function normalizeClosureReason(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string')
    throw new BadRequestException({
      code: 'ACCOUNT_CLOSURE_REASON_INVALID',
      message: 'reason must be a string of at most 500 characters',
    });
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_CLOSURE_REASON)
    throw new BadRequestException({
      code: 'ACCOUNT_CLOSURE_REASON_INVALID',
      message: 'reason must be 1 to 500 characters when provided',
    });
  return normalized;
}

function defaultPreferences(): NotificationPreferences {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, updatedAt: null };
}

function toPreferences(row: PreferenceRow): NotificationPreferences {
  return {
    orderUpdates: row.order_updates,
    reviewReplies: row.review_replies,
    caseUpdates: row.case_updates,
    pushEnabled: row.push_enabled,
    updatedAt: row.updated_at,
  };
}

function toDeviceView(row: DeviceRow): DeviceView {
  return {
    id: row.id,
    platform: row.platform,
    label: row.label,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizePreferenceChanges(input: UpdatePreferencesInput): {
  orderUpdates: boolean | null;
  reviewReplies: boolean | null;
  caseUpdates: boolean | null;
  pushEnabled: boolean | null;
} {
  const keys = [
    'orderUpdates',
    'reviewReplies',
    'caseUpdates',
    'pushEnabled',
  ] as const;
  const changes = {
    orderUpdates: null,
    reviewReplies: null,
    caseUpdates: null,
    pushEnabled: null,
  } as {
    orderUpdates: boolean | null;
    reviewReplies: boolean | null;
    caseUpdates: boolean | null;
    pushEnabled: boolean | null;
  };
  let provided = 0;
  for (const key of keys) {
    const value = input?.[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean')
      throw new BadRequestException({
        code: 'PREFERENCE_VALUE_INVALID',
        message: key + ' must be a boolean',
      });
    changes[key] = value;
    provided += 1;
  }
  if (provided === 0)
    throw new BadRequestException({
      code: 'PREFERENCE_UPDATE_EMPTY',
      message: 'At least one notification preference must be provided',
    });
  return changes;
}

function normalizePlatform(value: string | undefined): DevicePlatform {
  if (!DEVICE_PLATFORMS.includes(value as DevicePlatform))
    throw new BadRequestException({
      code: 'DEVICE_PLATFORM_INVALID',
      message: 'platform must be one of: ' + DEVICE_PLATFORMS.join(', '),
    });
  return value as DevicePlatform;
}

function normalizeToken(value: string | undefined): string {
  const token = typeof value === 'string' ? value : '';
  if (
    token.trim() !== token ||
    token.length < MIN_TOKEN_LENGTH ||
    token.length > MAX_TOKEN_LENGTH
  )
    throw new BadRequestException({
      code: 'DEVICE_TOKEN_INVALID',
      message:
        'token must be ' +
        String(MIN_TOKEN_LENGTH) +
        ' to ' +
        String(MAX_TOKEN_LENGTH) +
        ' characters without surrounding whitespace',
    });
  return token;
}

function normalizeLabel(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > MAX_DEVICE_LABEL)
    throw new BadRequestException({
      code: 'DEVICE_LABEL_INVALID',
      message: 'label must be at most 100 characters',
    });
  return value.trim();
}

/**
 * Masks everything but the last four digits of a phone number, keeping the
 * leading "+" and the country/operator prefix so the owner still recognizes it:
 * +6281234560001 -> +62812****0001.
 */
export function maskPhone(phone: string | null): string | null {
  if (phone === null || phone === undefined) return null;
  const value = phone.trim();
  if (!value) return null;
  if (value.length <= 8) return '*'.repeat(value.length);
  const head = Math.min(6, value.length - 4);
  return (
    value.slice(0, head) +
    '*'.repeat(value.length - head - 4) +
    value.slice(value.length - 4)
  );
}
