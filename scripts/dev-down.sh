#!/usr/bin/env bash
cd "$(dirname "$0")/.."
for name in scheduler worker api agent; do
  [ -f ".run/$name.pid" ] && kill -TERM "$(cat .run/$name.pid)" 2>/dev/null && echo "stopped $name"; rm -f ".run/$name.pid"
done
