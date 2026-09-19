(function (global) {
  "use strict";

  const ROW_FIELDS = [
    "id",
    "kind",
    "name",
    "version",
    "bundleId",
    "installId",
    "path",
  ];
  const AUTOMATIC_KINDS = new Set(["homebrew", "cask", "formula", "mas"]);
  const BREW_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@+._/-]*$/;
  const CASK_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@+._-]*$/;
  const APP_STORE_ID_PATTERN = /^[0-9]+$/;
  const NODE_FORMULA_PATTERN = /^node(?:@([0-9]+))?$/;
  const NODE_VERSION_PATTERN = /^v?([0-9]+(?:\.[0-9]+){0,2})/;
  const WEB_APP_URL_PATTERN = /^https?:\/\/[^\s"'`]+$/i;

  function decodeBase64(value) {
    if (!value) return "";

    if (typeof Buffer !== "undefined") {
      return Buffer.from(value, "base64").toString("utf8");
    }

    const binary = global.atob(value);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  }

  function decodeScanPayload(payload) {
    if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.rows)) {
      throw new Error("扫描数据格式不受支持");
    }

    const items = payload.rows
      .filter((row) => Array.isArray(row) && row.length === ROW_FIELDS.length)
      .map((row) =>
        Object.fromEntries(
          ROW_FIELDS.map((field, index) => [field, decodeBase64(row[index])]),
        ),
      )
      .filter((item) => item.id && item.name && isKnownKind(item.kind));

    return {
      scannedAt: decodeBase64(payload.scannedAt),
      computerName: decodeBase64(payload.computerName),
      items,
    };
  }

  function isKnownKind(kind) {
    return ["homebrew", "cask", "formula", "mas", "pwa", "manual"].includes(
      kind,
    );
  }

  function isAutomatic(item) {
    return AUTOMATIC_KINDS.has(item.kind);
  }

  function needsHomebrew(items) {
    return items.some(isAutomatic);
  }

  function summarize(items) {
    return items.reduce(
      (summary, item) => {
        summary.total += 1;
        if (isAutomatic(item)) {
          summary.automatic += 1;
        } else if (item.kind === "pwa") {
          summary.pwa += 1;
        } else {
          summary.manual += 1;
        }
        if (item.kind === "mas") summary.appStore += 1;
        if (item.kind === "formula") summary.commandLine += 1;
        if (item.kind === "cask") summary.casks += 1;
        return summary;
      },
      {
        total: 0,
        automatic: 0,
        pwa: 0,
        manual: 0,
        appStore: 0,
        commandLine: 0,
        casks: 0,
        homebrew: needsHomebrew(items),
      },
    );
  }

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
  }

  function brewfileQuote(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  function compareByName(left, right) {
    return left.name.localeCompare(right.name, "zh-Hans-CN", {
      sensitivity: "base",
      numeric: true,
    });
  }

  function webAppBrowser(item) {
    if (item.bundleId.startsWith("com.google.Chrome.app.")) return "Chrome";
    if (item.bundleId.startsWith("com.microsoft.edgemac.app.")) return "Edge";
    return "浏览器";
  }

  function nvmNodeVersion(item) {
    const installedVersion = item.version.trim().match(NODE_VERSION_PATTERN);
    if (installedVersion) return installedVersion[1];

    const formulaVersion = item.installId.match(NODE_FORMULA_PATTERN)?.[1];
    return formulaVersion || "lts/*";
  }

  function validInstallItems(items) {
    return items.filter((item) => {
      if (item.kind === "formula") {
        return BREW_TOKEN_PATTERN.test(item.installId);
      }
      if (item.kind === "cask") {
        return CASK_TOKEN_PATTERN.test(item.installId);
      }
      if (item.kind === "mas") {
        return APP_STORE_ID_PATTERN.test(item.installId);
      }
      if (item.kind === "pwa") {
        return WEB_APP_URL_PATTERN.test(item.installId);
      }
      return item.kind === "homebrew" || item.kind === "manual";
    });
  }

  function generateInstallScript(inputItems) {
    const items = validInstallItems(inputItems);
    const automatic = items.filter(isAutomatic).sort(compareByName);
    const manual = items
      .filter((item) => item.kind === "manual")
      .sort(compareByName);
    const webApps = items
      .filter((item) => item.kind === "pwa")
      .sort(compareByName);
    const shouldInstall = automatic.length > 0;
    const appStoreItems = automatic.filter((item) => item.kind === "mas");
    const formulaItems = automatic.filter((item) => item.kind === "formula");
    const nvmSelected = formulaItems.some((item) => item.installId === "nvm");
    const nvmNodeItems = nvmSelected
      ? formulaItems.filter((item) =>
          NODE_FORMULA_PATTERN.test(item.installId),
        )
      : [];
    const brewFormulaItems = formulaItems.filter(
      (item) =>
        !nvmSelected || !NODE_FORMULA_PATTERN.test(item.installId),
    );
    const caskItems = automatic.filter((item) => item.kind === "cask");

    const lines = [
      "#!/bin/zsh",
      "",
      "set -u",
      "",
      "clear",
      'print -- "EasyNewMac 迁移安装"',
      'print -- "===================="',
      "print -- \"\"",
      "",
      'if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then',
      '  print -u2 -- "此脚本只能在 Mac 上运行。"',
      '  read -r "?按回车键关闭..."',
      "  exit 1",
      "fi",
      "",
      `print -- "自动安装：${automatic.length} 项"`,
      `print -- "网页应用：${webApps.length} 项"`,
      `print -- "手动提醒：${manual.length} 项"`,
      "",
    ];

    if (shouldInstall) {
      lines.push(
        'print -- "脚本将联网下载安装所选项目。"',
        'print -- "输入 install apps 继续，或按回车键取消："',
        "read -r confirmation",
        'if [[ "$confirmation" != "install apps" ]]; then',
        '  print -- "已取消。"',
        "  exit 0",
        "fi",
        "",
        "activate_homebrew() {",
        "  local brew_path",
        "  if command -v brew >/dev/null 2>&1; then",
        "    return 0",
        "  fi",
        "",
        "  for brew_path in /opt/homebrew/bin/brew /usr/local/bin/brew; do",
        '    if [[ -x "$brew_path" ]]; then',
        '      if eval "$("$brew_path" shellenv)" && command -v brew >/dev/null 2>&1; then',
        "        return 0",
        "      fi",
        "    fi",
        "  done",
        "  return 1",
        "}",
        "",
        "ensure_homebrew() {",
        "  if activate_homebrew; then",
        '    print -- "Homebrew 已安装。"',
        "    return 0",
        "  fi",
        "",
        '  print -- "正在安装 Homebrew..."',
        '  /bin/bash -c "$(/usr/bin/curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || return 1',
        "  activate_homebrew",
        "}",
        "",
        "if ! ensure_homebrew; then",
        '  print -u2 -- "Homebrew 安装失败，请检查网络后重试。"',
        '  read -r "?按回车键关闭..."',
        "  exit 1",
        "fi",
        "",
        "typeset -a failed_items failed_reasons",
        "failed_items=()",
        "failed_reasons=()",
        "install_status=0",
        "",
        "record_failure() {",
        '  failed_items+=("$1")',
        '  failed_reasons+=("$2")',
        "  install_status=1",
        "}",
        "",
      );

      if (appStoreItems.length > 0) {
        lines.push(
          'print -- "Mac App Store 项目需要先在 App Store 中登录 Apple 账户。"',
          "",
        );
      }

      const brewfileLines = [];
      if (appStoreItems.length > 0) brewfileLines.push('brew "mas"');
      brewFormulaItems.forEach((item) => {
        brewfileLines.push(`brew ${brewfileQuote(item.installId)}`);
      });
      caskItems.forEach((item) => {
        brewfileLines.push(`cask ${brewfileQuote(item.installId)}`);
      });

      if (brewfileLines.length > 0) {
        lines.push(
          'brewfile="$(/usr/bin/mktemp -t easynewmac.Brewfile)"',
          "cleanup() {",
          '  /bin/rm -f -- "$brewfile"',
          "}",
          "trap cleanup EXIT",
          "",
          "cat > \"$brewfile\" <<'EASYNEWMAC_BREWFILE'",
          ...brewfileLines,
          "EASYNEWMAC_BREWFILE",
          "",
          "check_brew_item() {",
          '  local item_kind="$1" item_name="$2" item_id="$3"',
          '  if [[ "$item_kind" == "formula" ]]; then',
          '    brew list --formula "$item_id" >/dev/null 2>&1 && return 0',
          "  else",
          '    brew list --cask "$item_id" >/dev/null 2>&1 && return 0',
          "  fi",
          '  record_failure "$item_name" "Homebrew 未检测到已安装（$item_id）"',
          "}",
          "",
          'print -- "正在安装所选项目（最多 3 个并发下载）..."',
          'if HOMEBREW_DOWNLOAD_CONCURRENCY=3 brew bundle --file="$brewfile"; then',
          `  print -- "${nvmNodeItems.length > 0 ? "Homebrew 项目已安装。" : "自动安装已完成。"}"`,
          "else",
          "  brew_status=$?",
          '  print -u2 -- "部分项目安装失败，请查看上方信息。"',
          "  brew_failure_count=${#failed_items[@]}",
          ...(appStoreItems.length > 0
            ? [
                "  check_brew_item formula 'mas（App Store 安装工具）' 'mas'",
              ]
            : []),
          ...brewFormulaItems.map(
            (item) =>
              `  check_brew_item formula ${shellQuote(item.name)} ${shellQuote(item.installId)}`,
          ),
          ...caskItems.map(
            (item) =>
              `  check_brew_item cask ${shellQuote(item.name)} ${shellQuote(item.installId)}`,
          ),
          "  if (( ${#failed_items[@]} == brew_failure_count )); then",
          '    record_failure "Homebrew 批量安装" "brew bundle 退出码 $brew_status；请查看上方输出"',
          "  fi",
          "fi",
          "",
        );
      } else {
        lines.push('print -- "Homebrew 已准备完成。"', "");
      }

      if (nvmNodeItems.length > 0) {
        const defaultNode =
          nvmNodeItems.find((item) => item.installId === "node") ||
          nvmNodeItems[nvmNodeItems.length - 1];
        const defaultVersion = nvmNodeVersion(defaultNode);

        lines.push(
          "install_node_with_nvm() {",
          "  local nvm_prefix nvm_script profile existing_nvm_dirs existing_nvm_dir existing_nvm_value nvm_source_line needs_nvm_dir needs_nvm_source",
          '  profile="$HOME/.zshrc"',
          '  /usr/bin/touch "$profile" || { node_failure_reason="无法访问 $profile"; return 1; }',
          '  existing_nvm_dirs="$(/usr/bin/grep -E \'^[[:space:]]*(export[[:space:]]+)?NVM_DIR=\' "$profile" 2>/dev/null || true)"',
          '  while IFS= read -r existing_nvm_dir; do',
          '    [[ -n "$existing_nvm_dir" ]] || continue',
          '    existing_nvm_value="${existing_nvm_dir#*=}"',
          '    existing_nvm_value="${existing_nvm_value%%#*}"',
          '    existing_nvm_value="${existing_nvm_value//[[:space:]]/}"',
          '    existing_nvm_value="${existing_nvm_value%;}"',
          '    existing_nvm_value="${existing_nvm_value//\\"/}"',
          '    case "$existing_nvm_value" in',
          '      \'$HOME/.nvm\'|\'${HOME}/.nvm\'|\'~/.nvm\'|"$HOME/.nvm") ;;',
          "      *)",
          '        node_failure_reason="检测到自定义 NVM_DIR：$existing_nvm_dir"',
          '        print -u2 -- "$node_failure_reason"',
          "        return 1",
          "        ;;",
          "    esac",
          '  done <<< "$existing_nvm_dirs"',
          '  export NVM_DIR="$HOME/.nvm"',
          '  /bin/mkdir -p "$NVM_DIR" || { node_failure_reason="无法创建 $NVM_DIR"; return 1; }',
          '  nvm_prefix="$(brew --prefix nvm 2>/dev/null)" || { node_failure_reason="Homebrew nvm 未安装"; return 1; }',
          '  nvm_script="$nvm_prefix/nvm.sh"',
          '  [[ -s "$nvm_script" ]] || { node_failure_reason="未找到 $nvm_script"; return 1; }',
          "",
          "  set +u",
          '  if ! source "$nvm_script"; then',
          "    set -u",
          '    node_failure_reason="无法加载 $nvm_script"',
          "    return 1",
          "  fi",
          ...nvmNodeItems.flatMap((item) => {
            const version = nvmNodeVersion(item);
            return [
              `  if ! nvm install ${shellQuote(version)}; then`,
              "    set -u",
              `    node_failure_reason=${shellQuote(`nvm install ${version} 失败`)}`,
              "    return 1",
              "  fi",
            ];
          }),
          `  if ! nvm alias default ${shellQuote(defaultVersion)}; then`,
          "    set -u",
          `    node_failure_reason=${shellQuote(`无法将 ${defaultVersion} 设为默认 Node.js`)}`,
          "    return 1",
          "  fi",
          "  set -u",
          "",
          "  needs_nvm_dir=0",
          "  needs_nvm_source=0",
          '  [[ -n "$existing_nvm_dirs" ]] || needs_nvm_dir=1',
          '  nvm_source_line="$(printf \'[ -s "%s" ] && \\\\. "%s"\' "$nvm_script" "$nvm_script")"',
          '  /usr/bin/grep -Fqx "$nvm_source_line" "$profile" 2>/dev/null || needs_nvm_source=1',
          "  if (( needs_nvm_dir || needs_nvm_source )); then",
          '    if [[ -s "$profile" && -n "$(/usr/bin/tail -c 1 "$profile")" ]]; then',
          '      printf \'\\n\' >> "$profile" || { node_failure_reason="无法写入 $profile"; return 1; }',
          "    fi",
          "    if (( needs_nvm_dir )); then",
          '      print -r -- \'export NVM_DIR="$HOME/.nvm"\' >> "$profile" || { node_failure_reason="无法写入 $profile"; return 1; }',
          "    fi",
          "    if (( needs_nvm_source )); then",
          '      print -r -- "$nvm_source_line" >> "$profile" || { node_failure_reason="无法写入 $profile"; return 1; }',
          "    fi",
          "  fi",
          "}",
          "",
          'print -- "正在通过 nvm 安装 Node.js..."',
          'node_failure_reason=""',
          "if install_node_with_nvm; then",
          '  print -- "Node.js 已通过 nvm 安装并设为默认版本。"',
          "else",
          '  record_failure "Node.js" "${node_failure_reason:-nvm 安装或配置失败}"',
          '  print -u2 -- "Node.js 安装失败，请查看结尾汇总。"',
          "fi",
          "",
        );
      }

      if (appStoreItems.length > 0) {
        lines.push(
          "install_mas_app() {",
          '  local app_name="$1" app_id="$2" lookup_output lookup_status lookup_lower',
          '  mas_failure_reason=""',
          '  print -- "正在安装 $app_name..."',
          '  if mas install "$app_id" || mas get "$app_id"; then',
          '    print -- "$app_name 已安装。"',
          "    return 0",
          "  fi",
          "",
          '  lookup_output="$(mas lookup --json "$app_id" 2>&1)"',
          "  lookup_status=$?",
          '  lookup_lower="${(L)lookup_output}"',
          '  if [[ "$lookup_lower" == *"no apps found in the app store"* ]]; then',
          '    print -- "跳过 $app_name：当前 App Store 地区未找到该应用。"',
          "    return 0",
          "  fi",
          '  if [[ "$lookup_status" -ne 0 || "$lookup_output" != *\'"adamID":\'* ]]; then',
          '    mas_failure_reason="安装失败且无法确认 App Store 可用性"',
          '    print -u2 -- "无法检查 $app_name 的 App Store 可用性。"',
          '    [[ -z "$lookup_output" ]] || print -u2 -r -- "$lookup_output"',
          "    return 1",
          "  fi",
          '  mas_failure_reason="mas install 和 mas get 均失败"',
          '  print -u2 -- "$app_name 安装失败。"',
          "  return 1",
          "}",
          "",
          "if command -v mas >/dev/null 2>&1; then",
          ...appStoreItems.map(
            (item) =>
              `  install_mas_app ${shellQuote(item.name)} ${shellQuote(item.installId)} || record_failure ${shellQuote(item.name)} "$mas_failure_reason"`,
          ),
          "else",
          ...appStoreItems.map(
            (item) =>
              `  record_failure ${shellQuote(item.name)} "mas 未安装"`,
          ),
          '  print -u2 -- "mas 未安装，已跳过 Mac App Store 项目。"',
          "fi",
          "",
        );
      }
    } else {
      lines.push("install_status=0", "");
    }

    if (manual.length > 0) {
      lines.push(
        'print -- ""',
        'print -- "需要手动安装："',
        ...manual.map(
          (item) => `printf '  - %s\\n' ${shellQuote(item.name)}`,
        ),
        "",
      );
    }

    if (webApps.length > 0) {
      lines.push(
        'print -- ""',
        'print -- "需要在浏览器中重新添加的网页应用："',
        ...webApps.map(
          (item) =>
            `printf '  - %s [%s]\\n    %s\\n' ${shellQuote(item.name)} ${shellQuote(webAppBrowser(item))} ${shellQuote(item.installId)}`,
        ),
        "",
      );
    }

    lines.push(
      'print -- ""',
      "if (( ${#failed_items[@]} == 0 )); then",
      '  print -- "迁移清单处理完成。"',
      "else",
      '  print -- "迁移清单处理完成，但有安装失败项。"',
      '  print -- "失败详情："',
      "  failure_index=1",
      "  while (( failure_index <= ${#failed_items[@]} )); do",
      '    printf \'  - %s：%s\\n\' "${failed_items[$failure_index]}" "${failed_reasons[$failure_index]}"',
      "    (( failure_index++ ))",
      "  done",
      "fi",
      'read -r "?按回车键关闭..."',
      'exit "$install_status"',
      "",
    );

    return lines.join("\n");
  }

  function makeCrc32Table() {
    return Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      return value >>> 0;
    });
  }

  const CRC32_TABLE = makeCrc32Table();

  function crc32(bytes) {
    let crc = 0xffffffff;
    bytes.forEach((byte) => {
      crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    });
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const safeYear = Math.max(1980, date.getFullYear());
    return {
      time:
        (date.getHours() << 11) |
        (date.getMinutes() << 5) |
        Math.floor(date.getSeconds() / 2),
      date:
        ((safeYear - 1980) << 9) |
        ((date.getMonth() + 1) << 5) |
        date.getDate(),
    };
  }

  function concatBytes(...parts) {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    parts.forEach((part) => {
      output.set(part, offset);
      offset += part.length;
    });
    return output;
  }

  function createExecutableZip(filename, content, modifiedAt = new Date()) {
    const encoder = new TextEncoder();
    const filenameBytes = encoder.encode(filename);
    const contentBytes = encoder.encode(content);
    const checksum = crc32(contentBytes);
    const stamp = dosDateTime(modifiedAt);
    const utf8Flag = 0x0800;

    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, utf8Flag, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, stamp.time, true);
    localView.setUint16(12, stamp.date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, contentBytes.length, true);
    localView.setUint32(22, contentBytes.length, true);
    localView.setUint16(26, filenameBytes.length, true);
    localView.setUint16(28, 0, true);

    const localRecord = concatBytes(localHeader, filenameBytes, contentBytes);

    const centralHeader = new Uint8Array(46);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, (3 << 8) | 30, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, utf8Flag, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, stamp.time, true);
    centralView.setUint16(14, stamp.date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, contentBytes.length, true);
    centralView.setUint32(24, contentBytes.length, true);
    centralView.setUint16(28, filenameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0o100755 * 65536, true);
    centralView.setUint32(42, 0, true);

    const centralRecord = concatBytes(centralHeader, filenameBytes);

    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, 1, true);
    endView.setUint16(10, 1, true);
    endView.setUint32(12, centralRecord.length, true);
    endView.setUint32(16, localRecord.length, true);
    endView.setUint16(20, 0, true);

    return concatBytes(localRecord, centralRecord, endRecord);
  }

  const api = Object.freeze({
    decodeScanPayload,
    generateInstallScript,
    createExecutableZip,
    isAutomatic,
    needsHomebrew,
    summarize,
    validInstallItems,
  });

  global.EasyNewMacCore = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
