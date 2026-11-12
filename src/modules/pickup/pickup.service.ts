import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
} from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { uuidPattern } from '../notifications/outbox.service';
import type { OrderStatus } from '../orders/orders.constants';
import { OrdersService } from '../orders/orders.service';
import {
  MAX_PICKUP_REASON_LENGTH,
  PICKUP_CODE_ALPHABET,
  PICKUP_CODE_DISPLAY_SEPARATOR,
  PICKUP_CODE_GENERATION_ATTEMPTS,
  PICKUP_CODE_LENGTH,
  PICKUP_CODE_NORMALIZED_PATTERN,
  PICKUP_AUDIT_ACTIONS,
  PICKUP_ERROR_CODES,
  PICKUP_TTL_DEFAULT_SECONDS,
  PICKUP_TTL_MAX_SECONDS,
  PICKUP_TTL_MIN_SECONDS,
} from './pickup.constants';

export interface IssuedPickupCredential {
  credentialId: string;
  orderId: string;
  /** Plaintext, grouped for humans (XXXX-XXXX). Never logged, never stored. */
  code: string;
  expiresAt: string;
  rotatedFrom: string | null;
}

export interface RevokedPickupCredential {
  credentialId: string;
  orderId: string;
  revokedAt: string;
}

export interface BuyerPickupCredential {
  credentialId: string;
  orderId: string;
  code: string;
  expiresAt: string;
}

export interface PickupVerification {
  orderId: string;
  orderNumber: string | null;
  status: OrderStatus;
  readyForHandover: boolean;
  buyer: { id: string; displayName: string };
  totalMinor: string;
  currency: string;
  pickupStartsAt: string;
  pickupEndsAt: string;
  credentialId: string;
  credentialExpiresAt: string;
}

export interface PickupHandover {
  handoverId: string;
  orderId: string;
  credentialId: string;
  status: 'completed';
  handedOverAt: string;
}

/** D7: microsecond UTC strings produced by the database, never re-serialized. */
const SQL_TS = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface CredentialLookupRow {
  credential_id: string;
  order_id: string;
  tenant_id: string;
  revoked: boolean;
  consumed: boolean;
  expired: boolean;
}

const CREDENTIAL_LOOKUP_COLUMNS = `
       c.id AS credential_id,
       c.order_id,
       o.tenant_id,
       (c.revoked_at IS NOT NULL) AS revoked,
       (c.consumed_at IS NOT NULL) AS consumed,
       (c.expires_at <= now()) AS expired`;

/**
 * Pickup slice: credential issuance/rotation, side-effect-free code
 * verification and the one-time handover.
 *
 * Ownership and contracts (D4, D16.6):
 * - this service is the single writer of `pickup_credentials` and
 *   `order_handovers`; order state transitions go exclusively through
 *   OrdersService.markHandedOver inside the same transaction (never a direct
 *   write to `orders`);
 * - authorization is `tenant.orders.handover` for every staff action, checked
 *   with AccessService.requireTenant inside the mutating transaction;
 * - the plaintext code exists only in memory: lookup uses a deterministic
 *   HMAC-SHA256 hash (AUTH_SECRET) and re-display for the owning buyer uses
 *   AES-256-GCM ciphertext (AUTH_ENCRYPTION_KEY). Neither plaintext nor
 *   ciphertext is ever logged or written into event/audit metadata.
 */
