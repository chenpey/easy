import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createPasswordVerifier, digest, verifyPassword } from "../src/auth.js";
import { maintenance } from "../src/worker.js";
import { applyLocalMigrations } from "../scripts/preview.mjs";

const password = "test-only-share-password-38!";
const origin = "https://share.example.test";
let mf, db, bucket, script;
let cookie, csrf;
const config = JSON.parse(await readFile(new URL("../wrangler.json", import.meta.url)));

async function request(path, { method = "GET", body, headers = {}, authenticated = false } = {}) {
  return mf.dispatchFetch(`${origin}${path}`, {
    method, body,
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "192.0.2.1",
      ...(authenticated ? { Cookie: cookie, "X-CSRF-Token": csrf } : {}),
      ...headers,
    },
    redirect: "manual",
  });
}

async function jsonRequest(path, data, authenticated = false, headers = {}) {
  return request(path, {
    method: "POST", body: JSON.stringify(data), authenticated,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function signIn() {
  const response = await jsonRequest("/api/login", { password });
  assert.equal(response.status, 200, await response.clone().text());
  cookie = response.headers.get("Set-Cookie").split(";")[0];
  const session = await request("/api/session", { authenticated: true });
  csrf = (await session.json()).csrfToken;
  return response;
}

before(async () => {
  const bundle = await build({ entryPoints: ["src/worker.js"], bundle: true, write: false, format: "esm", platform: "browser" });
  script = bundle.outputFiles[0].text;
  mf = new Miniflare(convertV4MiniflareOptions({
    name: "easydrop-test",
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: config.compatibility_date,
    bindings: { ...config.vars, MAX_UPLOAD_BYTES: "6291456", PASSWORD_VERIFIER: await createPasswordVerifier(password) },
    d1Databases: ["DB"], r2Buckets: ["FILES"],
    assets: {
      directory: new URL("../dist", import.meta.url).pathname, binding: "ASSETS", run_worker_first: true,
      routerConfig: { has_user_worker: true },
      assetConfig: { html_handling: "none", not_found_handling: "none" },
    },
  }));
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("FILES");
  await applyLocalMigrations(db);
});

beforeEach(async () => {
  await db.batch(["DELETE FROM multipart_parts", "DELETE FROM multipart_uploads", "DELETE FROM items",
    "DELETE FROM sessions", "DELETE FROM login_attempts", "DELETE FROM operations",
    "UPDATE app_state SET revision = 0, sweep_cursor = ''"].map((sql) => db.prepare(sql)));
  const objects = await bucket.list();
  if (objects.objects.length) await bucket.delete(objects.objects.map((item) => item.key));
  cookie = "";
  csrf = "";
});

after(async () => { await mf?.dispose(); });

test("current and legacy password verifiers remain valid across the rename", async () => {
  const current = JSON.parse(await createPasswordVerifier(password));
  const versionOne = JSON.parse(await createPasswordVerifier(password, 1));
  const versionTwo = JSON.parse(await createPasswordVerifier(password, 2));
  assert.equal(current.version, 3);
  assert.equal(versionOne.version, 1);
  assert.equal(versionTwo.version, 2);
  assert.equal(await verifyPassword(password, current), true);
  assert.equal(await verifyPassword(password, versionOne), true);
  assert.equal(await verifyPassword(password, versionTwo), true);
  assert.equal(await verifyPassword("wrong-password-value", current), false);
});

test("missing credentials and invalid settings fail closed; production refuses HTTP", async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: config.compatibility_date, bindings: config.vars,
  }));
  try {
    const missing = await runtime.dispatchFetch(`${origin}/`);
    assert.equal(missing.status, 503);
    assert.match((await missing.json()).message, /PASSWORD_VERIFIER/);
    await runtime.setOptions(convertV4MiniflareOptions({
      modules: true, script, compatibilityDate: config.compatibility_date,
      bindings: { ...config.vars, MAX_UPLOAD_BYTES: "invalid", PASSWORD_VERIFIER: await createPasswordVerifier(password) },
    }));
    assert.equal((await runtime.dispatchFetch(`${origin}/`)).status, 503);
  } finally {
    await runtime.dispose();
  }
  const insecure = await mf.dispatchFetch("http://share.example.test/api/history");
  assert.equal(insecure.status, 426);
});

