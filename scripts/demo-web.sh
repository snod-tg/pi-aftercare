#!/bin/sh
# Run: npm run demo:web
# Prerequisites: dependencies, configured .env, running PostgreSQL and external model API.
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"
if [ ! -f .env ]; then
  echo 'Missing .env: copy .env.example and configure MODEL_* and DATABASE_URL first.' >&2
  exit 1
fi
# Isolate the demonstration from the default business schema. Reusing this name preserves data.
export DATABASE_SCHEMA="${DEMO_DATABASE_SCHEMA:-aftercare_demo}"
npm_exec() {
  if [ -x .runtime/node/bin/node ]; then ./scripts/npm "$@"; else npm "$@"; fi
}
npm_exec run db:init
npm_exec run build
echo 'Open http://127.0.0.1:3000 (or the PORT configured in .env).'
echo "Demo schema: $DATABASE_SCHEMA. Existing conversations and applications are preserved."
npm_exec start
