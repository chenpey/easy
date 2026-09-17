const EMPTY_DATABASE = '00000000-0000-0000-0000-000000000000';

export function createCloudflareClient(token, {
  baseUrl = 'https://api.cloudflare.com/client/v4',
  fetcher = fetch,
} = {}) {
  async function call(method, path, body, { allowMissing = false } = {}) {
    let response;
    let raw;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
        redirect: 'error',
      });
      raw = await response.text();
    } catch (error) {
      throw new Error(`${method} ${path}\nNetwork error: ${error.message}`, { cause: error });
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // The complete response is included in the error below.
    }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok || data?.success !== true) {
      const error = new Error(`${method} ${path}\nHTTP ${response.status}\n${raw}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  return {
    async request(method, path, body, options) {
      return (await call(method, path, body, options))?.result ?? null;
    },
    async list(path, parameters = {}) {
      const results = [];
      for (let page = 1; page <= 1000; page += 1) {
        const query = new URLSearchParams({ ...parameters, page: String(page), per_page: '50' });
        const data = await call('GET', `${path}?${query}`);
        if (!Array.isArray(data.result)) throw new Error(`GET ${path}: Expected a result array.`);
        results.push(...data.result);
        const info = data.result_info;
        if (data.result.length < 50 ||
            info?.total_count !== undefined && results.length >= info.total_count ||
            info?.total_pages !== undefined && page >= info.total_pages) return results;
      }
      throw new Error(`GET ${path}: Pagination safety limit exceeded.`);
    },
  };
}

export async function resolvePublicHostname(hostname, fetcher = fetch) {
  const query = new URL('https://1.1.1.1/dns-query');
  query.searchParams.set('name', hostname);
  query.searchParams.set('type', 'A');
  let response;
  let raw;
  try {
    response = await fetcher(query, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    raw = await response.text();
  } catch (error) {
    throw new Error(`GET ${query}\nNetwork error: ${error.message}`, { cause: error });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // The complete response is included in the error below.
  }
  if (!response.ok || data?.Status !== 0) {
    throw new Error(`GET ${query}\nHTTP ${response.status}\n${raw}`);
  }
  return (data.Answer || [])
    .filter((answer) => answer.type === 1)
    .map((answer) => answer.data);
}

export async function selectAccount(api, savedAccountId, ask, log = console.log) {
  if (savedAccountId) return savedAccountId;
  let accounts;
  try {
    accounts = await api.list('/accounts');
  } catch (error) {
    throw new Error(
      `Cloudflare account discovery failed. Add Account Settings Read to the API Token.\n${error.message}`,
      { cause: error },
    );
  }
  if (accounts.length === 1) {
    log(`Account: ${accounts[0].name} (${accounts[0].id})`);
    return accounts[0].id;
  }
  if (!accounts.length) throw new Error('The API Token cannot access any Cloudflare account.');
  accounts.forEach((account, index) => log(`${index + 1}. ${account.name} (${account.id})`));
  const answer = (await ask('Cloudflare account number: ')).trim();
  const selected = /^[1-9]\d*$/.test(answer) ? accounts[Number(answer) - 1] : null;
  if (!selected) throw new Error('Invalid Cloudflare account selection.');
  return selected.id;
}

export async function selectDeploymentDomain(existing, ask) {
  const saved = existing?.routes?.[0]?.pattern || '';
  if (!existing) {
    return (await ask('Custom domain (blank for workers.dev): ')).trim().toLowerCase();
  }
  const current = saved || 'workers.dev';
  const answer = (await ask(
    `Custom domain [${current}] (Enter keeps it; type a hostname or workers.dev): `,
  )).trim().toLowerCase();
  if (!answer) return saved;
  return answer === 'workers.dev' ? '' : answer;
}

export function validateCustomHostname(value) {
  const hostname = value.trim().toLowerCase();
  if (hostname && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
    throw new Error('Invalid custom hostname.');
  }
  return hostname;
}

export function deploymentConfig(template, existing, accountId, workerName, domain = '') {
  if (!/^[a-f0-9]{32}$/i.test(accountId || '')) throw new Error('Invalid Cloudflare account ID.');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(workerName || '')) {
    throw new Error('Worker name must be 3-63 lowercase letters, digits or hyphens.');
  }
  const hostname = validateCustomHostname(domain);
  const templateDatabase = template.d1_databases?.find((entry) => entry.binding === 'DB');
  const templateBucket = template.r2_buckets?.find((entry) => entry.binding === 'IMAGES');
  if (!templateDatabase?.database_name || !templateBucket?.bucket_name) {
    throw new Error('wrangler.json is missing the DB or IMAGES binding.');
  }

  let databaseId = EMPTY_DATABASE;
  let databaseName = templateDatabase.database_name;
  let bucketName = templateBucket.bucket_name;
  if (existing) {
    const savedDatabase = existing.d1_databases?.find((entry) => entry.binding === 'DB');
    const savedBucket = existing.r2_buckets?.find((entry) => entry.binding === 'IMAGES');
    if (existing.account_id !== accountId || existing.name !== workerName) {
      throw new Error('Saved deployment target does not match the selected account or Worker.');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(savedDatabase?.database_id || '') ||
        savedDatabase.database_id === EMPTY_DATABASE) {
      throw new Error('A real D1 database UUID is required in wrangler.deploy.json.');
    }
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(savedBucket?.bucket_name || '')) {
      throw new Error('Invalid R2 bucket name in wrangler.deploy.json.');
    }
    databaseId = savedDatabase.database_id;
    if (typeof savedDatabase.database_name === 'string' && savedDatabase.database_name) {
      databaseName = savedDatabase.database_name;
    }
    bucketName = savedBucket.bucket_name;
  }

  const config = structuredClone(template);
  Object.assign(config, {
    name: workerName,
    account_id: accountId,
    workers_dev: !hostname,
    preview_urls: false,
  });
  delete config.routes;
  if (hostname) config.routes = [{ pattern: hostname, custom_domain: true }];
  const database = config.d1_databases.find((entry) => entry.binding === 'DB');
  database.database_name = databaseName;
  database.database_id = databaseId;
  config.r2_buckets.find((entry) => entry.binding === 'IMAGES').bucket_name = bucketName;
  if (config.vars?.ALLOW_LOCAL_HTTP !== 'false') {
    throw new Error('Production ALLOW_LOCAL_HTTP must be false.');
  }
  return config;
}

export function validateWorkersSubdomain(value) {
  const subdomain = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    throw new Error('workers.dev subdomain must be 1-63 lowercase letters, digits or hyphens.');
  }
  return subdomain;
}

async function assertBucketPrivate(api, bucketPath) {
  const [managed, custom] = await Promise.all([
    api.request('GET', `${bucketPath}/domains/managed`),
    api.request('GET', `${bucketPath}/domains/custom`),
  ]);
  if (managed?.enabled !== false || !Array.isArray(custom?.domains) ||
      custom.domains.some((domain) => domain.enabled !== false)) {
    throw new Error('R2 public access is enabled or could not be verified. Disable r2.dev and bucket custom domains first.');
  }
}

export async function inspectDeployment(api, config, existing) {
  const prefix = `/accounts/${config.account_id}`;
  const scriptPath = `${prefix}/workers/scripts/${config.name}`;
  const settings = await api.request('GET', `${scriptPath}/settings`, undefined, { allowMissing: true });
  if (settings && !existing) {
    throw new Error(`Worker ${config.name} already exists. Choose another name; it will not be overwritten.`);
  }
  if (settings) {
    const expectedBindings = [
      ['DB', 'd1', 'id', config.d1_databases.find((entry) => entry.binding === 'DB').database_id],
      ['IMAGES', 'r2_bucket', 'bucket_name', config.r2_buckets.find((entry) => entry.binding === 'IMAGES').bucket_name],
    ];
    for (const [name, type, field, expected] of expectedBindings) {
      const binding = settings.bindings?.find((entry) => entry.name === name && entry.type === type);
      if (!binding || binding[field] !== expected) {
        throw new Error(`Remote ${name} binding differs from wrangler.deploy.json. Refusing to overwrite.`);
      }
    }
  }

  const database = config.d1_databases.find((entry) => entry.binding === 'DB');
  let foundDatabase;
  if (database.database_id !== EMPTY_DATABASE) {
    foundDatabase = await api.request('GET', `${prefix}/d1/database/${database.database_id}`);
    if (typeof foundDatabase?.name !== 'string') throw new Error('Cloudflare returned invalid D1 database details.');
    database.database_name = foundDatabase.name;
  } else {
    const matches = (await api.list(`${prefix}/d1/database`, { name: database.database_name }))
      .filter((entry) => entry.name === database.database_name);
    if (matches.length > 1) throw new Error('Multiple D1 databases have the configured name.');
    foundDatabase = matches[0] || null;
  }

  const bucket = config.r2_buckets.find((entry) => entry.binding === 'IMAGES');
  const bucketPath = `${prefix}/r2/buckets/${encodeURIComponent(bucket.bucket_name)}`;
  let foundBucket;
  try {
    foundBucket = await api.request('GET', bucketPath, undefined, { allowMissing: true });
  } catch (error) {
    if (error.status === 403) {
      throw new Error(
        `R2 is not enabled or the API Token lacks Workers R2 Storage Edit. ` +
        `Enable R2 at https://dash.cloudflare.com/?to=/:account/r2/overview\n${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (foundBucket) await assertBucketPrivate(api, bucketPath);

  let workersSubdomain = '';
  let url;
  if (config.routes?.length) {
    const hostname = config.routes[0].pattern;
    const zones = await api.list('/zones', { 'account.id': config.account_id });
    const zone = zones.find((item) => item.status === 'active' &&
      (hostname === item.name || hostname.endsWith(`.${item.name}`)));
    if (!zone) throw new Error(`No active accessible zone for ${hostname}.`);
    await api.list(`/zones/${zone.id}/workers/routes`);
    const domains = await api.list(`${prefix}/workers/domains`, { hostname });
    const conflictingDomain = domains.find((domain) =>
      domain.hostname === hostname && domain.service !== config.name);
    if (conflictingDomain) {
      throw new Error(
        `Custom domain ${hostname} is already attached to Worker ${conflictingDomain.service}.`,
      );
    }
    url = `https://${hostname}`;
  } else {
    const subdomain = await api.request('GET', `${prefix}/workers/subdomain`, undefined, { allowMissing: true });
    workersSubdomain = subdomain?.subdomain || '';
    if (workersSubdomain) url = `https://${config.name}.${workersSubdomain}.workers.dev`;
  }
  return {
    foundDatabase,
    foundBucket,
    workersSubdomain,
    url,
    adoptingDatabase: !!foundDatabase && database.database_id === EMPTY_DATABASE,
    adoptingBucket: !!foundBucket && !existing,
  };
}

export async function provisionDeployment(api, config, inspection, requestedSubdomain, save) {
  const prefix = `/accounts/${config.account_id}`;
  const database = config.d1_databases.find((entry) => entry.binding === 'DB');
  if (database.database_id === EMPTY_DATABASE) {
    const created = inspection.foundDatabase ||
      await api.request('POST', `${prefix}/d1/database`, { name: database.database_name });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(created?.uuid || '')) {
      throw new Error('Cloudflare returned an invalid D1 database UUID.');
    }
    database.database_id = created.uuid;
    await save(config);
  }

  const bucket = config.r2_buckets.find((entry) => entry.binding === 'IMAGES');
  const bucketPath = `${prefix}/r2/buckets/${encodeURIComponent(bucket.bucket_name)}`;
  if (!inspection.foundBucket) {
    try {
      await api.request('POST', `${prefix}/r2/buckets`, {
        name: bucket.bucket_name,
        storageClass: 'Standard',
      });
      await assertBucketPrivate(api, bucketPath);
    } catch (error) {
      if (error.status === 403) {
        throw new Error(
          `R2 is not enabled or the API Token lacks Workers R2 Storage Edit. ` +
          `Enable R2 at https://dash.cloudflare.com/?to=/:account/r2/overview\n${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  if (config.routes?.length) return `https://${config.routes[0].pattern}`;

  let workersSubdomain = inspection.workersSubdomain;
  if (!workersSubdomain) {
    workersSubdomain = validateWorkersSubdomain(requestedSubdomain);
    const created = await api.request('PUT', `${prefix}/workers/subdomain`, {
      subdomain: workersSubdomain,
    });
    if (created?.subdomain !== workersSubdomain) {
      throw new Error('Cloudflare did not return the requested workers.dev subdomain.');
    }
  }
  return `https://${config.name}.${workersSubdomain}.workers.dev`;
}