test("unauthenticated pages, APIs and direct downloads are protected", async () => {
  for (const path of ["/", "/index.html"]) {
    const response = await request(path);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("Location"), `${origin}/login`);
  }
  for (const path of ["/api/session", "/api/history", "/api/revision", "/uploads/arbitrary", "/login.html"]) {
    assert.equal((await request(path)).status, 401, path);
  }
  for (const path of ["/api/text", "/api/uploads", "/api/clear_history", "/api/logout"]) {
    assert.equal((await request(path, { method: "POST" })).status, 401, path);
  }
  assert.equal((await request("/api/history/arbitrary", { method: "DELETE" })).status, 401);
  const login = await request("/login");
  assert.equal(login.status, 200);
  assert.match(await login.text(), /<link rel="icon" href="\/favicon\.ico" type="image\/svg\+xml">/);
  assert.equal((await request("/assets/app.js")).status, 200);
  const favicon = await request("/favicon.ico");
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get("Content-Type"), /image\/svg\+xml/);
  assert.match(await favicon.text(), /<title id="title">EasyDrop<\/title>/);
  assert.equal((await request("/favicon.ico", { method: "HEAD" })).status, 200);
  const downloadPath = `/uploads/${crypto.randomUUID()}`;
  const navigation = await request(downloadPath, {
    headers: { "Sec-Fetch-Mode": "navigate", Accept: "text/html" },
  });
  assert.equal(navigation.status, 303);
  assert.equal(navigation.headers.get("Location"), `${origin}/login?next=${encodeURIComponent(downloadPath)}`);
});

test("login validates inputs and origin, issues secure cookies and stores only token hashes", async () => {
  assert.equal((await jsonRequest("/api/login", { password }, false, { Origin: "https://evil.test" })).status, 403);
  assert.equal((await jsonRequest("/api/login", { password: "wrong" })).status, 401);
  assert.equal((await jsonRequest("/api/login", { password: null })).status, 400);
  assert.equal((await request("/api/login", { method: "POST", body: "{" , headers: { "Content-Type": "application/json" } })).status, 400);
  assert.equal((await request("/api/login", { method: "POST", body: "password=test" })).status, 415);
  const response = await signIn();
  const header = response.headers.get("Set-Cookie");
  assert.match(header, /^__Host-easydrop=[a-f0-9]{64};/);
  for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=604800"]) assert.ok(header.includes(attribute));
  const stored = await db.prepare("SELECT * FROM sessions").first();
  assert.equal(stored.token_hash, await digest(cookie.split("=")[1]));
  assert.notEqual(stored.token_hash, cookie.split("=")[1]);
  assert.equal((await request("/", { authenticated: true })).status, 200);
  const downloadPath = `/uploads/${crypto.randomUUID()}`;
  const resumed = await request(`/login?next=${encodeURIComponent(downloadPath)}`, { authenticated: true });
  assert.equal(resumed.status, 303);
  assert.equal(resumed.headers.get("Location"), `${origin}${downloadPath}`);
  const unsafe = await request("/login?next=https%3A%2F%2Fevil.example", { authenticated: true });
  assert.equal(unsafe.headers.get("Location"), `${origin}/`);
});

test("session tampering, expiry and password-version changes invalidate access", async () => {
  await signIn();
  assert.equal((await request("/api/history", { headers: { Cookie: `${cookie.slice(0, -1)}z` } })).status, 401);
  await db.prepare("UPDATE sessions SET expires_at = 1").run();
  assert.equal((await request("/api/history", { authenticated: true })).status, 401);
  await signIn();
  await db.prepare("UPDATE sessions SET auth_version = 'previous-password'").run();
  assert.equal((await request("/api/history", { authenticated: true })).status, 401);
});

test("all mutations require both matching origin and CSRF token", async () => {
  await signIn();
  for (const [method, path] of [
    ["POST", "/api/text"], ["POST", "/api/clear_history"], ["POST", "/api/uploads"],
    ["PUT", `/api/uploads/${crypto.randomUUID()}/parts/1`],
    ["POST", `/api/uploads/${crypto.randomUUID()}/complete`], ["DELETE", `/api/uploads/${crypto.randomUUID()}`],
    ["POST", "/api/logout"], ["DELETE", "/api/history/anything"],
  ]) {
    assert.equal((await request(path, { method, authenticated: true, headers: { "X-CSRF-Token": "wrong" } })).status, 403);
    assert.equal((await request(path, { method, authenticated: true, headers: { Origin: "https://evil.test" } })).status, 403);
    assert.equal((await request(path, { method, authenticated: true, headers: { Origin: "" } })).status, 403);
  }
});

