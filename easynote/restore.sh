#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/common.sh"

if [[ "${1:-}" == "--help" ]]; then
  printf 'Usage: bash restore.sh BACKUP_DIR (--local|--remote) [--check]\n\nValidate a disaster-recovery backup and restore only into an empty target.\n'
  exit 0
fi
[[ $# -ge 2 ]] || fail "A backup directory and --local or --remote are required."
[[ " $* " == *" --local "* || " $* " == *" --remote "* ]] ||
  fail "Choose --local or --remote explicitly."
reject_environment_credentials
require_runtime
ensure_dependencies
if [[ " $* " != *" --check "* ]]; then
  require_terminal
  read -r -p 'Type restore easynote to write the target D1 and R2 resources: ' confirmation
  [[ "$confirmation" == "restore easynote" ]] || fail "Restore cancelled."
fi
node scripts/maintenance.mjs restore "$@"
