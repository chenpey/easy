const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const zlib = require("node:zlib");

const core = require("../web/core.js");

function item(overrides) {
  return {
    id: "manual:example",
    kind: "manual",
    name: "Example App",
    version: "1.0",
    bundleId: "com.example.app",
    installId: "",
    path: "/Applications/Example App.app",
    ...overrides,
  };
}

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function writeExecutable(filename, content) {
  fs.writeFileSync(filename, content, { mode: 0o755 });
}

test("decodes base64 scan payload without losing Unicode", () => {
  const scan = core.decodeScanPayload({
    schemaVersion: 1,
    scannedAt: encode("2026-09-19T00:00:00Z"),
    computerName: encode("旧 Mac"),
    rows: [
      [
        encode("manual:com.example"),
        encode("manual"),
        encode("示例应用"),
        encode("1.0"),
        encode("com.example"),
        encode(""),
        encode("~/Applications/示例应用.app"),
      ],
    ],
  });

  assert.equal(scan.computerName, "旧 Mac");
  assert.equal(scan.items[0].name, "示例应用");
  assert.equal(scan.items[0].path, "~/Applications/示例应用.app");
});

test("manual-only script contains reminders and no network installation", () => {
  const script = core.generateInstallScript([
    item({ name: "Bob's App" }),
    item({ id: "manual:second", name: "第二个应用" }),
  ]);

  assert.match(script, /需要手动安装/);
  assert.match(script, /Bob'"'"'s App/);
  assert.doesNotMatch(script, /curl|brew bundle|install\.sh/);
  assert.doesNotMatch(script, /install apps/);
});

test("PWA selections are grouped separately with browser and source URL", () => {
  const items = [
    item({
      id: "pwa:easy-note",
      kind: "pwa",
      name: "EasyNote",
      bundleId: "com.google.Chrome.app.easy-note",
      installId: "https://note.example.com/",
    }),
    item({
      id: "pwa:bits",
      kind: "pwa",
      name: "Bits",
      bundleId: "com.microsoft.edgemac.app.bits",
      installId: "https://bits.example.com/workbench?pwa=1",
    }),
  ];
  const script = core.generateInstallScript(items);
  const summary = core.summarize(items);

  assert.equal(summary.automatic, 0);
  assert.equal(summary.pwa, 2);
  assert.equal(summary.manual, 0);
  assert.match(script, /网页应用：2 项/);
  assert.match(script, /EasyNote.*Chrome/);
  assert.match(script, /Bits.*Edge/);
  assert.match(script, /https:\/\/note\.example\.com\//);
  assert.doesNotMatch(script, /curl|brew bundle|install\.sh|install apps/);
});

test("automatic selections prepare Homebrew and defer MAS installs", () => {
  const script = core.generateInstallScript([
    item({
      id: "cask:visual-studio-code",
      kind: "cask",
      name: "Visual Studio Code",
      installId: "visual-studio-code",
    }),
    item({
      id: "formula:ripgrep",
      kind: "formula",
      name: "ripgrep",
      installId: "ripgrep",
    }),
    item({
      id: "mas:692867256",
      kind: "mas",
      name: "Simplenote",
      installId: "692867256",
    }),
  ]);

  assert.match(script, /输入 install apps 继续/);
  assert.match(script, /Homebrew\/install\/HEAD\/install\.sh/);
  assert.match(script, /brew "mas"/);
  assert.match(script, /brew "ripgrep"/);
  assert.match(script, /cask "visual-studio-code"/);
  assert.doesNotMatch(script, /^mas /m);
  assert.match(script, /mas lookup --json "\$app_id"/);
  assert.match(script, /install_mas_app 'Simplenote' '692867256'/);
  assert.match(script, /HOMEBREW_DOWNLOAD_CONCURRENCY=3 brew bundle/);
  assert.ok(
    script.indexOf('mas install "$app_id"') <
      script.indexOf('mas lookup --json "$app_id"'),
    "account-backed installation must run before locale-based lookup",
  );
  assert.ok(
    script.indexOf("ensure_homebrew") < script.indexOf("brew bundle"),
    "Homebrew must be prepared before brew bundle runs",
  );
  assert.ok(
    script.indexOf("/opt/homebrew/bin/brew") <
      script.indexOf("正在安装 Homebrew"),
    "standard Homebrew paths must be checked before reinstalling",
  );
});

// Execute generated output with fake tools in a disposable HOME; never install software.
function migration(t, items, { brew = "exit 0", mas = "exit 1", setup = () => {}, env = {}, transform = (script) => script, timeout = 10000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easynewmac-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  writeExecutable(path.join(bin, "brew"), `#!/bin/zsh\nprint -r -- "$*" >> "$HOME/brew.log"\nif [[ "$1" == shellenv ]]; then
  printf 'export PATH=%q:$PATH\\n' "${bin}"
  exit 0
fi
${brew}\n`);
  writeExecutable(path.join(bin, "mas"), `#!/bin/zsh\nprint -r -- "$*" >> "$HOME/mas.log"\n${mas}\n`);
  fs.mkdirSync(path.join(root, ".nvm"));
  fs.writeFileSync(path.join(root, ".nvm/nvm.sh"), `
nvm() {
  print -r -- "$*" >> "$HOME/nvm.log"
  [[ "$1" != version ]] || print v24.0.0
  return 0
}
node() { if [[ "$1" == -v ]]; then print v24.0.0; else print Krypton; fi; }
npm() { print 11.0.0; }
`);
  setup(root);
  const script = transform(core.generateInstallScript(items));
  const syntax = childProcess.spawnSync("/bin/zsh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const result = childProcess.spawnSync("/bin/zsh", ["-c", script], {
    input: "install apps\n\n", encoding: "utf8", timeout,
    env: { ...process.env, HOME: root, ZDOTDIR: root, NVM_DIR: "", XDG_CONFIG_HOME: "", NPM_CONFIG_PREFIX: "", npm_config_prefix: "", PATH: `${bin}:/usr/bin:/bin`, ...env },
  });
  return { ...result, root, script, output: result.stdout + result.stderr };
}
const nodeItem = item({ kind: "formula", installId: "node", version: "26.8.2", name: "node" });
const caskItem = item({ kind: "cask", installId: "example", name: "Example App" });
const masItem = item({ kind: "mas", installId: "932747118", name: "Shadowrocket" });

test("Node alone or with nvm uses official nvm and latest LTS", (t) => {
  const result = migration(t, [nodeItem, item({ kind: "formula", installId: "nvm" })], {
    setup(root) { fs.writeFileSync(path.join(root, ".zshrc"), "export FOO=bar"); },
  });
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.script, /brew "(?:node|nvm)/);
  assert.match(result.script, /nvm-sh\/nvm\/v0\.40\.7\/install\.sh/);
  assert.match(fs.readFileSync(path.join(result.root, "nvm.log"), "utf8"), /install --lts\nalias default lts\/\*\nuse --lts/);
  assert.match(fs.readFileSync(path.join(result.root, ".zshrc"), "utf8"), /^export FOO=bar\nexport NVM_DIR=/);
  assert.match(core.generateInstallScript([nodeItem]), /nvm install --lts/);
});

test("nvm alone is configured without installing Node", (t) => {
  const result = migration(t, [item({ kind: "formula", installId: "nvm" })]);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.script, /nvm install --lts/);
});

test("bundle failure retries missing items and upgrades, then verifies", (t) => {
  const result = migration(t, [caskItem], { brew: `
if [[ "$1" == bundle && "$2" != check ]]; then
  [[ -f "$HOME/retried" ]] && exit 0
  touch "$HOME/retried"
  exit 1
fi
if [[ "$1" == list ]]; then [[ -f "$HOME/installed" ]]; exit $?; fi
if [[ "$1" == install ]]; then touch "$HOME/installed"; fi
exit 0` });
  assert.equal(result.status, 0, result.output);
  const calls = fs.readFileSync(path.join(result.root, "brew.log"), "utf8");
  assert.match(calls, /install --cask example/);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("bundle --file=")).length, 2);
  assert.match(calls, /bundle check --no-upgrade/);
  assert.doesNotMatch(calls, /bundle --no-upgrade/);
  assert.match(result.output, /失败：0 项/);
  const logDir = path.join(result.root, "Library/Logs/EasyNewMac");
  assert.match(fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), "utf8"), /验收通过/);
});

