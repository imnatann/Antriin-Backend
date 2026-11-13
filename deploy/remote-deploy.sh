#!/usr/bin/env bash
# Runs ON the deployment host. Invoked by .github/workflows/deploy.yml, which
# pipes this file over SSH with IMAGE and TAG already set.
set -euo pipefail

: "${IMAGE:?IMAGE is required}"
: "${TAG:?TAG is required}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/antriin}"
APP_PORT="${APP_PORT:-3000}"
RUNTIME_IMAGE="${IMAGE}:${TAG}"
MIGRATOR_IMAGE="${IMAGE}:${TAG}-migrator"

cd "$DEPLOY_DIR"

if [ ! -f .env ]; then
  echo "FATAL: $DEPLOY_DIR/.env is missing; provision it before deploying." >&2
  exit 1
fi

# Remember what is running so a failed healthcheck can roll back.
PREV_IMAGE="$(docker inspect --format '{{.Config.Image}}' antriin-api-1 2>/dev/null || true)"
echo "previous image: ${PREV_IMAGE:-<none>}"
echo "target image:   $RUNTIME_IMAGE"

echo '--- pulling images'
docker pull "$RUNTIME_IMAGE"
docker pull "$MIGRATOR_IMAGE"

echo '--- ensuring datastores are up'
ANTRIIN_IMAGE="$RUNTIME_IMAGE" docker compose up -d postgres redis

echo '--- running migrations'
# </dev/null: the migrate container must never read the caller's stdin.
ANTRIIN_IMAGE="$MIGRATOR_IMAGE" docker compose --profile tools run --rm migrate < /dev/null

echo '--- starting application'
ANTRIIN_IMAGE="$RUNTIME_IMAGE" docker compose up -d --remove-orphans api worker

echo '--- waiting for readiness'
ready=0
for attempt in $(seq 1 40); do
  if curl --fail --silent --max-time 5 "http://127.0.0.1:${APP_PORT}/v1/health/ready" >/dev/null 2>&1; then
    ready=1
    echo "ready after ${attempt} attempt(s)"
    break
  fi
  sleep 2
done

if [ "$ready" -ne 1 ]; then
  echo 'FATAL: /v1/health/ready never became ready' >&2
  docker compose ps >&2 || true
  docker compose logs --tail 80 api worker >&2 || true
  if [ -n "$PREV_IMAGE" ]; then
    echo "--- rolling back to $PREV_IMAGE"
    ANTRIIN_IMAGE="$PREV_IMAGE" docker compose up -d --no-deps api worker || true
  else
    echo '--- no previous image available for rollback' >&2
  fi
  exit 1
fi

echo '--- final state'
docker compose ps
docker image prune -f --filter 'until=168h' >/dev/null 2>&1 || true
