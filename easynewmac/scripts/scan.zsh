#!/bin/zsh

emulate -L zsh
set -euo pipefail
setopt null_glob

OUTPUT_FILE="${1:?需要指定 data.js 输出路径}"
OUTPUT_DIR="${OUTPUT_FILE:h}"
ROWS_FILE="$OUTPUT_DIR/.rows.js"
OUTPUT_TMP="$OUTPUT_FILE.tmp.$$"
PLIST_BUDDY="/usr/libexec/PlistBuddy"
SCRIPT_DIR="${0:A:h}"

typeset -A seen_ids
typeset -A seen_bundles
typeset -A cask_app_names
typeset -A catalog_casks
typeset -A catalog_cask_names

mkdir -p -- "$OUTPUT_DIR"
: > "$ROWS_FILE"

cleanup() {
  rm -f -- "$ROWS_FILE" "$OUTPUT_TMP"
}
trap cleanup EXIT

clean_text() {
  local value="${1:-}"
  value="${value//$'\r'/ }"
  value="${value//$'\n'/ }"
  value="${value//$'\t'/ }"
  print -rn -- "$value"
}

encode() {
  clean_text "${1:-}" | /usr/bin/base64 | /usr/bin/tr -d '\r\n'
}

plist_value() {
  local plist="$1"
  local key="$2"
  local value

  [[ -f "$plist" ]] || return 0
  value="$("$PLIST_BUDDY" -c "Print :$key" "$plist" 2>/dev/null || true)"
  clean_text "$value"
}

emit_item() {
  local id="$1"
  local kind="$2"
  local name="$3"
  local version="$4"
  local bundle_id="$5"
  local install_id="$6"
  local path="$7"

  [[ -n "$id" && -n "$name" ]] || return 0
  [[ -z "${seen_ids[$id]:-}" ]] || return 0
  seen_ids[$id]=1

  printf '    ["%s","%s","%s","%s","%s","%s","%s"],\n' \
    "$(encode "$id")" \
    "$(encode "$kind")" \
    "$(encode "$name")" \
    "$(encode "$version")" \
    "$(encode "$bundle_id")" \
    "$(encode "$install_id")" \
    "$(encode "$path")" >> "$ROWS_FILE"
}

bundle_details() {
  local app_path="$1"
  local plist="$app_path/Contents/Info.plist"
  local fallback_name="${app_path:t:r}"
  local name
  local version
  local bundle_id
  local pwa_url
  local pwa_id

  name="$(plist_value "$plist" "CFBundleDisplayName")"
  [[ -n "$name" ]] || name="$(plist_value "$plist" "CFBundleName")"
  [[ -n "$name" ]] || name="$fallback_name"

  version="$(plist_value "$plist" "CFBundleShortVersionString")"
  [[ -n "$version" ]] || version="$(plist_value "$plist" "CFBundleVersion")"
  bundle_id="$(plist_value "$plist" "CFBundleIdentifier")"
  pwa_url="$(plist_value "$plist" "CrAppModeShortcutURL")"
  pwa_id="$(plist_value "$plist" "CrAppModeShortcutID")"

  reply=("$name" "$version" "$bundle_id" "$pwa_url" "$pwa_id")
}

cask_catalog=""
for candidate in \
  "$SCRIPT_DIR/catalog/homebrew-casks.tsv" \
  "$SCRIPT_DIR/../catalog/homebrew-casks.tsv"; do
  if [[ -f "$candidate" ]]; then
    cask_catalog="$candidate"
    break
  fi
done

if [[ -n "$cask_catalog" ]]; then
  while IFS=$'\t' read -r app_filename cask_token; do
    [[ -n "$app_filename" && "$app_filename" != '# '* ]] || continue
    [[ "$app_filename" == *.app ]] || continue
    [[ "$cask_token" =~ '^[A-Za-z0-9][A-Za-z0-9@+._-]*$' ]] || continue
    catalog_casks[$app_filename]="$cask_token"
  done < "$cask_catalog"
fi

cask_name_catalog=""
for candidate in \
  "$SCRIPT_DIR/catalog/homebrew-cask-names.tsv" \
  "$SCRIPT_DIR/../catalog/homebrew-cask-names.tsv"; do
  if [[ -f "$candidate" ]]; then
    cask_name_catalog="$candidate"
    break
  fi
done

if [[ -n "$cask_name_catalog" ]]; then
  while IFS=$'\t' read -r display_name cask_token; do
    [[ -n "$display_name" && "$display_name" != '# '* ]] || continue
    [[ "$cask_token" =~ '^[A-Za-z0-9][A-Za-z0-9@+._-]*$' ]] || continue
    catalog_cask_names[$display_name]="$cask_token"
  done < "$cask_name_catalog"
fi

brew_bin=""
for candidate in \
  "/opt/homebrew/bin/brew" \
  "/usr/local/bin/brew" \
  "$(command -v brew 2>/dev/null || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    brew_bin="$candidate"
    break
  fi
done

