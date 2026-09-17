#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null 2>&1 || {
  printf '%s\n' 'Reset: Node.js 22.12 or newer is required.' >&2
  exit 1
}
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || major === 22 && minor < 12) process.exit(1)' || {
  printf '%s\n' 'Reset: Node.js 22.12 or newer is required.' >&2
  exit 1
}

exec node "$root/scripts/reset.mjs" "$@"
