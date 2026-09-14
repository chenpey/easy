import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createInitialAdmin, normalizeUsername, validatePassword } from "../src/auth.js";
import {
  createCloudflareClient,
  deploymentConfig,
  inspectDeployment,
  inspectPrivateBucket,
  provisionDeployment,
  resolvePublicHostname,
  selectAccount,
  selectDeploymentDomain,
  storageResourceNames,
} from "./cloudflare.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const mode = process.argv[2];
if (!["local", "deploy", "migrate-storage"].includes(mode)) throw new Error("Expected local, deploy or migrate-storage.");
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("An interactive terminal is required. Piped input is not supported.");
if (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_KEY || process.env.CF_API_KEY) {
  throw new Error("Remove Cloudflare credential environment variables. This script requires interactive credentials.");
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
      resolve(answer);
    });
    rl.once("SIGINT", () => rl.close());
    rl.once("close", () => { if (!answered) reject(new Error("Cancelled.")); });
  });
}

async function askInitialAdmin() {
  let username;
  while (!username) {
    try {
      username = normalizeUsername(await ask("Initial administrator username: "));
    } catch (error) {
      console.error(error.message);
    }
  }
  while (true) {
    const password = await ask("Initial administrator password (12-32 chars, upper/lower/digit, hidden): ", true);
    try {
      validatePassword(password);
    } catch (error) {
      console.error(error.message);
      continue;
    }
    if (await ask("Confirm administrator password (hidden): ", true) !== password) {
      console.error("Passwords do not match. Try again.");
      continue;
    }
    return createInitialAdmin(username, password);
  }
}

function run(args, env = {}, interactive = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], {
      cwd: root, env: { ...process.env, ...env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: `${root}/.wrangler/logs/` },
      stdio: [interactive ? "inherit" : "ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`wrangler ${args.join(" ")} failed (${code}).`)));
  });
}

function runCapture(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], {
      cwd: root,
      env: { ...process.env, ...env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: `${root}/.wrangler/logs/` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`wrangler ${args.join(" ")} failed (${code}).\n${stderr}${stdout}`.trim()));
    });
  });
}

async function withProgress(label, action) {
  const startedAt = Date.now();
  console.log(`\n${label}...`);
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`${label} still running (${elapsed}s elapsed)...`);
  }, 15000);
  heartbeat.unref();
  try {
    const result = await action();
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`${label} complete (${elapsed}s).`);
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

async function verifyDeploymentAccess(url) {
  const hostname = new URL(url).hostname;
  let addresses;
  try {
    addresses = await resolvePublicHostname(hostname);
  } catch (error) {
    console.warn(`Public DNS verification through 1.1.1.1 failed:\n${error.message}`);
    return;
  }
  if (!addresses.length) {
    console.warn(`Public DNS for ${hostname} is not visible through 1.1.1.1 yet. Wait for propagation before retrying.`);
    return;
  }
  console.log(`Public DNS active via 1.1.1.1: ${addresses.join(", ")}`);
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    console.log(`Local HTTPS access passed (HTTP ${response.status}).`);
  } catch (error) {
    console.warn(`Public DNS is active, but this machine cannot access ${url}: ${error.message}`);
    console.warn("If the browser shows ERR_NAME_NOT_RESOLVED, restart its DNS cache and the local proxy/DNS service.");
  }
}

