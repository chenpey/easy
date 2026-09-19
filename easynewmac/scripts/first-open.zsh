#!/bin/zsh

emulate -L zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_PATH="$SCRIPT_DIR/EasyNewMac.app"
INFO_PLIST="$APP_PATH/Contents/Info.plist"
EXPECTED_IDENTIFIER="party.tiandi.easynewmac"
terminal_tty="$(/usr/bin/tty 2>/dev/null || true)"

fail() {
  print -u2 -- ""
  print -u2 -- "无法打开 EasyNewMac：$1"
  print -u2 -- ""
  read -r "?按回车键关闭..."
  exit 1
}

[[ -d "$APP_PATH" ]] || fail "请将此脚本与 EasyNewMac.app 保持在同一文件夹。"

close_own_terminal_tab() {
  [[ "${TERM_PROGRAM:-}" == "Apple_Terminal" && "$terminal_tty" == /dev/* ]] || return 0

  (
    sleep 1
    /usr/bin/osascript - "$terminal_tty" <<'APPLESCRIPT'
on run argv
	set targetTTY to item 1 of argv
	tell application "Terminal"
		repeat with targetWindow in windows
			repeat with targetTab in tabs of targetWindow
				if tty of targetTab is targetTTY then
					if (count of tabs of targetWindow) is 1 then
						close targetWindow
					else
						close targetTab
					end if
					return
				end if
			end repeat
		end repeat
	end tell
end run
APPLESCRIPT
  ) >/dev/null 2>&1 &
}

print -- ""
print -- "EasyNewMac 首次打开"
print -- "正在验证应用完整性..."

/usr/bin/codesign --verify --deep --strict "$APP_PATH" 2>/dev/null \
  || fail "应用签名校验失败，请从官方 Release 重新下载。"

bundle_id="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$INFO_PLIST" 2>/dev/null || true)"
[[ "$bundle_id" == "$EXPECTED_IDENTIFIER" ]] \
  || fail "应用标识不正确，请从官方 Release 重新下载。"

# The app is ad-hoc signed because no Developer ID is available. Remove only
# this downloaded app's quarantine marker after verifying its sealed contents.
/usr/bin/xattr -dr com.apple.quarantine "$APP_PATH" \
  || fail "无法移除下载隔离标记。"

print -- "验证通过，正在打开 EasyNewMac..."
/usr/bin/open "$APP_PATH" || fail "无法打开应用。"

print -- "以后可以直接双击 EasyNewMac.app。"
close_own_terminal_tab
