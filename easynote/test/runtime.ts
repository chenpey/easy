import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { passwordVerifier } from '../src/worker/auth';
import { digest } from '../src/worker/core';

export const testPassword = 'Test-only-EasyNote-938!';
export const testToken = 'a'.repeat(64);
export const testCsrf = 'b'.repeat(64);
export const testUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
  const schema = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  await db.batch(schema.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
  await db.prepare('INSERT INTO users VALUES(?,?,?,?)').bind(testUserId, 'tester', JSON.stringify(verifier), Date.now()).run();
  await db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(testToken), testUserId, testCsrf, Date.now() + 86400_000).run();
  return { runtime, db, bucket: await runtime.getR2Bucket('IMAGES') };
}