test("persistent bundle failure does not prevent Node LTS installation", (t) => {
  const result = migration(t, [nodeItem, caskItem], { brew: '[[ "$1" != bundle ]]' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /重试后仍失败/);
  assert.match(fs.readFileSync(path.join(result.root, "nvm.log"), "utf8"), /install --lts/);
});

test("successful bundle still verifies missing packages", (t) => {
  const result = migration(t, [caskItem], { brew: '[[ "$1" != list ]]' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Example App：Homebrew 未检测到已安装/);
});

test("manual-only output runs without unset-array errors", (t) => {
  const result = migration(t, [item({ name: "Manual" })]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /迁移清单处理完成/);
});

for (const config of [".zshrc", ".zprofile", ".zshenv", ".zlogin", ".npmrc", "environment"]) {
  test(`nvm rejects conflicting ${config} without modifying it`, (t) => {
    const content = config === ".npmrc" ? "prefix=/custom" : 'export NVM_DIR="$HOME/custom"';
    const result = migration(t, [nodeItem], {
      setup(root) { if (config !== "environment") fs.writeFileSync(path.join(root, config), content); },
      env: config === "environment" ? { NVM_DIR: "/custom" } : {},
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /自定义 NVM_DIR|prefix.*冲突/);
    assert.equal(fs.existsSync(path.join(result.root, "nvm.log")), false);
    if (config !== "environment") assert.ok(fs.readFileSync(path.join(result.root, config), "utf8").startsWith(content));
  });
}

test("equivalent NVM_DIR and repeated execution do not duplicate config", (t) => {
  const result = migration(t, [nodeItem], { setup(root) {
    fs.writeFileSync(path.join(root, ".zshrc"), 'NVM_DIR="$HOME/.nvm"\n');
  } });
  assert.equal(result.status, 0, result.output);
  const profile = fs.readFileSync(path.join(result.root, ".zshrc"), "utf8");
  const brewProfile = fs.readFileSync(path.join(result.root, ".zprofile"), "utf8");
  const again = childProcess.spawnSync("/bin/zsh", ["-c", result.script], {
    input: "install apps\n\n", encoding: "utf8", timeout: 10000,
    env: { ...process.env, HOME: result.root, ZDOTDIR: result.root, NVM_DIR: "", XDG_CONFIG_HOME: "", NPM_CONFIG_PREFIX: "", npm_config_prefix: "", PATH: `${result.root}/bin:/usr/bin:/bin` },
  });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(fs.readFileSync(path.join(result.root, ".zshrc"), "utf8"), profile);
  assert.equal(fs.readFileSync(path.join(result.root, ".zprofile"), "utf8"), brewProfile);
});

function freshShell(root, command) {
  return childProcess.spawnSync("/usr/bin/env", ["-u", "NVM_DIR", "-u", "NVM_BIN", "-u", "NVM_INC", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "/bin/zsh", "-lic", command], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, HOME: root, ZDOTDIR: root, XDG_CONFIG_HOME: "" },
  });
}

test("Homebrew survives a fresh shell without inheriting migration PATH", (t) => {
  const result = migration(t, [caskItem]);
  assert.equal(result.status, 0, result.output);
  const fresh = freshShell(result.root, 'command -v brew');
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.stdout.trim(), `${result.root}/bin/brew`);
  assert.match(fs.readFileSync(path.join(result.root, ".zprofile"), "utf8"), /shellenv/);
});

