#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ ! -t 0 || ! -t 1 ]]; then
  printf '%s\n' 'Deployment requires an interactive terminal.' >&2
  exit 1
fi
command -v node >/dev/null || { printf '%s\n' 'Node.js 22+ is required.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || {
  printf '%s\n' 'Node.js 22+ is required.' >&2
  exit 1
}
npm ci --no-fund --no-audit
exec node scripts/manage.mjs deploy
