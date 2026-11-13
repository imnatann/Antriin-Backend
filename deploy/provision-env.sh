#!/usr/bin/env bash
# One-shot provisioning for the deployment host. Idempotent: an existing .env is
# never rewritten, so secrets are not rotated on redeploy.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/antriin}"
PUBLIC_HOST="${PUBLIC_HOST:-172.235.245.160}"
cd "$DEPLOY_DIR"

if [ -f .env ]; then
  echo "ENV_EXISTS: leaving the existing .env untouched"
  exit 0
fi

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

PG_PASSWORD="$(openssl rand -hex 24)"
AUTH_SECRET="$(openssl rand -hex 32)"
AUTH_ENCRYPTION_KEY="$(openssl rand -base64 32)"

umask 077
cat > .env <<ENVEOF
# Generated on the deployment host. Never commit this file.
NODE_ENV=production
HOST=0.0.0.0
PORT=3000

# Replace with the real frontend origins before the pilot opens to users.
CORS_ORIGINS=http://${PUBLIC_HOST}:3000
SWAGGER_ENABLED=true

# Datastores (service names inside the compose network).
POSTGRES_USER=antriin
POSTGRES_PASSWORD=${PG_PASSWORD}
POSTGRES_DB=antriin
DATABASE_URL=postgresql://antriin:${PG_PASSWORD}@postgres:5432/antriin
DATABASE_POOL_MAX=10
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=

LOG_LEVEL=info
AUTH_SECRET=${AUTH_SECRET}
AUTH_ENCRYPTION_KEY=${AUTH_ENCRYPTION_KEY}

# Providers stay disabled: production refuses sandbox modes.
PAYMENTS_PROVIDER_MODE=disabled
PAYOUTS_PROVIDER_MODE=disabled
REFUNDS_PROVIDER_MODE=disabled
ENVEOF
chmod 600 .env

echo "ENV_CREATED"
echo "keys present: $(grep -c '=' .env)"
echo "auth_encryption_key length: ${#AUTH_ENCRYPTION_KEY}"
