import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AvailabilityService } from '../src/modules/availability/availability.service';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { OutboxService } from '../src/modules/notifications/outbox.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { PickupService } from '../src/modules/pickup/pickup.service';
import { TenantOperatingHoursService } from '../src/modules/tenants/tenant-operating-hours.service';
import { WalletService } from '../src/modules/wallet/wallet.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const ITEM_PRICE_MINOR = 20000;
// Synthetic secrets for the disposable test database only (never real config).
const TEST_AUTH_SECRET = 'pickup-integration-test-secret-value-0123456789';
const TEST_TTL_SECONDS = 7200;

interface Fixture {
  campusId: string;
  tenantId: string;
  tenant2Id: string;
  buyerId: string;
  buyer2Id: string;
  ownerId: string;
  owner2Id: string;
  kitchenId: string;
  pickupStaffId: string;
  categoryId: string;
  itemId: string;
}

let orders: OrdersService;
let wallet: WalletService;
let pickup: PickupService;
let pool: Pool;

const MICROSECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DISPLAY_CODE = /^[2-9A-HJ-KM-NP-TV-Z]{4}-[2-9A-HJ-KM-NP-TV-Z]{4}$/;

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const response = error.getResponse();
  if (typeof response === 'object' && response !== null && 'code' in response) {
    return String((response as { code: unknown }).code);
  }
  return undefined;
}

function hmacOf(normalizedCode: string): string {
  return createHmac('sha256', Buffer.from(TEST_AUTH_SECRET, 'utf8'))
    .update(normalizedCode, 'utf8')
    .digest('hex');
}

/**
 * Unique, well-formed raw code per call. `pickup_credentials.code_hash` is
 * globally unique, so a hard-coded test code collides with itself on the second
 * run against the same database (23505 pickup_credentials_code_hash_unique).
 */
function rawCode(prefix: string): string {
  return (prefix + randomBytes(9).toString('hex')).toUpperCase();
}

