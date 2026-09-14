#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/common.sh"

if [[ "${1:-}" == "--help" && $# == 1 ]]; then
  printf 'Usage: bash setup.sh\n\nPrepare locked dependencies and initialize the local owner interactively.\nExisting valid local configuration is preserved; this does not reset passwords.\n'
  exit 0
fi
[[ $# == 0 ]] || fail "Unknown arguments. Run bash setup.sh --help."
require_terminal
require_runtime
ensure_dependencies
node scripts/setup.mjs
printf '\nReady. Start EasyNote with: bash dev.sh\n'
