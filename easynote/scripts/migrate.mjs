import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const [mode = '--local', ...rest] = process.argv.slice(2);

if (mode === '--help') {
  console.log('Usage: npm run migrate -- [--local|--remote]');
  process.exit(0);
}

if (!['--local', '--remote'].includes(mode) || rest.length) {
  console.error('Usage: npm run migrate -- [--local|--remote]');
  process.exit(1);
}

const config = mode === '--remote' ? 'wrangler.deploy.json' : 'wrangler.json';
const result = spawnSync(process.execPath, [
  wrangler,
  'd1',
  'migrations',
  'apply',
  'DB',
  mode,
  '--config',
  config,
], {
  cwd: root,
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: `${root}.wrangler/logs/`,
    WRANGLER_SEND_METRICS: 'false',
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