describe(
  'Pickup credentials, verification and one-time handover (PostgreSQL)',
  { skip: !testDatabaseUrl },
  () => {
    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl, max: 20 });
      await pool.query('select 1');
      const database = { pool } as unknown as DatabaseService;
      const access = new AccessService(database);
      const audit = new AuditService(database, access);
      const operatingHours = new TenantOperatingHoursService(
        database,
        access,
        audit,
      );
      const availability = new AvailabilityService(
        database,
        access,
        operatingHours,
        audit,
      );
      const catalog = new CatalogService(database, access, availability, audit);
      wallet = new WalletService(database);
      const outbox = new OutboxService(database);
      const config: Record<string, string | number> = {
        ORDER_PROPOSAL_TTL_SECONDS: 600,
        // A wide preparation lead so the deterministic fixture slot (tomorrow
        // 10:00 Asia/Jakarta, always inside operating hours) is eligible for
        // "prepare" without depending on the wall clock: tomorrow 10:00 is at
        // most 34 hours away, so a two-day lead always covers it (a 24-hour
        // lead fails when the suite runs between 10:00 and 24:00 local time).
        // The production lead gate belongs to the orders slice, not this suite.
        ORDER_PREPARATION_LEAD_SECONDS: 172_800,
        AUTH_SECRET: TEST_AUTH_SECRET,
        AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        PICKUP_CREDENTIAL_TTL_SECONDS: TEST_TTL_SECONDS,
      };
      const configService = {
        get: (key: string, fallback?: unknown) =>
          key in config ? config[key] : fallback,
      } as unknown as ConfigService;
      orders = new OrdersService(
        database,
        access,
        catalog,
        availability,
        wallet,
        audit,
        outbox,
        configService,
      );
      pickup = new PickupService(
        database,
        access,
        orders,
        audit,
        configService,
      );
    });

    after(async () => {
      await pool?.end();
    });

    it('issues a credential for a ready order only, with hash-only storage, event and audit', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);

      // Not ready -> 409 PICKUP_NOT_READY (fresh paid order).
      const pendingSlot = await insertSlot(fx.tenantId, { offsetMinutes: 45 });
      const pending = await placeOrder(fx, pendingSlot, 'pickup-not-ready');
      await assert.rejects(
        pickup.issueCredential(fx.pickupStaffId, fx.tenantId, pending.id),
        (error: unknown) =>
          error instanceof ConflictException &&
          codeOf(error) === 'PICKUP_NOT_READY',
      );
      // Staff without tenant.orders.handover is rejected.
      await assert.rejects(
        pickup.issueCredential(fx.kitchenId, fx.tenantId, order.id),
        ForbiddenException,
      );

      const issued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      assert.match(issued.data.code, DISPLAY_CODE);
      assert.equal(issued.data.orderId, order.id);
      assert.equal(issued.data.rotatedFrom, null);
      assert.match(issued.data.expiresAt, MICROSECOND_UTC);

      const normalized = issued.data.code.replace(/-/g, '');
      const row = (
        await pool.query<{
          code_hash: string;
          code_ciphertext: string;
          consumed_at: string | null;
          revoked_at: string | null;
        }>(
          'SELECT code_hash, code_ciphertext, consumed_at, revoked_at FROM pickup_credentials WHERE id = $1',
          [issued.data.credentialId],
        )
      ).rows[0];
      // Deterministic HMAC-SHA256 lookup hash; plaintext never stored.
      assert.equal(row.code_hash, hmacOf(normalized));
      assert.match(row.code_hash, /^[a-f0-9]{64}$/);
      assert.ok(!row.code_ciphertext.includes(normalized));
      assert.equal(row.consumed_at, null);
      assert.equal(row.revoked_at, null);

      const events = await orderEvents(order.id);
      const issuedEvent = events.find(
        (event) => event.event_type === 'pickup_credential.issued',
      );
      assert.ok(issuedEvent, 'pickup_credential.issued event must exist');
      assert.equal(issuedEvent.actor_user_id, fx.pickupStaffId);
      assert.equal(
        (issuedEvent.metadata as { credentialId?: string }).credentialId,
        issued.data.credentialId,
      );
      assert.ok(
        !JSON.stringify(issuedEvent.metadata).includes(normalized),
        'event metadata must never contain the plaintext code',
      );
      const audits = await credentialAudits(order.id);
      assert.deepEqual(
        audits.map((row2) => row2.action),
        ['tenant.pickup.credential.issued'],
      );
    });

    it('lets the owning buyer re-read the code and 404s every other buyer', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);
      const issued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      const own = await pickup.getBuyerCredential(fx.buyerId, order.id);
      assert.equal(own.data.code, issued.data.code);
      assert.equal(own.data.credentialId, issued.data.credentialId);
      assert.match(own.data.expiresAt, MICROSECOND_UTC);
      await assert.rejects(
        pickup.getBuyerCredential(fx.buyer2Id, order.id),
        NotFoundException,
      );
      await assert.rejects(
        pickup.getBuyerCredential(fx.buyer2Id, randomUUID()),
        NotFoundException,
      );
    });

    it('verifies codes without side effects, normalized, and rejects unknown codes', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);
      const issued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      const before = await sideEffectCounts(order.id);

      // Typed as spoken: lowercase with spaces and dashes.
      const messy =
        ' ' + issued.data.code.toLowerCase().replace('-', ' - ') + ' ';
      const verification = await pickup.verifyCode(
        fx.pickupStaffId,
        fx.tenantId,
        messy,
      );
      assert.equal(verification.data.orderId, order.id);
      assert.equal(verification.data.status, 'ready_for_pickup');
      assert.equal(verification.data.readyForHandover, true);
      assert.equal(verification.data.buyer.id, fx.buyerId);
      assert.ok(verification.data.buyer.displayName.length > 0);
      assert.equal(verification.data.totalMinor, String(ITEM_PRICE_MINOR));
      assert.equal(verification.data.currency, 'IDR');
      assert.equal(verification.data.credentialId, issued.data.credentialId);
      assert.match(verification.data.credentialExpiresAt, MICROSECOND_UTC);
      assert.ok(
        verification.data.orderNumber === null ||
          /^AN-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/.test(
            verification.data.orderNumber,
          ),
      );

      // Unknown but well-formed code -> 409 PICKUP_CODE_INVALID (never 404).
      await assert.rejects(
        pickup.verifyCode(fx.pickupStaffId, fx.tenantId, 'ZZZZ9999'),
        (error: unknown) =>
          error instanceof ConflictException &&
          codeOf(error) === 'PICKUP_CODE_INVALID',
      );

      const after = await sideEffectCounts(order.id);
      assert.deepEqual(after, before, 'verification must not write anything');
    });

    it('hands over exactly once with the correct code: order, reservation, credential, handover row', async () => {
      const fx = await createFixture();
      const { order, slot } = await makeReadyOrder(fx);
      const issued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );

      const result = await pickup.handover(
        fx.pickupStaffId,
        fx.tenantId,
        issued.data.code.toLowerCase(),
      );
      assert.equal(result.data.status, 'completed');
      assert.equal(result.data.orderId, order.id);
      assert.equal(result.data.credentialId, issued.data.credentialId);
      assert.match(result.data.handedOverAt, MICROSECOND_UTC);

      const orderRow = (
        await pool.query<{
          status: string;
          completed_at: string | null;
          version: number;
        }>('SELECT status, completed_at, version FROM orders WHERE id = $1', [
          order.id,
        ])
      ).rows[0];
      assert.equal(orderRow.status, 'completed');
      assert.ok(orderRow.completed_at);

      const reservation = (
        await pool.query<{
          status: string;
          consumed_at: string | null;
          updated_at: string | null;
        }>(
          'SELECT status, consumed_at, updated_at FROM slot_reservations WHERE order_id = $1',
          [order.id],
        )
      ).rows[0];
      assert.equal(reservation.status, 'consumed');
      assert.ok(
        reservation.consumed_at,
        'reservation consumed_at must be set (D13.5)',
      );
      assert.ok(reservation.updated_at);
      // Consuming keeps the seat occupied for its slot.
      const slotRow = (
        await pool.query<{ reserved_count: number }>(
          'SELECT reserved_count FROM pickup_slots WHERE id = $1',
          [slot.id],
        )
      ).rows[0];
      assert.equal(slotRow.reserved_count, 1);

      const credential = (
        await pool.query<{
          consumed_at: string | null;
          revoked_at: string | null;
        }>(
          'SELECT consumed_at, revoked_at FROM pickup_credentials WHERE id = $1',
          [issued.data.credentialId],
        )
      ).rows[0];
      assert.ok(credential.consumed_at);
      assert.equal(credential.revoked_at, null);

      const handovers = await pool.query<{
        tenant_id: string;
        actor_user_id: string;
        credential_id: string;
      }>(
        'SELECT tenant_id, actor_user_id, credential_id FROM order_handovers WHERE order_id = $1',
        [order.id],
      );
      assert.equal(handovers.rowCount, 1);
      assert.equal(handovers.rows[0].tenant_id, fx.tenantId);
      assert.equal(handovers.rows[0].actor_user_id, fx.pickupStaffId);
      assert.equal(handovers.rows[0].credential_id, issued.data.credentialId);

      const events = await orderEvents(order.id);
      assert.ok(
        events.some(
          (event) =>
            event.event_type === 'order.status_changed' &&
            event.to_status === 'completed',
        ),
      );
      const audits = await pool.query<{ action: string }>(
        "SELECT action FROM audit_events WHERE target_type = 'order' AND target_id = $1 ORDER BY occurred_at",
        [order.id],
      );
      assert.ok(audits.rows.some((row) => row.action === 'order.completed'));
    });

    it('replays a finished handover as a consistent 409 with no second effect', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);
      const issued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      await pickup.handover(fx.pickupStaffId, fx.tenantId, issued.data.code);
      const before = await sideEffectCounts(order.id);
      const versionBefore = (
        await pool.query<{ version: number }>(
          'SELECT version FROM orders WHERE id = $1',
          [order.id],
        )
      ).rows[0].version;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          pickup.handover(fx.pickupStaffId, fx.tenantId, issued.data.code),
          (error: unknown) =>
            error instanceof ConflictException &&
            codeOf(error) === 'PICKUP_CREDENTIAL_CONSUMED',
        );
        await assert.rejects(
          pickup.verifyCode(fx.pickupStaffId, fx.tenantId, issued.data.code),
          (error: unknown) =>
            error instanceof ConflictException &&
            codeOf(error) === 'PICKUP_CREDENTIAL_CONSUMED',
        );
      }
      const after = await sideEffectCounts(order.id);
      assert.deepEqual(after, before, 'replay must not create a second effect');
      const versionAfter = (
        await pool.query<{ version: number }>(
          'SELECT version FROM orders WHERE id = $1',
          [order.id],
        )
      ).rows[0].version;
      assert.equal(versionAfter, versionBefore);
      // Buyer read of a consumed credential is a 404 (nothing active left).
      await assert.rejects(
        pickup.getBuyerCredential(fx.buyerId, order.id),
        NotFoundException,
      );
    });

    it('rejects a handover before ready_for_pickup and rolls every effect back', async () => {
      const fx = await createFixture();
      const slot = await insertSlot(fx.tenantId, { offsetMinutes: 60 });
      const order = await placeOrder(fx, slot, 'pickup-too-early');
      // Credential exists (raw insert, as if issued) but the order never
      // reached ready_for_pickup: markHandedOver must 409 and the transaction
      // must leave no consumed credential and no handover row behind.
      const tooEarlyCode = rawCode('RAW');
      await pool.query(
        "INSERT INTO pickup_credentials (order_id, code_hash, code_ciphertext, expires_at) VALUES ($1, $2, 'v1:test', now() + interval '2 hours')",
        [order.id, hmacOf(tooEarlyCode)],
      );
      const before = await sideEffectCounts(order.id);
      await assert.rejects(
        pickup.handover(fx.pickupStaffId, fx.tenantId, tooEarlyCode),
        (error: unknown) =>
          error instanceof ConflictException &&
          codeOf(error) === 'ORDER_STATE_CONFLICT',
      );
      const credential = (
        await pool.query<{ consumed_at: string | null }>(
          'SELECT consumed_at FROM pickup_credentials WHERE order_id = $1',
          [order.id],
        )
      ).rows[0];
      assert.equal(
        credential.consumed_at,
        null,
        'rollback must undo the consume',
      );
      const after = await sideEffectCounts(order.id);
      assert.deepEqual(after, before);
      assert.equal(
        (
          await pool.query<{ status: string }>(
            'SELECT status FROM orders WHERE id = $1',
            [order.id],
          )
        ).rows[0].status,
        'paid_awaiting_tenant',
      );
    });

    it('rejects expired codes with 410 on both verify and handover', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);
      const issued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      // Keep the DB CHECK (expires_at > created_at) intact while making the
      // credential expire immediately.
      await pool.query(
        "UPDATE pickup_credentials SET expires_at = created_at + interval '1 millisecond' WHERE id = $1",
        [issued.data.credentialId],
      );
      await pool.query('SELECT pg_sleep(0.05)');
      await assert.rejects(
        pickup.verifyCode(fx.pickupStaffId, fx.tenantId, issued.data.code),
        (error: unknown) =>
          error instanceof GoneException &&
          codeOf(error) === 'PICKUP_CREDENTIAL_EXPIRED',
      );
      await assert.rejects(
        pickup.handover(fx.pickupStaffId, fx.tenantId, issued.data.code),
        (error: unknown) =>
          error instanceof GoneException &&
          codeOf(error) === 'PICKUP_CREDENTIAL_EXPIRED',
      );
      // R3-05 (root decision): the owner read of an EXPIRED credential is a
      // 404 - the buyer must never present a ticket the counter will reject.
      await assert.rejects(
        pickup.getBuyerCredential(fx.buyerId, order.id),
        (error: unknown) =>
          error instanceof NotFoundException &&
          codeOf(error) === 'PICKUP_CREDENTIAL_NOT_FOUND',
      );
      const credential = (
        await pool.query<{ consumed_at: string | null }>(
          'SELECT consumed_at FROM pickup_credentials WHERE id = $1',
          [issued.data.credentialId],
        )
      ).rows[0];
      assert.equal(credential.consumed_at, null);
      assert.equal(
        (
          await pool.query<{ status: string }>(
            'SELECT status FROM orders WHERE id = $1',
            [order.id],
          )
        ).rows[0].status,
        'ready_for_pickup',
      );
    });

    it('rotates on re-issuance: the old code dies, the new code completes the handover', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);
      const first = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      const second = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      assert.equal(second.data.rotatedFrom, first.data.credentialId);
      assert.notEqual(second.data.code, first.data.code);

      const oldRow = (
        await pool.query<{ revoked_at: string | null }>(
          'SELECT revoked_at FROM pickup_credentials WHERE id = $1',
          [first.data.credentialId],
        )
      ).rows[0];
      assert.ok(
        oldRow.revoked_at,
        'rotation must revoke the previous credential',
      );

      await assert.rejects(
        pickup.handover(fx.pickupStaffId, fx.tenantId, first.data.code),
        (error: unknown) =>
          error instanceof ConflictException &&
          codeOf(error) === 'PICKUP_CREDENTIAL_REVOKED',
      );
      // Revoked credential is no longer the active one for the buyer.
      const active = await pickup.getBuyerCredential(fx.buyerId, order.id);
      assert.equal(active.data.code, second.data.code);

      const events = await orderEvents(order.id);
      assert.equal(
        events.filter(
          (event) => event.event_type === 'pickup_credential.revoked',
        ).length,
        1,
      );
      assert.equal(
        events.filter(
          (event) => event.event_type === 'pickup_credential.issued',
        ).length,
        2,
      );

      const done = await pickup.handover(
        fx.pickupStaffId,
        fx.tenantId,
        second.data.code,
      );
      assert.equal(done.data.status, 'completed');
    });

    it('revokes with a mandatory reason: audit, event, and the code stops working', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);
      const issued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      await assert.rejects(
        pickup.revokeCredential(fx.pickupStaffId, fx.tenantId, order.id, '   '),
        (error: unknown) => error instanceof HttpException,
      );
      const revoked = await pickup.revokeCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
        'Kode bocor di foto',
      );
      assert.equal(revoked.data.credentialId, issued.data.credentialId);
      assert.match(revoked.data.revokedAt, MICROSECOND_UTC);

      await assert.rejects(
        pickup.handover(fx.pickupStaffId, fx.tenantId, issued.data.code),
        (error: unknown) =>
          error instanceof ConflictException &&
          codeOf(error) === 'PICKUP_CREDENTIAL_REVOKED',
      );
      await assert.rejects(
        pickup.getBuyerCredential(fx.buyerId, order.id),
        NotFoundException,
      );
      // Revoking twice: nothing active remains -> 404.
      await assert.rejects(
        pickup.revokeCredential(
          fx.pickupStaffId,
          fx.tenantId,
          order.id,
          'lagi',
        ),
        (error: unknown) =>
          error instanceof NotFoundException &&
          codeOf(error) === 'PICKUP_CREDENTIAL_NOT_FOUND',
      );
      const revokedEvent = (await orderEvents(order.id)).find(
        (event) => event.event_type === 'pickup_credential.revoked',
      );
      assert.ok(revokedEvent);
      assert.equal(revokedEvent.reason, 'Kode bocor di foto');
      const audits = await credentialAudits(order.id);
      const revokedAudit = audits.find(
        (row) => row.action === 'tenant.pickup.credential.revoked',
      );
      assert.ok(revokedAudit);
      assert.equal(revokedAudit.reason, 'Kode bocor di foto');
    });

    it('404s a code that belongs to another tenant on verify and handover', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);
      const issued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      // owner2 is the verified owner (all permissions) of tenant B.
      await assert.rejects(
        pickup.verifyCode(fx.owner2Id, fx.tenant2Id, issued.data.code),
        (error: unknown) =>
          error instanceof NotFoundException &&
          codeOf(error) === 'PICKUP_CREDENTIAL_NOT_FOUND',
      );
      await assert.rejects(
        pickup.handover(fx.owner2Id, fx.tenant2Id, issued.data.code),
        (error: unknown) =>
          error instanceof NotFoundException &&
          codeOf(error) === 'PICKUP_CREDENTIAL_NOT_FOUND',
      );
      const before = await sideEffectCounts(order.id);
      assert.equal(
        (
          await pool.query<{ status: string }>(
            'SELECT status FROM orders WHERE id = $1',
            [order.id],
          )
        ).rows[0].status,
        'ready_for_pickup',
      );
      // The rightful tenant can still complete the order afterwards.
      const done = await pickup.handover(
        fx.pickupStaffId,
        fx.tenantId,
        issued.data.code,
      );
      assert.equal(done.data.status, 'completed');
      const after = await sideEffectCounts(order.id);
      assert.equal(after.handovers, before.handovers + 1);
    });

    it('database rejects consumed+revoked together, foreign-order handovers and two active credentials', async () => {
      const fx = await createFixture();
      const slot = await insertSlot(fx.tenantId, { offsetMinutes: 90 });
      const order = await placeOrder(fx, slot, 'pickup-db-rules');
      const otherSlot = await insertSlot(fx.tenantId, { offsetMinutes: 120 });
      const otherOrder = await placeOrder(fx, otherSlot, 'pickup-db-rules-2');
      const consumedCredentialId = randomUUID();
      const foreignCredentialId = randomUUID();
      await pool.query(
        "INSERT INTO pickup_credentials (id, order_id, code_hash, code_ciphertext, expires_at, consumed_at) VALUES ($1, $2, $3, 'v1:test', now() + interval '2 hours', now())",
        [consumedCredentialId, order.id, hmacOf(rawCode('DBR'))],
      );
      // CHECK pickup_credentials_consume_revoke_check: never both.
      await assert.rejects(
        pool.query(
          'UPDATE pickup_credentials SET revoked_at = now() WHERE id = $1',
          [consumedCredentialId],
        ),
        (error: unknown) => {
          const pgError = error as { code?: string; constraint?: string };
          return (
            pgError.code === '23514' &&
            pgError.constraint === 'pickup_credentials_consume_revoke_check'
          );
        },
      );
      // FK order_handovers(order_id, credential_id) -> pickup_credentials(order_id, id):
      // a handover cannot pair an order with another order's credential.
      await pool.query(
        "INSERT INTO pickup_credentials (id, order_id, code_hash, code_ciphertext, expires_at) VALUES ($1, $2, $3, 'v1:test', now() + interval '2 hours')",
        [foreignCredentialId, otherOrder.id, hmacOf(rawCode('DBX'))],
      );
      await assert.rejects(
        pool.query(
          'INSERT INTO order_handovers (order_id, credential_id, tenant_id, actor_user_id) VALUES ($1, $2, $3, $4)',
          [order.id, foreignCredentialId, fx.tenantId, fx.pickupStaffId],
        ),
        (error: unknown) => {
          const pgError = error as { code?: string; constraint?: string };
          return (
            pgError.code === '23503' &&
            pgError.constraint === 'order_handovers_order_credential_fk'
          );
        },
      );
      // Partial unique: one active (revoked_at IS NULL) credential per order.
      await assert.rejects(
        pool.query(
          "INSERT INTO pickup_credentials (order_id, code_hash, code_ciphertext, expires_at) VALUES ($1, $2, 'v1:test', now() + interval '2 hours')",
          [order.id, hmacOf(rawCode('DBU'))],
        ),
        (error: unknown) => {
          const pgError = error as { code?: string; constraint?: string };
          return (
            pgError.code === '23505' &&
            pgError.constraint === 'pickup_credentials_one_current_order_unique'
          );
        },
      );
    });

    it('maps the partial-unique collision of a consumed credential to 409, never 500 (R3-03)', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);
      // A consumed credential still occupies the partial unique slot
      // (revoked_at IS NULL), so re-issuance cannot insert a second one.
      await pool.query(
        "INSERT INTO pickup_credentials (order_id, code_hash, code_ciphertext, expires_at, consumed_at) VALUES ($1, $2, 'v1:test', now() + interval '2 hours', now())",
        [order.id, hmacOf(rawCode('R3C'))],
      );
      const before = await sideEffectCounts(order.id);
      await assert.rejects(
        pickup.issueCredential(fx.pickupStaffId, fx.tenantId, order.id),
        (error: unknown) =>
          error instanceof ConflictException &&
          codeOf(error) === 'PICKUP_CREDENTIAL_CONSUMED',
      );
      const after = await sideEffectCounts(order.id);
      assert.deepEqual(after, before, 'the failed issuance must roll back');
    });

    it('rejects issue, verify and handover of a cancelled order and 404s the buyer read (R3-04)', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);
      const issued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      await cancelOrder(order.id, fx.ownerId, 'Kampus membatalkan pesanan');

      await assert.rejects(
        pickup.issueCredential(fx.pickupStaffId, fx.tenantId, order.id),
        (error: unknown) =>
          error instanceof ConflictException &&
          codeOf(error) === 'PICKUP_ORDER_NOT_ELIGIBLE',
      );
      await assert.rejects(
        pickup.verifyCode(fx.pickupStaffId, fx.tenantId, issued.data.code),
        (error: unknown) =>
          error instanceof ConflictException &&
          codeOf(error) === 'PICKUP_ORDER_NOT_ELIGIBLE',
      );
      await assert.rejects(
        pickup.handover(fx.pickupStaffId, fx.tenantId, issued.data.code),
        (error: unknown) =>
          error instanceof ConflictException &&
          codeOf(error) === 'PICKUP_ORDER_NOT_ELIGIBLE',
      );
      // The buyer must never be shown a code the counter is guaranteed to
      // reject, even though the credential row is still "active".
      await assert.rejects(
        pickup.getBuyerCredential(fx.buyerId, order.id),
        (error: unknown) =>
          error instanceof NotFoundException &&
          codeOf(error) === 'PICKUP_CREDENTIAL_NOT_FOUND',
      );
      assert.equal(
        (
          await pool.query<{ status: string }>(
            'SELECT status FROM orders WHERE id = $1',
            [order.id],
          )
        ).rows[0].status,
        'cancelled',
      );
    });

    it('lets exactly one of two parallel handovers win (R3-02c)', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);
      const issued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      const results = await Promise.allSettled([
        pickup.handover(fx.pickupStaffId, fx.tenantId, issued.data.code),
        pickup.handover(fx.pickupStaffId, fx.tenantId, issued.data.code),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      assert.equal(fulfilled.length, 1, 'exactly one handover must succeed');
      assert.equal(rejected.length, 1);
      const rejection = rejected[0].reason;
      assert.ok(
        rejection instanceof ConflictException,
        'the loser must get a domain 409, never a raw database error',
      );
      assert.ok(
        ['PICKUP_CREDENTIAL_CONSUMED', 'PICKUP_HANDOVER_CONFLICT'].includes(
          codeOf(rejection) ?? '',
        ),
        'unexpected loser code: ' + String(codeOf(rejection)),
      );
      assert.equal(
        (
          await pool.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM order_handovers WHERE order_id = $1',
            [order.id],
          )
        ).rows[0].n,
        '1',
      );
      const credential = (
        await pool.query<{
          consumed_at: string | null;
          revoked_at: string | null;
        }>(
          'SELECT consumed_at, revoked_at FROM pickup_credentials WHERE id = $1',
          [issued.data.credentialId],
        )
      ).rows[0];
      assert.ok(credential.consumed_at);
      assert.equal(credential.revoked_at, null);
      assert.equal(
        (
          await pool.query<{ status: string }>(
            'SELECT status FROM orders WHERE id = $1',
            [order.id],
          )
        ).rows[0].status,
        'completed',
      );
    });

    it('reports REVOKED (not CONSUMED) when a handover loses to a rotation (R3-11)', async () => {
      const fx = await createFixture();
      const { order } = await makeReadyOrder(fx);
      const issued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      // Hold the order row and revoke the credential in an uncommitted
      // transaction: the handover blocks on the order lock, then finds its
      // credential revoked when it tries to consume it. Deterministic
      // reproduction of the handover-vs-rotation race.
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [
          order.id,
        ]);
        await blocker.query(
          'UPDATE pickup_credentials SET revoked_at = now(), updated_at = now() WHERE id = $1',
          [issued.data.credentialId],
        );
        const handover = pickup.handover(
          fx.pickupStaffId,
          fx.tenantId,
          issued.data.code,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        await blocker.query('COMMIT');
        await assert.rejects(
          handover,
          (error: unknown) =>
            error instanceof ConflictException &&
            codeOf(error) === 'PICKUP_CREDENTIAL_REVOKED',
        );
      } finally {
        blocker.release();
      }
      // Nothing was consumed and the order is still waiting for a new code.
      assert.equal(
        (
          await pool.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM order_handovers WHERE order_id = $1',
            [order.id],
          )
        ).rows[0].n,
        '0',
      );
      assert.equal(
        (
          await pool.query<{ status: string }>(
            'SELECT status FROM orders WHERE id = $1',
            [order.id],
          )
        ).rows[0].status,
        'ready_for_pickup',
      );
      assert.equal(
        (
          await pool.query<{ consumed_at: string | null }>(
            'SELECT consumed_at FROM pickup_credentials WHERE id = $1',
            [issued.data.credentialId],
          )
        ).rows[0].consumed_at,
        null,
      );
      // A freshly issued code still completes the order afterwards.
      const reissued = await pickup.issueCredential(
        fx.pickupStaffId,
        fx.tenantId,
        order.id,
      );
      const done = await pickup.handover(
        fx.pickupStaffId,
        fx.tenantId,
        reissued.data.code,
      );
      assert.equal(done.data.status, 'completed');
    });

    it('serializes a handover against a concurrent rotation without double effects (R3-02c)', async () => {
      for (let round = 0; round < 3; round += 1) {
        const fx = await createFixture();
        const { order } = await makeReadyOrder(fx);
        const issued = await pickup.issueCredential(
          fx.pickupStaffId,
          fx.tenantId,
          order.id,
        );
        const results = await Promise.allSettled([
          pickup.handover(fx.pickupStaffId, fx.tenantId, issued.data.code),
          pickup.issueCredential(fx.pickupStaffId, fx.tenantId, order.id),
        ]);
        const handoverWon = results[0].status === 'fulfilled';
        assert.equal(
          [results[0], results[1]].filter((r) => r.status === 'fulfilled')
            .length,
          1,
          'exactly one of handover/rotation must win',
        );
        const orderRow = (
          await pool.query<{ status: string }>(
            'SELECT status FROM orders WHERE id = $1',
            [order.id],
          )
        ).rows[0];
        const handovers = (
          await pool.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM order_handovers WHERE order_id = $1',
            [order.id],
          )
        ).rows[0].n;
        const active = (
          await pool.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM pickup_credentials WHERE order_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL',
            [order.id],
          )
        ).rows[0].n;
        if (handoverWon) {
          assert.equal(orderRow.status, 'completed');
          assert.equal(handovers, '1');
          assert.equal(active, '0');
          const rotation = results[1] as PromiseRejectedResult;
          assert.ok(rotation.reason instanceof ConflictException);
          assert.equal(codeOf(rotation.reason), 'PICKUP_NOT_READY');
        } else {
          assert.equal(orderRow.status, 'ready_for_pickup');
          assert.equal(handovers, '0');
          assert.equal(active, '1');
          const handover = results[0] as PromiseRejectedResult;
          assert.ok(
            handover.reason instanceof ConflictException,
            'a lost handover must be a domain 409',
          );
          assert.ok(
            ['PICKUP_CREDENTIAL_REVOKED', 'PICKUP_HANDOVER_CONFLICT'].includes(
              codeOf(handover.reason) ?? '',
            ),
            'unexpected loser code: ' + String(codeOf(handover.reason)),
          );
        }
      }
    });
  },
);

