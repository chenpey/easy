import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTarget,
  parseArguments,
  parseD1Rows,
  projects,
  resetLocal,
  resetRemote,
} from "../scripts/reset.mjs";

const root = new URL("..", import.meta.url).pathname;
const accountId = "a".repeat(32);
const databaseId = "12345678-1234-4234-8234-123456789abc";
const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("reset command accepts only an explicit project and target", () => {
  assert.deepEqual(parseArguments(["easynote", "--local"]), { project: "easynote", mode: "local" });
  assert.deepEqual(parseArguments(["easydrop", "--remote"]), { project: "easydrop", mode: "remote" });
  assert.deepEqual(parseArguments(["--help"]), { help: true });
  assert.throws(() => parseArguments(["easynote"]), /Usage:/);
  assert.throws(() => parseArguments(["all", "--remote"]), /Usage:/);
  const help = spawnSync("/bin/bash", [join(root, "reset.sh"), "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /reset\.sh <easynote\|easydrop>/);
});

test("deployment targets are read from the selected project only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easy-reset-target-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "easynote"));
  await writeFile(join(directory, "easynote", "wrangler.deploy.json"), JSON.stringify({
    name: "note-worker",
    account_id: accountId,
    d1_databases: [{ binding: "DB", database_name: "note-db", database_id: databaseId }],
    r2_buckets: [{ binding: "IMAGES", bucket_name: "note-images" }],
  }));
  const target = await loadTarget("easynote", directory);
  assert.equal(target.workerName, "note-worker");
  assert.equal(target.databaseName, "note-db");
  assert.equal(target.bucketName, "note-images");
  assert.equal((await stat(target.configPath)).isFile(), true);
});

test("local reset removes Wrangler state and preserves account configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easy-reset-local-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, ".wrangler", "state"), { recursive: true });
  await writeFile(join(directory, ".wrangler", "state", "data"), "local");
  await writeFile(join(directory, ".dev.vars"), "INITIAL_OWNER='test'\n");
  const output = [];
  await resetLocal({
    ...projects.easynote,
    directory,
  }, { log: (line) => output.push(line) });
  await assert.rejects(stat(join(directory, ".wrangler", "state")), { code: "ENOENT" });
  assert.equal(await readFile(join(directory, ".dev.vars"), "utf8"), "INITIAL_OWNER='test'\n");
  assert.match(output.join("\n"), /Clear site data/);
});

test("remote reset deletes tracked objects, recreates R2 and reapplies the D1 baseline", async () => {
  const target = {
    ...projects.easynote,
    accountId,
    workerName: "note-worker",
    databaseName: "note-db",
    bucketName: "note-images",
    configPath: "/tmp/wrangler.deploy.json",
  };
  const first = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  const second = "33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444";
  const commands = [];
  const requests = [];
  const output = [];
  const run = (args, options) => {
    commands.push({ args, options });
    const sql = args[args.indexOf("--command") + 1];
    if (sql?.includes("sqlite_master")) return JSON.stringify([{ success: true, results: [{ name: "images" }] }]);
    if (sql === target.objectQuery) {
      return JSON.stringify([{ success: true, results: [{ object_key: first }, { object_key: second }] }]);
    }
    return "";
  };
  const request = async (method, path, body, options) => {
    requests.push({ method, path, body, options });
    return {};
  };
  await resetRemote(target, "secret", { run, request, log: (line) => output.push(line) });
  assert.deepEqual(commands.filter(({ args }) => args[0] === "r2" && args[1] === "object")
    .map(({ args }) => args[3]), [`${target.bucketName}/${first}`, `${target.bucketName}/${second}`]);
  assert.ok(commands.some(({ args }) => args[0] === "d1" && args[1] === "execute" && args.includes(target.dropSql)));
  assert.ok(commands.some(({ args }) => args.slice(0, 3).join(" ") === "d1 migrations apply"));
  assert.deepEqual(requests.map(({ method, path }) => [method, path]), [
    ["DELETE", `/accounts/${accountId}/workers/scripts/note-worker`],
    ["DELETE", `/accounts/${accountId}/r2/buckets/note-images`],
    ["POST", `/accounts/${accountId}/r2/buckets`],
  ]);
  assert.match(output.join("\n"), /Deleted R2 objects: 2\/2/);
});

test("remote reset rejects unexpected object keys before deleting cloud resources", async () => {
  const target = {
    ...projects.easydrop,
    accountId,
    workerName: "drop-worker",
    databaseName: "drop-db",
    bucketName: "drop-files",
    configPath: "/tmp/wrangler.deploy.json",
  };
  let requested = false;
  const run = (args) => {
    const sql = args[args.indexOf("--command") + 1];
    if (sql?.includes("sqlite_master")) return JSON.stringify([{ success: true, results: [{ name: "items" }] }]);
    if (sql === target.objectQuery) return JSON.stringify([{ success: true, results: [{ object_key: "../other" }] }]);
    return "";
  };
  await assert.rejects(resetRemote(target, "secret", {
    run,
    request: async () => { requested = true; },
  }), /unexpected R2 object key/);
  assert.equal(requested, false);
});

test("D1 JSON parsing fails closed", () => {
  assert.deepEqual(parseD1Rows('[{"success":true,"results":[{"name":"items"}]}]'), [{ name: "items" }]);
  assert.throws(() => parseD1Rows("not json"), /invalid JSON/);
  assert.throws(() => parseD1Rows('[{"success":false,"results":[]}]'), /invalid D1 result/);
});
