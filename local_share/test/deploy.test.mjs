import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  createCloudflareClient,
  deploymentConfig,
  inspectDeployment,
  provisionDeployment,
  resolvePublicHostname,
  selectAccount,
} from "../scripts/cloudflare.mjs";

const account = "a".repeat(32);
const zone = "z".repeat(32);
const template = JSON.parse(await readFile(new URL("../wrangler.json", import.meta.url)));
let server, api, records, database, bucket, settings, publicBucket, failBucket, failure, routeFailure, accounts;

before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    let body = "";
    for await (const chunk of request) body += chunk;
    records.push({ method: request.method, path: url.pathname, body: body ? JSON.parse(body) : undefined });
    assert.equal(request.headers.authorization, "Bearer local-test-token");
    const reply = (result, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(status < 400 ? { success: true, result } : { success: false, errors: [{ code: status, message: result }] }));
    };
    if (failure) return reply(failure.message, failure.status);
    if (url.pathname === "/accounts") return reply(accounts);
    if (url.pathname === "/zones") return reply([{ id: zone, name: "example.test", status: "active" }]);
    if (url.pathname === `/zones/${zone}/workers/routes`) {
      return routeFailure ? reply("Missing Workers Routes Read permission", 403) : reply([]);
    }
    if (url.pathname.endsWith("/settings")) return settings ? reply(settings) : reply("Worker not found", 404);
    if (url.pathname.endsWith("/workers/subdomain")) return reply({ subdomain: "personal" });
    if (url.pathname.endsWith("/d1/database")) {
      if (request.method === "GET") return reply(database ? [database] : []);
      database = { uuid: crypto.randomUUID(), name: JSON.parse(body).name };
      return reply(database);
    }
    if (url.pathname.includes("/d1/database/")) return reply(database);
    if (url.pathname.endsWith("/domains/managed")) return reply({ enabled: publicBucket });
    if (url.pathname.endsWith("/domains/custom")) return reply({ domains: [] });
    if (url.pathname.endsWith("/r2/buckets") && request.method === "POST") {
      if (failBucket) return reply("R2 is not enabled", 403);
      bucket = { name: JSON.parse(body).name };
      return reply(bucket);
    }
    if (url.pathname.includes("/r2/buckets/")) return bucket ? reply(bucket) : reply("Bucket not found", 404);
    return reply("Unknown route", 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = createCloudflareClient("local-test-token", { baseUrl: `http://127.0.0.1:${server.address().port}` });
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  records = [];
  database = bucket = settings = failure = routeFailure = null;
  publicBucket = failBucket = false;
  accounts = [{ id: account, name: "Personal" }];
});

test("one accessible account is selected without manual account input", async () => {
  assert.equal(await selectAccount(api, null, () => { throw new Error("Must not prompt"); }, () => {}), account);
});

test("multiple accounts require explicit selection", async () => {
  accounts.push({ id: "b".repeat(32), name: "Other" });
  assert.equal(await selectAccount(api, null, async () => "2", () => {}), "b".repeat(32));
  await assert.rejects(selectAccount(api, null, async () => "invalid", () => {}), /Invalid account/);
});

test("first deployment provisions private storage and subsequent deployment reuses it and password", async () => {
  const config = deploymentConfig(template, null, account, "my-share", "");
  const inspection = await inspectDeployment(api, config, null);
  assert.equal(inspection.hasPassword, false);
  assert.equal(inspection.url, "https://my-share.personal.workers.dev");
  const saves = [];
  await provisionDeployment(api, config, inspection, async (value) => saves.push(structuredClone(value)));
  assert.ok(saves[0].d1_databases[0].database_id !== template.d1_databases[0].database_id);
  settings = { bindings: [
    { name: "DB", type: "d1", id: database.uuid },
    { name: "FILES", type: "r2_bucket", bucket_name: bucket.name },
    { name: "PASSWORD_VERIFIER", type: "secret_text" },
  ] };
  records = [];
  const next = deploymentConfig(template, config, account, config.name, "");
  const repeated = await inspectDeployment(api, next, config);
  assert.equal(repeated.hasPassword, true);
  await provisionDeployment(api, next, repeated, async () => {});
  assert.equal(records.filter((request) => request.method !== "GET").length, 0);
});

