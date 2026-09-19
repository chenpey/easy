#!/bin/zsh

emulate -L zsh
set -euo pipefail

RESOURCE_DIR="${0:A:h}"
WEB_DIR="$RESOURCE_DIR/web"
SCANNER="$RESOURCE_DIR/scan.zsh"
runtime_root="${TMPDIR:-/tmp}/EasyNewMac-$UID"
run_dir="$runtime_root/current"

[[ -d "$WEB_DIR" ]] || {
  print -u2 -- "缺少网页资源。"
  exit 1
}
[[ -x "$SCANNER" ]] || {
  print -u2 -- "扫描器不可执行。"
  exit 1
}

rm -rf -- "$runtime_root"
mkdir -p -- "$run_dir"
cp -R "$WEB_DIR/." "$run_dir/"
rm -f -- "$run_dir/data.js"

/usr/bin/open "$run_dir/loading.html"
"$SCANNER" "$run_dir/data.js"

nohup /bin/zsh -c 'sleep 1800; rm -rf -- "$1"' _ "$runtime_root" \
  >/dev/null 2>&1 </dev/null &
