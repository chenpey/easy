#!/bin/zsh

emulate -L zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
SOURCE="$PROJECT_DIR/web/easynewmac-icon.svg"
OUTPUT="${1:-$PROJECT_DIR/build/EasyNewMac.icns}"
work_dir="$(/usr/bin/mktemp -d -t easynewmac-icon)"
iconset="$work_dir/EasyNewMac.iconset"
master="$work_dir/icon-1024.png"

cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

mkdir -p -- "$iconset"
/usr/bin/sips -s format png "$SOURCE" --out "$master" >/dev/null

for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$master" \
    --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double_size=$((size * 2))
  /usr/bin/sips -z "$double_size" "$double_size" "$master" \
    --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done

mkdir -p -- "${OUTPUT:h}"
/usr/bin/iconutil -c icns "$iconset" -o "$OUTPUT"
print -r -- "$OUTPUT"
