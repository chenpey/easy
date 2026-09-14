import { chmod, readFile, writeFile } from 'node:fs/promises';

const target = new URL('../wrangler.deploy.json', import.meta.url);
const args = process.argv.slice(2);
const mode = args[0]?.startsWith('--') ? args.shift() : '';
if (!['', '--show', '--reuse', '--validate'].includes(mode)) throw new Error('Invalid deployment configuration command.');
let id, bucket, name, accountId;
if (mode === '--show' || mode === '--reuse') {
  if (args.length) throw new Error('Unexpected arguments.');
  const saved = JSON.parse(await readFile(target, 'utf8'));
  id = saved.d1_databases?.find((entry) => entry.binding === 'DB')?.database_id;
  bucket = saved.r2_buckets?.find((entry) => entry.binding === 'IMAGES')?.bucket_name;
  name = saved.name;
  accountId = saved.account_id;
  if (accountId !== undefined && !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('Invalid saved Cloudflare account ID.');
} else {
  if (args.length !== 3) throw new Error('Expected database UUID, bucket name and Worker name.');
  [id, bucket, name] = args;
}
if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    id === '00000000-0000-0000-0000-000000000000') throw new Error('A real D1 database UUID is required.');
if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid R2 bucket name.');
if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) throw new Error('Invalid Worker name.');
if (mode === '--show') {
  console.log(`Worker: ${name}\nD1:     ${id}\nR2:     ${bucket}${accountId ? `\nAccount: ${accountId}` : ''}`);
} else if (mode !== '--validate') {
  const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
  config.name = name;
  config.d1_databases.find((entry) => entry.binding === 'DB').database_id = id;
  config.r2_buckets.find((entry) => entry.binding === 'IMAGES').bucket_name = bucket;
  if (accountId) config.account_id = accountId;
  config.vars.ALLOW_LOCAL_HTTP = 'false';
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
}
