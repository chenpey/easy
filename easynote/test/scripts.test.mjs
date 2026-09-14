import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { parseEnv } from 'node:util';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporary = `${project}/.wrangler/script-tests`;
await mkdir(temporary, { recursive: true });
const fixtures = [];
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const owner = { username: 'test-owner', verifier: { salt: 'a'.repeat(64), proof: 'b'.repeat(64) } };
const localConfig = `INITIAL_OWNER='${JSON.stringify(owner)}'\nALLOW_LOCAL_HTTP="true"\nCUSTOM_SETTING="keep me"\n`;
const databaseId = '12345678-1234-4234-8234-123456789abc';
const secret = 'Only-for-script-tests-39!';

after(async () => {
  for (const directory of fixtures) await rm(directory, { recursive: true, force: true });
});

async function fixture({ configured = true } = {}) {
  const root = await mkdtemp(`${temporary}/case with spaces-`);
  fixtures.push(root);
  await mkdir(`${root}/scripts`);
  await mkdir(`${root}/bin`);
  for (const name of ['setup.sh', 'dev.sh', 'deploy.sh', 'package.json', 'package-lock.json', 'wrangler.json']) {
    await cp(`${project}/${name}`, `${root}/${name}`);
  }
  for (const name of ['common.sh', 'setup.mjs', 'deploy-config.mjs']) await cp(`${project}/scripts/${name}`, `${root}/scripts/${name}`);
  if (configured) await writeFile(`${root}/.dev.vars`, localConfig, { mode: 0o600 });
  await writeFile(`${root}/bin/node`, `#!/bin/bash
if [[ "\${FAKE_OLD_NODE:-}" == 1 && "\${1:-}" == -e && "\${2:-}" == *process.versions.node* ]]; then exit 1; fi
exec ${shellQuote(process.execPath)} "$@"
`, { mode: 0o755 });
  await symlink('/usr/bin/dirname', `${root}/bin/dirname`);
  const mock = `${root}/mock.mjs`;
  await writeFile(mock, `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
const isEntry = process.argv[1].endsWith('/wrangler.js');
const tool = isEntry ? 'wrangler' : process.argv[2];
const args = process.argv.slice(isEntry ? 2 : 3);
appendFileSync(root + '/calls.jsonl', JSON.stringify({ tool, args, cwd: process.cwd(),
  logPath: process.env.WRANGLER_LOG_PATH, registryPath: process.env.WRANGLER_REGISTRY_PATH }) + '\\n');
if (process.env.FAKE_FAIL === tool + ':' + args[0]) process.exit(19);
if (tool === 'npm' && args[0] === 'ci') {
  mkdirSync(root + '/node_modules/.bin', {recursive:true});
  mkdirSync(root + '/node_modules/wrangler/bin', {recursive:true});
  for (const binary of ['wrangler', 'vite', 'tsc']) {
    writeFileSync(root + '/node_modules/.bin/' + binary,
      '#!/bin/bash\\nexec ' + ${JSON.stringify(shellQuote(process.execPath))} + ' ' + ${JSON.stringify(shellQuote(mock))} + ' ' + binary + ' "$@"\\n', {mode:0o755});
  }
  writeFileSync(root + '/node_modules/wrangler/bin/wrangler.js', 'import ' + JSON.stringify(${JSON.stringify(mock)}) + ';\\n');
}
if (tool === 'wrangler' && args[0] === 'secret' && args[1] === 'list') {
  console.log(process.env.FAKE_SECRETS ?? '[{"name":"INITIAL_OWNER","type":"secret_text"}]');
}
if (tool === 'wrangler' && args[0] === 'secret' && args[1] === 'put') {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const data = JSON.parse(input);
  if (!data.verifier || data.password || !/^[a-f0-9]{64}$/.test(data.verifier.proof)) process.exit(20);
  writeFileSync(root + '/installed-owner.json', input, {mode:0o600});
}
`, { mode: 0o644 });
  await writeFile(`${root}/bin/npm`, `#!/bin/bash\nexec ${shellQuote(process.execPath)} ${shellQuote(mock)} npm "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${root}/bin:/usr/bin:/bin`, NO_COLOR: '1', TERM: 'dumb' };
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_TOKEN', 'CF_API_KEY']) delete env[key];
  return { root, env };
}

function run(f, name, args = [], env = {}) {
  return spawnSync('/bin/bash', [`${f.root}/${name}`, ...args], {
    cwd: project, env: { ...f.env, ...env }, encoding: 'utf8', timeout: 15000,
  });
}

