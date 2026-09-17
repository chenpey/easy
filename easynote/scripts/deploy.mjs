import { spawn } from 'node:child_process';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  createCloudflareClient,
  deploymentConfig,
  inspectDeployment,
  provisionDeployment,
  resolvePublicHostname,
  selectAccount,
  selectDeploymentDomain,
  validateWorkersSubdomain,
} from './cloudflare.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const wranglerEntry = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
process.chdir(root);

function ask(prompt, secret = false) {
  return new Promise((resolve, reject) => {
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (!secret) process.stdout.write(chunk);
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    let answered = false;
    if (secret) process.stdout.write(prompt);
    rl.question(secret ? '' : prompt, (answer) => {
      answered = true;
      rl.close();
      if (secret) process.stdout.write('\n');
      resolve(answer);
    });
    rl.once('SIGINT', () => rl.close());
    rl.once('close', () => {
      if (!answered) reject(new Error('Deployment cancelled.'));
    });
  });
}

async function loadConfig(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveConfig(config) {
  const path = 'wrangler.deploy.json';
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function runWrangler(args, token, accountId, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerEntry, ...args], {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv,
        CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_PATH: `${root}/.wrangler/logs/`,
      },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler ${args.join(' ')} failed (${code}).`));
    });
  });
}

function runSetup(token, accountId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/setup.mjs', '--remote', '--config', 'wrangler.deploy.json'], {
      cwd: root,
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        EASYNOTE_INTERACTIVE_CLOUDFLARE: '1',
      },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Remote owner initialization failed (${code}).`));
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
    console.log(`${label} complete (${((Date.now() - startedAt) / 1000).toFixed(1)}s).`);
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
  console.log(`Public DNS active via 1.1.1.1: ${addresses.join(', ')}`);
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    console.log(`Local HTTPS access passed (HTTP ${response.status}).`);
  } catch (error) {
    console.warn(`Public DNS is active, but this machine cannot access ${url}: ${error.message}`);
    console.warn('If the browser shows ERR_NAME_NOT_RESOLVED, restart its DNS cache and the local proxy/DNS service.');
  }
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('An interactive terminal is required. Piped credentials are not supported.');
  }
  if (['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_TOKEN', 'CF_API_KEY']
    .some((name) => process.env[name])) {
    throw new Error('Environment credentials are not accepted. Enter the API Token interactively.');
  }
  const template = await loadConfig('wrangler.json');
  if (!template) throw new Error('wrangler.json is missing.');
  const existing = await loadConfig('wrangler.deploy.json');
  let config = existing
    ? deploymentConfig(template, existing, existing.account_id, existing.name)
    : null;

  console.log('\nEasyNote deploy: automatically prepares isolated D1 and private R2 resources.');
  if (existing) {
    const database = config.d1_databases.find((entry) => entry.binding === 'DB');
    const bucket = config.r2_buckets.find((entry) => entry.binding === 'IMAGES');
    console.log(`Saved target: ${config.name} / ${config.account_id} / ${database.database_name} / ${bucket.bucket_name}`);
  }

  const token = (await ask('Cloudflare API token (hidden, used only for this run): ', true)).trim();
  if (!token) throw new Error('A Cloudflare API Token is required.');
  const api = createCloudflareClient(token);
  const accountId = await selectAccount(api, existing?.account_id, ask);
  const workerName = existing?.name || (await ask(`Worker name [${template.name}]: `)).trim() || template.name;
  const domain = await selectDeploymentDomain(existing, ask);
  config = deploymentConfig(template, existing, accountId, workerName, domain);

  console.log('Checking the deployment target and private storage...');
  const inspection = await inspectDeployment(api, config, existing);
  let requestedSubdomain = inspection.workersSubdomain;
  if (!config.routes?.length && !requestedSubdomain) {
    const answer = await ask(`workers.dev account subdomain [${config.name}]: `);
    requestedSubdomain = validateWorkersSubdomain(answer || config.name);
  }
  const url = config.routes?.length
    ? `https://${config.routes[0].pattern}`
    : `https://${config.name}.${requestedSubdomain}.workers.dev`;

  if (inspection.adoptingDatabase || inspection.adoptingBucket) {
    const resources = [
      inspection.adoptingDatabase ? 'D1 database' : '',
      inspection.adoptingBucket ? 'R2 bucket' : '',
    ].filter(Boolean).join(' and ');
    const adoption = await ask(`Existing ${resources} found. Type ${config.name} to confirm they are dedicated to EasyNote: `);
    if (adoption !== config.name) throw new Error('Deployment cancelled.');
  }

  const database = config.d1_databases.find((entry) => entry.binding === 'DB');
  const bucket = config.r2_buckets.find((entry) => entry.binding === 'IMAGES');
  console.log(JSON.stringify({
    worker: config.name,
    account: accountId,
    database: `${database.database_name} (${inspection.foundDatabase ? 'reuse' : 'create'})`,
    bucket: `${bucket.bucket_name} (${inspection.foundBucket ? 'reuse' : 'create, private'})`,
    url,
  }, null, 2));

  if (await ask('Type deploy easynote to create/update resources and apply migrations: ') !== 'deploy easynote') {
    throw new Error('Deployment cancelled.');
  }

  const deployedUrl = await withProgress(
    'Preparing Cloudflare D1, R2 and public entrypoint',
    () => provisionDeployment(api, config, inspection, requestedSubdomain, saveConfig),
  );
  await saveConfig(config);
  await withProgress(
    'Applying remote D1 migrations',
    () => runWrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', 'wrangler.deploy.json'], token, accountId),
  );
  await withProgress(
    'Uploading the Worker',
    () => runWrangler(['deploy', '--config', 'wrangler.deploy.json'], token, accountId),
  );
  await withProgress('Checking the initial owner', () => runSetup(token, accountId));
  await withProgress('Verifying public DNS and HTTPS access', () => verifyDeploymentAccess(deployedUrl));
  console.log(`\nDeployment complete: ${deployedUrl}`);
  console.log('The Cloudflare API Token and owner password were not saved.');
}

main().catch((error) => {
  console.error(`EasyNote: ${error.message}`);
  process.exitCode = 1;
});
