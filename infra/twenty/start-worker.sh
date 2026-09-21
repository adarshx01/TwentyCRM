#!/bin/sh
set -eu
export NODE_PORT="${PORT:-${NODE_PORT:-3000}}"

if [ -n "${SERVER_URL:-}" ]; then
  health_url="${SERVER_URL%/}/healthz"
  attempt=1
  max_attempts=90
  while ! node -e 'fetch(process.argv[1]).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$health_url"; do
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "Twenty server did not become ready at ${health_url}" >&2
      exit 1
    fi
    echo "Waiting for Twenty server (attempt ${attempt}/${max_attempts})"
    attempt=$((attempt + 1))
    sleep 5
  done
fi

exec yarn worker:prod
