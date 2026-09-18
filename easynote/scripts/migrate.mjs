import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const [mode = '--local', ...rest] = process.argv.slice(2);
const migrationSql = `
CREATE TABLE note_shares_v2 (
  token_hash TEXT PRIMARY KEY,
  note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
INSERT INTO note_shares_v2(token_hash,note_id,expires_at,created_at)
SELECT token_hash,note_id,expires_at,created_at FROM note_shares;
DROP TABLE note_shares;
ALTER TABLE note_shares_v2 RENAME TO note_shares;
CREATE INDEX note_shares_expiry ON note_shares(expires_at);
`.trim();

function fail(message) {
  console.error(`Migration failed: ${message}`);
  process.exit(1);
}

if (mode === '--help') {
  console.log('Usage: npm run migrate -- [--local|--remote]');
  process.exit(0);
}

if (!['--local', '--remote'].includes(mode) || rest.length) {
  console.error('Usage: npm run migrate -- [--local|--remote]');
  process.exit(1);
}

let cloudflareToken = '';
if (mode === '--remote') {
  if (['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_TOKEN', 'CF_API_KEY']
      .some((name) => process.env[name])) {
    fail('Environment credentials are not accepted. Enter the API token interactively.');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('Remote migration requires an interactive terminal.');
  }
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write('Cloudflare API token (hidden, used only for this migration): ');
  cloudflareToken = await new Promise((resolve) => terminal.question('', resolve));
  terminal.close();
  process.stdout.write('\n');
  if (!cloudflareToken) fail('A Cloudflare API token is required.');
}

const config = mode === '--remote' ? 'wrangler.deploy.json' : 'wrangler.json';
const result = spawnSync(process.execPath, [
  wrangler,
  'd1',
  'execute',
  'DB',
  mode,
  '--command',
  migrationSql,
  '--config',
  config,
], {
  cwd: root,
  env: {
    ...process.env,
    ...(cloudflareToken ? { CLOUDFLARE_API_TOKEN: cloudflareToken } : {}),
    WRANGLER_LOG_PATH: `${root}.wrangler/logs/`,
    WRANGLER_SEND_METRICS: 'false',
  },
  stdio: 'inherit',
});

if (result.error) fail(result.error.message);
process.exitCode = result.status ?? 1;
