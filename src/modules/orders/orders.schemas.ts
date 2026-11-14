import type { OrderStatus } from './orders.constants';

/** Shared OpenAPI fragments for the orders endpoints. */

export const orderSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    orderNumber: {
      type: 'string',
      example: 'AN-20261112-7K3M2Q',
      pattern: '^AN-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{6}$',
    },
    status: {
      type: 'string',
      enum: [
        'paid_awaiting_tenant',
        'confirmed',
        'preparing',
        'ready_for_pickup',
        'completed',
        'declined',
        'cancelled',
      ],
    },
    buyer: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        displayName: { type: 'string' },
      },
      required: ['id', 'displayName'],
    },
    tenantId: { type: 'string', format: 'uuid' },
    tenantName: { type: 'string' },
    timezone: { type: 'string' },
    slotId: { type: 'string', format: 'uuid' },
    pickupStartsAt: { type: 'string', format: 'date-time' },
    pickupEndsAt: { type: 'string', format: 'date-time' },
    currency: { type: 'string', enum: ['IDR'] },
    subtotalMinor: { type: 'string', pattern: '^[1-9][0-9]{0,37}$' },
    totalMinor: { type: 'string', pattern: '^[1-9][0-9]{0,37}$' },
    specialRequest: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    paidAt: { type: 'string', nullable: true },
    confirmedAt: { type: 'string', nullable: true },
    preparingAt: { type: 'string', nullable: true },
    readyAt: { type: 'string', nullable: true },
    completedAt: { type: 'string', nullable: true },
    declinedAt: { type: 'string', nullable: true },
    cancelledAt: { type: 'string', nullable: true },
  },
  required: [
    'id',
    'orderNumber',
    'status',
    'buyer',
    'tenantId',
    'tenantName',
    'timezone',
    'slotId',
    'pickupStartsAt',
    'pickupEndsAt',
    'currency',
    'subtotalMinor',
    'totalMinor',
    'specialRequest',
    'version',
    'createdAt',
    'updatedAt',
    'paidAt',
    'confirmedAt',
    'preparingAt',
    'readyAt',
    'completedAt',
    'declinedAt',
    'cancelledAt',
  ],
};

export const scheduleProposalSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: ['pending_buyer', 'accepted', 'rejected', 'expired', 'cancelled'],
    },
    oldSlotId: { type: 'string', format: 'uuid' },
    proposedSlotId: { type: 'string', format: 'uuid' },
    oldStartsAt: { type: 'string' },
    oldEndsAt: { type: 'string' },
    proposedStartsAt: { type: 'string' },
    proposedEndsAt: { type: 'string' },
    expectedSlotVersion: { type: 'integer', minimum: 1 },
    expectedOrderVersion: { type: 'integer', minimum: 1 },
    reason: { type: 'string' },
    createdByUserId: { type: 'string', format: 'uuid' },
    expiresAt: { type: 'string' },
    decidedAt: { type: 'string', nullable: true },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: [
    'id',
    'orderId',
    'status',
    'oldSlotId',
    'proposedSlotId',
    'oldStartsAt',
    'oldEndsAt',
    'proposedStartsAt',
    'proposedEndsAt',
    'expectedSlotVersion',
    'expectedOrderVersion',
    'reason',
    'createdByUserId',
    'expiresAt',
    'decidedAt',
    'createdAt',
    'updatedAt',
  ],
};

export const orderItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    menuItemId: { type: 'string', format: 'uuid' },
    categoryId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string' },
    menuVersion: { type: 'integer', minimum: 1 },
    quantity: { type: 'integer', minimum: 1, maximum: 999 },
    baseUnitPriceMinor: { type: 'string', pattern: '^[0-9]{1,38}$' },
    unitPriceMinor: { type: 'string', pattern: '^[0-9]{1,38}$' },
    lineTotalMinor: { type: 'string', pattern: '^[0-9]{1,38}$' },
    notes: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          groupId: { type: 'string', format: 'uuid' },
          choiceId: { type: 'string', format: 'uuid' },
          groupName: { type: 'string' },
          name: { type: 'string' },
          priceDeltaMinor: { type: 'string', pattern: '^[0-9]{1,38}$' },
          groupVersion: { type: 'integer', minimum: 1 },
          choiceVersion: { type: 'integer', minimum: 1 },
        },
        required: [
          'id',
          'groupId',
          'choiceId',
          'groupName',
          'name',
          'priceDeltaMinor',
          'groupVersion',
          'choiceVersion',
        ],
      },
    },
  },
  required: [
    'id',
    'menuItemId',
    'categoryId',
    'name',
    'description',
    'menuVersion',
    'quantity',
    'baseUnitPriceMinor',
    'unitPriceMinor',
    'lineTotalMinor',
    'notes',
    'options',
  ],
};

