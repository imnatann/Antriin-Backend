import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import type { TenantPermission } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { AvailabilityService } from '../availability/availability.service';
import type { OrderQuote, QuoteItemInput } from '../catalog/catalog.service';
import { CatalogService } from '../catalog/catalog.service';
import { OutboxService } from '../notifications/outbox.service';
import { WalletService } from '../wallet/wallet.service';
import { generateOrderNumber } from './order-number';
import {
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_RETENTION_DAYS,
  MAX_CHECKOUT_LINES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_ITEM_NOTES_LENGTH,
  MAX_LINE_OPTIONS,
  MAX_LINE_QUANTITY,
  MAX_SPECIAL_REQUEST_LENGTH,
  ORDER_CHECKOUT_ROUTE,
  ORDER_NUMBER_ATTEMPTS,
  ORDER_PAGE_LIMIT_DEFAULT,
  ORDER_PAGE_LIMIT_MAX,
  PAYMENT_ESCROW_SYSTEM_KEY,
  PRE_PRODUCTION_STATUSES,
  TENANT_ORDER_PERMISSIONS,
  TERMINAL_STATUSES,
} from './orders.constants';
import type { OrderStatus } from './orders.constants';

// D7: timestamps that clients may echo back are emitted by PostgreSQL with
// microsecond precision; never re-serialize them through new Date().
const TS = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const ORDER_COLUMNS = `
  o.id, o.order_number, o.buyer_id, o.tenant_id, o.pickup_slot_id,
  o.tenant_name_snapshot, o.tenant_timezone_snapshot,
  o.status, o.currency,
  o.subtotal_minor::text AS subtotal_minor,
  o.total_minor::text AS total_minor,
  o.special_request, o.version,
  ${TS('o.pickup_starts_at')} AS pickup_starts_at_text,
  ${TS('o.pickup_ends_at')} AS pickup_ends_at_text,
  ${TS('o.created_at')} AS created_at_text,
  ${TS('o.updated_at')} AS updated_at_text,
  ${TS('o.paid_at')} AS paid_at_text,
  ${TS('o.confirmed_at')} AS confirmed_at_text,
  ${TS('o.preparing_at')} AS preparing_at_text,
  ${TS('o.ready_at')} AS ready_at_text,
  ${TS('o.completed_at')} AS completed_at_text,
  ${TS('o.declined_at')} AS declined_at_text,
  ${TS('o.cancelled_at')} AS cancelled_at_text,
  u.display_name AS buyer_display_name`;

const ORDER_FROM = 'FROM orders o LEFT JOIN users u ON u.id = o.buyer_id';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const UUID_PIPE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CheckoutInput {
  tenantId: string;
  slotId: string;
  expectedSlotVersion: number;
  items: {
    menuItemId: string;
    quantity: number;
    optionIds?: readonly string[];
    notes?: string;
  }[];
  specialRequest?: string;
}

export interface OrderItemOptionView {
  id: string;
  groupId: string;
  choiceId: string;
  groupName: string;
  name: string;
  priceDeltaMinor: string;
  groupVersion: number;
  choiceVersion: number;
}

export interface OrderItemView {
  id: string;
  menuItemId: string;
  categoryId: string;
  name: string;
  description: string;
  menuVersion: number;
  quantity: number;
  baseUnitPriceMinor: string;
  unitPriceMinor: string;
  lineTotalMinor: string;
  notes: string;
  options: OrderItemOptionView[];
}

export interface OrderPaymentView {
  id: string;
  method: 'wallet';
  status: 'succeeded';
  amountMinor: string;
  currency: 'IDR';
  ledgerTransactionId: string;
  succeededAt: string | null;
}

export interface ScheduleProposalView {
  id: string;
  orderId: string;
  status: 'pending_buyer' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
  oldSlotId: string;
  proposedSlotId: string;
  oldStartsAt: string;
  oldEndsAt: string;
  proposedStartsAt: string;
  proposedEndsAt: string;
  expectedSlotVersion: number;
  expectedOrderVersion: number;
  reason: string;
  createdByUserId: string;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderSummaryView {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  buyer: { id: string; displayName: string };
  tenantId: string;
  tenantName: string;
  timezone: string;
  slotId: string;
  pickupStartsAt: string;
  pickupEndsAt: string;
  currency: 'IDR';
  subtotalMinor: string;
  totalMinor: string;
  specialRequest: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  confirmedAt: string | null;
  preparingAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  declinedAt: string | null;
  cancelledAt: string | null;
}

export interface OrderView extends OrderSummaryView {
  items: OrderItemView[];
  payment: OrderPaymentView | null;
  scheduleProposal: ScheduleProposalView | null;
}

/**
 * Result of a manager refund decision that cancels an order. Consumed by the
 * refunds/cases slice (wave 3) which executes the actual money movement.
 */
export interface OrderRefundDecisionResult {
  orderId: string;
  buyerId: string;
  tenantId: string;
  status: string;
  totalMinor: string;
  currency: string;
  orderPaymentId: string;
}

/** Stable contract for the pickup slice (see docs/modules/orders.md). */
export interface OrderHandoverContext {
  orderId: string;
  tenantId: string;
  buyerId: string;
  status: OrderStatus;
  pickupSlotId: string;
  totalMinor: string;
  currency: string;
}

interface OrderRow {
  id: string;
  order_number: string;
  buyer_id: string;
  tenant_id: string;
  pickup_slot_id: string;
  tenant_name_snapshot: string;
  tenant_timezone_snapshot: string;
  status: OrderStatus;
  currency: string;
  subtotal_minor: string;
  total_minor: string;
  special_request: string;
  version: number;
  pickup_starts_at_text: string;
  pickup_ends_at_text: string;
  created_at_text: string;
  updated_at_text: string;
  paid_at_text: string | null;
  confirmed_at_text: string | null;
  preparing_at_text: string | null;
  ready_at_text: string | null;
  completed_at_text: string | null;
  declined_at_text: string | null;
  cancelled_at_text: string | null;
  buyer_display_name: string;
}

interface LockedOrderRow extends OrderRow {
  preparation_allowed: boolean;
}

interface OrderItemRow {
  id: string;
  source_menu_item_id: string;
  source_category_id: string;
  name_snapshot: string;
  description_snapshot: string;
  menu_version: number;
  quantity: number;
  base_unit_price_minor: string;
  unit_price_minor: string;
  line_total_minor: string;
  notes: string;
}

interface OrderItemOptionRow {
  id: string;
  order_item_id: string;
  source_group_id: string;
  source_choice_id: string;
  group_name_snapshot: string;
  name_snapshot: string;
  price_delta_minor: string;
  group_version: number;
  choice_version: number;
}

interface PaymentRow {
  id: string;
  method: string;
  status: string;
  amount_minor: string;
  currency: string;
  ledger_transaction_id: string;
  succeeded_at_text: string | null;
}

interface ProposalRow {
  id: string;
  order_id: string;
  status: ScheduleProposalView['status'];
  old_slot_id: string;
  proposed_slot_id: string;
  old_starts_at_text: string;
  old_ends_at_text: string;
  proposed_starts_at_text: string;
  proposed_ends_at_text: string;
  expected_slot_version: number;
  expected_order_version: number;
  reason: string;
  created_by_user_id: string;
  expires_at_text: string;
  decided_at_text: string | null;
  created_at_text: string;
  updated_at_text: string;
}

interface Cursor {
  createdAt: string;
  id: string;
}

type CheckoutReplay = {
  data: OrderView;
  meta: { replayed: boolean };
};

/**
 * Orders slice: atomic checkout, tenant fulfilment state machine and schedule
 * proposals.
 *
 * Financial safety rules enforced here (docs/PILOT-POLICY.md, D12):
 * - checkout is ONE PostgreSQL transaction: idempotency check -> server quote ->
 *   capacity reservation -> wallet debit (double-entry) -> order + item/option
 *   snapshots + payment + event + audit + outbox. Any failure rolls back every
 *   step, so there is never a debit without an order, or a reservation without
 *   a payment.
 * - the server never trusts client prices/totals/status; money is integer minor
 *   units transported as decimal strings (numeric in DB, BigInt in JS).
 * - declining releases the capacity reservation and records a refund
 *   OBLIGATION only; no wallet credit happens in this slice (refunds are
 *   executed by the wave-3 refunds module after provider success).
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly catalog: CatalogService,
    private readonly availability: AvailabilityService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Buyer checkout (atomic)
  // ---------------------------------------------------------------------------

  /**
   * POST /v1/orders. Idempotent per (buyer, Idempotency-Key) and additionally
   * refuses a different key that replays the same canonical payload, so a
   * retry storm cannot create two orders.
   *
   * Root decision D15 (docs/reviews/wave1-decisions.md) fixes the official
   * step order inside ONE transaction:
   *   1. idempotency claim (advisory locks per buyer+key and buyer+payload)
   *   2. server quote (read-only re-pricing)
   *   3. INSERT orders (paid_at NULL for now)
   *   4. INSERT order_items + order_item_options snapshots
   *   5. reserveForCheckout  <- requires the orders row to exist
   *      (FK slot_reservations.order_id -> orders(id), migration 0007)
   *   6. wallet debit, then UPDATE orders SET paid_at = now()
   *   7. INSERT order_payments
   *   8. order_events + audit + outbox
   *   9. persist the idempotency response
   * Any failure rolls back every step, so a debit can never survive without an
   * order, and a reservation can never survive without a payment.
   */
  async checkout(
    buyerId: string,
    idempotencyKey: string,
    input: CheckoutInput,
  ): Promise<CheckoutReplay> {
    this.assertUuid(buyerId, 'buyer id');
    this.assertIdempotencyKey(idempotencyKey);
    const items = this.normalizeCheckoutItems(input.items);
    const normalized: CheckoutInput = {
      tenantId: input.tenantId,
      slotId: input.slotId,
      expectedSlotVersion: input.expectedSlotVersion,
      items,
      specialRequest: (input.specialRequest ?? '').trim(),
    };
    this.validateCheckout(normalized);
    const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
    const requestHash = this.hashCheckoutRequest(normalized);
    const quoteItems: QuoteItemInput[] = items.map((item) => ({
      menuItemId: item.menuItemId,
      quantity: item.quantity,
      optionIds: item.optionIds ?? [],
    }));
    // D15: a serialization/deadlock failure (40P01) or a serialization failure
    // (40001) is retried AT MOST once; the retry wraps a transaction that never
    // committed, so no financial effect can be duplicated.
    return this.withTransactionRetry(() =>
      this.withTransaction((client) =>
        this.checkoutInTransaction(client, {
          buyerId,
          keyHash,
          requestHash,
          input: normalized,
          quoteItems,
        }),
      ),
    );
  }

