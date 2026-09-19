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
        "ensure_homebrew() {",
        "  if command -v brew >/dev/null 2>&1; then",
        '    print -- "Homebrew 已安装。"',
        "    return 0",
        "  fi",
        "",
        '  print -- "正在安装 Homebrew..."',
        '  /bin/bash -c "$(/usr/bin/curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || return 1',
        "",
        "  if [[ -x /opt/homebrew/bin/brew ]]; then",
        '    eval "$(/opt/homebrew/bin/brew shellenv)"',
        "  elif [[ -x /usr/local/bin/brew ]]; then",
        '    eval "$(/usr/local/bin/brew shellenv)"',
        "  fi",
        "",
        "  command -v brew >/dev/null 2>&1",
        "}",
        "",
        "if ! ensure_homebrew; then",
        '  print -u2 -- "Homebrew 安装失败，请检查网络后重试。"',
        '  read -r "?按回车键关闭..."',
        "  exit 1",
        "fi",
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
      formulaItems.forEach((item) => {
        brewfileLines.push(`brew ${brewfileQuote(item.installId)}`);
      });
      caskItems.forEach((item) => {
        brewfileLines.push(`cask ${brewfileQuote(item.installId)}`);
      });
      appStoreItems.forEach((item) => {
        brewfileLines.push(
          `mas ${brewfileQuote(item.name)}, id: ${item.installId}`,
        );
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
          'print -- "正在安装所选项目..."',
          'if brew bundle --file="$brewfile"; then',
          "  install_status=0",
          '  print -- "自动安装已完成。"',
          "else",
          "  install_status=$?",
          '  print -u2 -- "部分项目安装失败，请查看上方信息。"',
          "fi",
          "",
        );
      } else {
        lines.push(
          "install_status=0",
          'print -- "Homebrew 已准备完成。"',
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
      'if [[ "$install_status" -eq 0 ]]; then',
      '  print -- "迁移清单处理完成。"',
      "else",
      '  print -- "迁移清单处理完成，但有安装失败项。"',
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