async function sideEffectCounts(orderId: string): Promise<{
  events: number;
  credentialAudits: number;
  handovers: number;
  credentials: number;
}> {
  const events = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM order_events WHERE order_id = $1',
    [orderId],
  );
  const credentialAudits = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM audit_events WHERE target_type = 'pickup_credential' AND metadata->>'orderId' = $1",
    [orderId],
  );
  const handovers = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM order_handovers WHERE order_id = $1',
    [orderId],
  );
  const credentials = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM pickup_credentials WHERE order_id = $1',
    [orderId],
  );
  return {
    events: Number(events.rows[0].n),
    credentialAudits: Number(credentialAudits.rows[0].n),
    handovers: Number(handovers.rows[0].n),
    credentials: Number(credentials.rows[0].n),
  };
}

async function orderEvents(orderId: string): Promise<
  {
    event_type: string;
    to_status: string | null;
    actor_user_id: string | null;
    reason: string;
    metadata: unknown;
  }[]
> {
  const result = await pool.query(
    'SELECT event_type, to_status, actor_user_id, reason, metadata FROM order_events WHERE order_id = $1 ORDER BY version',
    [orderId],
  );
  return result.rows;
}

async function credentialAudits(
  orderId: string,
): Promise<{ action: string; reason: string }[]> {
  const result = await pool.query<{ action: string; reason: string }>(
    "SELECT action, reason FROM audit_events WHERE target_type = 'pickup_credential' AND metadata->>'orderId' = $1 ORDER BY occurred_at",
    [orderId],
  );
  return result.rows;
}

