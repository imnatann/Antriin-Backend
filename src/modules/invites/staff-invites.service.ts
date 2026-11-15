import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService, TENANT_PERMISSIONS } from '../access/access.service';
import type { TenantPermission } from '../access/access.service';
import { AuditService } from '../audit/audit.service';

/** How long an unaccepted invitation stays redeemable. */
export const INVITE_TTL_DAYS = 7;

/** Roles a tenant owner may hand out; owner is never invited, it is bootstrapped. */
export const INVITABLE_TENANT_ROLES = ['kitchen', 'pickup'] as const;
export type InvitableTenantRole = (typeof INVITABLE_TENANT_ROLES)[number];

/**
 * Queue filter for GET /tenants/{id}/staff/invites. 'open' is the default and
 * means "still redeemable or already timed out but not accepted/revoked".
 */
export const STAFF_INVITE_STATES = [
  'open',
  'pending',
  'expired',
  'accepted',
  'revoked',
  'all',
] as const;
export type StaffInviteState = (typeof STAFF_INVITE_STATES)[number];

export const STAFF_INVITE_DEFAULT_LIMIT = 50;
export const STAFF_INVITE_MAX_LIMIT = 200;

/**
 * Which permission codes each staff role may hold.
 *
 * This mirrors AccessService.STAFF_ROLE_PERMISSIONS deliberately: an invitation
 * must be refused at creation time instead of failing weeks later when the
 * invitee redeems it, and acceptance re-validates the stored row through this
 * same table so a hand-edited invite row cannot smuggle in a wider grant.
 * Finance, staff management and settings stay owner-only in both places.
 */
const ROLE_PERMISSIONS: Record<
  InvitableTenantRole,
  readonly TenantPermission[]