test("logout revokes the session and expires its cookie", async () => {
  await signIn();
  const response = await request("/api/logout", { method: "POST", authenticated: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal((await request("/api/history", { authenticated: true })).status, 401);
});

test("login rate limits survive parallel requests and apply globally", async () => {
  await db.prepare("INSERT INTO login_attempts VALUES ('global', ?, 100)").bind(Math.floor(Date.now() / 1000)).run();
  const blocked = await jsonRequest("/api/login", { password }, false, { "CF-Connecting-IP": "192.0.2.9" });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
  await db.prepare("DELETE FROM login_attempts").run();
  await db.prepare("INSERT INTO login_attempts VALUES (?, ?, 9)")
    .bind(`ip:${await digest("192.0.2.1")}`, Math.floor(Date.now() / 1000)).run();
  const statuses = await Promise.all([1, 2, 3].map(async () => (await jsonRequest("/api/login", { password: "wrong" })).status));
  assert.deepEqual(statuses.sort(), [401, 429, 429]);
  await db.prepare("UPDATE login_attempts SET started_at = 1").run();
  assert.equal((await jsonRequest("/api/login", { password })).status, 200);
});

test("text validation, preservation, pagination and revisions", async () => {
  await signIn();
  for (const text of ["", "   ", null, 123]) assert.equal((await jsonRequest("/api/text", { text }, true)).status, 400);
  assert.equal((await jsonRequest("/api/text", { text: "a".repeat(131073) }, true)).status, 413);
  const text = "  <script>alert('text')</script>\n中文内容  ";
  assert.equal((await jsonRequest("/api/text", { text }, true)).status, 201);
  let history = await (await request("/api/history", { authenticated: true })).json();
  assert.equal(history.items[0].content, text);
  assert.equal(history.revision, 1);
  await db.batch(Array.from({ length: 53 }, (_, i) => db.prepare(
    "INSERT INTO items(id, type, content, state, created_at) VALUES (?, 'text', ?, 'ready', 1)",
  ).bind(crypto.randomUUID(), `page-${i}`)));
  history = await (await request("/api/history", { authenticated: true })).json();
  assert.equal(history.items.length, 8);
  const seen = [...history.items];
  while (history.nextCursor) {
    const previousCursor = history.nextCursor;
    history = await (await request(`/api/history?before=${previousCursor}`, { authenticated: true })).json();
    assert.ok(history.items.every((item) => item.seq < previousCursor));
    seen.push(...history.items);
  }
  assert.equal(seen.length, 54);
  assert.equal(new Set(seen.map((item) => item.id)).size, 54);
  assert.equal((await request("/api/history?before=NaN", { authenticated: true })).status, 400);
});

async function checksum(body) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString("hex");
}

async function multipartMetadata(name, body, chunkSize = 5 * 1024 * 1024) {
  const partChecksums = [];
  for (let offset = 0; offset < body.length; offset += chunkSize) {
    partChecksums.push(await checksum(body.subarray(offset, Math.min(offset + chunkSize, body.length))));
  }
  const fileFingerprint = await checksum(Buffer.from(JSON.stringify([
    "multipart-file-v1", body.length, chunkSize, partChecksums,
  ])));
  return { name, size: body.length, chunkSize, fileFingerprint, partChecksums };
}

async function uploadFile(name, value = "file contents") {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const metadata = await multipartMetadata(name, body);
  const initiated = await jsonRequest("/api/uploads", metadata, true, { "Idempotency-Key": crypto.randomUUID() });
  if (!initiated.ok) return initiated;
  const upload = await initiated.clone().json();
  if (upload.complete) return initiated;
  for (let partNumber = 1; partNumber <= upload.totalParts; partNumber++) {
    const start = (partNumber - 1) * upload.chunkSize;
    const part = body.subarray(start, Math.min(start + upload.chunkSize, body.length));
    const response = await request(`/api/uploads/${upload.id}/parts/${partNumber}`, {
      method: "PUT", body: part, authenticated: true,
      headers: {
        "Content-Length": String(part.length),
        "X-Part-SHA256": metadata.partChecksums[partNumber - 1],
      },
    });
    if (!response.ok) return response;
  }
  return request(`/api/uploads/${upload.id}/complete`, { method: "POST", authenticated: true });
}

test("multipart upload supports duplicate names, Unicode, empty files and authenticated range download", async () => {
  await signIn();
  const first = await uploadFile("资料.html", "<script>alert(1)</script>");
  assert.equal(first.status, 201, await first.clone().text());
  const id = (await first.json()).id;
  const second = await uploadFile("资料.html");
  assert.notEqual((await second.json()).id, id);
  const response = await request(`/uploads/${id}`, { authenticated: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
  assert.match(response.headers.get("Content-Disposition"), /^attachment;/);
  assert.match(response.headers.get("Content-Disposition"), /%E8%B5%84%E6%96%99/);
  assert.equal(await response.text(), "<script>alert(1)</script>");
  assert.equal((await request(`/uploads/${id}`)).status, 401);
  const head = await request(`/uploads/${id}`, { authenticated: true, method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("Accept-Ranges"), "bytes");
  assert.match(head.headers.get("ETag"), /^".+"$/);
  assert.ok(Date.parse(head.headers.get("Last-Modified")));
  const partial = await request(`/uploads/${id}`, { authenticated: true, headers: { Range: "bytes=1-6" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 1-6/25");
  assert.equal(await partial.text(), "script");
  const suffix = await request(`/uploads/${id}`, { authenticated: true, headers: { Range: "bytes=-3" } });
  assert.equal(await suffix.text(), "pt>");
  const [left, right] = await Promise.all([
    request(`/uploads/${id}`, { authenticated: true, headers: { Range: "bytes=0-7" } }),
    request(`/uploads/${id}`, { authenticated: true, headers: { Range: "bytes=8-24" } }),
  ]);
  assert.equal(left.status, 206);
  assert.equal(right.status, 206);
  assert.equal(`${await left.text()}${await right.text()}`, "<script>alert(1)</script>");
  assert.equal((await request(`/uploads/${id}`, { authenticated: true, headers: { Range: "bytes=999-" } })).status, 416);
  const empty = await uploadFile("empty.txt", "");
  assert.equal(empty.status, 201);
  const emptyId = (await empty.json()).id;
  assert.equal(await (await request(`/uploads/${emptyId}`, { authenticated: true })).text(), "");
});

test("multipart upload persists verified parts, resumes safely and completes once", async () => {
  await signIn();
  const key = crypto.randomUUID();
  const firstPart = Buffer.alloc(5 * 1024 * 1024, 0x61);
  const lastPart = Buffer.from("resumable tail");
  const size = firstPart.length + lastPart.length;
  const partChecksums = [await checksum(firstPart), await checksum(lastPart)];
  const fileFingerprint = await checksum(Buffer.from(JSON.stringify([
    "multipart-file-v1", size, 5 * 1024 * 1024, partChecksums,
  ])));
  const headers = { "Idempotency-Key": key };
  const metadata = { name: "resume.bin", size, chunkSize: 5 * 1024 * 1024, fileFingerprint };
  const initiated = await jsonRequest("/api/uploads", metadata, true, headers);
  assert.equal(initiated.status, 201, await initiated.clone().text());
  const upload = await initiated.json();
  assert.equal(upload.chunkSize, 5 * 1024 * 1024);
  assert.equal(upload.totalParts, 2);
  assert.equal((await jsonRequest("/api/uploads", {
    ...metadata, fileFingerprint: "0".repeat(64),
  }, true, headers)).status, 409);

  const putPart = async (partNumber, body, digest) => {
    const partDigest = digest || await checksum(body);
    return request(`/api/uploads/${upload.id}/parts/${partNumber}`, {
      method: "PUT", body, authenticated: true,
      headers: { "Content-Length": String(body.length), "X-Part-SHA256": partDigest },
    });
  };
  assert.equal((await putPart(1, firstPart, "0".repeat(64))).status, 400);
  assert.equal((await putPart(2, lastPart)).status, 201);
  assert.equal((await putPart(1, firstPart)).status, 201);

  const resumed = await jsonRequest("/api/uploads", metadata, true, headers);
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).uploadedParts.length, 2);
  const replayedPart = await putPart(1, firstPart);
  assert.equal(replayedPart.status, 200);
  assert.equal((await replayedPart.json()).replayed, true);

  const completed = await request(`/api/uploads/${upload.id}/complete`, { method: "POST", authenticated: true });
  assert.equal(completed.status, 201, await completed.clone().text());
  assert.equal((await request(`/api/uploads/${upload.id}/complete`, { method: "POST", authenticated: true })).status, 200);
  const object = Buffer.from(await (await request(`/uploads/${upload.id}`, { authenticated: true })).arrayBuffer());
  assert.deepEqual(object, Buffer.concat([firstPart, lastPart]));
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM multipart_uploads").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM multipart_parts").first()).n, 0);
});

test("invalid filenames and oversized uploads never publish history", async () => {
  await signIn();
  for (const name of ["", "../file", "path\\file", "nul\u0000.txt", "a".repeat(256)]) {
    assert.equal((await uploadFile(name)).status, 400);
  }
  const large = await jsonRequest("/api/uploads", { name: "large.bin", size: 6291457 }, true);
  assert.equal(large.status, 413);
  const malformed = await jsonRequest("/api/uploads", {
    name: "bad.bin", size: 1, chunkSize: 5 * 1024 * 1024, fileFingerprint: "invalid",
  }, true);
  assert.equal(malformed.status, 400);
  assert.equal((await (await request("/api/history", { authenticated: true })).json()).items.length, 0);
});

test("delete and clear revoke downloads immediately and cleanup removes R2 objects", async () => {
  await signIn();
  const { id } = await (await uploadFile("delete.txt")).json();
  const response = await request(`/api/history/${id}`, { method: "DELETE", authenticated: true });
  assert.equal(response.status, 202);
  assert.equal((await request(`/uploads/${id}`, { authenticated: true })).status, 404);
  await maintenance({ DB: db, FILES: bucket });
  assert.equal(await bucket.head(`files/${id}`), null);
  await uploadFile("clear.txt");
  await jsonRequest("/api/text", { text: "clear text" }, true);
  const pendingId = crypto.randomUUID();
  await db.prepare("INSERT INTO items(id, type, state, created_at) VALUES (?, 'file', 'pending', ?)")
    .bind(pendingId, Math.floor(Date.now() / 1000)).run();
  assert.equal((await request("/api/clear_history", { method: "POST", authenticated: true })).status, 202);
  assert.equal((await (await request("/api/history", { authenticated: true })).json()).items.length, 0);
  // A pending upload cannot be published once clear has marked it (or removed it).
  const publish = await db.prepare("UPDATE items SET state = 'ready' WHERE id = ? AND state = 'pending'").bind(pendingId).run();
  assert.equal(publish.meta.changes, 0);
  await maintenance({ DB: db, FILES: bucket });
  assert.equal((await bucket.list()).objects.length, 0);
});

test("expired sessions, login counters and abandoned uploads are cleaned", async () => {
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO items(id, type, state, created_at) VALUES (?, 'file', 'pending', 1)").bind(id).run();
  await bucket.put(`files/${id}`, "partial");
  const multipartId = crypto.randomUUID();
  const operationKey = crypto.randomUUID();
  const multipart = await bucket.createMultipartUpload(`files/${multipartId}`);
  await db.batch([
    db.prepare("INSERT INTO items(id, type, name, size, state, created_at) VALUES (?, 'file', 'expired.bin', 1, 'pending', 1)")
      .bind(multipartId),
    db.prepare("INSERT INTO operations VALUES (?, 'expired', ?, 'pending', 1)").bind(operationKey, multipartId),
    db.prepare("INSERT INTO multipart_uploads VALUES (?, ?, ?, 5242880, 1, 'uploading', 1)")
      .bind(multipartId, multipart.uploadId, operationKey),
  ]);
  await db.prepare("INSERT INTO sessions VALUES ('old', 'csrf', 'version', 1)").run();
  await db.prepare("INSERT INTO login_attempts VALUES ('old', 1, 1)").run();
  await maintenance({ DB: db, FILES: bucket });
  assert.equal(await bucket.head(`files/${id}`), null);
  await assert.rejects(multipart.uploadPart(1, "late"));
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM multipart_uploads").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM login_attempts").first()).n, 0);
});

