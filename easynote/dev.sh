#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/common.sh"

port=8791
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      printf 'Usage: bash dev.sh [--port PORT]\n\nPrepare dependencies, initialize a missing local account, build, migrate and start.\nDefault: http://127.0.0.1:8791. Press Ctrl+C to stop. No cloud resources are used.\n'
      exit 0
      ;;
    --port)
      [[ $# -ge 2 && -n "$2" ]] || fail "--port requires a value."
      port="$2"
      shift 2
      ;;
    *) fail "Unknown argument: $1. Run bash dev.sh --help." ;;
  esac
done

require_runtime
require_free_port "$port"
if [[ ! -f .dev.vars ]]; then
  require_terminal
fi
ensure_dependencies
if [[ ! -f .dev.vars ]]; then
  node scripts/setup.mjs
else
  node scripts/setup.mjs --check-local
fi
build_app
printf 'Applying local database migrations...\n'
./node_modules/.bin/wrangler d1 migrations apply DB --local
printf '\nStarting http://127.0.0.1:%s (Ctrl+C to stop).\n' "$port"
exec ./node_modules/.bin/wrangler dev --ip 127.0.0.1 --port "$port" --var ALLOW_LOCAL_HTTP:true
