#!/usr/bin/env bash
# Start the local stack: Python LangChain agent, API, worker, scheduler (Twenty and Redis run in Docker).
#   ./scripts/dev-up.sh        start        ./scripts/dev-down.sh   stop
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
[ -f .env.local ] || { echo ".env.local is missing (see docs/local-run.md)"; exit 1; }
set -a; . ./.env.local; set +a
mkdir -p .run .data
[ -d dist ] || pnpm build

start() { # start <name> <cwd> [ENV=val ...] -- <command...>
  local name=$1 dir=$2; shift 2
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  if [ -f "$ROOT/.run/$name.pid" ] && kill -0 "$(cat "$ROOT/.run/$name.pid")" 2>/dev/null; then echo "$name already running"; return; fi
  ( cd "$dir"; env "${envs[@]}" setsid nohup "$@" > "$ROOT/.run/$name.log" 2>&1 < /dev/null & echo $! > "$ROOT/.run/$name.pid" )
  echo "started $name"
}
# Ports: 3400 API, 3401 worker, 3402 scheduler, 8001 agent (3000 = Twenty).
start agent     "$ROOT/agent" X=1 -- .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
start api       "$ROOT" APP_ROLE=api APP_PORT=3400 -- node dist/main.js
start worker    "$ROOT" APP_ROLE=worker APP_PORT=3401 -- node dist/main.js
start scheduler "$ROOT" APP_ROLE=scheduler APP_PORT=3402 -- node dist/main.js

for i in $(seq 1 90); do curl -sf localhost:3400/health/ready >/dev/null && curl -sf localhost:8001/health >/dev/null && break; sleep 1; done
echo "API      http://localhost:3400/health/ready"; echo "Dev chat http://localhost:3400/dev/chat"; echo "Agent    http://localhost:8001/health"; echo "Twenty   ${TWENTY_API_URL}"