async function loadConfig(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function saveJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

const saveConfig = (config) => saveJson("wrangler.deploy.json", config);

function parseD1Rows(output) {
  let payload;
  try { payload = JSON.parse(output); } catch { throw new Error(`Invalid JSON from remote D1 query:\n${output}`); }
  const statements = Array.isArray(payload) ? payload : [payload];
  if (!statements.length || statements.some((entry) => entry?.success === false)) {
    throw new Error(`Remote D1 query failed:\n${output}`);
  }
  const rows = statements.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
  return rows.map((row) => {
    const size = Number(row.size);
    if (!/^[a-f0-9-]{36}$/.test(row.id || "") || !Number.isSafeInteger(size) || size < 0 ||
        !["pending", "ready", "deleting"].includes(row.state)) {
      throw new Error(`Remote D1 returned an invalid file record:\n${JSON.stringify(row)}`);
    }
    return { id: row.id, size, state: row.state };
  });
}

async function remoteFileInventory(configPath, authEnv) {
  const output = await runCapture([
    "d1", "execute", "DB", "--remote", "--config", configPath, "--json",
    "--command", "SELECT id, size, state FROM items WHERE type = 'file' ORDER BY id",
  ], authEnv);
  return parseD1Rows(output);
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function copyR2Files(files, sourceBucket, targetBucket, configPath, authEnv) {
  const directory = ".wrangler/storage-migration";
  const sourcePath = `${directory}/source.bin`;
  const targetPath = `${directory}/target.bin`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [index, file] of files.entries()) {
    await rm(sourcePath, { force: true });
    await rm(targetPath, { force: true });
    const key = `files/${file.id}`;
    await run(["r2", "object", "get", `${sourceBucket}/${key}`, "--file", sourcePath, "--remote", "--config", configPath], authEnv, false);
    const sourceSize = (await stat(sourcePath)).size;
    if (sourceSize !== file.size) {
      throw new Error(`Source R2 object ${key} is ${sourceSize} bytes; D1 expects ${file.size}.`);
    }
    const sourceHash = await fileDigest(sourcePath);
    await run([
      "r2", "object", "put", `${targetBucket}/${key}`, "--file", sourcePath,
      "--content-type", "application/octet-stream", "--force", "--remote", "--config", configPath,
    ], authEnv, false);
    await run(["r2", "object", "get", `${targetBucket}/${key}`, "--file", targetPath, "--remote", "--config", configPath], authEnv, false);
    if ((await stat(targetPath)).size !== sourceSize || await fileDigest(targetPath) !== sourceHash) {
      throw new Error(`Copied R2 object ${key} failed size or SHA-256 verification.`);
    }
    console.log(`Copied and verified R2 object ${index + 1}/${files.length}: ${key}`);
  }
}

async function publicUrl(api, config) {
  if (config.routes?.[0]?.pattern) return `https://${config.routes[0].pattern}`;
  const subdomain = await api.request("GET", `/accounts/${config.account_id}/workers/subdomain`);
  if (!subdomain?.subdomain) throw new Error("Cloudflare workers.dev subdomain is unavailable.");
  return `https://${config.name}.${subdomain.subdomain}.workers.dev`;
}

async function migrateStorage(template, existing) {
  if (!existing) throw new Error("wrangler.deploy.json is required. Deploy the existing application before renaming storage.");
  const statePath = "wrangler.storage-migration.json";
  const temporaryConfigPath = "wrangler.storage.tmp.json";
  const savedState = await loadConfig(statePath);
  const sourceSaved = savedState?.sourceConfig || existing;
  if (sourceSaved.account_id !== existing.account_id || sourceSaved.name !== existing.name) {
    throw new Error("Saved storage migration belongs to a different deployment target.");
  }
  const target = savedState?.target || storageResourceNames(
    (await ask("New storage base name [easy-drop]: ")).trim() || "easy-drop",
  );
  if (existing.d1_databases[0].database_name === target.database &&
      existing.r2_buckets[0].bucket_name === target.bucket && savedState?.status !== "active") {
    console.log(`Storage already uses D1 ${target.database} and R2 ${target.bucket}.`);
    return;
  }

  const sourceDomain = sourceSaved.routes?.[0]?.pattern || "";
  const sourceConfig = deploymentConfig(
    template, sourceSaved, sourceSaved.account_id, sourceSaved.name, sourceDomain,
  );
  const finalConfig = structuredClone(sourceConfig);
  finalConfig.d1_databases[0].database_name = target.database;
  finalConfig.r2_buckets[0].bucket_name = target.bucket;
  finalConfig.vars.STORAGE_MIGRATION_MODE = "false";
  const summary = {
    worker: sourceConfig.name,
    database: `${sourceConfig.d1_databases[0].database_name} -> ${target.database}`,
    bucket: `${sourceConfig.r2_buckets[0].bucket_name} -> ${target.bucket}`,
    oldBucket: "retained after verified cutover",
  };
  console.log(JSON.stringify(summary, null, 2));
  if (await ask(`Type migrate ${target.database} to continue: `) !== `migrate ${target.database}`) {
    throw new Error("Cancelled.");
  }

  const token = (await ask("Cloudflare API token (hidden, used only for this run): ", true)).trim();
  if (!token) throw new Error("API token is required.");
  const authEnv = {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: sourceConfig.account_id,
  };
  const api = createCloudflareClient(token);
  const prefix = `/accounts/${sourceConfig.account_id}`;
  const settings = await api.request("GET", `${prefix}/workers/scripts/${sourceConfig.name}/settings`);
  const remoteDatabase = settings?.bindings?.find((entry) => entry.name === "DB" && entry.type === "d1");
  const remoteBucket = settings?.bindings?.find((entry) => entry.name === "FILES" && entry.type === "r2_bucket");
  if (remoteDatabase?.id !== sourceConfig.d1_databases[0].database_id) {
    throw new Error("Remote DB binding differs from the saved deployment.");
  }
  if (![sourceConfig.r2_buckets[0].bucket_name, target.bucket].includes(remoteBucket?.bucket_name)) {
    throw new Error("Remote FILES binding differs from both the source and target storage.");
  }
  const database = await api.request(
    "GET", `${prefix}/d1/database/${sourceConfig.d1_databases[0].database_id}`,
  );
  if (![sourceConfig.d1_databases[0].database_name, target.database].includes(database.name)) {
    throw new Error("Remote D1 name differs from both the source and target storage.");
  }

  let migrationState = savedState;
  let targetBucket = await inspectPrivateBucket(api, sourceConfig.account_id, target.bucket, true);
  if (!migrationState && targetBucket) {
    throw new Error(`Target R2 bucket ${target.bucket} already exists. Refusing to adopt or overwrite it.`);
  }
  if (!migrationState) {
    migrationState = {
      version: 1,
      status: "active",
      sourceConfig,
      target,
      createdAt: new Date().toISOString(),
    };
    await saveJson(statePath, migrationState);
  } else if (migrationState.version !== 1 || migrationState.target?.database !== target.database ||
      migrationState.target?.bucket !== target.bucket) {
    throw new Error("Saved storage migration state is invalid or targets different resources.");
  }

  if (!targetBucket) {
    await withProgress(`Creating private R2 bucket ${target.bucket}`,
      () => api.request("POST", `${prefix}/r2/buckets`, { name: target.bucket }));
    targetBucket = await inspectPrivateBucket(api, sourceConfig.account_id, target.bucket);
  }
  if (!targetBucket) throw new Error(`Target R2 bucket ${target.bucket} could not be verified.`);

  if (remoteBucket.bucket_name === target.bucket) {
    if (database.name !== target.database) {
      throw new Error("Worker already uses the target R2 bucket but D1 has not been renamed. Manual recovery is required.");
    }
    await saveConfig(finalConfig);
    await saveJson(statePath, { ...migrationState, status: "complete", completedAt: new Date().toISOString() });
    console.log("Remote storage already uses the migration target; local deployment configuration was repaired.");
    return;
  }

  await inspectPrivateBucket(api, sourceConfig.account_id, sourceConfig.r2_buckets[0].bucket_name);
  await withProgress("Building static assets", () => import("./build.mjs"));
  const maintenanceConfig = structuredClone(sourceConfig);
  maintenanceConfig.vars.STORAGE_MIGRATION_MODE = "true";
  await saveJson(temporaryConfigPath, maintenanceConfig);
  let maintenanceDeployed = false;
  let cutoverComplete = false;
  let databaseRenamed = database.name === target.database;
  try {
    await withProgress("Enabling read-only storage migration mode",
      () => run(["deploy", "--config", temporaryConfigPath], authEnv));
    maintenanceDeployed = true;
    const inventory = await remoteFileInventory(temporaryConfigPath, authEnv);
    const pending = inventory.filter((item) => item.state === "pending");
    if (pending.length) {
      throw new Error(`${pending.length} pending upload(s) exist. Finish or cancel them before migrating storage.`);
    }
    const ready = inventory.filter((item) => item.state === "ready");
    console.log(`Ready R2 objects to migrate: ${ready.length}`);
    await copyR2Files(
      ready,
      sourceConfig.r2_buckets[0].bucket_name,
      target.bucket,
      temporaryConfigPath,
      authEnv,
    );
    const finalInventory = await remoteFileInventory(temporaryConfigPath, authEnv);
    if (finalInventory.some((item) => item.state === "pending")) {
      throw new Error("A pending upload appeared during storage migration.");
    }
    const verified = finalInventory.filter((item) => item.state === "ready");
    if (JSON.stringify(verified) !== JSON.stringify(ready)) {
      throw new Error("D1 file inventory changed during storage migration.");
    }
    if (!databaseRenamed) {
      await withProgress(`Renaming D1 database to ${target.database}`,
        () => api.request("PATCH", `${prefix}/d1/database/${sourceConfig.d1_databases[0].database_id}`, {
          name: target.database,
        }));
      databaseRenamed = true;
    }
    await saveJson(temporaryConfigPath, finalConfig);
    await withProgress("Applying remote D1 migrations",
      () => run(["d1", "migrations", "apply", "DB", "--remote", "--config", temporaryConfigPath], authEnv, false));
    await withProgress("Switching Worker to migrated storage",
      () => run(["deploy", "--config", temporaryConfigPath], authEnv));
    cutoverComplete = true;
    await saveConfig(finalConfig);
    await saveJson(statePath, { ...migrationState, status: "complete", completedAt: new Date().toISOString() });
    const url = await publicUrl(api, finalConfig);
    await withProgress("Verifying public DNS and local HTTPS access", () => verifyDeploymentAccess(url));
    console.log(`Storage migration complete: D1 ${target.database}, R2 ${target.bucket}`);
    console.log(`Old R2 bucket ${sourceConfig.r2_buckets[0].bucket_name} was retained for manual verification and cleanup.`);
  } catch (error) {
    if (maintenanceDeployed && !cutoverComplete) {
      const recoveryConfig = structuredClone(sourceConfig);
      recoveryConfig.vars.STORAGE_MIGRATION_MODE = "false";
      if (databaseRenamed) recoveryConfig.d1_databases[0].database_name = target.database;
      await saveJson(temporaryConfigPath, recoveryConfig);
      try {
        await withProgress("Restoring normal access to source storage",
          () => run(["deploy", "--config", temporaryConfigPath], authEnv));
      } catch (restoreError) {
        throw new Error(`${error.message}\nRecovery deployment also failed:\n${restoreError.message}`, { cause: error });
      }
    }
    throw error;
  } finally {
    await rm(temporaryConfigPath, { force: true });
    await rm(".wrangler/storage-migration", { recursive: true, force: true });
  }
}

async function main() {
  if (mode === "local") {
    const initialAdmin = await askInitialAdmin();
    await writeFile(".dev.vars", `INITIAL_ADMIN='${initialAdmin}'\nALLOW_LOCAL_HTTP="true"\n`, { mode: 0o600 });
    console.log("Local administrator configured. Run npm run dev. No production credentials were used.");
    return;
  }
  const template = await loadConfig("wrangler.json");
  const existing = await loadConfig("wrangler.deploy.json");
  if (mode === "migrate-storage") {
    await migrateStorage(template, existing);
    return;
  }
  const token = (await ask("Cloudflare API token (hidden, used only for this run): ", true)).trim();
  if (!token) throw new Error("API token is required.");
  const api = createCloudflareClient(token);
  const account = await selectAccount(api, existing?.account_id, ask);
  const authEnv = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account };
  const name = existing?.name || (await ask(`Worker name [${template.name}]: `)).trim() || template.name;
  const domain = await selectDeploymentDomain(existing, ask);
  const config = deploymentConfig(template, existing, account, name, domain);
  console.log("Checking token access, deployment target and private storage...");
  const inspection = await inspectDeployment(api, config, existing);
  if (inspection.adoptingDatabase || inspection.adoptingBucket) {
    if (await ask(`Existing storage found. Type ${name} to confirm it is dedicated to this app: `) !== name) throw new Error("Cancelled.");
  }
  const initialAdmin = inspection.hasInitialAdmin ? null : await askInitialAdmin();
  const summary = {
    worker: name, account, database: config.d1_databases[0].database_name,
    bucket: config.r2_buckets[0].bucket_name, url: inspection.url,
    administrator: initialAdmin ? "initialize" : "preserve existing users and sessions",
  };
  console.log(JSON.stringify(summary, null, 2));
  if (await ask(`Type ${name} to create/update resources and apply pending D1 migrations: `) !== name) {
    throw new Error("Cancelled.");
  }
  await withProgress("Building static assets", () => import("./build.mjs"));
  await withProgress("Preparing D1 and R2 resources",
    () => provisionDeployment(api, config, inspection, saveConfig));
  await withProgress("Applying remote D1 migrations",
    () => run(["d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.deploy.json"], authEnv, false));
  // First deployment fails closed until the initial administrator secret is installed.
  await withProgress("Uploading Worker and configuring its public entrypoint",
    () => run(["deploy", "--config", "wrangler.deploy.json"], authEnv));
  if (initialAdmin) {
    await withProgress("Installing the initial administrator secret",
      () => api.request("PUT", `/accounts/${account}/workers/scripts/${name}/secrets`, {
        name: "INITIAL_ADMIN", type: "secret_text", text: initialAdmin,
      }));
  }
  await withProgress("Verifying public DNS and local HTTPS access", () => verifyDeploymentAccess(inspection.url));
  console.log(`Deployment complete: ${inspection.url}`);
  console.log("Cloudflare token and administrator password were not saved locally.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
