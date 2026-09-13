const EMPTY_DATABASE = "00000000-0000-0000-0000-000000000000";

export function createCloudflareClient(token, { baseUrl = "https://api.cloudflare.com/client/v4", fetcher = fetch } = {}) {
  async function call(method, path, body, { allowMissing = false } = {}) {
    let response;
    let raw;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000), redirect: "error",
      });
      raw = await response.text();
    } catch (error) {
      throw new Error(`${method} ${path}\nNetwork error: ${error.message}`, { cause: error });
    }
    let data;
    try { data = JSON.parse(raw); } catch { /* Include the complete non-JSON response below. */ }
    if (allowMissing && response.status === 404 && data?.success === false) return null;
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
      for (let page = 1; ; page++) {
        const query = new URLSearchParams({ ...parameters, page: String(page), per_page: "50" });
        const data = await call("GET", `${path}?${query}`);
        if (!Array.isArray(data.result)) throw new Error(`GET ${path}: Expected a result array.`);
        results.push(...data.result);
        const info = data.result_info;
        if (data.result.length < 50 || (info?.total_count !== undefined && results.length >= info.total_count) ||
            (info?.total_pages !== undefined && page >= info.total_pages)) return results;
        if (page >= 1000) throw new Error(`GET ${path}: Pagination safety limit exceeded.`);
      }
    },
  };
}

export async function selectAccount(api, saved, ask, log = console.log) {
  if (saved) return saved;
  let accounts;
  try {
    accounts = await api.list("/accounts");
  } catch (error) {
    log(error.message);
    log("Account discovery failed. Enter an account ID explicitly or cancel; no resources have been changed.");
    const id = (await ask("Cloudflare account ID: ")).trim();
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid account ID.");
    return id;
  }
  if (accounts.length === 1) {
    log(`Account: ${accounts[0].name} (${accounts[0].id})`);
    return accounts[0].id;
  }
  if (!accounts.length) throw new Error("Token cannot access any account.");
  accounts.forEach((account, i) => log(`${i + 1}. ${account.name} (${account.id})`));
  const answer = (await ask("Account number: ")).trim();
  const selected = /^[1-9]\d*$/.test(answer) ? accounts[Number(answer) - 1] : null;
  if (!selected) throw new Error("Invalid account selection.");
  return selected.id;
}

export function deploymentConfig(template, existing, account, name, domain) {
  if (!/^[a-f0-9]{32}$/.test(account)) throw new Error("Invalid account ID.");
  if (!/^[a-z][a-z0-9-]{1,48}[a-z0-9]$/.test(name)) throw new Error("Worker name must be 3-50 lowercase letters, digits or hyphens.");
  if (existing && (existing.account_id !== account || existing.name !== name)) {
    throw new Error("Deployment target differs from saved configuration. Use a separate directory for another target.");
  }
  if (domain && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) throw new Error("Invalid custom hostname.");
  const config = structuredClone(template);
  Object.assign(config, { name, account_id: account, workers_dev: !domain, preview_urls: false });
  delete config.routes;
  if (domain) config.routes = [{ pattern: domain, custom_domain: true }];
  config.d1_databases[0] = {
    ...config.d1_databases[0], database_name: existing?.d1_databases[0].database_name || name,
    database_id: existing?.d1_databases[0].database_id || EMPTY_DATABASE,
  };
  config.r2_buckets[0].bucket_name = existing?.r2_buckets[0].bucket_name || `${name}-files`;
  if (config.vars.ALLOW_LOCAL_HTTP !== "false") throw new Error("Production ALLOW_LOCAL_HTTP must be false.");
  return config;
}

export async function inspectDeployment(api, config, existing) {
  const prefix = `/accounts/${config.account_id}`;
  const script = `${prefix}/workers/scripts/${config.name}`;
  const settings = await api.request("GET", `${script}/settings`, undefined, { allowMissing: true });
  if (settings && !existing) throw new Error(`Worker ${config.name} already exists. Choose a different name; it will not be overwritten.`);
  if (settings) {
    for (const [name, type, field, expected] of [
      ["DB", "d1", "id", config.d1_databases[0].database_id],
      ["FILES", "r2_bucket", "bucket_name", config.r2_buckets[0].bucket_name],
    ]) {
      const binding = settings.bindings?.find((entry) => entry.name === name && entry.type === type);
      if (!binding || binding[field] !== expected) throw new Error(`Remote ${name} binding differs from saved deployment. Refusing to overwrite.`);
    }
  }
  const database = config.d1_databases[0];
  let foundDatabase;
  if (database.database_id !== EMPTY_DATABASE) {
    foundDatabase = await api.request("GET", `${prefix}/d1/database/${database.database_id}`);
    if (foundDatabase.name !== database.database_name) throw new Error("Saved D1 database name does not match the remote database.");
  } else {
    const matches = (await api.list(`${prefix}/d1/database`, { name: database.database_name })).filter((item) => item.name === database.database_name);
    if (matches.length > 1) throw new Error("Multiple D1 databases have the requested name.");
    foundDatabase = matches[0] || null;
  }
  const bucketPath = `${prefix}/r2/buckets/${encodeURIComponent(config.r2_buckets[0].bucket_name)}`;
  const foundBucket = await api.request("GET", bucketPath, undefined, { allowMissing: true });
  if (foundBucket) {
    const managed = await api.request("GET", `${bucketPath}/domains/managed`);
    const custom = await api.request("GET", `${bucketPath}/domains/custom`);
    if (managed.enabled !== false || !Array.isArray(custom.domains) || custom.domains.some((item) => item.enabled !== false)) {
      throw new Error("R2 public access is enabled or could not be verified. Disable r2.dev and bucket custom domains first.");
    }
  }
  let url;
  if (config.routes?.length) {
    const hostname = config.routes[0].pattern;
    const zones = await api.list("/zones", { "account.id": config.account_id });
    const zone = zones.find((item) => item.status === "active" && (hostname === item.name || hostname.endsWith(`.${item.name}`)));
    if (!zone) throw new Error(`No active accessible zone for ${hostname}.`);
    url = `https://${hostname}`;
  } else {
    const subdomain = await api.request("GET", `${prefix}/workers/subdomain`);
    if (!subdomain?.subdomain) throw new Error("Set up the account's workers.dev subdomain in Cloudflare first.");
    url = `https://${config.name}.${subdomain.subdomain}.workers.dev`;
  }
  return {
    foundDatabase, foundBucket, url,
    hasPassword: !!settings?.bindings?.some((entry) => entry.name === "PASSWORD_VERIFIER" && entry.type === "secret_text"),
    adoptingDatabase: !!foundDatabase && database.database_id === EMPTY_DATABASE,
    adoptingBucket: !!foundBucket && !existing,
  };
}

export async function provisionDeployment(api, config, inspection, save) {
  const prefix = `/accounts/${config.account_id}`;
  if (config.d1_databases[0].database_id === EMPTY_DATABASE) {
    const database = inspection.foundDatabase || await api.request("POST", `${prefix}/d1/database`, { name: config.d1_databases[0].database_name });
    if (!database?.uuid) throw new Error("D1 response is missing uuid.");
    config.d1_databases[0].database_id = database.uuid;
    await save(config);
  }
  if (!inspection.foundBucket) {
    await api.request("POST", `${prefix}/r2/buckets`, { name: config.r2_buckets[0].bucket_name });
  }
  await save(config);
}
