/** Shared OpenAPI fragments for the pickup endpoints. */

export const issuedPickupCredentialSchema = {
  type: 'object',
  properties: {
    credentialId: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    code: {
      type: 'string',
      example: 'K7XQ-2M9P',
      description:
        'Plaintext pickup code. Returned by the issuance endpoint and by the buyer read; never stored in plaintext and never logged.',
    },
    expiresAt: { type: 'string', format: 'date-time' },
    rotatedFrom: {
      type: 'string',
      format: 'uuid',
      nullable: true,
      description: 'Credential id revoked by this re-issuance, if any.',
    },
  },
  required: ['credentialId', 'orderId', 'code', 'expiresAt', 'rotatedFrom'],
};

export const revokedPickupCredentialSchema = {
  type: 'object',
  properties: {
    credentialId: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    revokedAt: { type: 'string', format: 'date-time' },
  },
  required: ['credentialId', 'orderId', 'revokedAt'],
};

export const buyerPickupCredentialSchema = {
  type: 'object',
  properties: {
    credentialId: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    code: { type: 'string', example: 'K7XQ-2M9P' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
  required: ['credentialId', 'orderId', 'code', 'expiresAt'],
};

export const pickupVerificationSchema = {
  type: 'object',
  properties: {
    orderId: { type: 'string', format: 'uuid' },
    orderNumber: { type: 'string', nullable: true },
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
    readyForHandover: { type: 'boolean' },
    buyer: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        displayName: { type: 'string' },
      },
      required: ['id', 'displayName'],
    },
    totalMinor: { type: 'string', pattern: '^[1-9][0-9]{0,37}$' },
    currency: { type: 'string', enum: ['IDR'] },
    pickupStartsAt: { type: 'string', format: 'date-time' },
    pickupEndsAt: { type: 'string', format: 'date-time' },
    credentialId: { type: 'string', format: 'uuid' },
    credentialExpiresAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'orderId',
    'orderNumber',
    'status',
    'readyForHandover',
    'buyer',
    'totalMinor',
    'currency',
    'pickupStartsAt',
    'pickupEndsAt',
    'credentialId',
    'credentialExpiresAt',
  ],
};

export const pickupHandoverSchema = {
  type: 'object',
  properties: {
    handoverId: { type: 'string', format: 'uuid' },
    orderId: { type: 'string', format: 'uuid' },
    credentialId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['completed'] },
    handedOverAt: { type: 'string', format: 'date-time' },
  },
  required: ['handoverId', 'orderId', 'credentialId', 'status', 'handedOverAt'],
};
