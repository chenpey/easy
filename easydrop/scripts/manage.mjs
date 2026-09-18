import { readFile, writeFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createInitialAdmin, normalizeUsername, validatePassword } from "../src/auth.js";
import {
  createCloudflareClient,
  deploymentConfig,
  inspectDeployment,
  provisionDeployment,
  resolvePublicHostname,
  selectAccount,
  selectDeploymentDomain,
} from "./cloudflare.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const mode = process.argv[2];
if (!["local", "deploy"].includes(mode)) throw new Error("Expected local or deploy.");
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

async function askExactConfirmation(phrase, action) {
  while (true) {
    process.stdout.write(`\nTo continue, type exactly:\n  \x1b[1m${phrase}\x1b[22m\n`);
    const answer = await ask('Confirmation: ');
    if (answer === phrase) return;
    if (answer.toLowerCase() === 'cancel') {
      throw new Error('Cancelled.');
    }
    console.error(`Confirmation did not match. Type exactly "${phrase}" to ${action}. Try again.`);
  }
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
  const path = "wrangler.deploy.json";
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
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
  await askExactConfirmation(`deploy ${name}`, "create/update resources and apply pending D1 migrations");
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
