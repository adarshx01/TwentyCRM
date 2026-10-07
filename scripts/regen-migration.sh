#!/usr/bin/env bash
# Regenerate migrations/0001_schema.sql from src/database/schema.ts while the schema is pre-release.
# After the first production deploy, NEVER edit applied migrations: use `pnpm migrate:generate`
# and commit the new numbered file instead.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf migrations/generated
npx drizzle-kit generate --config drizzle.config.ts >/dev/null
sed 's/--> statement-breakpoint//' migrations/generated/0000_*.sql > migrations/0001_schema.sql
rm -rf migrations/generated
echo "regenerated migrations/0001_schema.sql"