async function calls(f) {
  try { return (await readFile(`${f.root}/calls.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function dependencies(f) {
  const result = run(f, 'deploy.sh', ['--check']);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(`${f.root}/calls.jsonl`, '');
}

function terminal(f, name, args = [], steps = [], env = {}) {
  const tclString = (value) => `[encoding convertfrom utf-8 [binary format H* ${Buffer.from(value).toString('hex') || '{}'}]]`;
  const command = ['/bin/bash', `${f.root}/${name}`, ...args].map(tclString).join(' ');
  const script = `set timeout 10
spawn -noecho ${command}
${steps.map(([prompt, answer]) => `expect {
  -exact ${tclString(prompt)} { send -- "${tclString(answer)}\\r" }
  timeout { exit 124 }
  eof { exit 125 }
}`).join('\n')}
expect {
  eof {}
  timeout { exit 124 }
}
set result [wait]
exit [lindex $result 3]
`;
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd: project, env: { ...f.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Interactive script timed out:\n${output}`));
    }, 15000);
    const receive = (chunk) => { output += chunk; };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, output }); });
  });
}
const setupSteps = [
  ['Owner username (3-32 lowercase letters, digits, . _ -): ', 'test-owner'],
  ['Owner password (12-128 characters, hidden): ', secret],
  ['Confirm password (hidden): ', secret],
];

test('all three help commands work without Node or npm, even outside the project', async () => {
  const f = await fixture();
  await rm(`${f.root}/bin/node`);
  await rm(`${f.root}/bin/npm`);
  for (const name of ['setup.sh', 'dev.sh', 'deploy.sh']) {
    const result = run(f, name, ['--help'], { PATH: `${f.root}/bin` });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
});

test('missing and old Node fail before installing or launching anything', async () => {
  const f = await fixture();
  const old = run(f, 'deploy.sh', ['--check'], { FAKE_OLD_NODE: '1' });
  assert.notEqual(old.status, 0);
  assert.match(old.stderr, /Node.js 22/);
  await rm(`${f.root}/bin/node`);
  const missing = run(f, 'deploy.sh', ['--check'], { PATH: `${f.root}/bin` });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Install Node.js/);
  assert.deepEqual(await calls(f), []);
});

