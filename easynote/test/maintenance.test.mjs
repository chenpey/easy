import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const project = resolve(new URL('..', import.meta.url).pathname);
const maintenance = join(project, 'scripts/maintenance.mjs');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function migrationsFixture() {
  const directory = join(project, 'migrations');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const hash = createHash('sha256');
  const contents = [];
  for (const name of names) {
    const bytes = await readFile(join(directory, name));
    hash.update(name).update('\0').update(bytes).update('\0');
    contents.push(bytes);
  }
  return { bytes: Buffer.concat(contents.flatMap((bytes) => [bytes, Buffer.from('\n')])), sha256: hash.digest('hex') };
}

function run(args) {
  return spawnSync(process.execPath, [maintenance, ...args], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
}

test('maintenance help and shell entry points are available', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /backup --local\|--remote/);
  for (const script of ['backup.sh', 'restore.sh', 'reset-password.sh']) {
    const result = spawnSync('/bin/bash', [join(project, script), '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
});

test('offline verification accepts a complete manifest and rejects tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easynote-backup-test-'));
  try {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const fileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const object = Buffer.from('verified object bytes');
    await mkdir(join(directory, 'objects', userId), { recursive: true });
    await writeFile(join(directory, 'objects', userId, fileId), object);
    const migrations = await migrationsFixture();
    const database = Buffer.concat([migrations.bytes, Buffer.from(
      `\nINSERT INTO "images" ("id","user_id","filename","mime","size","width","height","sha256","status","created_at","last_used_at") VALUES('${fileId}','${userId}','test.txt','text/plain',${object.length},0,0,'${sha256(object)}','ready',1,1);\n`,
    )]);
    const databaseSha256 = sha256(database);
    await writeFile(join(directory, 'database.sql'), database);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({
      format: 'easynote-disaster-recovery',
      version: 1,
      createdAt: new Date(0).toISOString(),
      mode: 'local',
      database: { file: 'database.sql', size: database.length, sha256: databaseSha256 },
      migrationsSha256: migrations.sha256,
      objects: [{
        id: fileId,
        key: `${userId}/${fileId}`,
        mime: 'text/plain',
        size: object.length,
        sha256: sha256(object),
        path: `objects/${userId}/${fileId}`,
      }],
    }));
    const valid = run(['verify', directory]);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /Backup verified: 1 R2 objects/);

    await writeFile(join(directory, 'database.sql'), Buffer.concat([database, Buffer.from('\n-- tampered\n')]));
    const invalid = run(['verify', directory]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /checksum/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup creation exports D1 and verifies every referenced R2 object', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easynote-backup-create-'));
  try {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const fileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const object = Buffer.from('object downloaded from fake R2');
    const migrations = await migrationsFixture();
    const database = Buffer.concat([migrations.bytes, Buffer.from(
      `\nINSERT INTO "images" ("id","user_id","filename","mime","size","width","height","sha256","status","created_at","last_used_at") VALUES('${fileId}','${userId}','test.txt','text/plain',${object.length},0,0,'${sha256(object)}','ready',1,1);\n`,
    )]);
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'migrations'));
    await mkdir(join(directory, 'node_modules/wrangler/bin'), { recursive: true });
    await writeFile(join(directory, 'scripts/maintenance.mjs'), await readFile(maintenance));
    for (const name of (await readdir(join(project, 'migrations'))).filter((value) => value.endsWith('.sql'))) {
      await writeFile(join(directory, 'migrations', name), await readFile(join(project, 'migrations', name)));
    }
    await writeFile(join(directory, 'wrangler.json'), JSON.stringify({
      d1_databases: [{ binding: 'DB', database_name: 'test-db' }],
      r2_buckets: [{ binding: 'IMAGES', bucket_name: 'test-files' }],
    }));
    await writeFile(join(directory, 'node_modules/wrangler/bin/wrangler.js'), `
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))}, JSON.stringify(args) + '\\n');
const output = args[args.indexOf('--output') + 1];
const destination = args[args.indexOf('--file') + 1];
if (args[0] === 'd1' && args[1] === 'export') {
  writeFileSync(output, Buffer.from(${JSON.stringify(database.toString('base64'))}, 'base64'));
} else if (args[0] === 'r2' && args[2] === 'get') {
  writeFileSync(destination, Buffer.from(${JSON.stringify(object.toString('base64'))}, 'base64'));
} else {
  process.exit(20);
}
`);
    const output = join(directory, 'backup');
    const result = spawnSync(process.execPath, [
      join(directory, 'scripts/maintenance.mjs'), 'backup', '--local', '--config', 'wrangler.json', '--output', output,
    ], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.database.size, database.length);
    assert.equal(manifest.objects.length, 1);
    assert.equal(manifest.objects[0].sha256, sha256(object));
    assert.deepEqual(await readFile(join(output, manifest.objects[0].path)), object);
    const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const exportCall = calls.find((args) => args[0] === 'd1' && args[1] === 'export');
    const exportedTables = exportCall.flatMap((value, index) => value === '--table' ? [exportCall[index + 1]] : []);
    assert.deepEqual(exportedTables, [
      'users', 'sessions', 'integration_tokens', 'login_attempts', 'notes',
      'note_versions', 'note_changes', 'images', 'image_refs', 'purged_notes',
    ]);
    assert.ok(!exportedTables.includes('notes_fts'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('restore preflight verifies empty D1 and missing R2 keys without writing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easynote-restore-check-'));
  try {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const fileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const object = Buffer.from('restore preflight object');
    const migrations = await migrationsFixture();
    const database = Buffer.concat([migrations.bytes, Buffer.from(
      `\nINSERT INTO "images" ("id","user_id","filename","mime","size","width","height","sha256","status","created_at","last_used_at") VALUES('${fileId}','${userId}','test.txt','text/plain',${object.length},0,0,'${sha256(object)}','ready',1,1);\n`,
    )]);
    const backup = join(directory, 'backup');
    await mkdir(join(backup, 'objects', userId), { recursive: true });
    await writeFile(join(backup, 'database.sql'), database);
    await writeFile(join(backup, 'objects', userId, fileId), object);
    await writeFile(join(backup, 'manifest.json'), JSON.stringify({
      format: 'easynote-disaster-recovery',
      version: 1,
      database: { file: 'database.sql', size: database.length, sha256: sha256(database) },
      migrationsSha256: migrations.sha256,
      objects: [{
        id: fileId, key: `${userId}/${fileId}`, mime: 'text/plain', size: object.length,
        sha256: sha256(object), path: `objects/${userId}/${fileId}`,
      }],
    }));
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'migrations'));
    await mkdir(join(directory, 'node_modules/wrangler/bin'), { recursive: true });
    await writeFile(join(directory, 'scripts/maintenance.mjs'), await readFile(maintenance));
    for (const name of (await readdir(join(project, 'migrations'))).filter((value) => value.endsWith('.sql'))) {
      await writeFile(join(directory, 'migrations', name), await readFile(join(project, 'migrations', name)));
    }
    await writeFile(join(directory, 'wrangler.json'), JSON.stringify({
      d1_databases: [{ binding: 'DB', database_name: 'test-db' }],
      r2_buckets: [{ binding: 'IMAGES', bucket_name: 'test-files' }],
    }));
    await writeFile(join(directory, 'node_modules/wrangler/bin/wrangler.js'), `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))}, JSON.stringify(args) + '\\n');
if (args[0] === 'd1' && args[1] === 'execute' && args.some((value) => value.includes('sqlite_master'))) {
  console.log(JSON.stringify([{results:${JSON.stringify([
    'users', 'sessions', 'integration_tokens', 'login_attempts', 'notes',
    'note_versions', 'note_changes', 'images', 'image_refs', 'purged_notes',
  ].map((name) => ({ name })))}}]));
} else if (args[0] === 'd1' && args[1] === 'execute') {
  console.log(JSON.stringify([{results:[{rows:process.env.NONEMPTY === '1' ? 1 : 0}]}]));
} else if (args[0] === 'r2' && args[2] === 'get') {
  console.error('The specified key does not exist.');
  process.exit(1);
} else {
  process.exit(20);
}
`);
    const command = [
      join(directory, 'scripts/maintenance.mjs'), 'restore', backup, '--check', '--local', '--config', 'wrangler.json',
    ];
    const valid = spawnSync(process.execPath, command, { cwd: directory, encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /Restore preflight passed/);
    const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.every((args) => !(args[0] === 'r2' && args[2] === 'put')));

    const nonempty = spawnSync(process.execPath, command, {
      cwd: directory, encoding: 'utf8', env: { ...process.env, NONEMPTY: '1' },
    });
    assert.notEqual(nonempty.status, 0);
    assert.match(nonempty.stderr, /not empty/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('password reset refuses non-interactive execution before changing data', () => {
  const result = run(['reset-password', '--local']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /interactive terminal/i);
});

test('interactive password recovery hides the secret and revokes sessions and tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easynote-password-reset-'));
  const password = 'Recovered-Test-Password-741!';
  try {
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'node_modules/wrangler/bin'), { recursive: true });
    await writeFile(join(directory, 'scripts/maintenance.mjs'), await readFile(maintenance));
    await writeFile(join(directory, 'wrangler.json'), JSON.stringify({
      d1_databases: [{ binding: 'DB', database_name: 'test-db' }],
      r2_buckets: [{ binding: 'IMAGES', bucket_name: 'test-files' }],
    }));
    await writeFile(join(directory, '.dev.vars'), 'INITIAL_OWNER=\'old\'\nALLOW_LOCAL_HTTP="true"\nCUSTOM_SETTING="keep"\n');
    await writeFile(join(directory, 'node_modules/wrangler/bin/wrangler.js'), `
import { copyFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--command')) {
  console.log(JSON.stringify([{results:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',username:'owner'}]}]));
} else if (args.includes('--file')) {
  copyFileSync(args[args.indexOf('--file') + 1], ${JSON.stringify(join(directory, 'applied.sql'))});
} else {
  process.exit(20);
}
`);
    const encode = (value) => `[encoding convertfrom utf-8 [binary format H* ${Buffer.from(value).toString('hex')}]]`;
    const command = [process.execPath, join(directory, 'scripts/maintenance.mjs'), 'reset-password', '--local', '--config', 'wrangler.json']
      .map(encode).join(' ');
    const script = `set timeout 10
spawn -noecho ${command}
expect -exact ${encode('New password (12-128 characters, hidden): ')} { send -- "${encode(password)}\\r" }
expect -exact ${encode('Confirm password (hidden): ')} { send -- "${encode(password)}\\r" }
expect -exact ${encode('Type reset owner to continue: ')} { send -- "${encode('reset owner')}\\r" }
expect eof
set result [wait]
exit [lindex $result 3]
`;
    const result = spawnSync('/usr/bin/expect', ['-c', script], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
    const sql = await readFile(join(directory, 'applied.sql'), 'utf8');
    assert.ok(!sql.includes(password));
    assert.match(sql, /DELETE FROM sessions/);
    assert.match(sql, /UPDATE integration_tokens SET revoked_at=/);
    const config = parseEnv(await readFile(join(directory, '.dev.vars'), 'utf8'));
    const owner = JSON.parse(config.INITIAL_OWNER);
    const key = pbkdf2Sync(password, Buffer.from(owner.verifier.salt, 'hex'), 100000, 32, 'sha256');
    assert.equal(owner.verifier.proof, createHmac('sha256', key).update('easynote/password/v1').digest('hex'));
    assert.equal(config.CUSTOM_SETTING, 'keep');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