async function placeOrder(
  fx: Fixture,
  slot: { id: string; version: number },
  key?: string,
  quantity = 1,
) {
  const result = await orders.checkout(
    fx.buyerId,
    key ?? 'checkout-' + randomUUID(),
    {
      tenantId: fx.tenantId,
      slotId: slot.id,
      expectedSlotVersion: slot.version,
      items: [{ menuItemId: fx.itemId, quantity }],
    },
  );
  return result.data;
}

async function makeReadyOrder(
  fx: Fixture,
  options: { offsetMinutes?: number } = {},
): Promise<{ order: { id: string }; slot: { id: string; version: number } }> {
  const slot = await insertSlot(fx.tenantId, {
    offsetMinutes: options.offsetMinutes ?? 30,
  });
  const order = await placeOrder(fx, slot);
  await orders.tenantTransition(fx.ownerId, fx.tenantId, order.id, 'confirm');
  await orders.tenantTransition(fx.kitchenId, fx.tenantId, order.id, 'prepare');
  await orders.tenantTransition(fx.kitchenId, fx.tenantId, order.id, 'ready');
  return { order, slot };
}

/** Cancels through the orders contract (never a direct orders write). */
async function cancelOrder(
  orderId: string,
  actorUserId: string,
  reason: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await orders.cancelForRefundDecision(client, orderId, actorUserId, reason);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function jakartaLocalDate(daysFromNow: number): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(Date.now() + daysFromNow * 86_400_000));
}