@Injectable()
export class PickupService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Issues the pickup code for a ready_for_pickup order (staff action,
   * tenant.orders.handover). Re-issuance rotates: the previous active
   * credential is revoked and the new one is created in the SAME transaction,
   * preserving the partial unique "one active credential per order".
   */
  async issueCredential(
    actorUserId: string,
    tenantId: string,
    orderId: string,
  ): Promise<{ data: IssuedPickupCredential }> {
    this.assertUuid(actorUserId, 'actor id');
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(orderId, 'order id');
    const security = this.securityConfig();
    const ttlSeconds = this.credentialTtlSeconds();
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.orders.handover',
        client,
      );
      // Lock order first, credential rows second - the same lock order the
      // handover flow uses, so issuance and handover cannot ABBA-deadlock.
      const locked = await client.query<{ id: string; status: OrderStatus }>(
        `SELECT id, status FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [orderId, tenantId],
      );
      const order = locked.rows[0];
      if (!order) throw new NotFoundException('Order not found');
      if (order.status !== 'ready_for_pickup') {
        throw new ConflictException({
          code: PICKUP_ERROR_CODES.notReady,
          message: `Pickup credentials are issued for ready_for_pickup orders (current: ${order.status})`,
        });
      }
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM pickup_credentials
          WHERE order_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL
          FOR UPDATE`,
        [orderId],
      );
      const rotatedFrom = existing.rows[0]?.id ?? null;
      if (rotatedFrom) {
        const revoked = await client.query(
          `UPDATE pickup_credentials
              SET revoked_at = now(), updated_at = now()
            WHERE id = $1 AND revoked_at IS NULL AND consumed_at IS NULL`,
          [rotatedFrom],
        );
        if (revoked.rowCount !== 1) {
          throw new ConflictException({
            code: PICKUP_ERROR_CODES.handoverConflict,
            message: 'Pickup credential changed concurrently; retry',
          });
        }
        await this.appendPickupEvent(client, {
          orderId,
          eventType: 'pickup_credential.revoked',
          actorUserId,
          reason: 'Credential rotated by re-issuance',
          metadata: { credentialId: rotatedFrom, orderId, rotated: true },
        });
        await this.audit.append(client, {
          actor: { userId: actorUserId },
          scopeType: 'tenant',
          scopeId: tenantId,
          action: PICKUP_AUDIT_ACTIONS.revoked,
          targetType: 'pickup_credential',
          targetId: rotatedFrom,
          reason: 'Rotated by credential re-issuance',
          metadata: { orderId },
        });
      }
      // Collision-safe insert against the global code_hash unique index;
      // SAVEPOINT keeps the surrounding transaction usable after a 23505.
      let credentialId = '';
      let expiresAt = '';
      let issuedCode = '';
      for (
        let attempt = 0;
        attempt < PICKUP_CODE_GENERATION_ATTEMPTS && !credentialId;
        attempt += 1
      ) {
        const code = this.generateCode();
        const codeHash = this.hashCode(security.secret, code);
        const ciphertext = this.encrypt(security.encryptionKey, code);
        await client.query('SAVEPOINT pickup_code_insert');
        try {
          const inserted = await client.query<{
            id: string;
            expires_at_text: string;
          }>(
            `INSERT INTO pickup_credentials
               (order_id, code_hash, code_ciphertext, expires_at)
             VALUES ($1, $2, $3, now() + make_interval(secs => $4))
             RETURNING id, ${SQL_TS('expires_at')} AS expires_at_text`,
            [orderId, codeHash, ciphertext, ttlSeconds],
          );
          await client.query('RELEASE SAVEPOINT pickup_code_insert');
          credentialId = inserted.rows[0].id;
          expiresAt = inserted.rows[0].expires_at_text;
          issuedCode = code;
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT pickup_code_insert');
          const pgError = error as { code?: string; constraint?: string };
          if (
            pgError.code === '23505' &&
            pgError.constraint === 'pickup_credentials_code_hash_unique'
          ) {
            continue;
          }
          throw error;
        }
      }
      if (!credentialId) {
        throw new ServiceUnavailableException({
          code: PICKUP_ERROR_CODES.codeGenerationFailed,
          message: 'Could not generate a unique pickup code; retry',
        });
      }
      await this.appendPickupEvent(client, {
        orderId,
        eventType: 'pickup_credential.issued',
        actorUserId,
        reason: rotatedFrom
          ? 'Credential re-issued; previous credential revoked'
          : 'Pickup credential issued',
        metadata: { credentialId, orderId, expiresAt, rotatedFrom },
      });
      await this.audit.append(client, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: PICKUP_AUDIT_ACTIONS.issued,
        targetType: 'pickup_credential',
        targetId: credentialId,
        reason: rotatedFrom
          ? 'Re-issued; previous credential revoked'
          : 'Issued for pickup handover',
        metadata: { orderId, rotated: rotatedFrom !== null },
      });
      return {
        data: {
          credentialId,
          orderId,
          code: this.formatForDisplay(issuedCode),
          expiresAt,
          rotatedFrom,
        },
      };
    });
  }

  /**
   * Revokes the active credential of an order with a mandatory reason
   * (immutable audit + order_events 'pickup_credential.revoked'). A consumed
   * credential cannot be revoked (DB CHECK consume/revoke exclusivity).
   */
  async revokeCredential(
    actorUserId: string,
    tenantId: string,
    orderId: string,
    reason: string,
  ): Promise<{ data: RevokedPickupCredential }> {
    this.assertUuid(actorUserId, 'actor id');
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(orderId, 'order id');
    const trimmed = (reason ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException(
        'reason is required to revoke a pickup credential',
      );
    }
    if (trimmed.length > MAX_PICKUP_REASON_LENGTH) {
      throw new BadRequestException('reason exceeds 500 characters');
    }
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.orders.handover',
        client,
      );
      const locked = await client.query<{ id: string }>(
        `SELECT id FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [orderId, tenantId],
      );
      if (!locked.rows[0]) throw new NotFoundException('Order not found');
      const active = await client.query<{
        id: string;
        consumed_at: Date | null;
      }>(
        `SELECT id, consumed_at FROM pickup_credentials
          WHERE order_id = $1 AND revoked_at IS NULL
          FOR UPDATE`,
        [orderId],
      );
      const credential = active.rows[0];
      if (!credential) {
        throw new NotFoundException({
          code: PICKUP_ERROR_CODES.credentialNotFound,
          message: 'No active pickup credential for this order',
        });
      }
      if (credential.consumed_at) {
        throw new ConflictException({
          code: PICKUP_ERROR_CODES.credentialConsumed,
          message:
            'Credential was already used at handover and cannot be revoked',
        });
      }
      const revoked = await client.query<{ revoked_at_text: string }>(
        `UPDATE pickup_credentials
            SET revoked_at = now(), updated_at = now()
          WHERE id = $1 AND revoked_at IS NULL AND consumed_at IS NULL
          RETURNING ${SQL_TS('revoked_at')} AS revoked_at_text`,
        [credential.id],
      );
      if (revoked.rowCount !== 1) {
        throw new ConflictException({
          code: PICKUP_ERROR_CODES.handoverConflict,
          message: 'Pickup credential changed concurrently; retry',
        });
      }
      await this.appendPickupEvent(client, {
        orderId,
        eventType: 'pickup_credential.revoked',
        actorUserId,
        reason: trimmed,
        metadata: { credentialId: credential.id, orderId },
      });
      await this.audit.append(client, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: PICKUP_AUDIT_ACTIONS.revoked,
        targetType: 'pickup_credential',
        targetId: credential.id,
        reason: trimmed,
        metadata: { orderId },
      });
      return {
        data: {
          credentialId: credential.id,
          orderId,
          revokedAt: revoked.rows[0].revoked_at_text,
        },
      };
    });
  }

  /**
   * Side-effect-free verification of a presented code (staff). Read-only: no
   * event, no audit, no state change. Rejections mirror the handover flow so
   * what staff sees here is what handover will enforce.
   */
  async verifyCode(
    actorUserId: string,
    tenantId: string,
    code: string,
  ): Promise<{ data: PickupVerification }> {
    this.assertUuid(actorUserId, 'actor id');
    this.assertUuid(tenantId, 'tenant id');
    const security = this.securityConfig();
    const codeHash = this.hashCode(security.secret, this.normalizeCode(code));
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      'tenant.orders.handover',
    );
    const result = await this.database.pool.query<
      CredentialLookupRow & {
        status: OrderStatus;
        order_number: string | null;
        total_minor: string;
        currency: string;
        pickup_starts_at: string;
        pickup_ends_at: string;
        credential_expires_at: string;
        buyer_id: string;
        buyer_display_name: string;
      }
    >(
      `SELECT ${CREDENTIAL_LOOKUP_COLUMNS},
              o.status,
              o.order_number,
              o.total_minor::text AS total_minor,
              o.currency,
              ${SQL_TS('o.pickup_starts_at')} AS pickup_starts_at,
              ${SQL_TS('o.pickup_ends_at')} AS pickup_ends_at,
              ${SQL_TS('c.expires_at')} AS credential_expires_at,
              u.id AS buyer_id,
              u.display_name AS buyer_display_name
         FROM pickup_credentials c
         JOIN orders o ON o.id = c.order_id
         JOIN users u ON u.id = o.buyer_id
        WHERE c.code_hash = $1`,
      [codeHash],
    );
    const row = result.rows[0];
    this.assertCredentialUsable(row, tenantId);
    return {
      data: {
        orderId: row.order_id,
        orderNumber: row.order_number,
        status: row.status,
        readyForHandover: row.status === 'ready_for_pickup',
        buyer: { id: row.buyer_id, displayName: row.buyer_display_name },
        totalMinor: row.total_minor,
        currency: row.currency,
        pickupStartsAt: row.pickup_starts_at,
        pickupEndsAt: row.pickup_ends_at,
        credentialId: row.credential_id,
        credentialExpiresAt: row.credential_expires_at,
      },
    };
  }

  /**
   * One-time handover by pickup code. Single transaction:
   * credential lookup -> OrdersService.getOrderForHandover ->
   * OrdersService.markHandedOver (state transition + reservation consume +
   * order event + audit) -> consume credential -> insert order_handovers.
   *
   * Idempotency decision (documented in docs/modules/pickup.md): a replayed
   * handover is a CONSISTENT 409 (PICKUP_CREDENTIAL_CONSUMED) with no second
   * effect; it is never a silent 200, so staff always learns the code is used.
   */
  async handover(
    actorUserId: string,
    tenantId: string,
    code: string,
  ): Promise<{ data: PickupHandover }> {
    this.assertUuid(actorUserId, 'actor id');
    this.assertUuid(tenantId, 'tenant id');
    const security = this.securityConfig();
    const codeHash = this.hashCode(security.secret, this.normalizeCode(code));
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        'tenant.orders.handover',
        client,
      );
      const found = await client.query<CredentialLookupRow>(
        `SELECT ${CREDENTIAL_LOOKUP_COLUMNS}
           FROM pickup_credentials c
           JOIN orders o ON o.id = c.order_id
          WHERE c.code_hash = $1`,
        [codeHash],
      );
      const credential = found.rows[0];
      this.assertCredentialUsable(credential, tenantId);
      // Contract D16.6: the order side of the handover belongs to OrdersService.
      const order = await this.orders.getOrderForHandover(
        client,
        tenantId,
        credential.order_id,
      );
      await this.orders.markHandedOver(
        client,
        tenantId,
        order.orderId,
        actorUserId,
      );
      const consumed = await client.query<{ id: string }>(
        `UPDATE pickup_credentials
            SET consumed_at = now(), updated_at = now()
          WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
          RETURNING id`,
        [credential.credential_id],
      );
      if (consumed.rowCount !== 1) {
        throw new ConflictException({
          code: PICKUP_ERROR_CODES.credentialConsumed,
          message: 'Pickup credential was already used or revoked',
        });
      }
      try {
        const handover = await client.query<{
          id: string;
          handed_over_at_text: string;
        }>(
          `INSERT INTO order_handovers
             (order_id, credential_id, tenant_id, actor_user_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, ${SQL_TS('handed_over_at')} AS handed_over_at_text`,
          [order.orderId, credential.credential_id, tenantId, actorUserId],
        );
        return {
          data: {
            handoverId: handover.rows[0].id,
            orderId: order.orderId,
            credentialId: credential.credential_id,
            status: 'completed' as const,
            handedOverAt: handover.rows[0].handed_over_at_text,
          },
        };
      } catch (error) {
        const pgError = error as { code?: string; constraint?: string };
        if (
          pgError.code === '23505' &&
          (pgError.constraint === 'order_handovers_order_unique' ||
            pgError.constraint === 'order_handovers_credential_unique')
        ) {
          throw new ConflictException({
            code: PICKUP_ERROR_CODES.handoverConflict,
            message: 'Order was already handed over',
          });
        }
        throw error;
      }
    });
  }

  /**
   * Buyer read of their own active pickup code (re-display decision documented
   * in docs/modules/pickup.md): the code stays readable by the OWNER while the
   * credential is active, decrypted server-side from code_ciphertext. Another
   * buyer's order is a 404, never a 403 (no existence leak). Response carries
   * Cache-Control: no-store at the controller.
   */
  async getBuyerCredential(
    buyerUserId: string,
    orderId: string,
  ): Promise<{ data: BuyerPickupCredential }> {
    this.assertUuid(buyerUserId, 'buyer id');
    this.assertUuid(orderId, 'order id');
    const security = this.securityConfig();
    const result = await this.database.pool.query<{
      id: string;
      code_ciphertext: string;
      expires_at_text: string;
    }>(
      `SELECT c.id, c.code_ciphertext, ${SQL_TS('c.expires_at')} AS expires_at_text
         FROM pickup_credentials c
         JOIN orders o ON o.id = c.order_id
        WHERE c.order_id = $1
          AND o.buyer_id = $2
          AND c.revoked_at IS NULL
          AND c.consumed_at IS NULL`,
      [orderId, buyerUserId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException({
        code: PICKUP_ERROR_CODES.credentialNotFound,
        message: 'No active pickup credential for this order',
      });
    }
    let plaintext: string;
    try {
      plaintext = this.decrypt(security.encryptionKey, row.code_ciphertext);
    } catch {
      // Key rotation or corrupt ciphertext: fail closed without echoing the
      // stored value. Recovery path is staff-side rotation (D12.10).
      throw new ServiceUnavailableException({
        code: PICKUP_ERROR_CODES.codeUnavailable,
        message:
          'Pickup code could not be decrypted; ask the tenant to re-issue the credential',
      });
    }
    return {
      data: {
        credentialId: row.id,
        orderId,
        code: this.formatForDisplay(this.normalizeStored(plaintext)),
        expiresAt: row.expires_at_text,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Shared rejection ladder for a presented code (verify + handover):
   * unknown code -> 409 (not 404: a foreign code must stay distinguishable
   * from garbage per root brief, and 409 avoids client auth-interceptors
   * treating it as session expiry); foreign tenant -> 404 (existence is never
   * leaked across tenants); revoked/consumed -> 409; expired -> 410.
   */
  private assertCredentialUsable(
    row: CredentialLookupRow | undefined,
    tenantId: string,
  ): asserts row is CredentialLookupRow {
    if (!row) {
      throw new ConflictException({
        code: PICKUP_ERROR_CODES.codeInvalid,
        message: 'Pickup code is not valid',
      });
    }
    if (row.tenant_id !== tenantId) {
      throw new NotFoundException({
        code: PICKUP_ERROR_CODES.credentialNotFound,
        message: 'Pickup credential not found for this tenant',
      });
    }
    if (row.revoked) {
      throw new ConflictException({
        code: PICKUP_ERROR_CODES.credentialRevoked,
        message: 'Pickup credential was revoked; ask the tenant for a new code',
      });
    }
    if (row.consumed) {
      throw new ConflictException({
        code: PICKUP_ERROR_CODES.credentialConsumed,
        message: 'Pickup credential was already used at handover',
      });
    }
    if (row.expired) {
      throw new GoneException({
        code: PICKUP_ERROR_CODES.credentialExpired,
        message: 'Pickup credential expired; ask the tenant for a new code',
      });
    }
  }

  /**
   * Appends an order event with the same versioning scheme as
   * OrdersService.appendOrderEvent (max(version)+1). Callers MUST hold the
   * order row lock (FOR UPDATE) so concurrent appends serialize - every
   * mutating flow in this service locks the order row first.
   */
  private async appendPickupEvent(
    client: PoolClient,
    input: {
      orderId: string;
      eventType: 'pickup_credential.issued' | 'pickup_credential.revoked';
      actorUserId: string;
      reason: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const next = await client.query<{ version: number }>(
      `SELECT coalesce(max(version), 0) + 1 AS version
         FROM order_events WHERE order_id = $1`,
      [input.orderId],
    );
    await client.query(
      `INSERT INTO order_events
         (order_id, version, event_type, from_status, to_status, actor_user_id,
          actor_service, request_id, reason, metadata)
       VALUES ($1, $2, $3, NULL, NULL, $4, NULL, NULL, $5, $6::jsonb)`,
      [
        input.orderId,
        next.rows[0].version,
        input.eventType,
        input.actorUserId,
        input.reason,
        JSON.stringify(input.metadata),
      ],
    );
  }

  private securityConfig(): { secret: Buffer; encryptionKey: Buffer } {
    const notConfigured = (): ServiceUnavailableException =>
      new ServiceUnavailableException({
        code: PICKUP_ERROR_CODES.notConfigured,
        message: 'Pickup credential protection is not configured',
      });
    const secretText = this.config.get<string>('AUTH_SECRET');
    const encryptionKeyText = this.config.get<string>('AUTH_ENCRYPTION_KEY');
    if (!secretText || Buffer.byteLength(secretText, 'utf8') < 32) {
      throw notConfigured();
    }
    if (!encryptionKeyText) throw notConfigured();
    const encryptionKey = Buffer.from(encryptionKeyText, 'base64');
    if (encryptionKey.length !== 32) throw notConfigured();
    return { secret: Buffer.from(secretText, 'utf8'), encryptionKey };
  }

  private credentialTtlSeconds(): number {
    const value = this.config.get<number>(
      'PICKUP_CREDENTIAL_TTL_SECONDS',
      PICKUP_TTL_DEFAULT_SECONDS,
    );
    if (
      !Number.isSafeInteger(value) ||
      value < PICKUP_TTL_MIN_SECONDS ||
      value > PICKUP_TTL_MAX_SECONDS
    ) {
      throw new ServiceUnavailableException({
        code: PICKUP_ERROR_CODES.notConfigured,
        message: 'PICKUP_CREDENTIAL_TTL_SECONDS is out of bounds',
      });
    }
    return value;
  }

  private generateCode(): string {
    let code = '';
    for (let i = 0; i < PICKUP_CODE_LENGTH; i += 1) {
      code += PICKUP_CODE_ALPHABET[randomInt(0, PICKUP_CODE_ALPHABET.length)];
    }
    return code;
  }

  /** Uppercase and strip spaces/dashes so spoken or formatted codes match. */
  private normalizeCode(code: string): string {
    const normalized = (code ?? '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (!PICKUP_CODE_NORMALIZED_PATTERN.test(normalized)) {
      throw new BadRequestException(
        'code must be 4-32 alphanumeric characters after normalization',
      );
    }
    return normalized;
  }

  /** Defensive re-normalization of decrypted plaintext before display. */
  private normalizeStored(value: string): string {
    const normalized = value.trim().toUpperCase();
    if (!PICKUP_CODE_NORMALIZED_PATTERN.test(normalized)) {
      throw new ServiceUnavailableException({
        code: PICKUP_ERROR_CODES.codeUnavailable,
        message:
          'Pickup code could not be decrypted; ask the tenant to re-issue the credential',
      });
    }
    return normalized;
  }

  private formatForDisplay(normalizedCode: string): string {
    if (normalizedCode.length !== 8) return normalizedCode;
    return (
      normalizedCode.slice(0, 4) +
      PICKUP_CODE_DISPLAY_SEPARATOR +
      normalizedCode.slice(4)
    );
  }

  /** Deterministic lookup hash (same construction as the auth token hash). */
  private hashCode(secret: Buffer, normalizedCode: string): string {
    return createHmac('sha256', secret)
      .update(normalizedCode, 'utf8')
      .digest('hex');
  }

  /** AES-256-GCM, wire format base64(iv12 | tag16 | ciphertext) - auth pattern. */
  private encrypt(key: Buffer, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  private decrypt(key: Buffer, value: string): string {
    const payload = Buffer.from(value, 'base64');
    if (payload.length < 29) throw new Error('Invalid encrypted pickup code');
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }

  private assertUuid(value: string, label: string): void {
    if (!uuidPattern.test(value ?? '')) {
      throw new BadRequestException(`Invalid ${label}`);
    }
  }

  private async withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
