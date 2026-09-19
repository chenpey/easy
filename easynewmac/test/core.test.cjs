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

test("nvm installs and manages selected Node.js versions", () => {
  const script = core.generateInstallScript([
    item({
      id: "formula:nvm",
      kind: "formula",
      name: "nvm",
      version: "0.40.7",
      installId: "nvm",
    }),
    item({
      id: "formula:node",
      kind: "formula",
      name: "node",
      version: "26.8.2",
      installId: "node",
    }),
    item({
      id: "formula:node@20",
      kind: "formula",
      name: "node@20",
      version: "",
      installId: "node@20",
    }),
  ]);

  assert.match(script, /brew "nvm"/);
  assert.doesNotMatch(script, /brew "node(?:@20)?"/);
  assert.match(script, /source "\$nvm_script"/);
  assert.match(script, /nvm install '26\.8\.2'/);
  assert.match(script, /nvm install '20'/);
  assert.match(script, /nvm alias default '26\.8\.2'/);
  assert.match(script, /export NVM_DIR="\$HOME\/\.nvm"/);
  assert.match(script, /检测到自定义 NVM_DIR/);
  assert.match(script, /tail -c 1 "\$profile"/);
  assert.doesNotMatch(
    script,
    /if \[\[ "\$install_status" -eq 0 \]\]; then\n  print -- "正在通过 nvm 安装 Node\.js/,
  );
  assert.ok(
    script.indexOf('brew "nvm"') < script.indexOf("nvm install '26.8.2'"),
    "nvm must be installed before Node.js",
  );
});

test("Node.js still installs after an unrelated Brewfile failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easynewmac-node-"));
  const bin = path.join(root, "bin");
  const nvmPrefix = path.join(root, "nvm");
  const nvmLog = path.join(root, "nvm.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(nvmPrefix);
  writeExecutable(
    path.join(bin, "brew"),
    `#!/bin/zsh
if [[ "$1" == "bundle" ]]; then
  exit 1
fi
if [[ "$1" == "--prefix" && "$2" == "nvm" ]]; then
  print -r -- "$FAKE_NVM_PREFIX"
fi
`,
  );
  writeExecutable(path.join(bin, "clear"), "#!/bin/zsh\nexit 0\n");
  fs.writeFileSync(
    path.join(nvmPrefix, "nvm.sh"),
    'nvm() { print -r -- "NVM_DIR=$NVM_DIR command=$*" >> "$NVM_LOG"; }\n',
  );
  fs.writeFileSync(path.join(root, ".zshrc"), "export FOO=bar");

  const script = core.generateInstallScript([
    item({
      id: "formula:nvm",
      kind: "formula",
      name: "nvm",
      installId: "nvm",
    }),
    item({
      id: "formula:node",
      kind: "formula",
      name: "node",
      version: "26.8.2",
      installId: "node",
    }),
    item({
      id: "cask:example",
      kind: "cask",
      name: "Example",
      installId: "example",
    }),
  ]);
  const result = childProcess.spawnSync("/bin/zsh", ["-c", script], {
    input: "install apps\n\n",
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_NVM_PREFIX: nvmPrefix,
      HOME: root,
      NVM_LOG: nvmLog,
      NVM_DIR: path.join(root, "custom-nvm"),
      PATH: `${bin}:/usr/bin:/bin`,
      TERM: "xterm",
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    fs.readFileSync(nvmLog, "utf8"),
    new RegExp(`NVM_DIR=${root}/\\.nvm command=install 26\\.8\\.2`),
  );
  assert.match(
    fs.readFileSync(path.join(root, ".zshrc"), "utf8"),
    /^export FOO=bar\nexport NVM_DIR=/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("unavailable App Store apps are skipped without installation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easynewmac-mas-"));
  const bin = path.join(root, "bin");
  const masLog = path.join(root, "mas.log");
  fs.mkdirSync(bin);
  writeExecutable(path.join(bin, "brew"), "#!/bin/zsh\nexit 0\n");
  writeExecutable(path.join(bin, "clear"), "#!/bin/zsh\nexit 0\n");
  writeExecutable(
    path.join(bin, "mas"),
    `#!/bin/zsh
print -r -- "$*" >> "$MAS_LOG"
if [[ "$1" == "lookup" ]]; then
  print -u2 -- "No apps found in the App Store for ADAM ID $3"
  exit 0
fi
exit 1
`,
  );

  const script = core.generateInstallScript([
    item({
      id: "mas:932747118",
      kind: "mas",
      name: "Shadowrocket",
      installId: "932747118",
    }),
  ]);
  const result = childProcess.spawnSync("/bin/zsh", ["-c", script], {
    input: "install apps\n\n",
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      MAS_LOG: masLog,
      PATH: `${bin}:/usr/bin:/bin`,
      TERM: "xterm",
    },
  });

  assert.equal(result.status, 0);
  assert.equal(
    fs.readFileSync(masLog, "utf8").trim(),
    [
      "install 932747118",
      "get 932747118",
      "lookup --json 932747118",
    ].join("\n"),
  );
  assert.match(result.stdout, /跳过 Shadowrocket/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("App Store account installation succeeds before locale lookup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easynewmac-mas-"));
  const bin = path.join(root, "bin");
  const masLog = path.join(root, "mas.log");
  fs.mkdirSync(bin);
  writeExecutable(path.join(bin, "brew"), "#!/bin/zsh\nexit 0\n");
  writeExecutable(path.join(bin, "clear"), "#!/bin/zsh\nexit 0\n");
  writeExecutable(
    path.join(bin, "mas"),
    '#!/bin/zsh\nprint -r -- "$*" >> "$MAS_LOG"\nexit 0\n',
  );

  const script = core.generateInstallScript([
    item({
      id: "mas:932747118",
      kind: "mas",
      name: "Shadowrocket",
      installId: "932747118",
    }),
  ]);
  const result = childProcess.spawnSync("/bin/zsh", ["-c", script], {
    input: "install apps\n\n",
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      MAS_LOG: masLog,
      PATH: `${bin}:/usr/bin:/bin`,
      TERM: "xterm",
    },
  });

  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(masLog, "utf8").trim(), "install 932747118");
  fs.rmSync(root, { recursive: true, force: true });
});