export const orderViewSchema = {
  allOf: [orderSummarySchema],
  type: 'object',
  properties: {
    ...orderSummarySchema.properties,
    items: { type: 'array', items: orderItemSchema },
    payment: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        method: { type: 'string', enum: ['wallet'] },
        status: { type: 'string', enum: ['succeeded'] },
        amountMinor: { type: 'string', pattern: '^[1-9][0-9]{0,37}$' },
        currency: { type: 'string', enum: ['IDR'] },
        ledgerTransactionId: { type: 'string', format: 'uuid' },
        succeededAt: { type: 'string', nullable: true },
      },
      required: [
        'id',
        'method',
        'status',
        'amountMinor',
        'currency',
        'ledgerTransactionId',
        'succeededAt',
      ],
    },
    scheduleProposal: { ...scheduleProposalSchema, nullable: true },
  },
  required: [
    ...orderSummarySchema.required,
    'items',
    'payment',
    'scheduleProposal',
  ],
};

/** One quoted line: server-priced, never persisted. */
export const orderQuoteItemSchema = {
  type: 'object',
  properties: {
    menuItemId: { type: 'string', format: 'uuid' },
    categoryId: { type: 'string', format: 'uuid' },
    categoryName: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    menuVersion: { type: 'integer', minimum: 1 },
    quantity: { type: 'integer', minimum: 1, maximum: 999 },
    baseUnitPriceMinor: { type: 'string', pattern: '^[0-9]{1,38}$' },
    unitPriceMinor: { type: 'string', pattern: '^[0-9]{1,38}$' },
    lineTotalMinor: { type: 'string', pattern: '^[0-9]{1,38}$' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          groupId: { type: 'string', format: 'uuid' },
          groupName: { type: 'string' },
          name: { type: 'string' },
          priceDeltaMinor: { type: 'string', pattern: '^[0-9]{1,38}$' },
          groupVersion: { type: 'integer', minimum: 1 },
          optionVersion: { type: 'integer', minimum: 1 },
        },
        required: [
          'id',
          'groupId',
          'groupName',
          'name',
          'priceDeltaMinor',
          'groupVersion',
          'optionVersion',
        ],
      },
    },
  },
  required: [
    'menuItemId',
    'categoryId',
    'categoryName',
    'name',
    'description',
    'menuVersion',
    'quantity',
    'baseUnitPriceMinor',
    'unitPriceMinor',
    'lineTotalMinor',
    'options',
  ],
};

/**
 * Read-only cart preview. Identical to what checkout would charge because both
 * use CatalogService.quote; nothing is created or reserved by quoting.
 */
export const orderQuoteSchema = {
  type: 'object',
  properties: {
    tenant: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        campusId: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        timezone: { type: 'string' },
      },
      required: ['id', 'campusId', 'name', 'timezone'],
    },
    slot: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        startsAt: { type: 'string', format: 'date-time' },
        endsAt: { type: 'string', format: 'date-time' },
        version: { type: 'integer', minimum: 1 },
      },
      required: ['id', 'startsAt', 'endsAt', 'version'],
    },
    items: { type: 'array', items: orderQuoteItemSchema },
    subtotalMinor: { type: 'string', pattern: '^[1-9][0-9]{0,37}$' },
    totalMinor: { type: 'string', pattern: '^[1-9][0-9]{0,37}$' },
    currency: { type: 'string', enum: ['IDR'] },
    wallet: {
      type: 'object',
      properties: {
        currency: { type: 'string', enum: ['IDR'] },
        availableMinor: { type: 'string', pattern: '^[0-9]{1,38}$' },
        sufficient: { type: 'boolean' },
      },
      required: ['currency', 'availableMinor', 'sufficient'],
    },
  },
  required: [
    'tenant',
    'slot',
    'items',
    'subtotalMinor',
    'totalMinor',
    'currency',
    'wallet',
  ],
};

/** One immutable order_events row; metadata is the stored jsonb, unchanged. */
export const orderEventSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    version: { type: 'integer', minimum: 1 },
    eventType: { type: 'string' },
    fromStatus: {
      type: 'string',
      nullable: true,
      enum: [
        'paid_awaiting_tenant',
        'confirmed',
        'preparing',
        'ready_for_pickup',
        'completed',
        'declined',
        'cancelled',
      ],
    },
    toStatus: {
      type: 'string',
      nullable: true,
      enum: [
        'paid_awaiting_tenant',
        'confirmed',
        'preparing',
        'ready_for_pickup',
        'completed',
        'declined',
        'cancelled',
      ],
    },
    actorUserId: { type: 'string', format: 'uuid', nullable: true },
    actorService: { type: 'string', nullable: true },
    reason: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true },
    occurredAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'version',
    'eventType',
    'fromStatus',
    'toStatus',
    'actorUserId',
    'actorService',
    'reason',
    'metadata',
    'occurredAt',
  ],
};

export const orderEventListSchema = {
  type: 'object',
  properties: { data: { type: 'array', items: orderEventSchema } },
  required: ['data'],
};

export const orderPageSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: orderSummarySchema },
    meta: {
      type: 'object',
      properties: { next_cursor: { type: 'string', nullable: true } },
      required: ['next_cursor'],
    },
  },
  required: ['data', 'meta'],
};

export type OrderStatusValue = OrderStatus;
