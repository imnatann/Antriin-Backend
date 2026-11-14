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
