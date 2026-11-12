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
  PAYMENTS_PROVIDER_MODE: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().valid('disabled').default('disabled'),
    otherwise: Joi.string().valid('disabled', 'sandbox').default('disabled'),
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
  // Sandbox top-up intent lifetime; expiry is informational (no sweeper yet).
  PAYMENTS_SANDBOX_TOPUP_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(86400)
    .default(3600),
  PAYMENTS_SANDBOX_WEBHOOK_SECRET: Joi.when('PAYMENTS_PROVIDER_MODE', {
    is: 'sandbox',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
});