test("custom NVM_DIR in .zshrc fails before installing Node.js", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easynewmac-nvm-"));
  const bin = path.join(root, "bin");
  const nvmPrefix = path.join(root, "nvm");
  const nvmLog = path.join(root, "nvm.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(nvmPrefix);
  writeExecutable(
    path.join(bin, "brew"),
    `#!/bin/zsh
if [[ "$1" == "--prefix" && "$2" == "nvm" ]]; then
  print -r -- "$FAKE_NVM_PREFIX"
fi
exit 0
`,
  );
  writeExecutable(path.join(bin, "clear"), "#!/bin/zsh\nexit 0\n");
  fs.writeFileSync(
    path.join(nvmPrefix, "nvm.sh"),
    'nvm() { print -r -- "$*" >> "$NVM_LOG"; }\n',
  );
  fs.writeFileSync(
    path.join(root, ".zshrc"),
    'export NVM_DIR="$HOME/.config/nvm"\n',
  );

  const script = core.generateInstallScript([
    item({
      id: "formula:nvm",
      kind: "formula",
      name: "nvm",
      installId: "nvm",
    }),
    item({
      id: "formula:node",
      kind: "formula",
      name: "node",
      version: "26.8.2",
      installId: "node",
    }),
  ]);
  const result = childProcess.spawnSync("/bin/zsh", ["-c", script], {
    input: "install apps\n\n",
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_NVM_PREFIX: nvmPrefix,
      HOME: root,
      NVM_LOG: nvmLog,
      PATH: `${bin}:/usr/bin:/bin`,
      TERM: "xterm",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /检测到自定义 NVM_DIR/);
  assert.equal(fs.existsSync(nvmLog), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Node.js remains a Homebrew formula when nvm is not selected", () => {
  const script = core.generateInstallScript([
    item({
      id: "formula:node@20",
      kind: "formula",
      name: "node@20",
      version: "20.19.5",
      installId: "node@20",
    }),
  ]);

  assert.match(script, /brew "node@20"/);
  assert.doesNotMatch(script, /install_node_with_nvm|nvm install/);
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
