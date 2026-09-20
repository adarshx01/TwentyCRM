#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created infra/twenty/.env from .env.example"
fi

set_env () {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

need_replace () {
  local key="$1"
  local current
  current="$(grep -E "^${key}=" .env | head -n1 | cut -d= -f2- || true)"
  [[ -z "$current" || "$current" == replace_me_with_* ]]
}

if need_replace ENCRYPTION_KEY; then
  set_env ENCRYPTION_KEY "$(openssl rand -base64 32)"
  echo "Generated ENCRYPTION_KEY"
fi

if need_replace PG_DATABASE_PASSWORD; then
  set_env PG_DATABASE_PASSWORD "$(openssl rand -hex 16)"
  echo "Generated PG_DATABASE_PASSWORD"
fi

docker compose pull
docker compose up -d

echo "Waiting for Twenty healthz on :3000 ..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000/healthz >/dev/null; then
    echo "Twenty is up: http://localhost:3000"
    exit 0
  fi
  sleep 2
done

echo "Timed out waiting for healthz. Logs:" >&2
docker compose logs --tail=80 server >&2
exit 1
