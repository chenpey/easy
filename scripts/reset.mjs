#!/usr/bin/env node
import { access, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const projects = Object.freeze({
  easynote: {
    label: "EasyNote",
    directory: "easynote",
    r2Binding: "IMAGES",
    browserOrigin: "http://127.0.0.1:8791",
    objectTable: "images",
    objectQuery: "SELECT user_id || '/' || id AS object_key FROM images ORDER BY user_id,id",
    objectPattern: new RegExp(`^${uuid}/${uuid}$`, "i"),
    dropSql: [
      "DROP TABLE IF EXISTS note_shares",
      "DROP TABLE IF EXISTS image_refs",
      "DROP TABLE IF EXISTS note_versions",
      "DROP TABLE IF EXISTS note_changes",
      "DROP TABLE IF EXISTS purged_notes",
      "DROP TABLE IF EXISTS images",
      "DROP TABLE IF EXISTS notes_fts",
      "DROP TABLE IF EXISTS notes",
      "DROP TABLE IF EXISTS integration_tokens",
      "DROP TABLE IF EXISTS sessions",
      "DROP TABLE IF EXISTS account_attempts",
      "DROP TABLE IF EXISTS login_attempts",
      "DROP TABLE IF EXISTS app_state",
      "DROP TABLE IF EXISTS users",
      "DROP TABLE IF EXISTS d1_migrations",
    ].join(";"),
    nextLocal: "bash dev.sh",
    nextRemote: "bash deploy.sh",
  },
  easydrop: {
    label: "EasyDrop",
    directory: "easydrop",
    r2Binding: "FILES",
    browserOrigin: "http://127.0.0.1:8787",
    objectTable: "items",
    objectQuery: `SELECT 'files/' || id AS object_key FROM items WHERE type='file'
      UNION ALL SELECT 'files/' || id || '/preview' AS object_key FROM items WHERE type='file'
      ORDER BY object_key`,
    objectPattern: new RegExp(`^files/${uuid}(?:/preview)?$`, "i"),
    dropSql: [
      "DROP TABLE IF EXISTS file_shares",
      "DROP TABLE IF EXISTS multipart_parts",
      "DROP TABLE IF EXISTS multipart_uploads",
      "DROP TABLE IF EXISTS operations",
      "DROP TABLE IF EXISTS items",
      "DROP TABLE IF EXISTS sessions",
      "DROP TABLE IF EXISTS account_attempts",
      "DROP TABLE IF EXISTS login_attempts",
      "DROP TABLE IF EXISTS app_state",
      "DROP TABLE IF EXISTS users",
      "DROP TABLE IF EXISTS d1_migrations",
    ].join(";"),
    nextLocal: "npm run dev",
    nextRemote: "bash deploy.sh",
  },
});

const usage = `Usage:
  bash reset.sh <easynote|easydrop> --local
  bash reset.sh <easynote|easydrop> --remote

--local   Delete the selected project's local Wrangler D1/R2 state.
--remote  Delete all app data in the configured Cloudflare D1/R2 resources,
          reset the current D1 schema, and remove the deployed Worker.
`;

export function parseArguments(args) {
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) return { help: true };
  if (args.length !== 2 || !projects[args[0]] || !["--local", "--remote"].includes(args[1])) {
    throw new Error(usage.trim());
  }
  return { project: args[0], mode: args[1].slice(2) };
}

function validateName(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) {
    throw new Error(`Invalid ${label} in wrangler.deploy.json.`);
  }
  return value;
}

function validateDatabaseName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Invalid D1 database name in wrangler.deploy.json.");
  }
  return value;
}

export async function loadTarget(projectName, base = root) {
  const project = projects[projectName];
  const directory = join(base, project.directory);
  const configPath = join(directory, "wrangler.deploy.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${project.label}: wrangler.deploy.json is missing; there is no saved Cloudflare target to reset.`);
    }
    throw new Error(`${project.label}: wrangler.deploy.json is invalid.`);
  }
  const database = config.d1_databases?.find((entry) => entry.binding === "DB");
  const bucket = config.r2_buckets?.find((entry) => entry.binding === project.r2Binding);
  if (!/^[a-f0-9]{32}$/i.test(config.account_id || "")) throw new Error("Invalid Cloudflare account ID in wrangler.deploy.json.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(database?.database_id || "")) {
    throw new Error("Invalid D1 database UUID in wrangler.deploy.json.");
  }
  return {
    ...project,
    projectName,
    directory,
    configPath,
    config,
    accountId: config.account_id,
    workerName: validateName(config.name, "Worker name"),
    databaseName: validateDatabaseName(database.database_name),
    bucketName: validateName(bucket?.bucket_name, "R2 bucket name"),
    jurisdiction: bucket?.jurisdiction,
  };
}

export function parseD1Rows(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error(`Wrangler returned invalid JSON:\n${output}`);
  }
  const results = Array.isArray(payload) ? payload : [payload];
  if (results.some((entry) => entry?.success === false || !Array.isArray(entry?.results))) {
    throw new Error(`Wrangler returned an invalid D1 result:\n${output}`);
  }
  return results.flatMap((entry) => entry.results);
}

export async function resetLocal(target, { remove = rm, log = console.log } = {}) {
  await remove(join(target.directory, ".wrangler", "state"), { recursive: true, force: true });
  log(`${target.label} local D1/R2 state removed.`);
  log(`Clear site data for ${target.browserOrigin}, then run: cd ${target.directory} && ${target.nextLocal}`);
}

