#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/common.sh"

if [[ "${1:-}" == "--help" ]]; then
  printf 'Usage: bash reset-password.sh (--local|--remote)\n\nReset one account password interactively and revoke that account'\''s sessions and AI tokens.\n'
  exit 0
fi
[[ $# == 1 && ( "$1" == "--local" || "$1" == "--remote" ) ]] ||
  fail "Choose exactly one of --local or --remote."
require_terminal
reject_environment_credentials
require_runtime
ensure_dependencies
if [[ "$1" == "--remote" ]]; then
  [[ -f wrangler.deploy.json ]] || fail "wrangler.deploy.json is missing. Deploy EasyNote before resetting its remote password."
  prompt_cloudflare_token
  CLOUDFLARE_API_TOKEN="$cloudflare_api_token" EASYNOTE_INTERACTIVE_CLOUDFLARE=1 \
    node scripts/maintenance.mjs reset-password --remote --config wrangler.deploy.json
else
  node scripts/maintenance.mjs reset-password --local --config wrangler.json
fi
