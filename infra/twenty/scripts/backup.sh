#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p backups
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="backups/twenty_${STAMP}.sql"

# Official image names the db service "db"; compose project is rb-twenty.
CONTAINER="$(docker compose ps -q db)"
if [[ -z "$CONTAINER" ]]; then
  echo "db container is not running. Start with ./scripts/up.sh" >&2
  exit 1
fi

USER_NAME="$(grep -E '^PG_DATABASE_USER=' .env | cut -d= -f2- || true)"
DB_NAME="$(grep -E '^PG_DATABASE_NAME=' .env | cut -d= -f2- || true)"
USER_NAME="${USER_NAME:-postgres}"
DB_NAME="${DB_NAME:-default}"

docker compose exec -T db pg_dump -U "$USER_NAME" "$DB_NAME" > "$OUT"
echo "Wrote $ROOT/$OUT"