function commandFailure(command, result) {
  const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  return new Error(`${command} failed (${result.status})${detail ? `:\n${detail}` : "."}`);
}

async function ensureWrangler(target) {
  const entry = join(target.directory, "node_modules", "wrangler", "bin", "wrangler.js");
  try {
    await access(entry);
  } catch {
    console.log(`Preparing locked ${target.label} dependencies...`);
    const installed = spawnSync("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], {
      cwd: target.directory,
      stdio: "inherit",
    });
    if (installed.error) throw installed.error;
    if (installed.status !== 0) throw commandFailure("npm ci", installed);
  }
  return entry;
}

function defaultWrangler(target, token) {
  const entry = join(target.directory, "node_modules", "wrangler", "bin", "wrangler.js");
  return (args, { capture = true } = {}) => {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: target.directory,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_ACCOUNT_ID: target.accountId,
        WRANGLER_LOG_PATH: join(target.directory, ".wrangler", "logs") + "/",
        WRANGLER_SEND_METRICS: "false",
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw commandFailure(`wrangler ${args.join(" ")}`, result);
    return result.stdout || "";
  };
}

function defaultCloudflare(token) {
  return async (method, path, body, { allowMissing = false } = {}) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
      redirect: "error",
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { /* Preserve the complete response below. */ }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok || data?.success !== true) {
      throw new Error(`${method} ${path}\nHTTP ${response.status}\n${raw}`);
    }
    return data.result;
  };
}

export async function resetRemote(
  target,
  token,
  { run = defaultWrangler(target, token), request = defaultCloudflare(token), log = console.log } = {},
) {
  const configArgument = ["--config", target.configPath];
  run(["d1", "info", "DB", ...configArgument, "--json"]);
  run(["r2", "bucket", "info", target.bucketName, ...configArgument, "--json"]);
  const tables = parseD1Rows(run([
    "d1", "execute", "DB", "--remote",
    "--command", `SELECT name FROM sqlite_master WHERE type='table' AND name='${target.objectTable}'`,
    ...configArgument, "--json",
  ]));
  const keys = tables.length
    ? parseD1Rows(run([
      "d1", "execute", "DB", "--remote", "--command", target.objectQuery, ...configArgument, "--json",
    ])).map((row) => row.object_key)
    : [];
  if (keys.some((key) => typeof key !== "string" || !target.objectPattern.test(key))) {
    throw new Error("D1 returned an unexpected R2 object key; reset stopped before deletion.");
  }
  log(`Tracked R2 objects to delete: ${new Set(keys).size}`);

  const prefix = `/accounts/${target.accountId}`;
  await request("DELETE", `${prefix}/workers/scripts/${encodeURIComponent(target.workerName)}`, undefined, { allowMissing: true });
  for (const [index, key] of [...new Set(keys)].entries()) {
    run(["r2", "object", "delete", `${target.bucketName}/${key}`, "--remote", "--force", ...configArgument]);
    if ((index + 1) % 25 === 0 || index + 1 === keys.length) log(`Deleted R2 objects: ${index + 1}/${keys.length}`);
  }
  await request("DELETE", `${prefix}/r2/buckets/${encodeURIComponent(target.bucketName)}`);
  await request("POST", `${prefix}/r2/buckets`, { name: target.bucketName });
  run(["d1", "execute", "DB", "--remote", "--command", target.dropSql, ...configArgument, "--yes"]);
  run(["d1", "migrations", "apply", "DB", "--remote", ...configArgument], { capture: false });
  log(`${target.label} Cloudflare D1/R2 data and Worker were reset.`);
}

function ask(prompt, secret = false) {
  return new Promise((resolve, reject) => {
    const output = new Writable({ write(chunk, _encoding, callback) {
      if (!secret) process.stdout.write(chunk);
      callback();
    } });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    let answered = false;
    if (secret) process.stdout.write(prompt);
    rl.question(secret ? "" : prompt, (answer) => {
      answered = true;
      rl.close();
      if (secret) process.stdout.write("\n");
      resolve(answer.trim());
    });
    rl.once("SIGINT", () => rl.close());
    rl.once("close", () => { if (!answered) reject(new Error("Cancelled.")); });
  });
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("An interactive terminal is required.");
  const target = options.mode === "remote"
    ? await loadTarget(options.project)
    : { ...projects[options.project], projectName: options.project, directory: join(root, projects[options.project].directory) };
  if (options.mode === "remote") {
    for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_TOKEN", "CF_API_KEY"]) {
      if (process.env[name]) throw new Error("Environment credentials are not accepted. Enter the API token interactively.");
    }
    console.log(`Worker: ${target.workerName}\nD1: ${target.databaseName}\nR2: ${target.bucketName}`);
  }
  const phrase = `reset ${options.project} ${options.mode}`;
  console.log(`${target.label} ${options.mode} reset permanently deletes all ${options.mode === "local" ? "local" : "Cloudflare"} app data.`);
  if (await ask(`Type ${phrase} to continue: `) !== phrase) throw new Error("Reset cancelled.");
  if (options.mode === "local") {
    await resetLocal(target);
    return;
  }
  await ensureWrangler(target);
  const token = await ask("Cloudflare API token (hidden, used only for this run): ", true);
  if (!token) throw new Error("A Cloudflare API token is required.");
  await resetRemote(target, token);
  console.log(`Redeploy with: cd ${target.directory} && ${target.nextRemote}`);
  console.log("The Cloudflare API token was not saved.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Reset: ${error.message}`);
    process.exitCode = 1;
  });
}