test("security headers apply to success, error and static responses", async () => {
  for (const path of ["/login", "/api/history", "/assets/app.js", "/favicon.ico"]) {
    const response = await request(path);
    const publicAsset = path.startsWith("/assets/") || path === "/favicon.ico";
    assert.equal(response.headers.get("Cache-Control"), publicAsset ? "public, max-age=0, must-revalidate" : "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
  const error = await (await request("/api/history")).json();
  assert.equal(error.method, "GET");
  assert.equal(error.path, "/api/history");
  assert.ok(error.requestId);
});

test("blocked IP does not consume global login budget", async () => {
  await db.prepare("INSERT INTO login_attempts VALUES (?, ?, 10)")
    .bind(`ip:${await digest("192.0.2.1")}`, Math.floor(Date.now() / 1000)).run();
  for (let i = 0; i < 5; i++) {
    assert.equal((await jsonRequest("/api/login", { password: "wrong" })).status, 429);
  }
  assert.equal(await db.prepare("SELECT * FROM login_attempts WHERE key = 'global'").first(), null);
  assert.equal((await jsonRequest("/api/login", { password }, false, { "CF-Connecting-IP": "192.0.2.2" })).status, 200);
});

test("text idempotency survives response loss and rejects changed content or deleted results", async () => {
  await signIn();
  const headers = { "Idempotency-Key": crypto.randomUUID() };
  const first = await jsonRequest("/api/text", { text: "retry safely" }, true, headers);
  const id = (await first.json()).id;
  const replay = await jsonRequest("/api/text", { text: "retry safely" }, true, headers);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).id, id);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM items").first()).n, 1);
  assert.equal((await jsonRequest("/api/text", { text: "different text" }, true, headers)).status, 409);
  await request(`/api/history/${id}`, { method: "DELETE", authenticated: true });
  assert.equal((await jsonRequest("/api/text", { text: "retry safely" }, true, headers)).status, 410);
});