for (const style of ["official", "single-quoted", "spaces", "conditional", "overridden"]) {
  test(`nvm uses effective directory for ${style} config`, (t) => {
    let original;
    const result = migration(t, [nodeItem], { setup(root) {
      const configs = {
        official: 'export NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"',
        "single-quoted": `export NVM_DIR='${root}/.nvm'`,
        spaces: 'export NVM_DIR="$HOME/.nvm" # normal directory',
        conditional: 'if [[ -d "$HOME/.nvm" ]]; then export NVM_DIR="$HOME/.nvm"; fi',
        overridden: 'export NVM_DIR="$HOME/old"\nexport NVM_DIR="$HOME/.nvm"',
      };
      original = configs[style] + "\n";
      fs.writeFileSync(path.join(root, ".zshrc"), original);
    } });
    assert.equal(result.status, 0, result.output);
    assert.ok(fs.readFileSync(path.join(result.root, ".zshrc"), "utf8").startsWith(original));
    assert.equal(freshShell(result.root, 'nvm --version && node -v').status, 0);
  });
}

test("actual custom directory from official XDG expression remains untouched", (t) => {
  const original = 'export XDG_CONFIG_HOME="$HOME/.config"\nexport NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"\n';
  const result = migration(t, [nodeItem], { setup(root) {
    fs.writeFileSync(path.join(root, ".zshrc"), original);
  } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /自定义 NVM_DIR/);
  assert.equal(fs.readFileSync(path.join(result.root, ".zshrc"), "utf8"), original);
  assert.equal(fs.existsSync(path.join(result.root, "nvm.log")), false);
});

test("startup that exits cannot be mistaken for an empty or conflicting NVM_DIR", (t) => {
  const result = migration(t, [nodeItem], { setup(root) {
    fs.writeFileSync(path.join(root, ".zshrc"), "exit 0\n");
  } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /无法读取.*shell/);
  assert.doesNotMatch(result.output, /检测到自定义 NVM_DIR/);
  assert.equal(fs.readFileSync(path.join(result.root, ".zshrc"), "utf8"), "exit 0\n");
});

test("ZDOTDIR set by .zshenv determines where configuration is written", (t) => {
  const result = migration(t, [nodeItem], { setup(root) {
    fs.mkdirSync(path.join(root, "zsh"));
    fs.writeFileSync(path.join(root, ".zshenv"), 'export ZDOTDIR="$HOME/zsh"\n');
  } });
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.existsSync(path.join(result.root, ".zshrc")), false);
  assert.match(fs.readFileSync(path.join(result.root, "zsh/.zshrc"), "utf8"), /nvm.sh/);
  assert.match(fs.readFileSync(path.join(result.root, "zsh/.zprofile"), "utf8"), /shellenv/);
  assert.equal(freshShell(result.root, 'command -v brew && node -v').status, 0);
});

test("startup output does not contaminate the evaluated configuration", (t) => {
  const result = migration(t, [nodeItem], { setup(root) {
    fs.writeFileSync(path.join(root, ".zshrc"), 'print welcome\nexport NVM_DIR="$HOME/.nvm"\n');
  } });
  assert.equal(result.status, 0, result.output);
});

test("current NVM_DIR cannot hide a different independent-shell directory", (t) => {
  const result = migration(t, [nodeItem], { setup(root) {
    fs.writeFileSync(path.join(root, ".zshrc"), 'export NVM_DIR="${NVM_DIR:-$HOME/custom}"\n');
  }, transform(script) {
    return script.replace('set -u', 'set -u\nexport NVM_DIR="$HOME/.nvm"');
  } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /登录 shell 配置存在自定义 NVM_DIR/);
});

test("Node login validation observes startup version without switching it", (t) => {
  const result = migration(t, [nodeItem], { setup(root) {
    fs.appendFileSync(path.join(root, ".nvm/nvm.sh"), `
node() { if [[ "$1" == -v ]]; then print "v$active_node.0.0"; elif [[ "$active_node" == 24 ]]; then print Krypton; fi; }
nvm() {
  case "$1" in
    version) print v24.0.0;;
    use) if [[ "$2" == 26 ]]; then active_node=26; else active_node=24; fi;;
  esac
  return 0
}
active_node=24
`);
    fs.writeFileSync(path.join(root, ".zshrc"), 'export NVM_DIR="$HOME/.nvm"\nsource "$NVM_DIR/nvm.sh"\nnvm use 26\n');
  } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /独立登录 shell 中 nvm \/ Node.js 验收失败/);
  assert.equal(freshShell(result.root, 'node -v').stdout.trim(), "v26.0.0");
});

test("Node verification rejects Current even when install succeeds", (t) => {
  const result = migration(t, [nodeItem], { setup(root) {
    fs.appendFileSync(path.join(root, ".nvm/nvm.sh"), '\nnode() { [[ "$1" != -v ]] || print v26.0.0; }\n');
  } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /LTS \/ npm 验收失败/);
});

test("MAS records region skips and does not depend on JSON field names", (t) => {
  const result = migration(t, [masItem], { mas: `
if [[ "$1" == lookup ]]; then print 'No apps found in the App Store'; exit 0; fi
exit 1` });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /跳过：1 项；失败：0 项/);
  assert.doesNotMatch(result.script, /adamID/);
});

test("MAS verifies account-backed install before locale lookup", (t) => {
  const result = migration(t, [masItem], { mas: '[[ "$1" != list ]] || print "932747118 Shadowrocket"; exit 0' });
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(path.join(result.root, "mas.log"), "utf8").trim(), "install 932747118\nlist");
});

test("MAS false success reports Spotlight verification failure", (t) => {
  const result = migration(t, [masItem], { mas: "exit 0" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Spotlight/);
});

test("MAS lookup network failure is failed, not skipped", (t) => {
  const result = migration(t, [masItem]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /无法确认 App Store 可用性/);
  assert.match(result.output, /跳过：0 项/);
});

test("preflight rejects root and old macOS before package commands", (t) => {
  for (const transform of [
    (script) => script.replace('if (( EUID == 0 )); then', 'if true; then'),
    (script) => script.replace('$(/usr/bin/sw_vers -productVersion)', '13.7'),
  ]) {
    const result = migration(t, [caskItem], { transform });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /sudo\/root|需要 macOS 14/);
    assert.equal(fs.existsSync(path.join(result.root, "brew.log")), false);
  }
});

test("official nvm download failure reports error and continues MAS", (t) => {
  const result = migration(t, [nodeItem, masItem], {
    setup(root) { fs.rmSync(path.join(root, ".nvm/nvm.sh")); },
    transform: (script) => script.replaceAll('/usr/bin/curl', '/usr/bin/false'),
    mas: '[[ "$1" != list ]] || print "932747118 Shadowrocket"; exit 0',
  });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /无法下载官方 nvm 安装器/);
  assert.match(result.output, /Shadowrocket 已安装并通过验收/);
});

test("real official nvm installs LTS and survives an independent login", { skip: process.env.EASYNEWMAC_REAL_NVM !== "1" }, (t) => {
  const result = migration(t, [nodeItem], {
    timeout: 300000,
    env: { METHOD: "script" },
    setup(root) {
      fs.rmSync(path.join(root, ".nvm/nvm.sh"));
      fs.writeFileSync(path.join(root, ".zshrc"), 'export NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"\n');
    },
  });
  assert.equal(result.status, 0, result.output);
  const fresh = freshShell(result.root, 'nvm --version && node -p \'Boolean(process.release.lts)\' && npm --version');
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.match(fresh.stdout, /^true$/m);
});

test("PWA removes tracking and known temporary sign, preserving functional parameters", () => {
  const script = core.generateInstallScript([
    item({ kind: "pwa", installId: "https://x.com/?utm_source=homescreen&q=hello#tab" }),
    item({ kind: "pwa", installId: "https://www.iwencai.com/unifiedwap/home/index?sign=123&query=abc" }),
    item({ kind: "pwa", installId: "https://example.com/?sign=keep&pwa=1" }),
    item({ kind: "pwa", installId: "http://[invalid" }),
  ]);
  assert.doesNotMatch(script, /utm_source|sign=123|invalid/);
  assert.match(script, /q=hello#tab/);
  assert.match(script, /query=abc/);
  assert.match(script, /sign=keep&pwa=1/);
});

test("invalid install identifiers are excluded from generated commands", () => {
  const script = core.generateInstallScript([
    item({
      id: "cask:unsafe",
      kind: "cask",
      name: "Unsafe",
      installId: 'unsafe"; touch /tmp/injected; #',
    }),
    item({
      id: "mas:unsafe",
      kind: "mas",
      name: "Unsafe Store",
      installId: "$(touch /tmp/injected)",
    }),
    item({ id: "manual:safe", name: "Safe reminder" }),
  ]);

  assert.doesNotMatch(script, /touch \/tmp\/injected/);
  assert.doesNotMatch(script, /brew bundle/);
  assert.match(script, /Safe reminder/);
});

test("ZIP entry stores executable Unix permissions", () => {
  const zip = core.createExecutableZip(
    "EasyNewMac-Migration.command",
    "#!/bin/zsh\nprint ok\n",
    new Date("2026-09-19T00:00:00Z"),
  );
  const endOffset = zip.length - 22;
  const endView = new DataView(zip.buffer, zip.byteOffset + endOffset, 22);
  const centralOffset = endView.getUint32(16, true);
  const centralView = new DataView(
    zip.buffer,
    zip.byteOffset + centralOffset,
    46,
  );
  const externalAttributes = centralView.getUint32(38, true);
  const mode = externalAttributes >>> 16;

  assert.equal(mode & 0o777, 0o755);
  assert.equal(Buffer.from(zip.subarray(0, 4)).toString("hex"), "504b0304");
});

test("bundled Cask catalog contains unique safe mappings", () => {
  const catalog = zlib
    .gunzipSync(
      fs.readFileSync(path.resolve(__dirname, "../catalog/casks.tsv.gz")),
    )
    .toString("utf8");
  const sections = { apps: [], names: [] };
  let activeSection;
  catalog.split("\n").forEach((line) => {
    const section = line.match(/^\[(apps|names)\]$/)?.[1];
    if (section) {
      activeSection = section;
    } else if (activeSection && line && !line.startsWith("# ")) {
      sections[activeSection].push(line.split("\t"));
    }
  });
  const appCatalog = sections.apps;
  const nameCatalog = sections.names;
  const mappings = new Map(appCatalog);
  const nameMappings = new Map(nameCatalog);

  assert.equal(mappings.size, appCatalog.length);
  assert.equal(nameMappings.size, nameCatalog.length);
  assert.equal(mappings.get("visual studio code.app"), "visual-studio-code");
  assert.equal(mappings.get("google chrome.app"), "google-chrome");
  assert.equal(mappings.get("obsidian.app"), "obsidian");
  assert.equal(nameMappings.get("proxybridge"), "proxybridge");
  assert.ok(![...mappings.values()].includes("homebrew-app"));
  assert.ok(appCatalog.every(([filename]) => filename.endsWith(".app")));
  assert.ok(
    [...appCatalog, ...nameCatalog].every(
      ([filename, token]) =>
        filename &&
        /^[A-Za-z0-9][A-Za-z0-9@+._-]*$/.test(token),
    ),
  );
});

test("real scanner payload is decodable when integration fixture exists", () => {
  const fixturePath = process.env.EASYNEWMAC_SCAN_FIXTURE;
  if (!fixturePath) return;

  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(fixturePath), "utf8"), context);
  const scan = core.decodeScanPayload(context.window.EASYNEWMAC_SCAN);

  assert.ok(scan.items.length > 0);
  assert.equal(new Set(scan.items.map((entry) => entry.id)).size, scan.items.length);
  assert.ok(
    scan.items
      .filter((entry) => entry.kind === "pwa")
      .every((entry) => /^https?:\/\//.test(entry.installId)),
  );
  assert.ok(
    !scan.items.some(
      (entry) =>
        entry.kind === "manual" &&
        /^com\.(google\.Chrome|microsoft\.edgemac)\.app\./.test(entry.bundleId),
    ),
  );
  assert.ok(
    !scan.items.some(
      (entry) => entry.kind === "cask" && entry.installId === "homebrew-app",
    ),
  );
  assert.ok(
    scan.items.filter((entry) => entry.name === "Homebrew").length <= 1,
  );
});
