const assert = require("node:assert/strict");
const fs = require("node:fs");
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

test("automatic selections install Homebrew first and emit a Brewfile", () => {
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
  assert.match(script, /mas "Simplenote", id: 692867256/);
  assert.ok(
    script.indexOf("ensure_homebrew") < script.indexOf("brew bundle"),
    "Homebrew must be prepared before brew bundle runs",
  );
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
