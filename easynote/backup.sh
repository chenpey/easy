#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/common.sh"

if [[ "${1:-}" == "--help" ]]; then
  printf 'Usage: bash backup.sh (--local|--remote) [--output DIR]\n\nCreate and verify a complete D1 and R2 disaster-recovery backup.\n'
  exit 0
fi
[[ " $* " == *" --local "* || " $* " == *" --remote "* ]] ||
  fail "Choose --local or --remote explicitly."
require_terminal
reject_environment_credentials
require_runtime
ensure_dependencies
read -r -p 'Type backup easynote to export D1 and R2: ' confirmation
[[ "$confirmation" == "backup easynote" ]] || fail "Backup cancelled."
if [[ " $* " == *" --remote "* ]]; then
  prompt_cloudflare_token
  CLOUDFLARE_API_TOKEN="$cloudflare_api_token" EASYNOTE_INTERACTIVE_CLOUDFLARE=1 \
    node scripts/maintenance.mjs backup "$@"
else
  node scripts/maintenance.mjs backup "$@"
fi
