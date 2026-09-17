#!/usr/bin/env node
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const isoName = () => new Date().toISOString().replace(/[:.]/g, '-');
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const applicationTables = [
  'users', 'sessions', 'integration_tokens', 'login_attempts', 'account_attempts', 'app_state',
  'notes', 'note_versions', 'note_changes', 'note_shares', 'images', 'image_refs', 'purged_notes',
];

async function migrationsSha256() {
  const directory = new URL('../migrations/', import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name).update('\0').update(await readFile(new URL(name, directory))).update('\0');
  }
  return hash.digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function parseOptions(args) {
  const options = { mode: '', config: '', output: '', check: false, backup: '' };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--local' || value === '--remote') {
      if (options.mode) fail('Choose exactly one of --local or --remote.');
      options.mode = value.slice(2);
    } else if (value === '--config' || value === '--output') {
      const next = args[++index];
      if (!next) fail(`${value} requires a value.`);
      options[value.slice(2)] = next;
    } else if (value === '--check') {
      options.check = true;
    } else if (!value.startsWith('-') && !options.backup) {
      options.backup = value;
    } else {
      fail(`Unknown argument: ${value}`);
    }
  }
  return options;
}

function requireRemoteAuthorization(options) {
  if (options.mode !== 'remote') return;
  if (!process.env.CLOUDFLARE_API_TOKEN || process.env.EASYNOTE_INTERACTIVE_CLOUDFLARE !== '1' ||
      ['CLOUDFLARE_API_KEY', 'CF_API_TOKEN', 'CF_API_KEY'].some((key) => process.env[key])) {
    fail('Remote maintenance must be launched through its shell command with an interactively entered API Token.');
  }
}

function runWrangler(args, capture = false) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: `${root}/.wrangler/logs/`,
      WRANGLER_REGISTRY_PATH: `${root}/.wrangler/registry`,
      WRANGLER_SEND_METRICS: 'false',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim() : '';
    fail(`Wrangler command failed${detail ? `:\n${detail}` : '.'}`);
  }
  return capture ? String(result.stdout) : '';
}

function probeWrangler(args) {
  return spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: `${root}/.wrangler/logs/`,
      WRANGLER_REGISTRY_PATH: `${root}/.wrangler/registry`,
      WRANGLER_SEND_METRICS: 'false',
    },
  });
}

function putSecret(configPath, value) {
  const result = spawnSync(process.execPath, [wrangler, 'secret', 'put', 'INITIAL_OWNER', '--config', configPath], {
    cwd: root,
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: `${root}/.wrangler/logs/`,
      WRANGLER_REGISTRY_PATH: `${root}/.wrangler/registry`,
      WRANGLER_SEND_METRICS: 'false',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail('The password changed, but INITIAL_OWNER could not be updated. Run password recovery again.');
}

async function configFor(options) {
  const configPath = resolve(options.config || (options.mode === 'local' ? 'wrangler.json' : 'wrangler.deploy.json'));
  if (!existsSync(configPath)) fail(`Configuration file not found: ${configPath}`);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const database = config.d1_databases?.find((entry) => entry.binding === 'DB');
  const bucket = config.r2_buckets?.find((entry) => entry.binding === 'IMAGES');
  if (!database?.database_name || !bucket?.bucket_name) fail('The configuration must define DB and IMAGES bindings.');
  return { configPath, database: database.database_name, bucket: bucket.bucket_name };
}

function modeArgs(options) {
  return [options.mode === 'local' ? '--local' : '--remote'];
}

function parseSqlValues(source) {
  const values = [];
  let value = '';
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "'" && quoted && source[index + 1] === "'") {
      value += "''";
      index++;
      continue;
    }
    if (character === "'") quoted = !quoted;
    if (!quoted && character === '(') depth++;
    if (!quoted && character === ')') depth--;
    if (character === ',' && !quoted && depth === 0) {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values.map((entry) => {
    if (entry === 'NULL') return null;
    if (entry.startsWith("'") && entry.endsWith("'")) return entry.slice(1, -1).replaceAll("''", "'");
    return /^-?\d+$/.test(entry) ? Number(entry) : entry;
  });
}

async function fileMetadata(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

function objectFromInsert(line) {
  const match = /^INSERT INTO "images" \(([^)]+)\) VALUES\((.*)\);$/.exec(line);
  if (!match) return null;
  const columns = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  const values = parseSqlValues(match[2]);
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  if (row.status !== 'ready') fail(`Storage row ${row.id} is ${row.status}; run cleanup and retry the backup.`);
  if (typeof row.id !== 'string' || typeof row.user_id !== 'string' || typeof row.sha256 !== 'string' ||
      typeof row.mime !== 'string' || !Number.isSafeInteger(row.size)) fail('The D1 export contains an invalid storage row.');
  return {
    id: row.id,
    key: `${row.user_id}/${row.id}`,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    path: `objects/${row.user_id}/${row.id}`,
  };
}

async function scanDatabase(path) {
  const objects = [];
  const tables = new Set();
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of reader) {
    const table = /^CREATE TABLE(?: IF NOT EXISTS)?\s+"?([A-Za-z0-9_]+)"?/.exec(line)?.[1];
    if (table) tables.add(table);
    const object = objectFromInsert(line);
    if (object) objects.push(object);
  }
  return { objects, tables };
}

async function writeRestoreData(source, destination) {
  const included = new Set(applicationTables);
  async function* statements() {
    yield 'PRAGMA foreign_keys=ON;\n';
    const reader = createInterface({ input: createReadStream(source), crlfDelay: Infinity });
    for await (const line of reader) {
      const table = /^INSERT INTO "?([^" (]+)"?/.exec(line)?.[1];
      if (table && included.has(table)) yield `${line}\n`;
    }
  }
  await pipeline(Readable.from(statements()), createWriteStream(destination, { mode: 0o600, flags: 'wx' }));
}

