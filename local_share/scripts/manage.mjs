import { readFile, writeFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createPasswordVerifier } from "../src/auth.js";
import {
  createCloudflareClient,
  deploymentConfig,
  inspectDeployment,
  provisionDeployment,
  resolvePublicHostname,
  selectAccount,
} from "./cloudflare.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const mode = process.argv[2];
if (!["local", "deploy", "password"].includes(mode)) throw new Error("Expected local, deploy or password.");
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

async function askPassword() {
  const password = await ask("Shared password (12+ characters, hidden): ", true);
  const verifier = await createPasswordVerifier(password);
  if (await ask("Confirm shared password (hidden): ", true) !== password) throw new Error("Passwords do not match.");
  return verifier;
}

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], {
      cwd: root, env: { ...process.env, ...env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: `${root}/.wrangler/logs/` },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`wrangler ${args.join(" ")} failed (${code}).`)));
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

async function saveConfig(config) {
  await writeFile("wrangler.deploy.json.tmp", `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename("wrangler.deploy.json.tmp", "wrangler.deploy.json");
}

async function main() {
  if (mode === "local") {
    const verifier = await askPassword();
    await writeFile(".dev.vars", `PASSWORD_VERIFIER='${verifier}'\nALLOW_LOCAL_HTTP="true"\n`, { mode: 0o600 });
    console.log("Local password configured. Run npm run dev. No production credentials were used.");
    return;
  }
  const template = await loadConfig("wrangler.json");
  const existing = await loadConfig("wrangler.deploy.json");
  if (mode === "password" && !existing) throw new Error("Deploy once before rotating the remote password.");
  const token = (await ask("Cloudflare API token (hidden, used only for this run): ", true)).trim();
  if (!token) throw new Error("API token is required.");
  const api = createCloudflareClient(token);
  const account = await selectAccount(api, existing?.account_id, ask);
  const authEnv = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account };
  if (mode === "password") {
    await inspectDeployment(api, existing, existing);
    const verifier = await askPassword();
    if (await ask(`Type ${existing.name} to rotate its password and invalidate all sessions: `) !== existing.name) throw new Error("Cancelled.");
    await api.request("PUT", `/accounts/${account}/workers/scripts/${existing.name}/secrets`, {
      name: "PASSWORD_VERIFIER", type: "secret_text", text: verifier,
    });
    console.log("Remote password rotated. Existing sessions are invalid.");
    return;
  }
  const name = existing?.name || (await ask(`Worker name [${template.name}]: `)).trim() || template.name;
  const previousDomain = existing?.routes?.[0]?.pattern || "";
  const domain = existing ? previousDomain : (await ask("Custom domain (blank for workers.dev): ")).trim();
  const config = deploymentConfig(template, existing, account, name, domain);
  console.log("Checking token access, deployment target and private storage...");
  const inspection = await inspectDeployment(api, config, existing);
  if (inspection.adoptingDatabase || inspection.adoptingBucket) {
    if (await ask(`Existing storage found. Type ${name} to confirm it is dedicated to this app: `) !== name) throw new Error("Cancelled.");
  }
  const verifier = inspection.hasPassword ? null : await askPassword();
  console.log(JSON.stringify({
    worker: name, account, database: config.d1_databases[0].database_name,
    bucket: config.r2_buckets[0].bucket_name, url: inspection.url,
    password: verifier ? "initialize" : "preserve existing password and sessions",
  }, null, 2));
  if (await ask(`Type ${name} to create/update these Cloudflare resources: `) !== name) throw new Error("Cancelled.");
  await withProgress("Building static assets", () => import("./build.mjs"));
  await withProgress("Preparing D1 and R2 resources", () => provisionDeployment(api, config, inspection, saveConfig));
  await withProgress("Applying remote D1 migrations",
    () => run(["d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.deploy.json"], authEnv));
  // First deployment has no verifier and fails closed until the secret is installed.
  await withProgress("Uploading Worker and configuring its public entrypoint",
    () => run(["deploy", "--config", "wrangler.deploy.json"], authEnv));
  if (verifier) {
    await withProgress("Installing the shared-password secret",
      () => api.request("PUT", `/accounts/${account}/workers/scripts/${name}/secrets`, {
        name: "PASSWORD_VERIFIER", type: "secret_text", text: verifier,
      }));
  }
  await withProgress("Verifying public DNS and local HTTPS access", () => verifyDeploymentAccess(inspection.url));
  console.log(`Deployment complete: ${inspection.url}`);
  console.log("Cloudflare token and shared password were not saved locally.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
