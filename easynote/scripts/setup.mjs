import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { writeFile, readFile } from 'node:fs/promises';
import { pbkdf2Sync, createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const { values } = parseArgs({
  options: { remote: { type: 'boolean' }, config: { type: 'string' }, 'check-local': { type: 'boolean' } },
});
if (values['check-local'] && (values.remote || values.config) || values.config && !values.remote) {
  throw new Error('Invalid setup options.');
}

async function localConfigured() {
  let content;
  try { content = await readFile('.dev.vars', 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const env = parseEnv(content);
    const owner = JSON.parse(env.INITIAL_OWNER);
    if (typeof owner?.username !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(owner.username) ||
        !/^[a-f0-9]{64}$/.test(owner.verifier?.salt) || !/^[a-f0-9]{64}$/.test(owner.verifier?.proof)) throw new Error();
    return true;
  } catch {
    throw new Error('.dev.vars contains an invalid INITIAL_OWNER. Check your local configuration; it will not be overwritten.');
  }
}

const wranglerEntry = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
async function main() {
  if (values['check-local']) {
    if (!await localConfigured()) throw new Error('Local account is not configured. Run bash setup.sh.');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive terminal required. Credentials cannot be passed by environment or arguments.');
  if (!values.remote && await localConfigured()) {
    console.log('Local account configuration already exists; preserved without changes.');
    return;
  }
  if (values.remote) {
    if (['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_TOKEN', 'CF_API_KEY'].some((key) => process.env[key])) {
      throw new Error('Environment credentials are not accepted. Use interactive Wrangler login.');
    }
    if (!values.config) throw new Error('--config is required.');
    await readFile(values.config);
    const result = spawnSync(process.execPath, [wranglerEntry, 'secret', 'list', '--format', 'json', '--config', values.config], {
      encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (result.stdout) process.stderr.write(result.stdout);
      throw new Error('Could not check remote secrets. No owner credentials were changed.');
    }
    let secrets;
    try {
      secrets = JSON.parse(result.stdout);
      if (!Array.isArray(secrets) || secrets.some((entry) => !entry || typeof entry.name !== 'string')) throw new Error();
    } catch { throw new Error(`Unexpected response from wrangler secret list:\n${result.stdout}`); }
    if (secrets.some((entry) => entry.name === 'INITIAL_OWNER')) {
      console.log('Remote owner verifier already exists; preserved without changes.');
      return;
    }
    console.log('No remote owner verifier exists. The new service remains locked until initialization completes.');
  }
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  async function ask(label, secret = false) {
    if (secret) { process.stdout.write(label); muted = true; }
    try {
      const answer = await rl.question(secret ? '' : label);
      return secret ? answer : answer.trim();
    } finally {
      if (secret) { muted = false; process.stdout.write('\n'); }
    }
  }
  try {
    console.log('Initialize the owner account. This does NOT reset passwords for existing database accounts.');
    const username = (await ask('Owner username (3-32 lowercase letters, digits, . _ -): ')).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error('Invalid username.');
    const password = await ask('Owner password (12-128 characters, hidden): ', true);
    if (password.length < 12 || password.length > 128) throw new Error('Password must be 12-128 characters.');
    if (password !== await ask('Confirm password (hidden): ', true)) throw new Error('Passwords do not match.');
    const salt = randomBytes(32).toString('hex');
    const key = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256');
    const proof = createHmac('sha256', key).update('easynote/password/v1').digest('hex');
    const owner = JSON.stringify({ username, verifier: { salt, proof } });
    rl.close();
    if (values.remote) {
      const result = spawnSync(process.execPath, [wranglerEntry, 'secret', 'put', 'INITIAL_OWNER', '--config', values.config], {
        input: owner, stdio: ['pipe', 'inherit', 'inherit'],
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error('Failed to install owner verifier. Run bash deploy.sh again to finish initialization.');
      console.log('Owner verifier installed. No plaintext password was saved.');
    } else {
      await writeFile('.dev.vars', `INITIAL_OWNER='${owner}'\nALLOW_LOCAL_HTTP="true"\n`, { mode: 0o600, flag: 'wx' });
      console.log('Local verifier saved to ignored .dev.vars. No plaintext password was saved.');
    }
  } finally {
    rl.close();
  }
}

await main().catch((error) => { console.error(`EasyNote: ${error.message}`); process.exitCode = 1; });
