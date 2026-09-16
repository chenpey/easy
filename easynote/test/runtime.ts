import { readdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { passwordVerifier } from '../src/worker/auth';
import { digest } from '../src/worker/core';

export const testPassword = 'Test-only-EasyNote-938!';
export const testToken = 'a'.repeat(64);
export const testCsrf = 'b'.repeat(64);
export const testUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function migrationStatements(schema: string): string[] {
  const statements: string[] = [];
  let current = '';
  let trigger = false;
  for (const line of schema.split('\n')) {
    current += `${line}\n`;
    const trimmed = line.trim();
    if (!trigger && /^CREATE TRIGGER\b/i.test(current.trimStart())) trigger = true;
    if (trigger ? /^END;$/.test(trimmed) : trimmed.endsWith(';')) {
      statements.push(current.trim());
      current = '';
      trigger = false;
    }
  }
  if (current.trim()) throw new Error('Migration contains an unterminated SQL statement.');
  return statements;
}

export async function createRuntime(port?: number) {
  const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
  const bundle = await build({
    entryPoints: [new URL('../src/worker/index.ts', import.meta.url).pathname],
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:*'],
  });
  const verifier = await passwordVerifier(testPassword);
  const runtime = new Miniflare(convertV4MiniflareOptions({
    name: 'easynote-test',
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      ...config.vars, ALLOW_LOCAL_HTTP: port ? 'true' : 'false',
      INITIAL_OWNER: JSON.stringify({ username: 'tester', verifier }),
      VERSIONS_KEPT: '3',
    },
    d1Databases: ['DB'], r2Buckets: ['IMAGES'],
    host: '127.0.0.1', ...(port ? { port } : {}),
    assets: {
      directory: new URL('../dist/client', import.meta.url).pathname,
      binding: 'ASSETS', run_worker_first: true,
      routerConfig: { has_user_worker: true },
      assetConfig: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application' },
    },
  }));
  const db = await runtime.getD1Database('DB');
  const migrationsDirectory = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    const schema = await readFile(new URL(name, migrationsDirectory), 'utf8');
    await db.batch(migrationStatements(schema).map((sql) => db.prepare(sql)));
  }
  await db.batch([
    'DELETE FROM image_refs', 'DELETE FROM note_versions', 'DELETE FROM note_changes', 'DELETE FROM notes',
    'DELETE FROM sessions', 'DELETE FROM integration_tokens', 'DELETE FROM login_attempts', 'DELETE FROM images',
    'DELETE FROM purged_notes', 'DELETE FROM note_shares', 'DELETE FROM account_attempts', 'DELETE FROM users',
  ].map((sql) => db.prepare(sql)));
  const bucket = await runtime.getR2Bucket('IMAGES');
  const objects = await bucket.list();
  if (objects.objects.length) await bucket.delete(objects.objects.map((object) => object.key));
  const now = Date.now();
  await db.prepare(`INSERT OR REPLACE INTO users
    (id,username,password_verifier,created_at,role,enabled,approved_at,updated_at)
    VALUES(?,?,?,?,'admin',1,?,?)`)
    .bind(testUserId, 'tester', JSON.stringify(verifier), now, now, now).run();
  await db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)').bind(await digest(testToken), testUserId, testCsrf, Date.now() + 86400_000).run();
  return { runtime, db, bucket };
}