async function verifyBackup(path) {
  const directory = resolve(path);
  const manifestInfo = await lstat(`${directory}/manifest.json`);
  if (!manifestInfo.isFile() || manifestInfo.size > 10 * 1024 * 1024) fail('Invalid disaster-recovery manifest file.');
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  if (manifest.format !== 'easynote-disaster-recovery' || manifest.version !== 1 ||
      !Array.isArray(manifest.objects) || typeof manifest.database?.sha256 !== 'string') {
    fail('Invalid EasyNote disaster-recovery manifest.');
  }
  const databasePath = `${directory}/database.sql`;
  const databaseInfo = await lstat(databasePath);
  if (!databaseInfo.isFile()) fail('database.sql must be a regular file.');
  const database = await fileMetadata(databasePath);
  if (database.size !== manifest.database.size || database.sha256 !== manifest.database.sha256) {
    fail('database.sql checksum does not match the manifest.');
  }
  const scanned = await scanDatabase(databasePath);
  for (const table of applicationTables) {
    if (!scanned.tables.has(table)) fail(`database.sql does not contain table ${table}.`);
  }
  const exported = new Map(scanned.objects.map((entry) => [entry.key, entry]));
  if (exported.size !== manifest.objects.length) fail('R2 object count does not match the D1 export.');
  for (const object of manifest.objects) {
    const expected = exported.get(object.key);
    if (!expected || expected.sha256 !== object.sha256 || expected.size !== object.size ||
        object.path !== expected.path) fail(`Manifest metadata mismatch for ${object.key}.`);
    const objectPath = `${directory}/${object.path}`;
    const info = await lstat(objectPath);
    if (!info.isFile()) fail(`R2 object backup must be a regular file: ${object.key}.`);
    const actual = await fileMetadata(objectPath);
    if (actual.size !== object.size || actual.sha256 !== object.sha256) fail(`R2 object checksum mismatch for ${object.key}.`);
  }
  if (manifest.migrationsSha256 !== await migrationsSha256()) {
    fail('Backup schema differs from the current EasyNote migrations.');
  }
  return { directory, manifest, databasePath };
}

