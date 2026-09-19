#!/bin/zsh

emulate -L zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
WEB_DIR="$PROJECT_DIR/web"
SCANNER="$PROJECT_DIR/scripts/scan.zsh"
output_dir="${1:-${TMPDIR:-/tmp}/EasyNewMac-scan-$UID}"

rm -rf -- "$output_dir"
mkdir -p -- "$output_dir"
cp -R "$WEB_DIR/." "$output_dir/"
"$SCANNER" "$output_dir/data.js"

print -r -- "$output_dir/index.html"