  private async checkoutInTransaction(
    client: PoolClient,
    context: {
      buyerId: string;
      keyHash: string;
      requestHash: string;
      input: CheckoutInput;
      quoteItems: QuoteItemInput[];
    },
  ): Promise<CheckoutReplay> {
    const { buyerId, keyHash, requestHash, input, quoteItems } = context;
    // 1. Idempotency claim: serialize identical keys, and identical payloads
    // under a different key, in a fixed order (no deadlock between the two
    // advisory-lock domains).
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`orders.checkout.key:${buyerId}:${keyHash}`],
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`orders.checkout.payload:${buyerId}:${requestHash}`],
    );
    const replay = await this.findIdempotentReplay(
      client,
      buyerId,
      keyHash,
      requestHash,
    );
    if (replay) return replay;

    const buyer = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 AND status = 'active'",
      [buyerId],
    );
    if (!buyer.rows[0]) throw new NotFoundException('Buyer account not found');

    // P2-05: pin the tenant row (shared) before reading any tenant state, so a
    // concurrent tenant archive cannot slip between the check and the commit.
    await this.lockTenantForOrderCommitment(client, input.tenantId);

    // Lock the slot row FOR UPDATE *before* quoting. CatalogService.quote takes
    // FOR SHARE on the same row; acquiring the stronger lock first removes the
    // share->update upgrade that deadlocked parallel checkouts (D15.B).
    const slotContext = await this.availability.assertBookableSlot(
      client,
      input.tenantId,
      input.slotId,
      'update',
    );
    if (slotContext.version !== input.expectedSlotVersion) {
      throw new ConflictException({
        code: 'SLOT_VERSION_CONFLICT',
        message: 'Pickup slot changed; request a new quote',
      });
    }

    // 2. Server-side re-pricing: never trust client prices/totals.
    const quote: OrderQuote = await this.catalog.quote(
      client,
      input.tenantId,
      input.slotId,
      quoteItems,
    );

    // 3. Order row first: slot_reservations.order_id has a real FK to
    // orders(id) since migration 0007, so the reservation must come after it.
    const orderId = randomUUID();
    await this.insertOrderWithNumber(client, {
      orderId,
      buyerId,
      tenantId: input.tenantId,
      slotId: quote.slot.id,
      tenantName: quote.tenant.name,
      timezone: quote.tenant.timezone,
      pickupStartsAt: quote.slot.startsAt,
      pickupEndsAt: quote.slot.endsAt,
      subtotalMinor: quote.subtotalMinor,
      totalMinor: quote.totalMinor,
      specialRequest: input.specialRequest ?? '',
    });

    // 4. Immutable item/option snapshots.
    await this.insertOrderItems(client, orderId, quote, input.items);

    // 5. Reserve exactly one seat (replay-safe per order id).
    const reservation = await this.availability.reserveForCheckout(
      client,
      input.tenantId,
      input.slotId,
      input.expectedSlotVersion,
      orderId,
    );

    // 6. Debit the buyer wallet into the escrow system account, then stamp
    // paid_at (the order only counts as paid once the ledger posted).
    const wallet = await this.wallet.getOrCreateWallet(
      buyerId,
      quote.currency,
      client,
    );
    const escrow = await this.wallet.ensureSystemAccount(
      PAYMENT_ESCROW_SYSTEM_KEY,
      quote.currency,
      client,
    );
    const transfer = await this.wallet.postTransfer(
      {
        idempotencyScope: 'orders.checkout',
        idempotencyKey: orderId,
        reference: { namespace: 'order', id: orderId },
        currency: quote.currency,
        amountMinor: quote.totalMinor,
        debitAccountId: wallet.accountId,
        creditAccountId: escrow.accountId,
        actor: { type: 'user', id: buyerId },
        reason: 'order payment',
        metadata: {
          orderId,
          tenantId: input.tenantId,
          pickupSlotId: reservation.slotId,
        },
      },
      client,
    );
    const paid = await client.query(
      `UPDATE orders SET paid_at = now(), updated_at = now()
        WHERE id = $1 AND paid_at IS NULL`,
      [orderId],
    );
    if (paid.rowCount !== 1) {
      throw new ConflictException({
        code: 'ORDER_STATE_CONFLICT',
        message: 'Order payment state changed unexpectedly',
      });
    }

    // 7. Payment row referencing the ledger transaction.
    const payment = await this.insertOrderPayment(
      client,
      orderId,
      quote,
      transfer.transactionId,
    );

    // 8. Idempotency row (needed before order_events.request_id FK), then the
    // event/audit/outbox trail.
    const idempotencyId = await this.insertIdempotencyRecord(client, {
      buyerId,
      keyHash,
      requestHash,
      orderId,
    });
    await this.appendOrderEvent(client, {
      orderId,
      eventType: 'order.created',
      fromStatus: null,
      toStatus: 'paid_awaiting_tenant',
      actorUserId: buyerId,
      requestId: idempotencyId,
      reason: 'Order paid and awaiting tenant confirmation',
      metadata: {
        tenantId: input.tenantId,
        pickupSlotId: reservation.slotId,
        totalMinor: quote.totalMinor,
        currency: quote.currency,
        ledgerTransactionId: payment.ledgerTransactionId,
      },
    });
    await this.audit.append(client, {
      actor: { userId: buyerId },
      scopeType: 'tenant',
      scopeId: input.tenantId,
      action: 'order.created',
      targetType: 'order',
      targetId: orderId,
      reason: 'Order paid with wallet balance',
      metadata: {
        totalMinor: quote.totalMinor,
        currency: quote.currency,
        paymentId: payment.id,
        pickupSlotId: reservation.slotId,
      },
    });
    const staff = await this.tenantStaffRecipients(client, input.tenantId);
    if (staff.length > 0) {
      await this.outbox.append(client, {
        eventKey: `order.created:${orderId}`,
        eventType: 'order.created',
        aggregateType: 'order',
        aggregateId: orderId,
        recipientIds: staff,
      });
    }

    // 9. Persist the exact response body for idempotent replays.
    const view = await this.loadOrderView(client, orderId);
    await client.query(
      'UPDATE order_request_idempotency SET response_body = $2::jsonb WHERE id = $1',
      [idempotencyId, JSON.stringify({ data: view })],
    );
    return { data: view, meta: { replayed: false } };
  }

  // ---------------------------------------------------------------------------
  // Tenant fulfilment state machine
  // ---------------------------------------------------------------------------

  /**
   * Tenant transitions:
   * - paid_awaiting_tenant -> confirmed   (tenant.orders.accept)
   * - confirmed -> preparing              (tenant.orders.prepare, gated by
   *   ORDER_PREPARATION_LEAD_SECONDS: never start production early)
   * - preparing -> ready_for_pickup        (tenant.orders.prepare OR .accept)
   * - paid_awaiting_tenant|confirmed -> declined (tenant.orders.accept, reason
   *   mandatory) -> capacity released + refund obligation recorded, NO money
   *   moved.
   * A replay of the same transition is an idempotent 200 without a duplicate
   * event; any other state is a 409.
   */
  async tenantTransition(
    actorUserId: string,
    tenantId: string,
    orderId: string,
    action: 'confirm' | 'prepare' | 'ready' | 'decline',
    input: { reason?: string; expectedStatus?: OrderStatus } = {},
  ): Promise<{ data: OrderView }> {
    this.assertUuid(actorUserId, 'actor id');
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(orderId, 'order id');
    const definition = this.transitionDefinition(action);
    return this.withTransaction(async (client) => {
      await this.requireAnyPermission(
        actorUserId,
        tenantId,
        definition.permissions,
        client,
      );
      // P2-05: serialize against a concurrent tenant archive.
      await this.lockTenantForOrderCommitment(client, tenantId);
      const order = await this.lockTenantOrder(
        client,
        tenantId,
        orderId,
        this.preparationLeadSeconds,
      );
      if (!order) throw new NotFoundException('Order not found');
      if (input.expectedStatus && input.expectedStatus !== order.status) {
        throw new ConflictException({
          code: 'ORDER_STATE_CONFLICT',
          message: `Order is ${order.status}, not ${input.expectedStatus}`,
        });
      }
      if (order.status === definition.to) {
        // Idempotent replay: same target state, no duplicate event/audit.
        return { data: await this.loadOrderView(client, orderId) };
      }
      if (!definition.from.includes(order.status)) {
        throw new ConflictException({
          code: 'ORDER_STATE_CONFLICT',
          message: `Order cannot become ${definition.to} from ${order.status}`,
        });
      }
      const reason = this.resolveTransitionReason(action, input.reason);
      if (action === 'prepare' && !order.preparation_allowed) {
        throw new ConflictException({
          code: 'ORDER_PREPARATION_TOO_EARLY',
          message: `Preparation cannot start before ${this.preparationLeadSeconds}s prior to the pickup window`,
        });
      }
      const updated = await client.query<{ version: number }>(
        `UPDATE orders
            SET status = $3, ${definition.timestampColumn} = now(),
                version = version + 1, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status = $4
          RETURNING version`,
        [orderId, tenantId, definition.to, order.status],
      );
      if (updated.rowCount !== 1) {
        throw new ConflictException({
          code: 'ORDER_STATE_CONFLICT',
          message: 'Order changed; reload and retry',
        });
      }
      if (action === 'decline') {
        // Give the seat back exactly once (idempotent inside availability).
        await this.availability.releaseReservation(client, tenantId, orderId);
      }
      await this.appendOrderEvent(client, {
        orderId,
        eventType: definition.eventType,
        fromStatus: order.status,
        toStatus: definition.to,
        actorUserId,
        reason,
        metadata:
          action === 'decline'
            ? {
                refundObligation: 'pending',
                refundExecution:
                  'refunds module (wave 3) after provider success; no wallet credit in orders',
                releasedSlotId: order.pickup_slot_id,
              }
            : {},
      });
      await this.audit.append(client, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: definition.auditAction,
        targetType: 'order',
        targetId: orderId,
        reason,
        metadata: {
          fromStatus: order.status,
          toStatus: definition.to,
          orderNumber: order.order_number,
        },
      });
      await this.outbox.append(client, {
        eventKey: `order.status_changed:${orderId}:${updated.rows[0].version}`,
        eventType: 'order.status_changed',
        aggregateType: 'order',
        aggregateId: orderId,
        recipientIds: [order.buyer_id],
      });
      return { data: await this.loadOrderView(client, orderId) };
    });
  }

  // ---------------------------------------------------------------------------
  // Schedule proposals (tenant proposes, buyer decides; expiry never accepts)
  // ---------------------------------------------------------------------------

  async createScheduleProposal(
    actorUserId: string,
    tenantId: string,
    orderId: string,
    input: { proposedSlotId: string; reason: string },
  ): Promise<{ data: ScheduleProposalView }> {
    this.assertUuid(actorUserId, 'actor id');
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(orderId, 'order id');
    this.assertUuid(input.proposedSlotId, 'proposed slot id');
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new BadRequestException('reason is required');
    const ttlSeconds = this.proposalTtlSeconds;
    return this.withTransaction(async (client) => {
      await this.requireAnyPermission(
        actorUserId,
        tenantId,
        TENANT_ORDER_PERMISSIONS.propose,
        client,
      );
      const order = await this.lockTenantOrder(
        client,
        tenantId,
        orderId,
        this.preparationLeadSeconds,
      );
      if (!order) throw new NotFoundException('Order not found');
      if (!PRE_PRODUCTION_STATUSES.includes(order.status)) {
        throw new ConflictException({
          code: 'ORDER_STATE_CONFLICT',
          message: `A schedule proposal is not possible from ${order.status}`,
        });
      }
      if (order.pickup_slot_id === input.proposedSlotId) {
        throw new BadRequestException(
          'Proposed slot is already the order pickup slot',
        );
      }
      // Read-only bookability check (capacity is only reserved on approval).
      const slot = await this.availability.assertBookableSlot(
        client,
        tenantId,
        input.proposedSlotId,
        'share',
      );
      let proposalId: string;
      try {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO schedule_proposals
             (order_id, tenant_id, buyer_id, old_slot_id, proposed_slot_id,
              old_starts_at, old_ends_at, proposed_starts_at, proposed_ends_at,
              expected_slot_version, expected_order_version, status, reason,
              created_by_user_id, expires_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,
                   $8::timestamptz,$9::timestamptz,$10,$11,'pending_buyer',$12,
                   $13, now() + ($14::int * interval '1 second'), now())
           RETURNING id`,
          [
            orderId,
            tenantId,
            order.buyer_id,
            order.pickup_slot_id,
            input.proposedSlotId,
            order.pickup_starts_at_text,
            order.pickup_ends_at_text,
            slot.startsAt,
            slot.endsAt,
            slot.version,
            order.version,
            reason,
            actorUserId,
            ttlSeconds,
          ],
        );
        proposalId = inserted.rows[0].id;
      } catch (error) {
        if (
          this.isUniqueViolation(
            error,
            'schedule_proposals_one_pending_per_order',
          )
        ) {
          throw new ConflictException({
            code: 'SCHEDULE_PROPOSAL_PENDING',
            message: 'This order already has a pending schedule proposal',
          });
        }
        throw error;
      }
      await this.appendOrderEvent(client, {
        orderId,
        eventType: 'schedule_proposal.created',
        fromStatus: order.status,
        toStatus: order.status,
        actorUserId,
        reason,
        metadata: {
          proposalId,
          proposedSlotId: input.proposedSlotId,
          expectedSlotVersion: slot.version,
          expiresInSeconds: ttlSeconds,
        },
      });
      await this.audit.append(client, {
        actor: { userId: actorUserId },
        scopeType: 'tenant',
        scopeId: tenantId,
        action: 'order.schedule_proposal.created',
        targetType: 'order',
        targetId: orderId,
        reason,
        metadata: {
          proposalId,
          oldSlotId: order.pickup_slot_id,
          proposedSlotId: input.proposedSlotId,
        },
      });
      await this.outbox.append(client, {
        eventKey: `schedule_proposal.created:${proposalId}`,
        eventType: 'schedule_proposal.created',
        aggregateType: 'schedule_proposal',
        aggregateId: proposalId,
        recipientIds: [order.buyer_id],
      });
      const proposal = await this.loadProposalById(client, proposalId);
      if (!proposal) throw new NotFoundException('Schedule proposal not found');
      return { data: proposal };
    });
  }

  /**
   * Buyer decision on a pending proposal.
   * - accept: atomically moves the reservation and the order pickup window
   *   (guarded by the proposed slot version stored at creation time).
   * - reject: the order (and its slot) is untouched.
   * - expired: only ever marked from a read/decision path (never by a job) and
   *   NEVER auto-accepted, never starts production, never refunds.
   */
  async decideScheduleProposal(
    buyerId: string,
    orderId: string,
    proposalId: string,
    decision: 'accept' | 'reject',
  ): Promise<{ data: ScheduleProposalView; meta: { replayed: boolean } }> {
    this.assertUuid(buyerId, 'buyer id');
    this.assertUuid(orderId, 'order id');
    this.assertUuid(proposalId, 'proposal id');
    const outcome = await this.withTransaction(async (client) => {
      const order = await this.lockBuyerOrder(client, buyerId, orderId);
      if (!order) throw new NotFoundException('Order not found');
      const proposal = await this.lockProposal(client, orderId, proposalId);
      if (!proposal) throw new NotFoundException('Schedule proposal not found');
      const target = decision === 'accept' ? 'accepted' : 'rejected';
      if (proposal.status !== 'pending_buyer') {
        if (proposal.status === target) {
          // Idempotent replay of the same decision.
          return {
            kind: 'replayed' as const,
            proposal: this.mapProposal(proposal),
          };
        }
        throw new ConflictException({
          code: 'SCHEDULE_PROPOSAL_DECIDED',
          message: `Schedule proposal is already ${proposal.status}`,
        });
      }
      const expired = await client.query<{ expired: boolean }>(
        'SELECT ($1::timestamptz <= now()) AS expired',
        [proposal.expires_at_text],
      );
      if (expired.rows[0].expired) {
        await this.markProposalExpired(client, proposal);
        return { kind: 'expired' as const };
      }
      if (!PRE_PRODUCTION_STATUSES.includes(order.status)) {
        throw new ConflictException({
          code: 'ORDER_STATE_CONFLICT',
          message: `A schedule proposal cannot be decided from ${order.status}`,
        });
      }
      if (decision === 'accept') {
        const moved = await this.availability.moveReservation(
          client,
          order.tenant_id,
          orderId,
          proposal.proposed_slot_id,
          proposal.expected_slot_version,
        );
        const updated = await client.query(
          `UPDATE orders
              SET pickup_slot_id = $3, pickup_starts_at = $4::timestamptz,
                  pickup_ends_at = $5::timestamptz, version = version + 1,
                  updated_at = now()
            WHERE id = $1 AND buyer_id = $2 AND status = ANY($6::varchar[])`,
          [
            orderId,
            buyerId,
            moved.slotId,
            moved.startsAt,
            moved.endsAt,
            PRE_PRODUCTION_STATUSES,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new ConflictException({
            code: 'ORDER_STATE_CONFLICT',
            message: 'Order changed; reload and retry',
          });
        }
      }
      const decided = await client.query(
        `UPDATE schedule_proposals
            SET status = $2, decided_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'pending_buyer'`,
        [proposalId, target],
      );
      if (decided.rowCount !== 1) {
        throw new ConflictException({
          code: 'SCHEDULE_PROPOSAL_DECIDED',
          message: 'Schedule proposal was decided concurrently',
        });
      }
      await this.appendOrderEvent(client, {
        orderId,
        eventType: 'schedule_proposal.decided',
        fromStatus: order.status,
        toStatus: order.status,
        actorUserId: buyerId,
        reason:
          decision === 'accept'
            ? 'Buyer accepted the proposed pickup schedule'
            : 'Buyer rejected the proposed pickup schedule',
        metadata: { proposalId, decision: target },
      });
      await this.audit.append(client, {
        actor: { userId: buyerId },
        scopeType: 'tenant',
        scopeId: order.tenant_id,
        action: `order.schedule_proposal.${target}`,
        targetType: 'order',
        targetId: orderId,
        reason:
          decision === 'accept'
            ? 'Buyer accepted the proposed pickup schedule'
            : 'Buyer rejected the proposed pickup schedule',
        metadata: { proposalId, proposedSlotId: proposal.proposed_slot_id },
      });
      const staff = await this.tenantStaffRecipients(client, order.tenant_id);
      if (staff.length > 0) {
        await this.outbox.append(client, {
          eventKey: `schedule_proposal.decided:${proposalId}`,
          eventType: 'schedule_proposal.decided',
          aggregateType: 'schedule_proposal',
          aggregateId: proposalId,
          recipientIds: staff,
        });
      }
      const reloaded = await this.loadProposalById(client, proposalId);
      if (!reloaded) throw new NotFoundException('Schedule proposal not found');
      return { kind: 'decided' as const, proposal: reloaded };
    });
    if (outcome.kind === 'expired') {
      // Committed above; the buyer must be told the window closed without any
      // automatic acceptance or production start.
      throw new ConflictException({
        code: 'SCHEDULE_PROPOSAL_EXPIRED',
        message:
          'Schedule proposal expired; it is never accepted automatically',
      });
    }
    return {
      data: outcome.proposal,
      meta: { replayed: outcome.kind === 'replayed' },
    };
  }

  // ---------------------------------------------------------------------------
  // Read APIs
  // ---------------------------------------------------------------------------

  async listBuyerOrders(
    buyerId: string,
    query: { status?: OrderStatus; cursor?: string; limit?: number },
  ) {
    this.assertUuid(buyerId, 'buyer id');
    const limit = this.normalizeLimit(query.limit);
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : undefined;
    const values: unknown[] = [buyerId];
    let where = 'o.buyer_id = $1';
    if (query.status) {
      values.push(query.status);
      where += ` AND o.status = $${values.length}`;
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      where += ` AND (o.created_at, o.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
    }
    values.push(limit + 1);
    const result = await this.database.pool.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} ${ORDER_FROM}
        WHERE ${where}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $${values.length}`,
      values,
    );
    return this.toPage(result.rows, limit);
  }

  async getBuyerOrder(buyerId: string, orderId: string) {
    this.assertUuid(buyerId, 'buyer id');
    this.assertUuid(orderId, 'order id');
    return this.withTransaction(async (client) => {
      const order = await this.fetchBuyerOrder(client, buyerId, orderId);
      if (!order) throw new NotFoundException('Order not found');
      // Reading a stale pending proposal is one of the two allowed places to
      // mark it expired (the other is the decision endpoint); no job does this.
      await this.expireStaleProposal(client, order);
      return { data: await this.loadOrderView(client, orderId) };
    });
  }

  async listTenantOrders(
    actorUserId: string,
    tenantId: string,
    query: { status?: OrderStatus; cursor?: string; limit?: number },
  ) {
    this.assertUuid(actorUserId, 'actor id');
    this.assertUuid(tenantId, 'tenant id');
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      TENANT_ORDER_PERMISSIONS.read[0],
    );
    const limit = this.normalizeLimit(query.limit);
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : undefined;
    const values: unknown[] = [tenantId];
    let where = 'o.tenant_id = $1';
    if (query.status) {
      values.push(query.status);
      where += ` AND o.status = $${values.length}`;
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      where += ` AND (o.created_at, o.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
    }
    values.push(limit + 1);
    const result = await this.database.pool.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} ${ORDER_FROM}
        WHERE ${where}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $${values.length}`,
      values,
    );
    return this.toPage(result.rows, limit);
  }

  async getTenantOrder(actorUserId: string, tenantId: string, orderId: string) {
    this.assertUuid(actorUserId, 'actor id');
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(orderId, 'order id');
    return this.withTransaction(async (client) => {
      await this.access.requireTenant(
        actorUserId,
        tenantId,
        TENANT_ORDER_PERMISSIONS.read[0],
        client,
      );
      const order = await this.fetchTenantOrder(client, tenantId, orderId);
      if (!order) throw new NotFoundException('Order not found');
      await this.expireStaleProposal(client, order);
      return { data: await this.loadOrderView(client, orderId) };
    });
  }

  // ---------------------------------------------------------------------------
  // Contract for the pickup slice (docs/modules/orders.md)
  // ---------------------------------------------------------------------------

  /**
   * Read the order inside the caller's transaction. The pickup slice uses it to
   * validate that the presented credential/order/tenant match before recording
   * a handover. Never authorizes by itself: the caller must have checked
   * `tenant.orders.handover`.
   */
  async getOrderForHandover(
    client: PoolClient,
    tenantId: string,
    orderId: string,
  ): Promise<OrderHandoverContext> {
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(orderId, 'order id');
    const result = await client.query<{
      id: string;
      tenant_id: string;
      buyer_id: string;
      status: OrderStatus;
      pickup_slot_id: string;
      total_minor: string;
      currency: string;
    }>(
      `SELECT id, tenant_id, buyer_id, status, pickup_slot_id,
              total_minor::text AS total_minor, currency
         FROM orders WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
      [orderId, tenantId],
    );
    const order = result.rows[0];
    if (!order) throw new NotFoundException('Order not found');
    return {
      orderId: order.id,
      tenantId: order.tenant_id,
      buyerId: order.buyer_id,
      status: order.status,
      pickupSlotId: order.pickup_slot_id,
      totalMinor: order.total_minor,
      currency: order.currency,
    };
  }

  /**
   * Records the handover inside the caller's transaction: ready_for_pickup ->
   * completed, consumes the capacity reservation and writes the order event +
   * immutable audit. Replaying for an already completed order is a no-op.
   * `order_handovers` itself is written by the pickup slice (single writer per
   * table, D4).
   */
  async markHandedOver(
    client: PoolClient,
    tenantId: string,
    orderId: string,
    actorUserId: string,
  ): Promise<void> {
    this.assertUuid(tenantId, 'tenant id');
    this.assertUuid(orderId, 'order id');
    this.assertUuid(actorUserId, 'actor id');
    // Defense in depth: the pickup flow already authorized its actor.
    await this.access.requireTenant(
      actorUserId,
      tenantId,
      'tenant.orders.handover',
      client,
    );
    const locked = await client.query<{
      id: string;
      status: OrderStatus;
    }>(
      `SELECT id, status FROM orders
        WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [orderId, tenantId],
    );
    const order = locked.rows[0];
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'completed') return;
    if (order.status !== 'ready_for_pickup') {
      throw new ConflictException({
        code: 'ORDER_STATE_CONFLICT',
        message: `Order cannot be completed from ${order.status}`,
      });
    }
    const updated = await client.query(
      `UPDATE orders
          SET status = 'completed', completed_at = now(),
              version = version + 1, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'ready_for_pickup'`,
      [orderId, tenantId],
    );
    if (updated.rowCount !== 1) {
      throw new ConflictException({
        code: 'ORDER_STATE_CONFLICT',
        message: 'Order changed; reload and retry',
      });
    }
    await this.availability.consumeReservation(client, tenantId, orderId);
    await this.appendOrderEvent(client, {
      orderId,
      eventType: 'order.status_changed',
      fromStatus: 'ready_for_pickup',
      toStatus: 'completed',
      actorUserId,
      reason: 'Order handed over to buyer',
      metadata: {},
    });
    await this.audit.append(client, {
      actor: { userId: actorUserId },
      scopeType: 'tenant',
      scopeId: tenantId,
      action: 'order.completed',
      targetType: 'order',
      targetId: orderId,
      reason: 'Order handed over to buyer',
      metadata: { fromStatus: 'ready_for_pickup', toStatus: 'completed' },
    });
  }

  // ---------------------------------------------------------------------------
  // Contract for the refunds/cases slice (wave 3)
  // ---------------------------------------------------------------------------

  /**
   * Cancels an order as the outcome of a manager refund decision and returns
   * the payment reference the refunds slice must refund.
   *
   * Single writer per table (D4): the refunds/cases modules never update
   * `orders`; they call this method inside THEIR transaction (the caller owns
   * BEGIN/COMMIT and the authorization of its own actor).
   *
   * Behaviour:
   * - locks the order row FOR UPDATE and derives tenant/buyer/total/currency
   *   from that row (never from parameters);
   * - rejects 409 when the order is already completed, cancelled or declined
   *   (no money may be returned after handover, and a terminal order must not be
   *   cancelled twice);
   * - sets status='cancelled', cancelled_at=now(), version=version+1 and
   *   updated_at=now(), which satisfies CHECK 0007
   *   (`orders_status_timestamps_check` for cancelled + monotonicity);
   * - releases the capacity reservation idempotently (a replay or an already
   *   released reservation is a no-op, capacity is never returned twice);
   * - writes the `order.cancelled` order event, an immutable audit entry and a
   *   buyer outbox notification inside the same transaction;
   * - requires the order to have a payment row, because a refund without a
   *   captured payment is not executable (409 otherwise).
   */
  async cancelForRefundDecision(
    client: PoolClient,
    orderId: string,
    actorUserId: string,
    reason: string,
  ): Promise<OrderRefundDecisionResult> {
    this.assertUuid(orderId, 'order id');
    this.assertUuid(actorUserId, 'actor id');
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!trimmedReason) {
      throw new BadRequestException(
        'reason is required to cancel an order for a refund decision',
      );
    }
    if (trimmedReason.length > 500) {
      throw new BadRequestException('reason must be at most 500 characters');
    }

    const locked = await client.query<{
      id: string;
      buyer_id: string;
      tenant_id: string;
      status: OrderStatus;
      total_minor: string;
      currency: string;
    }>(
      `SELECT id, buyer_id, tenant_id, status, total_minor::text AS total_minor,
              currency
         FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = locked.rows[0];
    if (!order) throw new NotFoundException('Order not found');
    if (TERMINAL_STATUSES.includes(order.status)) {
      throw new ConflictException({
        code: 'ORDER_CANCEL_CONFLICT',
        message: `Order cannot be cancelled for a refund from ${order.status}`,
      });
    }

    const payment = await client.query<{ id: string }>(
      `SELECT id FROM order_payments
        WHERE order_id = $1 AND status = 'succeeded'
        ORDER BY created_at, id LIMIT 1`,
      [orderId],
    );
    if (!payment.rows[0]) {
      throw new ConflictException({
        code: 'ORDER_PAYMENT_NOT_REFUNDABLE',
        message: 'Order has no successful payment that could be refunded',
      });
    }
    const orderPaymentId = payment.rows[0].id;

    const updated = await client.query(
      `UPDATE orders
          SET status = 'cancelled', cancelled_at = now(),
              version = version + 1, updated_at = now()
        WHERE id = $1 AND status = $2
        RETURNING version`,
      [orderId, order.status],
    );
    if (updated.rowCount !== 1) {
      throw new ConflictException({
        code: 'ORDER_CANCEL_CONFLICT',
        message: 'Order changed; reload and retry',
      });
    }

    // Idempotent by contract: false when the reservation was already released
    // (capacity is never returned twice). A missing reservation row means the
    // seat was never held, which is not a failure for the cancellation itself.
    try {
      await this.availability.releaseReservation(
        client,
        order.tenant_id,
        orderId,
      );
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }

    await this.appendOrderEvent(client, {
      orderId,
      eventType: 'order.cancelled',
      fromStatus: order.status,
      toStatus: 'cancelled',
      actorUserId,
      reason: trimmedReason,
      metadata: {
        orderPaymentId,
        totalMinor: order.total_minor,
        currency: order.currency,
        refundExecution:
          'refunds module (wave 3) after provider success + dedupe',
      },
    });
    await this.audit.append(client, {
      actor: { userId: actorUserId },
      scopeType: 'tenant',
      scopeId: order.tenant_id,
      action: 'tenant.orders.cancelled_by_manager',
      targetType: 'order',
      targetId: orderId,
      reason: trimmedReason,
      metadata: {
        fromStatus: order.status,
        toStatus: 'cancelled',
        orderPaymentId,
        totalMinor: order.total_minor,
        currency: order.currency,
      },
    });
    await this.outbox.append(client, {
      eventKey: `order.cancelled:${orderId}`,
      eventType: 'order.status_changed',
      aggregateType: 'order',
      aggregateId: orderId,
      recipientIds: [order.buyer_id],
    });

    return {
      orderId,
      buyerId: order.buyer_id,
      tenantId: order.tenant_id,
      status: 'cancelled',
      totalMinor: order.total_minor,
      currency: order.currency,
      orderPaymentId,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private transitionDefinition(
    action: 'confirm' | 'prepare' | 'ready' | 'decline',
  ) {
    switch (action) {
      case 'confirm':
        return {
          from: ['paid_awaiting_tenant'] as OrderStatus[],
          to: 'confirmed' as OrderStatus,
          permissions: TENANT_ORDER_PERMISSIONS.confirm,
          timestampColumn: 'confirmed_at',
          eventType: 'order.status_changed' as const,
          auditAction: 'order.confirmed',
        };
      case 'prepare':
        return {
          from: ['confirmed'] as OrderStatus[],
          to: 'preparing' as OrderStatus,
          permissions: TENANT_ORDER_PERMISSIONS.prepare,
          timestampColumn: 'preparing_at',
          eventType: 'order.status_changed' as const,
          auditAction: 'order.preparing',
        };
      case 'ready':
        return {
          from: ['preparing'] as OrderStatus[],
          to: 'ready_for_pickup' as OrderStatus,
          permissions: TENANT_ORDER_PERMISSIONS.ready,
          timestampColumn: 'ready_at',
          eventType: 'order.status_changed' as const,
          auditAction: 'order.ready_for_pickup',
        };
      case 'decline':
        return {
          from: PRE_PRODUCTION_STATUSES,
          to: 'declined' as OrderStatus,
          permissions: TENANT_ORDER_PERMISSIONS.decline,
          timestampColumn: 'declined_at',
          eventType: 'order.declined' as const,
          auditAction: 'order.declined',
        };
    }
  }

  private resolveTransitionReason(
    action: 'confirm' | 'prepare' | 'ready' | 'decline',
    reason?: string,
  ): string {
    if (action === 'decline') {
      const trimmed = (reason ?? '').trim();
      if (!trimmed) {
        throw new BadRequestException('reason is required to decline an order');
      }
      return trimmed;
    }
    const trimmed = (reason ?? '').trim();
    if (trimmed) return trimmed;
    switch (action) {
      case 'confirm':
        return 'Tenant confirmed the order';
      case 'prepare':
        return 'Tenant started preparing the order';
      case 'ready':
        return 'Order is ready for pickup';
    }
  }

  private normalizeCheckoutItems(
    items: CheckoutInput['items'],
  ): CheckoutInput['items'] {
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('At least one order line is required');
    }
    if (items.length > MAX_CHECKOUT_LINES) {
      throw new BadRequestException(
        `A checkout may contain at most ${MAX_CHECKOUT_LINES} lines`,
      );
    }
    return items.map((item) => {
      this.assertUuid(item.menuItemId, 'menu item id');
      if (
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > MAX_LINE_QUANTITY
      ) {
        throw new BadRequestException(
          `quantity must be between 1 and ${MAX_LINE_QUANTITY}`,
        );
      }
      const optionIds = item.optionIds ?? [];
      if (optionIds.length > MAX_LINE_OPTIONS) {
        throw new BadRequestException('Too many options on one line');
      }
      for (const optionId of optionIds) this.assertUuid(optionId, 'option id');
      return {
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        optionIds: [...optionIds],
        notes: (item.notes ?? '').trim(),
      };
    });
  }

  private validateCheckout(input: CheckoutInput): void {
    this.assertUuid(input.tenantId, 'tenant id');
    this.assertUuid(input.slotId, 'slot id');
    if (
      !Number.isSafeInteger(input.expectedSlotVersion) ||
      input.expectedSlotVersion < 1
    ) {
      throw new BadRequestException(
        'expectedSlotVersion must be a positive integer',
      );
    }
    if ((input.specialRequest ?? '').length > MAX_SPECIAL_REQUEST_LENGTH) {
      throw new BadRequestException('specialRequest is too long');
    }
    for (const item of input.items) {
      if ((item.notes ?? '').length > MAX_ITEM_NOTES_LENGTH) {
        throw new BadRequestException('Item notes are too long');
      }
    }
  }

  /** Canonical payload hash: lines sorted as strings (duplicates preserved). */
  private hashCheckoutRequest(input: CheckoutInput): string {
    const lines = input.items
      .map((item) =>
        JSON.stringify({
          menuItemId: item.menuItemId,
          quantity: item.quantity,
          optionIds: [...(item.optionIds ?? [])].sort(),
          notes: item.notes ?? '',
        }),
      )
      .sort();
    return createHash('sha256')
      .update(
        JSON.stringify({
          tenantId: input.tenantId,
          slotId: input.slotId,
          expectedSlotVersion: input.expectedSlotVersion,
          specialRequest: input.specialRequest ?? '',
          items: lines,
        }),
      )
      .digest('hex');
  }

  private assertIdempotencyKey(idempotencyKey: string): void {
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
    ) {
      throw new BadRequestException(
        'Idempotency-Key header is required (8-200 characters: A-Z a-z 0-9 . _ :)',
      );
    }
  }

  /**
   * Replay resolution, executed BEFORE re-quoting (docs/HANDOFF.md):
   * - same key + same payload hash -> the original order, no new effects;
   * - same key + different payload -> 409;
   * - different key + same payload (within the retention window) -> 409.
   */
  private async findIdempotentReplay(
    client: PoolClient,
    buyerId: string,
    keyHash: string,
    requestHash: string,
  ): Promise<CheckoutReplay | null> {
    const existing = await client.query<{
      request_hash: string;
      response_body: { data: OrderView };
    }>(
      `SELECT request_hash, response_body
         FROM order_request_idempotency
        WHERE actor_user_id = $1 AND route_name = $2 AND key_hash = $3`,
      [buyerId, ORDER_CHECKOUT_ROUTE, keyHash],
    );
    const record = existing.rows[0];
    if (record) {
      if (record.request_hash !== requestHash) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency key was already used with different input',
        });
      }
      return { data: record.response_body.data, meta: { replayed: true } };
    }
    const duplicate = await client.query<{ id: string }>(
      `SELECT id FROM order_request_idempotency
        WHERE actor_user_id = $1 AND route_name = $2 AND request_hash = $3
          AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1`,
      [buyerId, ORDER_CHECKOUT_ROUTE, requestHash],
    );
    if (duplicate.rows[0]) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_PAYLOAD_REUSED',
        message:
          'This checkout payload was already processed with a different idempotency key',
      });
    }
    return null;
  }

  /**
   * Idempotency claim row. `order_id` is NOT NULL with a FK to orders, so the
   * row is written in the same transaction right after the order exists; the
   * response body is filled in at the end of the transaction (step 9 of D15).
   */
  private async insertIdempotencyRecord(
    client: PoolClient,
    input: {
      buyerId: string;
      keyHash: string;
      requestHash: string;
      orderId: string;
    },
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO order_request_idempotency
         (actor_user_id, route_name, key_hash, request_hash, order_id,
          response_body, expires_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb,
               now() + ($6::int * interval '1 day'))
       RETURNING id`,
      [
        input.buyerId,
        ORDER_CHECKOUT_ROUTE,
        input.keyHash,
        input.requestHash,
        input.orderId,
        IDEMPOTENCY_RETENTION_DAYS,
      ],
    );
    return result.rows[0].id;
  }

  /**
   * Insert the order with a collision-safe order number. A unique violation on
   * orders_order_number_uq aborts the statement, so each attempt runs inside a
   * savepoint and the transaction continues with a fresh number.
   */
  private async insertOrderWithNumber(
    client: PoolClient,
    input: {
      orderId: string;
      buyerId: string;
      tenantId: string;
      slotId: string;
      tenantName: string;
      timezone: string;
      pickupStartsAt: string;
      pickupEndsAt: string;
      subtotalMinor: string;
      totalMinor: string;
      specialRequest: string;
    },
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ORDER_NUMBER_ATTEMPTS; attempt += 1) {
      await client.query('SAVEPOINT order_number_attempt');
      try {
        await client.query(
          `INSERT INTO orders
             (id, buyer_id, tenant_id, pickup_slot_id, order_number,
              tenant_name_snapshot, tenant_timezone_snapshot,
              pickup_starts_at, pickup_ends_at, status, currency,
              subtotal_minor, total_minor, special_request, version,
              paid_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,
                   'paid_awaiting_tenant','IDR',$10,$11,$12,1, NULL, now())`,
          [
            input.orderId,
            input.buyerId,
            input.tenantId,
            input.slotId,
            generateOrderNumber(),
            input.tenantName,
            input.timezone,
            input.pickupStartsAt,
            input.pickupEndsAt,
            input.subtotalMinor,
            input.totalMinor,
            input.specialRequest,
          ],
        );
        await client.query('RELEASE SAVEPOINT order_number_attempt');
        return;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT order_number_attempt');
        await client.query('RELEASE SAVEPOINT order_number_attempt');
        lastError = error;
        if (!this.isUniqueViolation(error, 'orders_order_number_uq'))
          throw error;
      }
    }
    throw new ConflictException({
      code: 'ORDER_NUMBER_GENERATION_FAILED',
      message: 'Could not allocate a unique order number; retry the checkout',
      cause: String(lastError),
    });
  }

  private async insertOrderItems(
    client: PoolClient,
    orderId: string,
    quote: OrderQuote,
    items: CheckoutInput['items'],
  ): Promise<void> {
    for (const [index, line] of quote.items.entries()) {
      const requested = items[index];
      if (!requested || requested.menuItemId !== line.menuItemId) {
        // Defensive: quote lines always mirror the request order.
        throw new ConflictException('Quote does not match the requested items');
      }
      const lineTotal = (
        BigInt(line.unitPriceMinor) * BigInt(line.quantity)
      ).toString();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO order_items
           (order_id, source_menu_item_id, source_category_id, name_snapshot,
            description_snapshot, menu_version, quantity, base_unit_price_minor,
            unit_price_minor, line_total_minor, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          orderId,
          line.menuItemId,
          line.categoryId,
          line.name,
          line.description,
          line.menuVersion,
          line.quantity,
          line.basePriceMinor,
          line.unitPriceMinor,
          lineTotal,
          requested.notes ?? '',
        ],
      );
      const orderItemId = inserted.rows[0].id;
      for (const option of line.options) {
        await client.query(
          `INSERT INTO order_item_options
             (order_item_id, source_group_id, source_choice_id,
              group_name_snapshot, name_snapshot, price_delta_minor,
              group_version, choice_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            orderItemId,
            option.groupId,
            option.id,
            option.groupName,
            option.name,
            option.priceDeltaMinor,
            option.groupVersion,
            option.optionVersion,
          ],
        );
      }
    }
  }

  private async insertOrderPayment(
    client: PoolClient,
    orderId: string,
    quote: OrderQuote,
    ledgerTransactionId: string,
  ): Promise<{ id: string; ledgerTransactionId: string }> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO order_payments
         (order_id, method, status, amount_minor, currency,
          ledger_transaction_id, succeeded_at, updated_at)
       VALUES ($1,'wallet','succeeded',$2,$3,$4, now(), now())
       RETURNING id`,
      [orderId, quote.totalMinor, quote.currency, ledgerTransactionId],
    );
    return { id: result.rows[0].id, ledgerTransactionId };
  }

  /** Append an order event; version = max(existing)+1 under the order row lock. */
  private async appendOrderEvent(
    client: PoolClient,
    input: {
      orderId: string;
      eventType:
        | 'order.created'
        | 'order.status_changed'
        | 'order.cancelled'
        | 'order.declined'
        | 'schedule_proposal.created'
        | 'schedule_proposal.decided'
        | 'pickup_credential.issued'
        | 'pickup_credential.revoked';
      fromStatus: OrderStatus | null;
      toStatus: OrderStatus | null;
      actorUserId?: string;
      actorService?: string;
      requestId?: string;
      reason: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!input.actorUserId && !input.actorService) {
      throw new BadRequestException('Order event requires an actor');
    }
    const next = await client.query<{ version: number }>(
      `SELECT coalesce(max(version), 0) + 1 AS version
         FROM order_events WHERE order_id = $1`,
      [input.orderId],
    );
    await client.query(
      `INSERT INTO order_events
         (order_id, version, event_type, from_status, to_status, actor_user_id,
          actor_service, request_id, reason, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        input.orderId,
        next.rows[0].version,
        input.eventType,
        input.fromStatus,
        input.toStatus,
        input.actorUserId ?? null,
        input.actorService ?? null,
        input.requestId ?? null,
        input.reason,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  private async tenantStaffRecipients(
    client: PoolClient,
    tenantId: string,
  ): Promise<string[]> {
    const result = await client.query<{ user_id: string }>(
      `SELECT DISTINCT tm.user_id
         FROM tenant_memberships tm
         JOIN users u ON u.id = tm.user_id
        WHERE tm.tenant_id = $1
          AND tm.status = 'active'
          AND u.status = 'active'
          AND (tm.role = 'owner' OR 'tenant.orders.read' = ANY(tm.permissions))
        ORDER BY tm.user_id
        LIMIT 100`,
      [tenantId],
    );
    return result.rows.map((row) => row.user_id);
  }

  /**
   * P2-05 (write-skew guard): hold a SHARE lock on the tenant row for the whole
   * transaction that creates or transitions an order, before any tenant state
   * is read.
   *
   * TenantsService.archive() locks the same row with FOR UPDATE before counting
   * dependencies, so the two paths are serialized:
   * - archive first -> this read sees status 'archived' and the checkout fails
   *   with 404 (no order is ever born on an archived tenant);
   * - checkout first -> the archive UPDATE waits until the order transaction
   *   commits, so the archive dependency count includes the new order and the
   *   archive is refused with 409 instead of silently overriding it.
   * FOR SHARE (not FOR UPDATE) keeps concurrent checkouts of the same tenant
   * parallel; only writers of the tenant row block.
   */
  private async lockTenantForOrderCommitment(
    client: PoolClient,
    tenantId: string,
  ): Promise<{ tenantId: string; campusId: string; timezone: string }> {
    const result = await client.query<{
      id: string;
      campus_id: string;
      timezone: string;
    }>(
      `SELECT t.id, t.campus_id, c.timezone
         FROM tenants t JOIN campuses c ON c.id = t.campus_id
        WHERE t.id = $1 AND t.status <> 'archived' AND c.status = 'active'
        FOR SHARE OF t, c`,
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Tenant not found');
    return {
      tenantId: row.id,
      campusId: row.campus_id,
      timezone: row.timezone,
    };
  }

  private async fetchOrderRow(
    client: PoolClient,
    orderId: string,
  ): Promise<OrderRow | undefined> {
    const result = await client.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} ${ORDER_FROM} WHERE o.id = $1`,
      [orderId],
    );
    return result.rows[0];
  }

  private async fetchBuyerOrder(
    client: PoolClient,
    buyerId: string,
    orderId: string,
  ): Promise<OrderRow | undefined> {
    const result = await client.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} ${ORDER_FROM}
        WHERE o.id = $1 AND o.buyer_id = $2`,
      [orderId, buyerId],
    );
    return result.rows[0];
  }

  private async fetchTenantOrder(
    client: PoolClient,
    tenantId: string,
    orderId: string,
  ): Promise<OrderRow | undefined> {
    const result = await client.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} ${ORDER_FROM}
        WHERE o.id = $1 AND o.tenant_id = $2`,
      [orderId, tenantId],
    );
    return result.rows[0];
  }

  private async lockTenantOrder(
    client: PoolClient,
    tenantId: string,
    orderId: string,
    leadSeconds: number,
  ): Promise<LockedOrderRow | undefined> {
    const result = await client.query<LockedOrderRow>(
      `SELECT ${ORDER_COLUMNS},
              (o.pickup_starts_at - ($3::int * interval '1 second') <= now())
                AS preparation_allowed
         ${ORDER_FROM}
        WHERE o.id = $1 AND o.tenant_id = $2
        FOR UPDATE OF o`,
      [orderId, tenantId, leadSeconds],
    );
    return result.rows[0];
  }

  private async lockBuyerOrder(
    client: PoolClient,
    buyerId: string,
    orderId: string,
  ): Promise<LockedOrderRow | undefined> {
    const result = await client.query<LockedOrderRow>(
      `SELECT ${ORDER_COLUMNS}, true AS preparation_allowed
         ${ORDER_FROM}
        WHERE o.id = $1 AND o.buyer_id = $2
        FOR UPDATE OF o`,
      [orderId, buyerId],
    );
    return result.rows[0];
  }

  private async loadOrderView(
    client: PoolClient,
    orderId: string,
  ): Promise<OrderView> {
    const order = await this.fetchOrderRow(client, orderId);
    if (!order) throw new NotFoundException('Order not found');
    const items = await this.loadOrderItems(client, orderId);
    const payment = await this.loadPayment(client, orderId);
    const proposal = await this.loadLatestProposal(client, orderId);
    return {
      ...this.mapOrderSummary(order),
      items,
      payment,
      scheduleProposal: proposal,
    };
  }

  private async loadOrderItems(
    client: PoolClient,
    orderId: string,
  ): Promise<OrderItemView[]> {
    const items = await client.query<OrderItemRow>(
      `SELECT id, source_menu_item_id, source_category_id, name_snapshot,
              description_snapshot, menu_version, quantity,
              base_unit_price_minor::text AS base_unit_price_minor,
              unit_price_minor::text AS unit_price_minor,
              line_total_minor::text AS line_total_minor, notes
         FROM order_items WHERE order_id = $1
        ORDER BY created_at, id`,
      [orderId],
    );
    const options = await client.query<OrderItemOptionRow>(
      `SELECT oio.id, oio.order_item_id, oio.source_group_id,
              oio.source_choice_id, oio.group_name_snapshot, oio.name_snapshot,
              oio.price_delta_minor::text AS price_delta_minor,
              oio.group_version, oio.choice_version
         FROM order_item_options oio
         JOIN order_items oi ON oi.id = oio.order_item_id
        WHERE oi.order_id = $1
        ORDER BY oio.created_at, oio.id`,
      [orderId],
    );
    const byItem = new Map<string, OrderItemOptionView[]>();
    for (const option of options.rows) {
      const list = byItem.get(option.order_item_id) ?? [];
      list.push({
        id: option.id,
        groupId: option.source_group_id,
        choiceId: option.source_choice_id,
        groupName: option.group_name_snapshot,
        name: option.name_snapshot,
        priceDeltaMinor: option.price_delta_minor,
        groupVersion: option.group_version,
        choiceVersion: option.choice_version,
      });
      byItem.set(option.order_item_id, list);
    }
    return items.rows.map((item) => ({
      id: item.id,
      menuItemId: item.source_menu_item_id,
      categoryId: item.source_category_id,
      name: item.name_snapshot,
      description: item.description_snapshot,
      menuVersion: item.menu_version,
      quantity: item.quantity,
      baseUnitPriceMinor: item.base_unit_price_minor,
      unitPriceMinor: item.unit_price_minor,
      lineTotalMinor: item.line_total_minor,
      notes: item.notes,
      options: byItem.get(item.id) ?? [],
    }));
  }

  private async loadPayment(
    client: PoolClient,
    orderId: string,
  ): Promise<OrderPaymentView | null> {
    const result = await client.query<PaymentRow>(
      `SELECT id, method, status, amount_minor::text AS amount_minor, currency,
              ledger_transaction_id, ${TS('succeeded_at')} AS succeeded_at_text
         FROM order_payments WHERE order_id = $1`,
      [orderId],
    );
    const payment = result.rows[0];
    if (!payment) return null;
    return {
      id: payment.id,
      method: 'wallet',
      status: 'succeeded',
      amountMinor: payment.amount_minor,
      currency: 'IDR',
      ledgerTransactionId: payment.ledger_transaction_id,
      succeededAt: payment.succeeded_at_text,
    };
  }

  private async loadLatestProposal(
    client: PoolClient,
    orderId: string,
  ): Promise<ScheduleProposalView | null> {
    const result = await client.query<ProposalRow>(
      `SELECT id, order_id, status, old_slot_id, proposed_slot_id,
              ${TS('old_starts_at')} AS old_starts_at_text,
              ${TS('old_ends_at')} AS old_ends_at_text,
              ${TS('proposed_starts_at')} AS proposed_starts_at_text,
              ${TS('proposed_ends_at')} AS proposed_ends_at_text,
              expected_slot_version, expected_order_version, reason,
              created_by_user_id,
              ${TS('expires_at')} AS expires_at_text,
              ${TS('decided_at')} AS decided_at_text,
              ${TS('created_at')} AS created_at_text,
              ${TS('updated_at')} AS updated_at_text
         FROM schedule_proposals WHERE order_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [orderId],
    );
    return result.rows[0] ? this.mapProposal(result.rows[0]) : null;
  }

  private async loadProposalById(
    client: PoolClient,
    proposalId: string,
  ): Promise<ScheduleProposalView | null> {
    const result = await client.query<ProposalRow>(
      `SELECT id, order_id, status, old_slot_id, proposed_slot_id,
              ${TS('old_starts_at')} AS old_starts_at_text,
              ${TS('old_ends_at')} AS old_ends_at_text,
              ${TS('proposed_starts_at')} AS proposed_starts_at_text,
              ${TS('proposed_ends_at')} AS proposed_ends_at_text,
              expected_slot_version, expected_order_version, reason,
              created_by_user_id,
              ${TS('expires_at')} AS expires_at_text,
              ${TS('decided_at')} AS decided_at_text,
              ${TS('created_at')} AS created_at_text,
              ${TS('updated_at')} AS updated_at_text
         FROM schedule_proposals WHERE id = $1`,
      [proposalId],
    );
    return result.rows[0] ? this.mapProposal(result.rows[0]) : null;
  }

  private async lockProposal(
    client: PoolClient,
    orderId: string,
    proposalId: string,
  ): Promise<ProposalRow | undefined> {
    const result = await client.query<ProposalRow>(
      `SELECT id, order_id, status, old_slot_id, proposed_slot_id,
              ${TS('old_starts_at')} AS old_starts_at_text,
              ${TS('old_ends_at')} AS old_ends_at_text,
              ${TS('proposed_starts_at')} AS proposed_starts_at_text,
              ${TS('proposed_ends_at')} AS proposed_ends_at_text,
              expected_slot_version, expected_order_version, reason,
              created_by_user_id,
              ${TS('expires_at')} AS expires_at_text,
              ${TS('decided_at')} AS decided_at_text,
              ${TS('created_at')} AS created_at_text,
              ${TS('updated_at')} AS updated_at_text
         FROM schedule_proposals
        WHERE id = $1 AND order_id = $2
        FOR UPDATE`,
      [proposalId, orderId],
    );
    return result.rows[0];
  }

  /** Marks a stale pending proposal expired (never accepted) inside a transaction. */
  private async expireStaleProposal(
    client: PoolClient,
    order: OrderRow,
  ): Promise<void> {
    const expired = await client.query<{ id: string }>(
      `UPDATE schedule_proposals
          SET status = 'expired', decided_at = now(), updated_at = now()
        WHERE order_id = $1 AND status = 'pending_buyer' AND expires_at <= now()
        RETURNING id`,
      [order.id],
    );
    for (const row of expired.rows) {
      await this.appendOrderEvent(client, {
        orderId: order.id,
        eventType: 'schedule_proposal.decided',
        fromStatus: order.status,
        toStatus: order.status,
        actorService: 'orders.proposal-expiry',
        reason: 'Schedule proposal expired without a buyer decision',
        metadata: { proposalId: row.id, decision: 'expired' },
      });
      await this.audit.append(client, {
        actor: { service: 'orders.proposal-expiry' },
        scopeType: 'tenant',
        scopeId: order.tenant_id,
        action: 'order.schedule_proposal.expired',
        targetType: 'order',
        targetId: order.id,
        reason: 'Schedule proposal expired without a buyer decision',
        metadata: { proposalId: row.id },
      });
    }
  }

  private async markProposalExpired(
    client: PoolClient,
    proposal: ProposalRow,
  ): Promise<void> {
    const updated = await client.query(
      `UPDATE schedule_proposals
          SET status = 'expired', decided_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'pending_buyer'`,
      [proposal.id],
    );
    if (updated.rowCount !== 1) return;
    await this.appendOrderEvent(client, {
      orderId: proposal.order_id,
      eventType: 'schedule_proposal.decided',
      fromStatus: null,
      toStatus: null,
      actorService: 'orders.proposal-expiry',
      reason: 'Schedule proposal expired without a buyer decision',
      metadata: { proposalId: proposal.id, decision: 'expired' },
    });
  }

  private mapOrderSummary(order: OrderRow): OrderSummaryView {
    return {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      buyer: { id: order.buyer_id, displayName: order.buyer_display_name },
      tenantId: order.tenant_id,
      tenantName: order.tenant_name_snapshot,
      timezone: order.tenant_timezone_snapshot,
      slotId: order.pickup_slot_id,
      pickupStartsAt: order.pickup_starts_at_text,
      pickupEndsAt: order.pickup_ends_at_text,
      currency: 'IDR',
      subtotalMinor: order.subtotal_minor,
      totalMinor: order.total_minor,
      specialRequest: order.special_request,
      version: order.version,
      createdAt: order.created_at_text,
      updatedAt: order.updated_at_text,
      paidAt: order.paid_at_text,
      confirmedAt: order.confirmed_at_text,
      preparingAt: order.preparing_at_text,
      readyAt: order.ready_at_text,
      completedAt: order.completed_at_text,
      declinedAt: order.declined_at_text,
      cancelledAt: order.cancelled_at_text,
    };
  }

  private mapProposal(proposal: ProposalRow): ScheduleProposalView {
    return {
      id: proposal.id,
      orderId: proposal.order_id,
      status: proposal.status,
      oldSlotId: proposal.old_slot_id,
      proposedSlotId: proposal.proposed_slot_id,
      oldStartsAt: proposal.old_starts_at_text,
      oldEndsAt: proposal.old_ends_at_text,
      proposedStartsAt: proposal.proposed_starts_at_text,
      proposedEndsAt: proposal.proposed_ends_at_text,
      expectedSlotVersion: proposal.expected_slot_version,
      expectedOrderVersion: proposal.expected_order_version,
      reason: proposal.reason,
      createdByUserId: proposal.created_by_user_id,
      expiresAt: proposal.expires_at_text,
      decidedAt: proposal.decided_at_text,
      createdAt: proposal.created_at_text,
      updatedAt: proposal.updated_at_text,
    };
  }

  private toPage(rows: OrderRow[], limit: number) {
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => this.mapOrderSummary(row)),
      meta: {
        next_cursor:
          rows.length > limit && last
            ? this.encodeCursor({
                createdAt: last.created_at_text,
                id: last.id,
              })
            : null,
      },
    };
  }

  private encodeCursor(cursor: Cursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private decodeCursor(value: string): Cursor {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as { createdAt?: unknown; id?: unknown };
      if (
        typeof parsed.createdAt !== 'string' ||
        !CURSOR_TIMESTAMP_PATTERN.test(parsed.createdAt) ||
        typeof parsed.id !== 'string' ||
        !UUID_PIPE_PATTERN.test(parsed.id)
      ) {
        throw new Error('invalid cursor shape');
      }
      return { createdAt: parsed.createdAt, id: parsed.id };
    } catch {
      throw new BadRequestException('Invalid order cursor');
    }
  }

  private normalizeLimit(value: number | undefined): number {
    if (value === undefined) return ORDER_PAGE_LIMIT_DEFAULT;
    if (!Number.isInteger(value) || value < 1 || value > ORDER_PAGE_LIMIT_MAX) {
      throw new BadRequestException(
        `limit must be an integer from 1 to ${ORDER_PAGE_LIMIT_MAX}`,
      );
    }
    return value;
  }

  private async requireAnyPermission(
    actorUserId: string,
    tenantId: string,
    permissions: readonly TenantPermission[],
    client: PoolClient,
  ) {
    let lastError: unknown;
    for (const permission of permissions) {
      try {
        return await this.access.requireTenant(
          actorUserId,
          tenantId,
          permission,
          client,
        );
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof ForbiddenException
      ? lastError
      : new ForbiddenException('Tenant permission denied');
  }

  private get preparationLeadSeconds(): number {
    const value = this.config.get<number>('ORDER_PREPARATION_LEAD_SECONDS');
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? value
      : 900;
  }

  private get proposalTtlSeconds(): number {
    const value = this.config.get<number>('ORDER_PROPOSAL_TTL_SECONDS');
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : 600;
  }

  private assertUuid(value: string, field: string): void {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new BadRequestException(`Invalid ${field}`);
    }
  }

  private isUniqueViolation(error: unknown, constraint: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505' &&
      (error as { constraint?: string }).constraint === constraint
    );
  }

  /**
   * D15.B: retry a checkout transaction at most once on a deadlock (40P01) or
   * a serialization failure (40001). Only a transaction that never committed is
   * re-run, so no financial effect can be duplicated; a second failure is
   * surfaced as 409 instead of a 500.
   */
  private async withTransactionRetry<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!this.isRetryableTransactionError(error)) throw error;
      try {
        return await operation();
      } catch (retryError) {
        if (!this.isRetryableTransactionError(retryError)) throw retryError;
        throw new ConflictException({
          code: 'CHECKOUT_RETRY_CONFLICT',
          message:
            'Concurrent checkout conflict; retry the request with the same Idempotency-Key',
        });
      }
    }
  }

  /**
   * A checkout transaction may be retried exactly once when PostgreSQL aborted
   * it with a deadlock (40P01) or a serialization failure (40001). Two shapes
   * reach this method:
   *
   * 1. A raw database error, when the failing statement belongs to this slice
   *    (e.g. our own `UPDATE orders SET paid_at`).
   * 2. The stable contract code `DATABASE_DEADLOCK` that the availability slice
   *    attaches to its mapped 409 (R2-02), because reserve/release/consume now
   *    convert database rejections into ConflictException bodies.
   *
   * Retrying is safe in both cases: the transaction never committed, so no
   * financial or capacity effect can be duplicated (D15). Mapped errors keep
   * their 409 status; only the retry decision depends on this classification.
   */
  private isRetryableTransactionError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (code === '40P01' || code === '40001') return true;
    }
    if (error instanceof HttpException) {
      const response: unknown = error.getResponse();
      if (
        typeof response === 'object' &&
        response !== null &&
        'code' in response
      ) {
        return (response as { code?: unknown }).code === 'DATABASE_DEADLOCK';
      }
    }
    return false;
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
