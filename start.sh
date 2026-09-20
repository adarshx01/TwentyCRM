#!/usr/bin/env sh
set -e
if [ -f /app/dist/main.js ]; then
  exec node /app/dist/main.js
fi
if [ -f dist/main.js ]; then
  exec node dist/main.js
fi
if [ -f apps/outreach/dist/main.js ]; then
  exec node apps/outreach/dist/main.js
fi
echo "outreach dist/main.js not found" >&2
exit 1