test("partial R2 failure preserves D1 identity for the next run", async () => {
  const config = deploymentConfig(template, null, account, "my-share", "");
  let saved;
  failBucket = true;
  await assert.rejects(provisionDeployment(api, config, await inspectDeployment(api, config, null),
    async (value) => { saved = structuredClone(value); }), /POST .*r2\/buckets[\s\S]*403[\s\S]*R2 is not enabled/);
  assert.equal(saved.d1_databases[0].database_id, database.uuid);
  failBucket = false;
  records = [];
  const next = await inspectDeployment(api, saved, saved);
  await provisionDeployment(api, saved, next, async () => {});
  assert.equal(records.filter((request) => request.method === "POST" && request.path.endsWith("/d1/database")).length, 0);
});

test("public R2 and existing unrelated Worker are rejected before writes", async () => {
  const config = deploymentConfig(template, null, account, "my-share", "");
  bucket = { name: "my-share-files" };
  publicBucket = true;
  await assert.rejects(inspectDeployment(api, config, null), /public access/);
  publicBucket = false;
  settings = { bindings: [] };
  await assert.rejects(inspectDeployment(api, config, null), /already exists/);
  await assert.rejects(inspectDeployment(api, config, config), /binding differs/);
  assert.ok(records.every((request) => request.method === "GET"));
});

test("API errors preserve method, path, HTTP status and JSON response without retry", async () => {
  failure = { status: 403, message: "Missing permission" };
  await assert.rejects(api.request("POST", `/accounts/${account}/r2/buckets`, { name: "test" }),
    new RegExp(`POST /accounts/${account}/r2/buckets\\nHTTP 403\\n.*Missing permission`));
  assert.equal(records.length, 1);
  await assert.rejects(api.request("GET", "/anything", undefined, { allowMissing: true }), /HTTP 403/);
});

test("public DNS verification uses 1.1.1.1 without relying on the system resolver", async () => {
  let requested;
  const addresses = await resolvePublicHostname("share.example.test", async (url, options) => {
    requested = { url, options };
    return new Response(JSON.stringify({
      Status: 0,
      Answer: [
        { name: "share.example.test", type: 1, data: "192.0.2.10" },
        { name: "share.example.test", type: 28, data: "2001:db8::10" },
      ],
    }));
  });
  assert.equal(requested.url.hostname, "1.1.1.1");
  assert.equal(requested.url.searchParams.get("name"), "share.example.test");
  assert.equal(requested.options.headers.Accept, "application/dns-json");
  assert.deepEqual(addresses, ["192.0.2.10"]);
  await assert.rejects(resolvePublicHostname("missing.example.test",
    async () => new Response('{"Status":3,"Comment":"NXDOMAIN"}')), /HTTP 200[\s\S]*NXDOMAIN/);
});

test("custom domain checks active zone and disables alternative public entrypoints", async () => {
  const config = deploymentConfig(template, null, account, "my-share", "share.example.test");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal((await inspectDeployment(api, config, null)).url, "https://share.example.test");
  assert.ok(records.some((request) => request.path === `/zones/${zone}/workers/routes`));
  routeFailure = true;
  await assert.rejects(inspectDeployment(api, config, null),
    new RegExp(`GET /zones/${zone}/workers/routes\\?page=1&per_page=50\\nHTTP 403\\n.*Missing Workers Routes Read permission`));
  assert.ok(records.every((request) => request.method === "GET"));
  assert.throws(() => deploymentConfig(template, config, "b".repeat(32), config.name, ""), /target differs/);
});