/**
 * Deterministic slot fixture: tomorrow 10:00 Asia/Jakarta plus an offset, so a
 * slot is always in the future AND inside the fixture's 00:00..23:59:59
 * operating hours regardless of when the suite runs (a "now + 120 minutes" slot
 * crosses midnight in the evening and is then rejected as outside operating
 * hours). ORDER_PREPARATION_LEAD_SECONDS is 0 in this suite, so the fixture
 * does not need the slot to sit inside the production preparation lead.
 */
async function insertSlot(
  tenantId: string,
  options: { offsetMinutes?: number; capacity?: number } = {},
): Promise<{ id: string; version: number }> {
  const offset = options.offsetMinutes ?? 0;
  const result = await pool.query<{ id: string; version: number }>(
    `INSERT INTO pickup_slots
       (tenant_id, starts_at, ends_at, capacity, reserved_count, status, updated_at)
     VALUES ($1,
             (($3::date + '10:00'::time) + ($2::int * interval '1 minute'))
               AT TIME ZONE 'Asia/Jakarta',
             (($3::date + '11:00'::time) + ($2::int * interval '1 minute'))
               AT TIME ZONE 'Asia/Jakarta',
             $4, 0, 'open', now())
     RETURNING id, version`,
    [tenantId, offset, jakartaLocalDate(1), options.capacity ?? 5],
  );
  return result.rows[0];
}