test("parallel uploads share one idempotency key and publish at most one object", async () => {
  await signIn();
  const key = crypto.randomUUID();
  const body = Buffer.from("contents");
  const metadata = await multipartMetadata("once.txt", body);
  const send = () => jsonRequest("/api/uploads", metadata, true, { "Idempotency-Key": key });
  const responses = await Promise.all([send(), send(), send()]);
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.ok(responses.every((response) => [200, 201, 409].includes(response.status)));
  const upload = await responses.find((response) => response.ok).json();
  assert.equal((await request(`/api/uploads/${upload.id}/parts/1`, {
    method: "PUT", body, authenticated: true,
    headers: { "Content-Length": String(body.length), "X-Part-SHA256": metadata.partChecksums[0] },
  })).status, 201);
  assert.equal((await request(`/api/uploads/${upload.id}/complete`, { method: "POST", authenticated: true })).status, 201);
  const replay = await send();
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM items WHERE state = 'ready'").first()).n, 1);
  assert.equal((await bucket.list()).objects.length, 1);
});

test("no-op deletes and clears do not change revision", async () => {
  await signIn();
  assert.equal((await request(`/api/history/${crypto.randomUUID()}`, { method: "DELETE", authenticated: true })).status, 404);
  await request("/api/clear_history", { method: "POST", authenticated: true });
  assert.equal((await (await request("/api/revision", { authenticated: true })).json()).revision, 0);
});