test('locked dependencies install once; changed manifests and missing tools invalidate the marker', async () => {
  const f = await fixture();
  await dependencies(f);
  let result = run(f, 'deploy.sh', ['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await calls(f)).filter((c) => c.tool === 'npm' && c.args[0] === 'ci').length, 0);
  await writeFile(`${f.root}/package.json`, `${await readFile(`${f.root}/package.json`, 'utf8')}\n`);
  result = run(f, 'deploy.sh', ['--check']);
  assert.equal(result.status, 0, result.stderr);
  await rm(`${f.root}/node_modules/.bin/vite`);
  result = run(f, 'deploy.sh', ['--check']);
  assert.equal(result.status, 0, result.stderr);
  const recorded = await calls(f);
  assert.equal(recorded.filter((c) => c.tool === 'npm' && c.args[0] === 'ci').length, 2);
  assert.ok(recorded.every((c) => c.cwd === f.root && c.logPath.startsWith(f.root) && c.registryPath.startsWith(f.root)));
  assert.ok(recorded.filter((c) => c.tool === 'wrangler').every((c) => c.args.includes('--dry-run')));
});

test('dependency failure does not record success or continue to the build', async () => {
  const f = await fixture();
  const result = run(f, 'deploy.sh', ['--check'], { FAKE_FAIL: 'npm:ci' });
  assert.notEqual(result.status, 0);
  assert.deepEqual((await calls(f)).map((c) => c.args[0]), ['ci']);
  await assert.rejects(stat(`${f.root}/node_modules/.easynote-dependencies`), { code: 'ENOENT' });
});

test('account initialization and deployment reject non-interactive input before side effects', async () => {
  const f = await fixture({ configured: false });
  for (const name of ['setup.sh', 'deploy.sh', 'dev.sh']) {
    const result = run(f, name, name === 'dev.sh' ? ['--port', '18791'] : []);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /interactive terminal/i);
  }
  assert.deepEqual(await calls(f), []);
});

test('local startup validates configuration and respects an explicit free port', async () => {
  const f = await fixture();
  await dependencies(f);
  const result = run(f, 'dev.sh', ['--port', '18793']);
  assert.equal(result.status, 0, result.stderr);
  const recorded = await calls(f);
  assert.equal(recorded.filter((c) => c.tool === 'npm' && c.args[0] === 'ci').length, 0);
  assert.deepEqual(recorded.filter((c) => c.tool === 'wrangler').map((c) => c.args), [
    ['d1', 'migrations', 'apply', 'DB', '--local'],
    ['dev', '--ip', '127.0.0.1', '--port', '18793', '--var', 'ALLOW_LOCAL_HTTP:true'],
  ]);
  assert.equal(await readFile(`${f.root}/.dev.vars`, 'utf8'), localConfig);
});

test('busy or invalid ports fail without killing the listener or installing dependencies', async () => {
  const f = await fixture();
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const busy = run(f, 'dev.sh', ['--port', String(port)]);
    assert.notEqual(busy.status, 0);
    assert.match(busy.stderr, /is in use/);
    assert.ok(server.listening);
    for (const value of ['abc', '0', '1023', '65536']) {
      const invalid = run(f, 'dev.sh', ['--port', value]);
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /--port must/);
    }
    assert.deepEqual(await calls(f), []);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('invalid local config is never replaced and blocks migrations', async () => {
  const f = await fixture();
  await dependencies(f);
  const invalid = 'INITIAL_OWNER="not-json"\nCUSTOM_SETTING=keep\n';
  await writeFile(`${f.root}/.dev.vars`, invalid);
  const result = run(f, 'dev.sh', ['--port', '18793']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /will not be overwritten/);
  assert.equal(await readFile(`${f.root}/.dev.vars`, 'utf8'), invalid);
  assert.deepEqual(await calls(f), []);
});

test('interactive setup hides the password, stores only a verifier and preserves an existing config', async () => {
  const f = await fixture({ configured: false });
  await dependencies(f);
  const first = await terminal(f, 'setup.sh', [], setupSteps);
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /Ready\. Start EasyNote/);
  assert.ok(!first.output.includes(secret));
  const content = await readFile(`${f.root}/.dev.vars`, 'utf8');
  const parsed = JSON.parse(parseEnv(content).INITIAL_OWNER);
  assert.equal(parsed.username, 'test-owner');
  assert.match(parsed.verifier.proof, /^[a-f0-9]{64}$/);
  assert.ok(!content.includes(secret));
  assert.equal((await stat(`${f.root}/.dev.vars`)).mode & 0o777, 0o600);
  const second = await terminal(f, 'setup.sh');
  assert.match(second.output, /already exists; preserved/);
  assert.ok(!second.output.includes('Owner password'));
  assert.equal(await readFile(`${f.root}/.dev.vars`, 'utf8'), content);
});

test('first local startup initializes an account and then launches without a second command', async () => {
  const f = await fixture({ configured: false });
  await dependencies(f);
  const result = await terminal(f, 'dev.sh', ['--port', '18793'], setupSteps);
  assert.match(result.output, /Starting http:\/\/127.0.0.1:18793/);
  assert.ok((await calls(f)).some((c) => c.tool === 'wrangler' && c.args[0] === 'dev'));
});

test('deployment cancellation makes no cloud calls and does not write a new resource config', async () => {
  const f = await fixture();
  await dependencies(f);
  const result = await terminal(f, 'deploy.sh', [], [
    ['Existing D1 database UUID (create easynote-db in Cloudflare first): ', databaseId],
    ['Existing R2 bucket name: ', 'easynote-test-images'],
    ['Worker name [easynote]: ', 'easynote-test'],
    ['Type deploy easynote to apply migrations and deploy: ', 'cancel'],
  ]);
  assert.match(result.output, /Deployment cancelled/);
  assert.equal((await calls(f)).filter((c) => c.tool === 'wrangler').length, 0);
  await assert.rejects(stat(`${f.root}/wrangler.deploy.json`), { code: 'ENOENT' });
});

test('deployment reuses resource IDs, refreshes template settings and preserves a remote owner secret', async () => {
  const f = await fixture();
  await dependencies(f);
  const config = JSON.parse(await readFile(`${f.root}/wrangler.json`, 'utf8'));
  const original = { ...config, name: 'easynote-saved', account_id: 'a'.repeat(32), vars: { ...config.vars, AUTOSAVE_MS: '2000' } };
  original.d1_databases[0].database_id = databaseId;
  original.r2_buckets[0].bucket_name = 'easynote-saved-images';
  await writeFile(`${f.root}/wrangler.deploy.json`, JSON.stringify(original));
  const result = await terminal(f, 'deploy.sh', [], [
    ['Reuse these deployment resources? [Y/n]: ', ''],
    ['Type deploy easynote to apply migrations and deploy: ', 'deploy easynote'],
  ]);
  assert.match(result.output, /Remote owner verifier already exists/);
  assert.match(result.output, /Deployment complete/);
  assert.ok(!result.output.includes('Owner password'));
  const saved = JSON.parse(await readFile(`${f.root}/wrangler.deploy.json`, 'utf8'));
  assert.equal(saved.name, original.name);
  assert.equal(saved.account_id, original.account_id);
  assert.equal(saved.vars.AUTOSAVE_MS, config.vars.AUTOSAVE_MS);
  assert.equal(saved.vars.ALLOW_LOCAL_HTTP, 'false');
  assert.equal(saved.d1_databases[0].database_id, databaseId);
  assert.deepEqual((await calls(f)).filter((c) => c.tool === 'wrangler').map((c) => c.args.slice(0, 2)), [
    ['login'], ['d1', 'migrations'], ['deploy', '--config'], ['secret', 'list'],
  ]);
});

test('new deployments initialize only a missing owner secret, never storing plaintext credentials', async () => {
  const f = await fixture();
  await dependencies(f);
  const result = await terminal(f, 'deploy.sh', [], [
    ['Existing D1 database UUID (create easynote-db in Cloudflare first): ', databaseId],
    ['Existing R2 bucket name: ', 'easynote-test-images'],
    ['Worker name [easynote]: ', 'easynote-test'],
    ['Type deploy easynote to apply migrations and deploy: ', 'deploy easynote'],
    ...setupSteps,
  ], { FAKE_SECRETS: '[]' });
  assert.match(result.output, /Owner verifier installed/);
  assert.ok(!result.output.includes(secret));
  const installed = await readFile(`${f.root}/installed-owner.json`, 'utf8');
  assert.equal(JSON.parse(installed).username, 'test-owner');
  assert.ok(!installed.includes(secret));
  assert.equal(await readFile(`${f.root}/.dev.vars`, 'utf8'), localConfig);
});

test('credential environment aliases are rejected and build failure stops deployment before login', async () => {
  const f = await fixture();
  await dependencies(f);
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_TOKEN', 'CF_API_KEY']) {
    const result = await terminal(f, 'deploy.sh', [], [], { [key]: 'test-only-token' });
    assert.match(result.output, /Environment credentials are not accepted/);
  }
  const result = await terminal(f, 'deploy.sh', [], [], { FAKE_FAIL: 'npm:run' });
  assert.ok(!result.output.includes('Existing D1'));
  assert.equal((await calls(f)).filter((c) => c.tool === 'wrangler').length, 0);
});

