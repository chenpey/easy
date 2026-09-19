#!/bin/zsh

emulate -L zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
BUILD_DIR="$PROJECT_DIR/build"
DIST_DIR="$PROJECT_DIR/dist"
PACKAGE_NAME="EasyNewMac"
VERSION="$(<"$PROJECT_DIR/VERSION")"
VERSION="${VERSION//$'\r'/}"
VERSION="${VERSION//$'\n'/}"
STAGING_DIR="$(/usr/bin/mktemp -d -t easynewmac-release)"

cleanup() {
  rm -rf -- "$STAGING_DIR"
}
trap cleanup EXIT

[[ "$VERSION" =~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ]] || {
  print -u2 -- "无效版本号：$VERSION"
  exit 1
}

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf -- "$BUILD_DIR" "$DIST_DIR"
  print -- "已清理 build/ 和 dist/。"
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  print -u2 -- "用法：./scripts/build.zsh [--clean]"
  exit 1
fi

APP_PATH="$BUILD_DIR/$PACKAGE_NAME.app"
ARCHIVE_NAME="$PACKAGE_NAME-v$VERSION.zip"
ARCHIVE_PATH="$DIST_DIR/$ARCHIVE_NAME"
RELEASE_DIR="$STAGING_DIR/$PACKAGE_NAME"
ICON_PATH="$STAGING_DIR/$PACKAGE_NAME.icns"

rm -rf -- "$BUILD_DIR" "$DIST_DIR"
mkdir -p -- "$BUILD_DIR" "$DIST_DIR" "$RELEASE_DIR"

"$PROJECT_DIR/scripts/generate-icon.zsh" "$ICON_PATH" >/dev/null

/usr/bin/osacompile \
  -o "$APP_PATH" \
  "$PROJECT_DIR/scripts/launcher.applescript"

APP_RESOURCES="$APP_PATH/Contents/Resources"
mkdir -p "$APP_RESOURCES/web" "$APP_RESOURCES/catalog"
cp "$ICON_PATH" "$APP_RESOURCES/EasyNewMac.icns"
cp "$PROJECT_DIR/scripts/app-launch.zsh" "$APP_RESOURCES/"
cp "$PROJECT_DIR/scripts/scan.zsh" "$APP_RESOURCES/"
cp "$PROJECT_DIR/catalog/homebrew-casks.tsv" "$APP_RESOURCES/catalog/"
cp "$PROJECT_DIR/catalog/homebrew-cask-names.tsv" "$APP_RESOURCES/catalog/"
cp "$PROJECT_DIR/web/index.html" "$APP_RESOURCES/web/"
cp "$PROJECT_DIR/web/loading.html" "$APP_RESOURCES/web/"
cp "$PROJECT_DIR/web/style.css" "$APP_RESOURCES/web/"
cp "$PROJECT_DIR/web/core.js" "$APP_RESOURCES/web/"
cp "$PROJECT_DIR/web/app.js" "$APP_RESOURCES/web/"
chmod 755 "$APP_RESOURCES/app-launch.zsh" "$APP_RESOURCES/scan.zsh"

INFO_PLIST="$APP_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile EasyNewMac.icns" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string party.tiandi.easynewmac" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $VERSION" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $VERSION" "$INFO_PLIST"

/usr/bin/codesign --force --deep --sign - "$APP_PATH"
/usr/bin/codesign --verify --deep --strict "$APP_PATH"

/usr/bin/ditto --norsrc --noextattr --noqtn --noacl \
  "$APP_PATH" \
  "$RELEASE_DIR/$PACKAGE_NAME.app"
cp "$PROJECT_DIR/README.md" "$RELEASE_DIR/"

/usr/bin/ditto -c -k --keepParent --norsrc --noextattr --noqtn --noacl \
  "$RELEASE_DIR" \
  "$ARCHIVE_PATH"

(
  cd "$DIST_DIR"
  /usr/bin/shasum -a 256 "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256"
)

print -r -- "应用：$APP_PATH"
print -r -- "发布包：$ARCHIVE_PATH"
print -r -- "校验和：$ARCHIVE_PATH.sha256"
