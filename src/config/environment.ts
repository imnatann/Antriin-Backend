import Joi from 'joi';
export const environmentSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  HOST: Joi.string().default('127.0.0.1'),
  PORT: Joi.number().port().default(3000),
  CORS_ORIGINS: Joi.string().required(),
  SWAGGER_ENABLED: Joi.boolean().default(false),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DATABASE_POOL_MAX: Joi.number().integer().min(1).max(100).default(10),
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),
  AUTH_SECRET: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).allow('').optional(),
  }),
  AUTH_ENCRYPTION_KEY: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().required(),
    otherwise: Joi.string().allow('').optional(),
  }).custom((value: string, helpers) => {
    if (
      value &&
      (Buffer.from(value, 'base64').length !== 32 ||
        Buffer.from(value, 'base64').toString('base64') !== value)
    ) {
      return helpers.error('any.invalid');
    }
    return value;
  }),
  AUTH_OTP_TTL_SECONDS: Joi.number().integer().min(60).max(600).default(300),
  AUTH_OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(5),
  AUTH_OTP_RESEND_COOLDOWN_SECONDS: Joi.number()
    .integer()
    .min(30)
    .max(300)
    .default(60),
  AUTH_SESSION_TTL_SECONDS: Joi.number()
    .integer()
    .min(300)
    .max(86400)
    .default(86400),
  AUTH_OTP_DELIVERY_MAX_ATTEMPTS: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .default(5),
  // Pilot/dev only: log OTP codes instead of sending them. Independent of
  // NODE_ENV so a pilot host can keep production guards closed. Off by default.
  AUTH_OTP_DEV_ECHO: Joi.boolean().default(false),
  // Order/schedule proposal policy (pilot). Expiry never auto-accepts a proposal
  // and never starts production; preparation stays an explicit authorized action.
  ORDER_PROPOSAL_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(3600)
    .default(600),
  ORDER_PREPARATION_LEAD_SECONDS: Joi.number()
    .integer()
    .min(0)
    .max(7200)
    .default(900),
  PICKUP_CREDENTIAL_TTL_SECONDS: Joi.number()
    .integer()
    .min(300)
    .max(86400)
    .default(7200),
  // Top-up payments stay provider-disabled until real credentials/contracts exist.
  // Production refuses sandbox mode; sandbox requires an independent webhook secret.
  // 'xendit' runs the real QR flow against test-mode keys. It is allowed even
  // with NODE_ENV=production because XENDIT_SECRET_KEY below only accepts an
  // xnd_development_ key, and a test key cannot move real money. 'sandbox'
  // (a local stub) stays refused in production.
  PAYMENTS_PROVIDER_MODE: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().valid('disabled', 'xendit').default('disabled'),
    otherwise: Joi.string()
      .valid('disabled', 'sandbox', 'xendit')
      .default('disabled'),
  }),
  PAYMENTS_TOPUP_MIN_MINOR: Joi.number()
    .integer()
    .min(1)
    .max(100000000)
    .default(1000),
  PAYMENTS_TOPUP_MAX_MINOR: Joi.number()
    .integer()
    .min(Joi.ref('PAYMENTS_TOPUP_MIN_MINOR'))
    .max(100000000)
    .default(2000000),
  // Payout provider stays sandbox-only; production is disabled (D18 Q10).
  PAYOUTS_PROVIDER_MODE: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().valid('disabled').default('disabled'),
    otherwise: Joi.string().valid('disabled', 'sandbox').default('disabled'),
  }),
  // Sandbox top-up intent lifetime; expiry is informational (no sweeper yet).
  PAYMENTS_SANDBOX_TOPUP_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(86400)
    .default(3600),
  // Refund provider stays processor-driven sandbox-only; production is disabled.
  REFUNDS_PROVIDER_MODE: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().valid('disabled').default('disabled'),
    otherwise: Joi.string().valid('disabled', 'sandbox').default('disabled'),
  }),
  PAYMENTS_SANDBOX_WEBHOOK_SECRET: Joi.when('PAYMENTS_PROVIDER_MODE', {
    is: 'sandbox',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  // Xendit test-mode credentials. Required only when the Xendit adapter is
  // selected, so a disabled/sandbox deployment needs neither.
  XENDIT_SECRET_KEY: Joi.when('PAYMENTS_PROVIDER_MODE', {
    is: 'xendit',
    then: Joi.string()
      .pattern(/^xnd_development_[A-Za-z0-9]+$/)
      .required()
      .messages({
        'string.pattern.base':
          'XENDIT_SECRET_KEY must be a test-mode key (xnd_development_...); live keys are refused',
      }),
    otherwise: Joi.string().allow('').optional(),
  }),
  // Static token Xendit sends in the x-callback-token header. This is what
  // authenticates a callback, so it is mandatory whenever Xendit is enabled.
  XENDIT_CALLBACK_TOKEN: Joi.when('PAYMENTS_PROVIDER_MODE', {
    is: 'xendit',
    then: Joi.string().min(16).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  // Overridable so a test can point the adapter at a local stub.
  XENDIT_API_BASE_URL: Joi.string()
    .uri({ scheme: ['https', 'http'] })
    .default('https://api.xendit.co'),
  // Image uploads (POST /media) are written to this local directory and served
  // back from GET /media/{id}. Absolute paths are recommended outside local
  // development; the directory is created on boot if it does not exist.
  MEDIA_ROOT: Joi.string().default('./storage/media'),
  // Upper bound for one uploaded image. The database CHECK allows at most
  // MEDIA_ABSOLUTE_MAX_BYTES (20 MiB); this can only narrow it.
  MEDIA_MAX_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(20971520)
    .default(5242880),
  // When set, GET /metrics requires "Authorization: Bearer <token>". Unset
  // leaves the endpoint open, which is only appropriate for a private host.
  METRICS_TOKEN: Joi.string().min(16).max(200).allow('').optional(),
  // Optional allowlist for the SSE stream; the cap is enforced per connection
  // so a long-lived stream cannot pin a worker forever.
  EVENTS_STREAM_MAX_SECONDS: Joi.number()
    .integer()
    .min(30)
    .max(3600)
    .default(900),
});