async function createFixture(): Promise<Fixture> {
  const id = randomUUID();
  const campusId = (
    await pool.query<{ id: string }>(
      "INSERT INTO campuses (name, timezone, status) VALUES ($1, 'Asia/Jakarta', 'active') RETURNING id",
      ['Campus ' + id],
    )
  ).rows[0].id;
  const insertTenant = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        "INSERT INTO tenants (campus_id, name, location, status) VALUES ($1, $2, 'Kantin Uji', 'open') RETURNING id",
        [campusId, name + ' ' + id],
      )
    ).rows[0].id;
  const tenantId = await insertTenant('Tenant A');
  const tenant2Id = await insertTenant('Tenant B');
  const insertUser = async (name: string) =>
    (
      await pool.query<{ id: string }>(
        'INSERT INTO users (display_name) VALUES ($1) RETURNING id',
        [name + ' ' + id],
      )
    ).rows[0].id;
  const buyerId = await insertUser('Buyer');
  const buyer2Id = await insertUser('Buyer2');
  const ownerId = await insertUser('Owner');
  const owner2Id = await insertUser('Owner2');
  const kitchenId = await insertUser('Kitchen');
  const pickupStaffId = await insertUser('PickupStaff');

  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) VALUES ($1, $2, 'owner', '{}', 'active', now())",
    [tenantId, ownerId],
  );
  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status, owner_verified_at) VALUES ($1, $2, 'owner', '{}', 'active', now())",
    [tenant2Id, owner2Id],
  );
  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status) VALUES ($1, $2, 'kitchen', '{tenant.orders.read,tenant.orders.accept,tenant.orders.prepare}', 'active')",
    [tenantId, kitchenId],
  );
  await pool.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, permissions, status) VALUES ($1, $2, 'pickup', '{tenant.orders.read,tenant.orders.handover}', 'active')",
    [tenantId, pickupStaffId],
  );
  for (const tenant of [tenantId, tenant2Id]) {
    await pool.query(
      "INSERT INTO tenant_operating_hours (tenant_id, weekday, is_open, opens_at, closes_at, updated_at) SELECT $1, g, true, '00:00:00'::time, '23:59:59'::time, now() FROM generate_series(0, 6) AS g",
      [tenant],
    );
  }
  const categoryId = (
    await pool.query<{ id: string }>(
      "INSERT INTO menu_categories (tenant_id, name, sort_order, status) VALUES ($1, 'Makanan', 0, 'active') RETURNING id",
      [tenantId],
    )
  ).rows[0].id;
  const itemId = (
    await pool.query<{ id: string }>(
      "INSERT INTO menu_items (tenant_id, category_id, name, description, price_minor, status, version, updated_at) VALUES ($1,$2,'Nasi Ayam','Deskripsi',$3,'active',1, now()) RETURNING id",
      [tenantId, categoryId, ITEM_PRICE_MINOR],
    )
  ).rows[0].id;
  const funding = await wallet.ensureSystemAccount('test.funding', 'IDR');
  const target = await wallet.getOrCreateWallet(buyerId, 'IDR');
  await wallet.postTransfer({
    idempotencyScope: 'test.funding',
    idempotencyKey: randomUUID(),
    currency: 'IDR',
    amountMinor: '10000000',
    debitAccountId: funding.accountId,
    creditAccountId: target.accountId,
    actor: { type: 'service', id: 'test.funding' },
    reason: 'test funding',
  });
  return {
    campusId,
    tenantId,
    tenant2Id,
    buyerId,
    buyer2Id,
    ownerId,
    owner2Id,
    kitchenId,
    pickupStaffId,
    categoryId,
    itemId,
  };
}
