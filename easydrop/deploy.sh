#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

cleanup() {
  result=$?
  trap - EXIT
  if [[ $result -eq 0 ]]; then
    rm -rf node_modules dist .wrangler/logs
    rmdir .wrangler 2>/dev/null || true
    printf '%s\n' 'Cleaned local deployment dependencies, build output and logs.'
  fi
  exit "$result"
}
trap cleanup EXIT

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
node scripts/manage.mjs deploy