> = {
  kitchen: [
    'tenant.orders.read',
    'tenant.orders.accept',
    'tenant.orders.prepare',
    'tenant.orders.pause',
    'tenant.menu.manage',
    'tenant.capacity.manage',
    'tenant.reviews.reply',
    'tenant.incidents.report',
  ],
  pickup: [
    'tenant.orders.read',
    'tenant.orders.handover',
    'tenant.incidents.report',
  ],
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** base64url of 32 random bytes is 43 characters; allow a generous window. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_REASON = 500;

export type StaffInviteStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

export type StaffInviteView = {
  id: string;
  tenantId: string;
  invitedUserId: string;
  invitedBy: string;
  role: InvitableTenantRole;
  permissions: TenantPermission[];
  status: StaffInviteStatus;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/** The raw token exists only in this response; the database keeps its hash. */
export type CreatedStaffInvite = StaffInviteView & { token: string };

export type CreateStaffInviteInput = {
  userId: string;
  role: string;
  permissions: readonly string[];
};

export type AcceptedStaffInvite = {
  inviteId: string;
  tenantId: string;
  membershipId: string;
  role: InvitableTenantRole;
  permissions: TenantPermission[];
  acceptedAt: string;
};

type InviteRow = {
  id: string;
  tenant_id: string;
  invited_user_id: string;
  invited_by: string;
  role: string;
  permissions: string[];
  status: StaffInviteStatus;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

/**
 * Response timestamps are the DB microsecond UTC strings themselves (D7):
 * re-serializing through JS Date would truncate them to milliseconds.
 */
function microUtc(column: string, alias: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${alias}`;
}

/** Status is derived, never stored, so expiry needs no background sweeper. */
const INVITE_STATUS_SQL = `case
    when i.accepted_at is not null then 'accepted'
    when i.revoked_at is not null then 'revoked'
    when i.expires_at <= now() then 'expired'
    else 'pending'
  end as status`;

const INVITE_COLUMNS = [
  'i.id::text',
  'i.tenant_id::text',
  'i.invited_user_id::text',
  'i.invited_by::text',
  'i.role',
  // jsonb is returned as a parsed JS array; jsonb -> text[] has no cast.
  'i.permissions',
  INVITE_STATUS_SQL,
  microUtc('i.expires_at', 'expires_at'),
  microUtc('i.accepted_at', 'accepted_at'),
  microUtc('i.revoked_at', 'revoked_at'),
  microUtc('i.created_at', 'created_at'),
].join(', ');

/**
 * Staff invitations (REQUIREMENTS §6 StaffInvite).
 *
 * An owner invites a specific user id to a tenant with a staff role; the
 * invitee redeems a one-time token and only then does the membership exist.
 * Until redemption the invitation grants nothing, so a leaked list is not an
 * access grant. Only the SHA-256 of the token is stored, so the database cannot
 * be replayed as an invitation either.
 */
@Injectable()
export class StaffInvitesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Issues an invitation. The actor must hold tenant.staff.manage, the granted
   * permissions must be a subset of what the actor holds and of what the role
   * may hold, and the invitee must be a real, active, not-yet-member user.
   */
  async createInvite(
    actorUserId: string,
    tenantId: string,
    input: CreateStaffInviteInput,
  ): Promise<CreatedStaffInvite> {
    this.assertUuid(tenantId, 'tenant');
    this.assertUuid(input?.userId, 'user');
    const role = this.normalizeRole(input?.role);
    const permissions = this.normalizePermissions(role, input?.permissions);

    const token = this.generateToken();
    const tokenHash = this.hashToken(token);

    return this.withTransaction(undefined, async (tx) => {
      const authorization = await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.staff.manage',
        tx,
      );

      // An inviter can never hand out more than they hold themselves.
      const held = new Set<string>(authorization.permissions);
      const escalated = permissions.filter((item) => !held.has(item));
      if (escalated.length > 0)
        throw new ForbiddenException({
          code: 'INVITE_PERMISSION_EXCEEDS_ACTOR',
          message: 'The inviter does not hold: ' + escalated.join(', '),
        });

      if (input.userId === actorUserId)
        throw new ForbiddenException({
          code: 'INVITE_SELF_FORBIDDEN',
          message: 'An invitation cannot be issued to the inviter',
        });

      const target = await tx.query<{ id: string; status: string }>(
        'select id, status from users where id = $1 for share',
        [input.userId],
      );
      if (target.rows[0]?.status !== 'active')
        throw new NotFoundException({
          code: 'INVITE_USER_NOT_FOUND',
          message: 'An active user with that id was not found',
        });

      const membership = await tx.query<{ id: string }>(
        `select id from tenant_memberships
          where tenant_id = $1 and user_id = $2 and status = 'active'
          for share`,
        [tenantId, input.userId],
      );
      if (membership.rows[0])
        throw new ConflictException({
          code: 'INVITE_USER_ALREADY_STAFF',
          message: 'That user already has an active membership in this tenant',
        });

      // One open invitation per (tenant, user): a second live token would make
      // "which invitation did this membership come from" ambiguous. The
      // advisory lock closes the race where two concurrent creates both find no
      // pending row: the table has no unique constraint over that pair because
      // accepted/revoked history must stay.
      await tx.query(
        `select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`,
        [tenantId, input.userId],
      );
      const pending = await tx.query<{ id: string }>(
        `select id from tenant_staff_invites
          where tenant_id = $1 and invited_user_id = $2
            and accepted_at is null and revoked_at is null
            and expires_at > now()
          for update`,
        [tenantId, input.userId],
      );
      if (pending.rows[0])
        throw new ConflictException({
          code: 'INVITE_ALREADY_PENDING',
          message:
            'An invitation for that user is already pending; revoke it first',
        });

      const inserted = await tx.query<InviteRow>(
        `insert into tenant_staff_invites
           (tenant_id, invited_user_id, invited_by, role, permissions,
            token_hash, expires_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6,
                 now() + make_interval(days => $7::int), now(), now())
         returning id, tenant_id::text, invited_user_id::text,
                   invited_by::text, role, permissions,
                   'pending'::text as status,
                   ${microUtc('expires_at', 'expires_at')},
                   null::text as accepted_at, null::text as revoked_at,
                   ${microUtc('created_at', 'created_at')}`,
        [
          tenantId,
          input.userId,
          actorUserId,
          role,
          JSON.stringify(permissions),
          tokenHash,
          INVITE_TTL_DAYS,
        ],
      );
      const invite = this.toView(inserted.rows[0]);
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: 'tenant.staff.invite.created',
        targetType: 'tenant_invite',
        targetId: invite.id,
        reason: 'Staff invitation issued',
        metadata: {
          invitedUserId: invite.invitedUserId,
          role: invite.role,
          permissions: invite.permissions,
          expiresAt: invite.expiresAt,
        },
      });
      return { ...invite, token };
    });
  }

  /** Open invitations by default; the token hash is never projected. */
  async listInvites(
    actorUserId: string,
    tenantId: string,
    options: { state?: StaffInviteState; limit?: number } = {},
  ): Promise<{ items: StaffInviteView[]; meta: { count: number } }> {
    this.assertUuid(tenantId, 'tenant');
    const state = this.normalizeState(options.state);
    const limit = this.normalizeLimit(options.limit);
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      'tenant.staff.manage',
    );
    // The state is derived, so the filter has to run outside the projection.
    const result = await this.database.pool.query<InviteRow>(
      `select * from (
          select ${INVITE_COLUMNS}
            from tenant_staff_invites i
           where i.tenant_id = $1
        ) scoped
        where $2::text = 'all'
           or scoped.status = $2::text
           or ($2::text = 'open' and scoped.status in ('pending', 'expired'))
        order by scoped.created_at desc, scoped.id desc
        limit $3`,
      [tenantId, state, limit],
    );
    const items = result.rows.map((row) => this.toView(row));
    return { items, meta: { count: items.length } };
  }

  /**
   * Revokes a still-open invitation. Revoking an already revoked invitation is
   * a no-op so a retried request cannot fail; an accepted invitation is not
   * revocable because the membership it created is a separate decision.
   */
  async revokeInvite(
    actorUserId: string,
    tenantId: string,
    inviteId: string,
    reason?: string,
  ): Promise<StaffInviteView> {
    this.assertUuid(tenantId, 'tenant');
    this.assertUuid(inviteId, 'invite');
    const note = this.normalizeReason(reason);
    return this.withTransaction(undefined, async (tx) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.staff.manage',
        tx,
      );
      const existing = await tx.query<InviteRow>(
        `select ${INVITE_COLUMNS}
           from tenant_staff_invites i
          where i.id = $1 and i.tenant_id = $2
          for update of i`,
        [inviteId, tenantId],
      );
      const row = existing.rows[0];
      if (!row)
        throw new NotFoundException({
          code: 'INVITE_NOT_FOUND',
          message: 'Invitation was not found for this tenant',
        });
      if (row.status === 'accepted')
        throw new ConflictException({
          code: 'INVITE_ALREADY_ACCEPTED',
          message: 'An accepted invitation cannot be revoked',
        });
      if (row.status === 'revoked') return this.toView(row);

      const updated = await tx.query<InviteRow>(
        `update tenant_staff_invites i
            set revoked_at = now(), updated_at = now()
          where i.id = $1
          returning id, tenant_id::text, invited_user_id::text,
                    invited_by::text, role, permissions,
                    'revoked'::text as status,
                    ${microUtc('expires_at', 'expires_at')},
                    ${microUtc('accepted_at', 'accepted_at')},
                    ${microUtc('revoked_at', 'revoked_at')},
                    ${microUtc('created_at', 'created_at')}`,
        [inviteId],
      );
      await this.audit.append(tx, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: 'tenant.staff.invite.revoked',
        targetType: 'tenant_invite',
        targetId: inviteId,
        reason: note ?? 'Staff invitation revoked',
        metadata: { invitedUserId: row.invited_user_id },
      });
      return this.toView(updated.rows[0]);
    });
  }

  /**
   * Redeems an invitation for the authenticated invitee. Every refusal is a
   * distinct code so the invitee can tell "expired" from "wrong account"
   * without leaking whether some other user's token exists.
   */
  async acceptInvite(
    userId: string,
    token: string,
  ): Promise<AcceptedStaffInvite> {
    if (!TOKEN_PATTERN.test(token ?? ''))
      throw new NotFoundException({
        code: 'INVITE_NOT_FOUND',
        message: 'Invitation was not found',
      });
    const tokenHash = this.hashToken(token);

    return this.withTransaction(undefined, async (tx) => {
      // FOR UPDATE serialises two simultaneous redemptions of one token.
      const found = await tx.query<
        InviteRow & {
          expired: boolean;
          tenant_status: string;
          campus_status: string;
        }
      >(
        `select ${INVITE_COLUMNS},
                (i.expires_at <= now()) as expired,
                t.status as tenant_status,
                c.status as campus_status
           from tenant_staff_invites i
           join tenants t on t.id = i.tenant_id
           join campuses c on c.id = t.campus_id
          where i.token_hash = $1
          for update of i`,
        [tokenHash],
      );
      const row = found.rows[0];
      if (!row)
        throw new NotFoundException({
          code: 'INVITE_NOT_FOUND',
          message: 'Invitation was not found',
        });
      if (row.invited_user_id !== userId)
        throw new ForbiddenException({
          code: 'INVITE_USER_MISMATCH',
          message: 'This invitation belongs to a different account',
        });
      if (row.accepted_at !== null || row.status === 'accepted')
        throw new ConflictException({
          code: 'INVITE_ALREADY_ACCEPTED',
          message: 'This invitation has already been accepted',
        });
      if (row.revoked_at !== null || row.status === 'revoked')
        throw new ConflictException({
          code: 'INVITE_REVOKED',
          message: 'This invitation was revoked',
        });
      if (row.expired || row.status === 'expired')
        throw new ConflictException({
          code: 'INVITE_EXPIRED',
          message: 'This invitation has expired',
        });
      if (row.tenant_status === 'archived' || row.campus_status !== 'active')
        throw new ConflictException({
          code: 'INVITE_TENANT_UNAVAILABLE',
          message: 'The tenant is no longer accepting staff',
        });

      // Re-validate the stored row: it is data, not a captured decision.
      const role = this.normalizeRole(row.role);
      let permissions: TenantPermission[];
      try {
        permissions = this.normalizePermissions(role, row.permissions);
      } catch {
        throw new ConflictException({
          code: 'INVITE_PERMISSION_INVALID',
          message: 'The invitation grants permissions this role cannot hold',
        });
      }

      const membership = await tx.query<{ id: string }>(
        `insert into tenant_memberships
           (tenant_id, user_id, role, permissions, status, revoked_at,
            updated_at)
         values ($1, $2, $3, $4::text[], 'active', null, now())
         on conflict (tenant_id, user_id) do update
           set role = excluded.role,
               permissions = excluded.permissions,
               status = 'active',
               revoked_at = null,
               updated_at = now()
           where tenant_memberships.role <> 'owner'
             and tenant_memberships.owner_verified_at is null
         returning id`,
        [row.tenant_id, userId, role, permissions],
      );
      const membershipId = membership.rows[0]?.id;
      if (!membershipId)
        throw new ConflictException({
          code: 'INVITE_MEMBERSHIP_CONFLICT',
          message: 'The invited account already holds the owner membership',
        });

      const accepted = await tx.query<InviteRow>(
        `update tenant_staff_invites i
            set accepted_at = now(), updated_at = now()
          where i.id = $1
          returning id, tenant_id::text, invited_user_id::text,
                    invited_by::text, role, permissions,
                    'accepted'::text as status,
                    ${microUtc('expires_at', 'expires_at')},
                    ${microUtc('accepted_at', 'accepted_at')},
                    null::text as revoked_at,
                    ${microUtc('created_at', 'created_at')}`,
        [row.id],
      );
      // The access trail is what the campus audit feed reads ("access.grant").
      await tx.query(
        `insert into access_audit_events
           (actor_user_id, subject_user_id, scope_type, scope_id, membership_id,
            action, reason, details)
         values ($1, $2, 'tenant', $3, $4, 'grant', $5, $6::text[])`,
        [
          userId,
          userId,
          row.tenant_id,
          membershipId,
          'Tenant staff invitation accepted',
          permissions,
        ],
      );
      await this.audit.append(tx, {
        actor: { userId },
        scopeType: 'tenant',
        scopeId: row.tenant_id,
        action: 'tenant.staff.invite.accepted',
        targetType: 'tenant_invite',
        targetId: row.id,
        reason: 'Staff invitation accepted by the invited user',
        metadata: {
          membershipId,
          role,
          permissions,
          invitedBy: row.invited_by,
        },
      });
      const view = this.toView(accepted.rows[0]);
      return {
        inviteId: view.id,
        tenantId: view.tenantId,
        membershipId,
        role: view.role,
        permissions: view.permissions,
        acceptedAt: view.acceptedAt as string,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private toView(row: InviteRow): StaffInviteView {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      invitedUserId: row.invited_user_id,
      invitedBy: row.invited_by,
      role: row.role as InvitableTenantRole,
      permissions: row.permissions as TenantPermission[],
      status: row.status,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    };
  }

  private normalizeRole(value: string | undefined): InvitableTenantRole {
    if (!INVITABLE_TENANT_ROLES.includes(value as InvitableTenantRole))
      throw new BadRequestException({
        code: 'INVITE_ROLE_INVALID',
        message: 'role must be one of: ' + INVITABLE_TENANT_ROLES.join(', '),
      });
    return value as InvitableTenantRole;
  }

  private normalizePermissions(
    role: InvitableTenantRole,
    permissions: readonly string[] | undefined,
  ): TenantPermission[] {
    if (
      !Array.isArray(permissions) ||
      new Set(permissions).size !== permissions.length
    )
      throw new BadRequestException({
        code: 'INVITE_PERMISSION_INVALID',
        message: 'permissions must be a unique explicit list',
      });
    const allowed = new Set<string>(ROLE_PERMISSIONS[role]);
    for (const permission of permissions) {
      if (!(TENANT_PERMISSIONS as readonly string[]).includes(permission))
        throw new BadRequestException({
          code: 'INVITE_PERMISSION_INVALID',
          message: 'Unknown tenant permission: ' + permission,
        });
      if (!allowed.has(permission))
        throw new BadRequestException({
          code: 'INVITE_PERMISSION_INVALID',
          message: 'Permission ' + permission + ' cannot be granted to ' + role,
        });
    }
    return [...permissions] as TenantPermission[];
  }

  private normalizeState(value: string | undefined): StaffInviteState {
    if (value === undefined) return 'open';
    if (!STAFF_INVITE_STATES.includes(value as StaffInviteState))
      throw new BadRequestException({
        code: 'INVITE_STATE_INVALID',
        message: 'state must be one of: ' + STAFF_INVITE_STATES.join(', '),
      });
    return value as StaffInviteState;
  }

  private normalizeLimit(value: number | undefined): number {
    if (value === undefined) return STAFF_INVITE_DEFAULT_LIMIT;
    if (!Number.isInteger(value) || value < 1 || value > STAFF_INVITE_MAX_LIMIT)
      throw new BadRequestException({
        code: 'INVITE_LIMIT_INVALID',
        message:
          'limit must be an integer between 1 and ' +
          String(STAFF_INVITE_MAX_LIMIT),
      });
    return value;
  }

  private normalizeReason(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_REASON)
      throw new BadRequestException({
        code: 'INVITE_REASON_INVALID',
        message: 'reason must be 1 to 500 characters',
      });
    return normalized;
  }

  private generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Same pattern as sessions and pickup codes: only the SHA-256 is stored. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private assertUuid(value: string, name: string): void {
    if (!UUID_PATTERN.test(value ?? ''))
      throw new BadRequestException('Invalid ' + name + ' id');
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
