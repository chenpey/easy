#!/usr/bin/env bash

EASYNOTE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$EASYNOTE_ROOT"
export WRANGLER_LOG_PATH="$EASYNOTE_ROOT/.wrangler/logs/"
export WRANGLER_REGISTRY_PATH="$EASYNOTE_ROOT/.wrangler/registry"
export WRANGLER_SEND_METRICS=false
export XDG_CONFIG_HOME="$EASYNOTE_ROOT/.wrangler/config"
export XDG_CACHE_HOME="$EASYNOTE_ROOT/.wrangler/cache"

fail() {
  printf 'EasyNote: %s\n' "$*" >&2
  exit 1
}

require_terminal() {
  [[ -t 0 && -t 1 ]] || fail "An interactive terminal is required for account setup and deployment."
}

require_runtime() {
  command -v node >/dev/null 2>&1 || fail "Install Node.js 22.12 or newer from https://nodejs.org, then run this command again."
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || major === 22 && minor < 12) process.exit(1)' ||
    fail "Node.js 22.12 or newer is required."
  command -v npm >/dev/null 2>&1 || fail "npm is missing. Install the complete Node.js distribution."
}

reject_environment_credentials() {
  [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -z "${CLOUDFLARE_API_KEY:-}" &&
     -z "${CF_API_TOKEN:-}" && -z "${CF_API_KEY:-}" ]] ||
    fail "Environment credentials are not accepted. This command prompts for an API token interactively."
}

prompt_cloudflare_token() {
  IFS= read -r -s -p 'Cloudflare API token (hidden, used only for this run): ' cloudflare_api_token
  printf '\n'
  [[ -n "$cloudflare_api_token" ]] || fail "A Cloudflare API token is required."
}

ensure_dependencies() {
  [[ -f package-lock.json ]] || fail "package-lock.json is missing; restore it before installing dependencies."
  local fingerprint installed
  fingerprint="$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    const hash = createHash("sha256");
    for (const path of ["package.json", "package-lock.json"]) hash.update(readFileSync(path));
    hash.update([process.platform, process.arch, process.versions.node.split(".")[0]].join(":"));
    console.log(hash.digest("hex"));
  ')"
  installed=""
  if [[ -f node_modules/.easynote-dependencies ]]; then
    IFS= read -r installed < node_modules/.easynote-dependencies || true
  fi
  if [[ "$installed" == "$fingerprint" &&
        -x node_modules/.bin/wrangler && -x node_modules/.bin/vite && -x node_modules/.bin/tsc ]]; then
    return
  fi
  printf 'Preparing locked dependencies...\n'
  npm ci --include=dev --no-audit --no-fund
  [[ -x node_modules/.bin/wrangler && -x node_modules/.bin/vite && -x node_modules/.bin/tsc ]] ||
    fail "Dependency installation did not produce the required tools."
  printf '%s\n' "$fingerprint" > node_modules/.easynote-dependencies
}

build_app() {
  printf 'Checking and building EasyNote...\n'
  npm run --silent build
}

require_free_port() {
  node --input-type=module - "$1" <<'NODE'
import net from 'node:net';
const value = process.argv[2];
const port = Number(value);
if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('EasyNote: --port must be an integer between 1024 and 65535.');
  process.exit(1);
}
const server = net.createServer();
server.once('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `EasyNote: port ${port} is in use. Stop that server or choose another port: bash dev.sh --port <port>`
    : `EasyNote: cannot listen on 127.0.0.1:${port}: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => server.close());
NODE
}