async function createBackup(options) {
  if (!options.mode) fail('Backup mode is required.');
  const config = await configFor(options);
  const output = resolve(options.output || `backups/easynote-${isoName()}`);
  if (existsSync(output)) fail(`Backup destination already exists: ${output}`);
  const partial = `${output}.partial-${process.pid}`;
  await mkdir(`${partial}/objects`, { recursive: true, mode: 0o700 });
  await chmod(partial, 0o700);
  try {
    const databasePath = `${partial}/database.sql`;
    const tables = applicationTables.flatMap((name) => ['--table', name]);
    runWrangler([
      'd1', 'export', 'DB', ...modeArgs(options), '--output', databasePath,
      ...tables, '--config', config.configPath, '-y',
    ]);
    await chmod(databasePath, 0o600);
    const scanned = await scanDatabase(databasePath);
    for (const table of applicationTables) {
      if (!scanned.tables.has(table)) fail(`D1 export does not contain table ${table}. Apply all migrations before backing up.`);
    }
    const objects = scanned.objects;
    for (const [index, object] of objects.entries()) {
      const destination = `${partial}/${object.path}`;
      await mkdir(dirname(destination), { recursive: true });
      runWrangler(['r2', 'object', 'get', `${config.bucket}/${object.key}`, ...modeArgs(options), '--file', destination, '--config', config.configPath]);
      await chmod(destination, 0o600);
      const actual = await fileMetadata(destination);
      if (actual.size !== object.size || actual.sha256 !== object.sha256) fail(`R2 verification failed for ${object.key}.`);
      process.stdout.write(`Verified R2 object ${index + 1}/${objects.length}\n`);
    }
    const manifest = {
      format: 'easynote-disaster-recovery',
      version: 1,
      createdAt: new Date().toISOString(),
      mode: options.mode,
      database: { file: 'database.sql', ...await fileMetadata(databasePath) },
      migrationsSha256: await migrationsSha256(),
      objects,
    };
    await writeFile(`${partial}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(partial, output);
    await chmod(output, 0o700);
    process.stdout.write(`Backup verified: ${output}\n`);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

function parseWranglerJson(output) {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
  const match = /(?:^|\n)(\[[\s\S]*)$/.exec(clean.trim());
  if (!match) fail('Wrangler did not return JSON.');
  return JSON.parse(match[1]);
}

async function assertR2TargetsEmpty(options, config, objects) {
  const directory = resolve(`.wrangler/restore-preflight-${process.pid}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    for (const [index, object] of objects.entries()) {
      const destination = `${directory}/${index}`;
      const result = probeWrangler([
        'r2', 'object', 'get', `${config.bucket}/${object.key}`, ...modeArgs(options),
        '--file', destination, '--config', config.configPath,
      ]);
      if (result.error) throw result.error;
      if (result.status === 0) fail(`Target R2 already contains ${object.key}. Restore is refused.`);
      const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      if (!/specified key does not exist|not found|NoSuchKey|status.?404/i.test(detail)) {
        fail(`Unable to verify target R2 key ${object.key}:\n${detail.trim()}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function targetState(options, config) {
  const namesSql = applicationTables.map((name) => sqlString(name)).join(',');
  const query = `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${namesSql});`;
  const output = runWrangler(['d1', 'execute', 'DB', ...modeArgs(options), '--command', query, '--config', config.configPath, '--json'], true);
  const response = parseWranglerJson(output);
  const names = response.flatMap((entry) => entry.results ?? []).map((entry) => entry.name);
  if (!names.length) return { schema: false, rows: 0 };
  if (!applicationTables.every((name) => names.includes(name))) fail('Target D1 schema is incomplete.');
  const countSql = applicationTables.map((name) => `(SELECT COUNT(*) FROM ${name})`).join('+');
  const countsOutput = runWrangler([
    'd1', 'execute', 'DB', ...modeArgs(options),
    '--command', `SELECT ${countSql} AS rows;`,
    '--config', config.configPath, '--json',
  ], true);
  const counts = parseWranglerJson(countsOutput);
  return { schema: true, rows: Number(counts[0]?.results?.[0]?.rows ?? -1) };
}

async function restoreBackup(options) {
  if (!options.mode || !options.backup) fail('Restore mode and backup directory are required.');
  const verified = await verifyBackup(options.backup);
  const config = await configFor(options);
  const state = await targetState(options, config);
  if (state.rows > 0) fail('Target D1 is not empty. Restore is refused.');
  await assertR2TargetsEmpty(options, config, verified.manifest.objects);
  process.stdout.write(`Backup verified: ${verified.manifest.objects.length} R2 objects.\n`);
  process.stdout.write(`Target D1: ${state.schema ? 'empty schema' : 'new database without schema'}.\n`);
  if (options.check) {
    process.stdout.write('Restore preflight passed. No data was changed.\n');
    return;
  }
  if (!state.schema) {
    runWrangler(['d1', 'migrations', 'apply', 'DB', ...modeArgs(options), '--config', config.configPath]);
  }
  const targetAfterMigration = await targetState(options, config);
  if (targetAfterMigration.rows !== 0) fail('Target D1 changed during restore preparation.');
  for (const [index, object] of verified.manifest.objects.entries()) {
    runWrangler([
      'r2', 'object', 'put', `${config.bucket}/${object.key}`, ...modeArgs(options),
      '--file', `${verified.directory}/${object.path}`, '--content-type', object.mime, '--force', '--config', config.configPath,
    ]);
    process.stdout.write(`Restored R2 object ${index + 1}/${verified.manifest.objects.length}\n`);
  }
  const restoreSql = resolve(`.wrangler/restore-${process.pid}.sql`);
  await mkdir(dirname(restoreSql), { recursive: true });
  try {
    await writeRestoreData(verified.databasePath, restoreSql);
    runWrangler(['d1', 'execute', 'DB', ...modeArgs(options), '--file', restoreSql, '--config', config.configPath, '-y']);
  } finally {
    await rm(restoreSql, { force: true });
  }
  process.stdout.write('Restore completed. Change the account password before normal use.\n');
}

function terminalReader() {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  return {
    reader,
    async ask(label, secret = false) {
      if (secret) { process.stdout.write(label); muted = true; }
      try { return (await reader.question(secret ? '' : label)).trim(); }
      finally { if (secret) { muted = false; process.stdout.write('\n'); } }
    },
  };
}

async function resetPassword(options) {
  if (!options.mode) fail('Reset mode is required.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('An interactive terminal is required for password recovery.');
  const config = await configFor(options);
  const output = runWrangler([
    'd1', 'execute', 'DB', ...modeArgs(options),
    '--command', 'SELECT id,username,role FROM users WHERE deletion_requested_at IS NULL ORDER BY created_at,id;',
    '--config', config.configPath, '--json',
  ], true);
  const users = parseWranglerJson(output).flatMap((entry) => entry.results ?? []);
  if (!users.length || users.some((user) => typeof user.id !== 'string' || typeof user.username !== 'string')) {
    fail('Password recovery requires at least one initialized account.');
  }
  const io = terminalReader();
  try {
    let user = users[0];
    if (users.length > 1) {
      process.stdout.write(`Accounts: ${users.map((entry) => entry.username).join(', ')}\n`);
      const username = (await io.ask('Username to reset: ')).toLowerCase();
      user = users.find((entry) => entry.username === username);
      if (!user) fail('Account not found.');
    }
    const password = await io.ask('New password (12-128 characters, hidden): ', true);
    if (password.length < 12 || password.length > 128) fail('Password must be 12-128 characters.');
    if (password !== await io.ask('Confirm password (hidden): ', true)) fail('Passwords do not match.');
    const confirmation = await io.ask(`Type reset ${user.username} to continue: `);
    if (confirmation !== `reset ${user.username}`) fail('Password reset cancelled.');
    const salt = randomBytes(32).toString('hex');
    const key = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256');
    const proof = createHmac('sha256', key).update('easynote/password/v1').digest('hex');
    const verifier = JSON.stringify({ salt, proof });
    const owner = JSON.stringify({ username: user.username, verifier: { salt, proof } });
    const sqlPath = resolve(`.wrangler/reset-password-${process.pid}.sql`);
    await mkdir(dirname(sqlPath), { recursive: true });
    try {
      await writeFile(sqlPath, [
        `UPDATE users SET password_verifier=${sqlString(verifier)},recovery_code_hash=NULL,recovery_code_created_at=NULL,updated_at=${Date.now()} WHERE id=${sqlString(user.id)};`,
        `DELETE FROM sessions WHERE user_id=${sqlString(user.id)};`,
        `UPDATE integration_tokens SET revoked_at=${Date.now()} WHERE user_id=${sqlString(user.id)} AND revoked_at IS NULL;`,
      ].join('\n'), { mode: 0o600 });
      runWrangler(['d1', 'execute', 'DB', ...modeArgs(options), '--file', sqlPath, '--config', config.configPath, '-y']);
    } finally {
      await rm(sqlPath, { force: true });
    }
    const initialAccount = user.id === users[0].id;
    if (options.mode === 'remote' && initialAccount) {
      putSecret(config.configPath, owner);
    } else if (options.mode === 'local' && initialAccount) {
      const localPath = resolve('.dev.vars');
      const existing = existsSync(localPath) ? await readFile(localPath, 'utf8') : '';
      const line = `INITIAL_OWNER='${owner}'`;
      const next = !existing
        ? `${line}\nALLOW_LOCAL_HTTP="true"\n`
        : /^INITIAL_OWNER=.*$/m.test(existing)
        ? existing.replace(/^INITIAL_OWNER=.*$/m, line)
        : `${existing.replace(/\s*$/, '\n')}${line}\n`;
      await writeFile(localPath, next, { mode: 0o600 });
      await chmod(localPath, 0o600);
    }
    process.stdout.write('Password reset complete. All browser sessions and AI tokens were revoked.\n');
  } finally {
    io.reader.close();
  }
}

const help = `EasyNote maintenance

Usage:
  node scripts/maintenance.mjs backup --local|--remote [--config PATH] [--output DIR]
  node scripts/maintenance.mjs verify BACKUP_DIR
  node scripts/maintenance.mjs restore BACKUP_DIR --check --local|--remote [--config PATH]
  node scripts/maintenance.mjs restore BACKUP_DIR --local|--remote [--config PATH]
  node scripts/maintenance.mjs reset-password --local|--remote [--config PATH]
`;

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(help);
    return;
  }
  const options = parseOptions(args);
  requireRemoteAuthorization(options);
  if (command === 'backup') return createBackup(options);
  if (command === 'verify') {
    if (!options.backup) fail('Backup directory is required.');
    const result = await verifyBackup(options.backup);
    process.stdout.write(`Backup verified: ${result.manifest.objects.length} R2 objects.\n`);
    return;
  }
  if (command === 'restore') return restoreBackup(options);
  if (command === 'reset-password') return resetPassword(options);
  fail(`Unknown command: ${command}\n\n${help}`);
}

await main().catch((error) => {
  process.stderr.write(`EasyNote: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