if [[ -n "$brew_bin" ]]; then
  export HOMEBREW_NO_ANALYTICS=1
  export HOMEBREW_NO_AUTO_UPDATE=1

  brew_version="$("$brew_bin" --version 2>/dev/null | /usr/bin/head -n 1 || true)"
  brew_version="${brew_version#Homebrew }"
  emit_item "homebrew" "homebrew" "Homebrew" "$brew_version" "" "homebrew" ""

  cask_tokens=("${(@f)$("$brew_bin" list --cask 2>/dev/null || true)}")
  for token in "${cask_tokens[@]}"; do
    [[ "$token" =~ '^[A-Za-z0-9][A-Za-z0-9@+._-]*$' ]] || continue

    cask_paths=("${(@f)$("$brew_bin" list --cask "$token" 2>/dev/null || true)}")
    app_path=""
    for installed_path in "${cask_paths[@]}"; do
      if [[ "$installed_path" == *.app ]]; then
        app_name="${installed_path:t}"
        cask_app_names[$app_name]="$token"
        [[ -n "$app_path" ]] || app_path="$installed_path"
      fi
    done

    name="$token"
    version=""
    bundle_id=""
    if [[ -n "$app_path" && -d "$app_path" ]]; then
      bundle_details "$app_path"
      name="$reply[1]"
      version="$reply[2]"
      bundle_id="$reply[3]"
    fi

    # Homebrew GUI is an optional frontend for the package manager. Listing it
    # beside Homebrew itself creates two indistinguishable migration choices.
    if [[ "$token" == "homebrew-app" ]]; then
      [[ -n "$bundle_id" ]] && seen_bundles[$bundle_id]=1
      continue
    fi

    if [[ -z "$version" ]]; then
      version_line="$("$brew_bin" list --versions --cask "$token" 2>/dev/null || true)"
      version="${version_line#"$token"}"
      version="${version## }"
    fi

    emit_item "cask:$token" "cask" "$name" "$version" "$bundle_id" "$token" ""
    [[ -n "$bundle_id" ]] && seen_bundles[$bundle_id]=1
  done

  formula_tokens=("${(@f)$("$brew_bin" leaves 2>/dev/null || true)}")
  for token in "${formula_tokens[@]}"; do
    [[ "$token" =~ '^[A-Za-z0-9][A-Za-z0-9@+._/-]*$' ]] || continue
    version_line="$("$brew_bin" list --versions "$token" 2>/dev/null || true)"
    version="${version_line#"$token"}"
    version="${version## }"
    emit_item "formula:$token" "formula" "$token" "$version" "" "$token" ""
  done
fi

search_roots=()
[[ -d "/Applications" ]] && search_roots+=("/Applications")
[[ -d "$HOME/Applications" ]] && search_roots+=("$HOME/Applications")

if (( ${#search_roots[@]} > 0 )); then
  while IFS= read -r -d $'\0' app_path; do
    [[ -d "$app_path" ]] || continue

    app_filename="${app_path:t}"
    [[ -z "${cask_app_names[$app_filename]:-}" ]] || continue

    bundle_details "$app_path"
    name="$reply[1]"
    version="$reply[2]"
    bundle_id="$reply[3]"
    pwa_url="$reply[4]"
    pwa_id="$reply[5]"

    if [[ -n "$bundle_id" && -n "${seen_bundles[$bundle_id]:-}" ]]; then
      continue
    fi

    adam_id="$(/usr/bin/mdls -raw -name kMDItemAppStoreAdamID "$app_path" 2>/dev/null \
      | /usr/bin/tr -d '\0\r\n' || true)"

    display_path="$app_path"
    if [[ "$display_path" == "$HOME"/* ]]; then
      display_path="~/${display_path#"$HOME"/}"
    fi

    catalog_key="${app_filename:l}"
    cask_token="${catalog_casks[$catalog_key]:-}"
    app_stem="${app_filename:r}"
    app_stem="${app_stem:l}"
    display_name_key="${name:l}"
    if [[ -z "$cask_token" && "$app_stem" == "$display_name_key" ]]; then
      cask_token="${catalog_cask_names[$display_name_key]:-}"
    fi

    if [[ -n "$pwa_id" && "$pwa_url" == (http|https)://* ]]; then
      stable_id="$bundle_id"
      [[ -n "$stable_id" ]] || stable_id="$pwa_id"
      emit_item "pwa:$stable_id" "pwa" "$name" "$version" "$bundle_id" "$pwa_url" "$display_path"
    elif [[ "$adam_id" =~ '^[0-9]+$' ]]; then
      emit_item "mas:$adam_id" "mas" "$name" "$version" "$bundle_id" "$adam_id" "$display_path"
    elif [[ "$bundle_id" != com.google.Chrome.app.* \
      && "$bundle_id" != com.microsoft.edgemac.app.* \
      && -n "$cask_token" ]]; then
      emit_item "cask:$cask_token" "cask" "$name" "$version" "$bundle_id" "$cask_token" "$display_path"
    else
      stable_id="$bundle_id"
      [[ -n "$stable_id" ]] || stable_id="$display_path"
      emit_item "manual:$stable_id" "manual" "$name" "$version" "$bundle_id" "" "$display_path"
    fi

    [[ -n "$bundle_id" ]] && seen_bundles[$bundle_id]=1
  done < <(/usr/bin/find "${search_roots[@]}" -maxdepth 4 -name '*.app' -prune -print0 2>/dev/null)
fi

scanned_at="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
computer_name="$(/usr/sbin/scutil --get ComputerName 2>/dev/null || /bin/hostname -s)"

{
  print 'window.EASYNEWMAC_SCAN = Object.freeze({'
  print '  schemaVersion: 1,'
  printf '  scannedAt: "%s",\n' "$(encode "$scanned_at")"
  printf '  computerName: "%s",\n' "$(encode "$computer_name")"
  print '  rows: ['
  /bin/cat "$ROWS_FILE"
  print '  ]'
  print '});'
} > "$OUTPUT_TMP"

/bin/chmod 600 "$OUTPUT_TMP"
/bin/mv -f -- "$OUTPUT_TMP" "$OUTPUT_FILE"
