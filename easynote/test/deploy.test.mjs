import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  createCloudflareClient,
  deploymentConfig,
  inspectDeployment,
  provisionDeployment,
  selectAccount,
  validateWorkersSubdomain,
} from '../scripts/cloudflare.mjs';

const accountId = 'a'.repeat(32);
const databaseId = '12345678-1234-4234-8234-123456789abc';
const template = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url)));
let server;
let api;
let requests;
let accounts;
let database;
let bucket;
let settings;
let workersSubdomain;
let publicBucket;
let failR2;

before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: request.method, path: url.pathname, body });
    assert.equal(request.headers.authorization, 'Bearer local-test-token');
    const reply = (result, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(status < 400
        ? { success: true, result }
        : { success: false, errors: [{ code: status, message: result }] }));
    };

    if (url.pathname === '/accounts') return reply(accounts);
    if (url.pathname.endsWith('/workers/subdomain')) {
      if (request.method === 'PUT') {
        workersSubdomain = body.subdomain;
        return reply({ subdomain: workersSubdomain });
      }
      return workersSubdomain ? reply({ subdomain: workersSubdomain }) : reply('Subdomain not found', 404);
    }
    if (url.pathname.endsWith('/settings')) {
      return settings ? reply(settings) : reply('Worker not found', 404);
    }
    if (url.pathname.endsWith('/d1/database')) {
      if (request.method === 'GET') return reply(database ? [database] : []);
      database = { uuid: databaseId, name: body.name };
      return reply(database);
    }
    if (url.pathname.includes('/d1/database/')) return reply(database);
    if (url.pathname.endsWith('/domains/managed')) return reply({ enabled: publicBucket });
    if (url.pathname.endsWith('/domains/custom')) return reply({ domains: [] });
    if (url.pathname.endsWith('/r2/buckets') && request.method === 'POST') {
      if (failR2) return reply('R2 subscription is required', 403);
      bucket = { name: body.name };
      return reply(bucket);
    }
    if (url.pathname.includes('/r2/buckets/')) {
      if (failR2) return reply('R2 subscription is required', 403);
      return bucket ? reply(bucket) : reply('Bucket not found', 404);
    }
    return reply('Unknown route', 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  api = createCloudflareClient('local-test-token', {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  accounts = [{ id: accountId, name: 'Personal' }];
  database = null;
  bucket = null;
  settings = null;
  workersSubdomain = 'personal-notes';
  publicBucket = false;
  failR2 = false;
});

test('account discovery selects one account and requires an explicit choice for multiple accounts', async () => {
  assert.equal(await selectAccount(api, '', () => {
    throw new Error('Must not prompt for one account.');
  }, () => {}), accountId);
  accounts.push({ id: 'b'.repeat(32), name: 'Team' });
  assert.equal(await selectAccount(api, '', async () => '2', () => {}), 'b'.repeat(32));
  await assert.rejects(selectAccount(api, '', async () => 'invalid', () => {}), /Invalid Cloudflare account selection/);
});

test('first deployment creates D1, private R2 and a missing workers.dev subdomain', async () => {
  workersSubdomain = '';
  const config = deploymentConfig(template, null, accountId, 'easynote-test');
  const inspection = await inspectDeployment(api, config, null);
  assert.equal(inspection.foundDatabase, null);
  assert.equal(inspection.foundBucket, null);
  assert.equal(inspection.workersSubdomain, '');
  const saves = [];
  const url = await provisionDeployment(
    api,
    config,
    inspection,
    'personal-notes',
    async (value) => saves.push(structuredClone(value)),
  );
  assert.equal(url, 'https://easynote-test.personal-notes.workers.dev');
  assert.equal(config.d1_databases[0].database_id, databaseId);
  assert.equal(saves[0].d1_databases[0].database_id, databaseId);
  assert.deepEqual(
    requests.filter((request) => ['POST', 'PUT'].includes(request.method))
      .map((request) => [request.method, request.path]),
    [
      ['POST', `/accounts/${accountId}/d1/database`],
      ['POST', `/accounts/${accountId}/r2/buckets`],
      ['PUT', `/accounts/${accountId}/workers/subdomain`],
    ],
  );
});

test('existing dedicated resources are adopted once and reused without writes later', async () => {
  database = { uuid: databaseId, name: 'easynote-db' };
  bucket = { name: 'easynote-images' };
  const config = deploymentConfig(template, null, accountId, 'easynote-test');
  const inspection = await inspectDeployment(api, config, null);
  assert.equal(inspection.adoptingDatabase, true);
  assert.equal(inspection.adoptingBucket, true);
  await provisionDeployment(api, config, inspection, workersSubdomain, async () => {});

  settings = {
    bindings: [
      { name: 'DB', type: 'd1', id: databaseId },
      { name: 'IMAGES', type: 'r2_bucket', bucket_name: bucket.name },
    ],
  };
  requests = [];
  database.name = 'legacy-notes';
  const repeated = deploymentConfig(template, config, accountId, config.name);
  const repeatedInspection = await inspectDeployment(api, repeated, config);
  assert.equal(repeated.d1_databases[0].database_name, 'legacy-notes');
  await provisionDeployment(
    api,
    repeated,
    repeatedInspection,
    workersSubdomain,
    async () => {},
  );
  assert.ok(requests.every((request) => request.method === 'GET'));
});

test('a partial R2 failure preserves the newly-created D1 identity', async () => {
  const config = deploymentConfig(template, null, accountId, 'easynote-test');
  const inspection = await inspectDeployment(api, config, null);
  failR2 = true;
  let saved;
  await assert.rejects(
    provisionDeployment(api, config, inspection, workersSubdomain, async (value) => {
      saved = structuredClone(value);
    }),
    /R2 is not enabled[\s\S]*POST .*r2\/buckets[\s\S]*HTTP 403/,
  );
  assert.equal(saved.d1_databases[0].database_id, databaseId);
});

test('public R2 and an unrelated existing Worker are rejected before writes', async () => {
  bucket = { name: 'easynote-images' };
  publicBucket = true;
  const config = deploymentConfig(template, null, accountId, 'easynote-test');
  await assert.rejects(inspectDeployment(api, config, null), /R2 public access is enabled/);
  publicBucket = false;
  settings = { bindings: [] };
  await assert.rejects(inspectDeployment(api, config, null), /already exists/);
  assert.ok(requests.every((request) => request.method === 'GET'));
});

test('saved remote bindings and identifiers are validated before deployment', async () => {
  const config = deploymentConfig(template, null, accountId, 'easynote-test');
  database = { uuid: databaseId, name: 'easynote-db' };
  bucket = { name: 'easynote-images' };
  config.d1_databases[0].database_id = databaseId;
  settings = { bindings: [] };
  await assert.rejects(inspectDeployment(api, config, config), /Remote DB binding differs/);
  assert.throws(
    () => deploymentConfig(template, { name: 'easynote-test', account_id: accountId }, accountId, 'easynote-test'),
    /real D1 database UUID/,
  );
});

test('workers.dev subdomains and API errors fail closed with actionable details', async () => {
  assert.equal(validateWorkersSubdomain('Personal-Notes'), 'personal-notes');
  assert.throws(() => validateWorkersSubdomain('-invalid'), /workers.dev subdomain/);
  failR2 = true;
  const config = deploymentConfig(template, null, accountId, 'easynote-test');
  await assert.rejects(
    inspectDeployment(api, config, null),
    /Enable R2 at https:\/\/dash\.cloudflare\.com[\s\S]*HTTP 403[\s\S]*R2 subscription is required/,
  );
});