test('invalid persisted resource IDs fail closed and leave configuration unchanged', async () => {
  const f = await fixture();
  await dependencies(f);
  const invalid = '{"name":"easynote","d1_databases":[]}';
  await writeFile(`${f.root}/wrangler.deploy.json`, invalid);
  const result = await terminal(f, 'deploy.sh');
  assert.match(result.output, /real D1 database UUID is required/);
  assert.equal(await readFile(`${f.root}/wrangler.deploy.json`, 'utf8'), invalid);
  assert.equal((await calls(f)).filter((c) => c.tool === 'wrangler').length, 0);
});

test('the generated local account works through a real Wrangler server and local D1', async () => {
  const f = await fixture({ configured: false });
  await dependencies(f);
  const initialized = await terminal(f, 'setup.sh', [], setupSteps);
  assert.equal(initialized.status, 0, initialized.output);
  await cp(`${project}/src`, `${f.root}/src`, { recursive: true });
  await cp(`${project}/migrations`, `${f.root}/migrations`, { recursive: true });
  await mkdir(`${f.root}/dist/client`, { recursive: true });
  await cp(`${project}/index.html`, `${f.root}/dist/client/index.html`);
  await symlink(`${project}/node_modules/image-dimensions`, `${f.root}/node_modules/image-dimensions`);
  await writeFile(`${f.root}/node_modules/.bin/wrangler`,
    `#!/bin/bash\nexec ${shellQuote(process.execPath)} ${shellQuote(`${project}/node_modules/wrangler/bin/wrangler.js`)} "$@"\n`, { mode: 0o755 });
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn('/bin/bash', [`${f.root}/dev.sh`, '--port', String(port)], {
    cwd: project, env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise((resolve) => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Local startup timed out:\n${output}`)), 30000);
      const receive = (chunk) => {
        output += chunk;
        if (output.includes(`Ready on http://127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(new Error(`Server exited before readiness:\n${output}`)); });
    });
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/api/login`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test-owner', password: secret }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).user.username, 'test-owner');
    assert.ok(!output.includes(secret));
  } finally {
    child.kill('SIGINT');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
  }
});