test("cleanup drains configured batches without R2 calls for text items", async () => {
  await db.batch(Array.from({ length: 120 }, () => db.prepare(
    "INSERT INTO items(id, type, content, state, created_at) VALUES (?, 'text', 'old', 'deleting', 1)",
  ).bind(crypto.randomUUID())));
  let deletes = 0;
  await maintenance({
    DB: db, CLEANUP_BATCHES: "4",
    FILES: { list: (...args) => bucket.list(...args), delete: () => { deletes++; } },
  });
  assert.equal(deletes, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM items").first()).n, 0);
});

test("failed operations can be atomically retried while pending operations remain locked", async () => {
  await signIn();
  const key = crypto.randomUUID();
  const oldId = crypto.randomUUID();
  const fingerprint = await digest(JSON.stringify(["text", "retry after failure"]));
  await db.prepare("INSERT INTO operations VALUES (?, ?, ?, 'pending', ?)")
    .bind(key, fingerprint, oldId, Math.floor(Date.now() / 1000)).run();
  const send = () => jsonRequest("/api/text", { text: "retry after failure" }, true, { "Idempotency-Key": key });
  assert.equal((await send()).status, 409);
  await db.prepare("UPDATE operations SET state = 'failed' WHERE request_key = ?").bind(key).run();
  const response = await send();
  assert.equal(response.status, 201);
  assert.notEqual((await response.json()).id, oldId);
  assert.equal((await send()).status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM items").first()).n, 1);
});
