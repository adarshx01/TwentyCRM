#!/bin/sh
set -eu
# Railway public proxy uses PORT; Twenty listens on NODE_PORT.
export NODE_PORT="${PORT:-${NODE_PORT:-3000}}"
exec /app/entrypoint.sh "$@"
