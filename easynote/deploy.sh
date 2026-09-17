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

printf '\nEasyNote deploy: uses isolated D1 / R2 resources.\n'
reuse=no
account_id=""
if [[ -f wrangler.deploy.json ]]; then
  node scripts/deploy-config.mjs --show
  account_id="$(node scripts/deploy-config.mjs --account)"
  read -r -p 'Reuse these deployment resources? [Y/n]: ' answer
  case "$answer" in
    ""|y|Y|yes|YES) reuse=yes ;;
    n|N|no|NO) ;;
    *) fail "Expected y or n; deployment cancelled." ;;
  esac
fi
if [[ "$reuse" == "no" ]]; then
  read -r -p 'Cloudflare account ID: ' account_id
  read -r -p 'Existing D1 database UUID (create easynote-db in Cloudflare first): ' database_id
  read -r -p 'Existing R2 bucket name: ' bucket_name
  read -r -p 'Worker name [easynote]: ' worker_name
  worker_name="${worker_name:-easynote}"
  node scripts/deploy-config.mjs --validate "$account_id" "$database_id" "$bucket_name" "$worker_name"
elif [[ -z "$account_id" ]]; then
  read -r -p 'Cloudflare account ID: ' account_id
fi
read -r -p 'Type deploy easynote to apply migrations and deploy: ' confirmation
if [[ "$confirmation" != "deploy easynote" ]]; then
  printf 'Deployment cancelled.\n'
  exit 1
fi
prompt_cloudflare_token
if [[ "$reuse" == "yes" ]]; then
  node scripts/deploy-config.mjs --reuse "$account_id"
else
  node scripts/deploy-config.mjs "$account_id" "$database_id" "$bucket_name" "$worker_name"
fi
bucket_name="$(node scripts/deploy-config.mjs --bucket)"
run_wrangler() {
  CLOUDFLARE_API_TOKEN="$cloudflare_api_token" CLOUDFLARE_ACCOUNT_ID="$account_id" \
    ./node_modules/.bin/wrangler "$@"
}
printf 'Checking API Token access to D1 and R2...\n'
run_wrangler d1 info DB --config wrangler.deploy.json --json >/dev/null
run_wrangler r2 bucket info "$bucket_name" --config wrangler.deploy.json --json >/dev/null
run_wrangler d1 migrations apply DB --remote --config wrangler.deploy.json
run_wrangler deploy --config wrangler.deploy.json
CLOUDFLARE_API_TOKEN="$cloudflare_api_token" CLOUDFLARE_ACCOUNT_ID="$account_id" EASYNOTE_INTERACTIVE_CLOUDFLARE=1 \
  node scripts/setup.mjs --remote --config wrangler.deploy.json
printf '\nDeployment complete.\n'
printf 'The Cloudflare API Token was not saved.\n'
