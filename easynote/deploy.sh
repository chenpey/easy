#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/common.sh"

if [[ "${1:-}" == "--help" && $# == 1 ]]; then
  printf 'Usage: bash deploy.sh [--check]\n\nDeploy interactively using a hidden Cloudflare API Token and independent D1 / R2 resources.\n--check builds and validates locally without requesting credentials or changing cloud resources.\n'
  exit 0
fi
if [[ $# -gt 1 || ( $# == 1 && "$1" != "--check" ) ]]; then
  fail "Unknown arguments. Run bash deploy.sh --help."
fi
if [[ "${1:-}" != "--check" ]]; then
  require_terminal
fi
reject_environment_credentials
require_runtime
ensure_dependencies
build_app
if [[ "${1:-}" == "--check" ]]; then
  exec ./node_modules/.bin/wrangler deploy --dry-run --outdir .wrangler/dry-run
fi

exec node scripts/deploy.mjs
