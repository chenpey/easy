import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createInitialAdmin, createPasswordVerifier, digest, verifyPassword } from "../src/auth.js";
import { maintenance } from "../src/worker.js";
import { applyLocalMigrations } from "../scripts/preview.mjs";

const password = "Test-only-share-Password-38!";
const username = "admin";
const origin = "https://share.example.test";
let mf, db, bucket, script;
let cookie, csrf;
const config = JSON.parse(await readFile(new URL("../wrangler.json", import.meta.url)));

async function request(path, { method = "GET", body, headers = {}, authenticated = false } = {}) {
  return mf.dispatchFetch(`${origin}${path}`, {
    method, body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
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

function deferredJsonBody(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let release;
  let reached;
  const hold = new Promise((resolve) => { release = resolve; });
  const reading = new Promise((resolve) => { reached = resolve; });
  let offset = 0;
  return {
    body: new ReadableStream({
      pull(controller) {
        if (offset === 0) {
          controller.enqueue(bytes.subarray(0, 1));
          offset = 1;
          return;
        }
        if (offset === 1) {
          offset = bytes.length;
          reached();
          return hold.then(() => {
            controller.enqueue(bytes.subarray(1));
            controller.close();
          });
        }
      },
    }),
    reading,
    release,
  };
}

const fileDownloadPath = (id, name) => `/uploads/${id}/${encodeURIComponent(name)}`;
const webpPreview = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
  "base64",
);

async function signIn() {
  const response = await jsonRequest("/api/login", { username, password });
  assert.equal(response.status, 200, await response.clone().text());
  cookie = response.headers.get("Set-Cookie").split(";")[0];
  const session = await request("/api/session", { authenticated: true });
  csrf = (await session.json()).csrfToken;
  return response;
}

async function credentialsFor(name, secret) {
  const response = await jsonRequest("/api/login", { username: name, password: secret });
  assert.equal(response.status, 200, await response.clone().text());
  const userCookie = response.headers.get("Set-Cookie").split(";")[0];
  const sessionResponse = await request("/api/session", { headers: { Cookie: userCookie } });
  const userSession = await sessionResponse.json();
  return { cookie: userCookie, csrf: userSession.csrfToken, session: userSession };
}

function useCredentials(credentials) {
  cookie = credentials.cookie;
  csrf = credentials.csrf;
}

before(async () => {
  const initialAdmin = await createInitialAdmin(username, password);
  const bundle = await build({ entryPoints: ["src/worker.js"], bundle: true, write: false, format: "esm", platform: "browser" });
  script = bundle.outputFiles[0].text;
  mf = new Miniflare(convertV4MiniflareOptions({
    name: "easydrop-test",
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: config.compatibility_date,
    bindings: { ...config.vars, MAX_UPLOAD_BYTES: "6291456", INITIAL_ADMIN: initialAdmin },
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
  await db.batch(["DELETE FROM file_shares", "DELETE FROM multipart_parts", "DELETE FROM multipart_uploads", "DELETE FROM items",
    "DELETE FROM sessions", "DELETE FROM login_attempts", "DELETE FROM account_attempts", "DELETE FROM operations",
    "DELETE FROM users WHERE username != 'admin'",
    "UPDATE users SET role = 'admin', enabled = 1, recovery_code_hash = NULL, recovery_code_created_at = NULL, approved_at = created_at, deletion_requested_at = NULL, content_revision = 0 WHERE username = 'admin'",
    "UPDATE app_state SET revision = 0, sweep_cursor = '', self_registration_enabled = 0"].map((sql) => db.prepare(sql)));
  const objects = await bucket.list();
  if (objects.objects.length) await bucket.delete(objects.objects.map((item) => item.key));
  cookie = "";
  csrf = "";
});

after(async () => { await mf?.dispose(); });

test("password verifier validates only the current EasyDrop format", async () => {
  for (const invalid of [
    "Short1A",
    "lowercase-only-password1",
    "UPPERCASE-ONLY-PASSWORD1",
    "MissingNumberPassword!",
    `Aa1!${"x".repeat(29)}`,
  ]) {
    await assert.rejects(createPasswordVerifier(invalid), /12-32 characters/);
  }
  await createPasswordVerifier("Abcdefghij1!");
  await createPasswordVerifier(`Aa1!${"x".repeat(28)}`);
  const verifier = JSON.parse(await createPasswordVerifier(password));
  assert.equal(verifier.version, 3);
  assert.equal(await verifyPassword(password, verifier), true);
  assert.equal(await verifyPassword("wrong-password-value", verifier), false);
});

test("missing credentials and invalid settings fail closed; production refuses HTTP", async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: config.compatibility_date, bindings: config.vars,
  }));
  try {
    const missing = await runtime.dispatchFetch(`${origin}/`);
    assert.equal(missing.status, 503);
    assert.match((await missing.json()).message, /INITIAL_ADMIN/);
    await runtime.setOptions(convertV4MiniflareOptions({
      modules: true, script, compatibilityDate: config.compatibility_date,
      bindings: { ...config.vars, MAX_UPLOAD_BYTES: "invalid", INITIAL_ADMIN: await createInitialAdmin(username, password) },
    }));
    assert.equal((await runtime.dispatchFetch(`${origin}/`)).status, 503);
    await runtime.setOptions(convertV4MiniflareOptions({
      modules: true, script, compatibilityDate: config.compatibility_date,
      bindings: {
        ...config.vars,
        MAX_UPLOAD_BYTES: String(200 * 1024 * 1024 + 1),
        INITIAL_ADMIN: await createInitialAdmin(username, password),
      },
    }));
    assert.equal((await runtime.dispatchFetch(`${origin}/`)).status, 503);
    await runtime.setOptions(convertV4MiniflareOptions({
      modules: true, script, compatibilityDate: config.compatibility_date,
      bindings: {
        ...config.vars,
        SESSION_TTL_SECONDS: "3600",
        SESSION_RENEW_INTERVAL_SECONDS: "1801",
        INITIAL_ADMIN: await createInitialAdmin(username, password),
      },
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
  const unauthorizedDownload = await request(fileDownloadPath(crypto.randomUUID(), "file.txt"));
  assert.equal(unauthorizedDownload.status, 401);
  assert.deepEqual(await unauthorizedDownload.json(), {
    success: false,
    message: "Authentication required.",
  });
  for (const path of ["/api/text", "/api/uploads", "/api/clear_history", "/api/logout"]) {
    assert.equal((await request(path, { method: "POST" })).status, 401, path);
  }
  assert.equal((await request("/api/history/arbitrary", { method: "DELETE" })).status, 401);
  for (const path of ["/login", "/register", "/reset-password"]) {
    const page = await request(path);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<link rel="icon" href="\/favicon\.ico" type="image\/svg\+xml">/);
  }
  for (const path of [
    "/assets/app.js",
    "/apple-touch-icon.png",
    "/manifest.webmanifest",
    "/pwa-192x192.png",
    "/pwa-512x512.png",
    "/pwa-maskable-512x512.png",
    "/sw.js",
  ]) {
    assert.equal((await request(path)).status, 200, path);
  }
  const favicon = await request("/favicon.ico");
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get("Content-Type"), /image\/svg\+xml/);
  assert.match(await favicon.text(), /<title id="title">EasyDrop<\/title>/);
  assert.equal((await request("/favicon.ico", { method: "HEAD" })).status, 200);
  const downloadPath = fileDownloadPath(crypto.randomUUID(), "file.txt");
  const navigation = await request(downloadPath, {
    headers: { "Sec-Fetch-Mode": "navigate", Accept: "text/html" },
  });
  assert.equal(navigation.status, 303);
  assert.equal(navigation.headers.get("Location"), `${origin}/login?next=${encodeURIComponent(downloadPath)}`);
});

test("login validates inputs and origin, issues secure cookies and stores only token hashes", async () => {
  assert.equal((await jsonRequest("/api/login", { username, password }, false, { Origin: "https://evil.test" })).status, 403);
  assert.equal((await jsonRequest("/api/login", { username, password: "wrong" })).status, 401);
  assert.equal((await jsonRequest("/api/login", { username, password: null })).status, 400);
  assert.equal((await jsonRequest("/api/login", { username: "x", password })).status, 400);
  assert.equal((await request("/api/login", { method: "POST", body: "{" , headers: { "Content-Type": "application/json" } })).status, 400);
  assert.equal((await request("/api/login", { method: "POST", body: "password=test" })).status, 415);
  const response = await signIn();
  const header = response.headers.get("Set-Cookie");
  assert.match(header, /^__Host-easydrop=[a-f0-9]{64};/);
  for (const attribute of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000"]) assert.ok(header.includes(attribute));
  const stored = await db.prepare("SELECT * FROM sessions").first();
  assert.equal(stored.token_hash, await digest(cookie.split("=")[1]));
  assert.notEqual(stored.token_hash, cookie.split("=")[1]);
  const active = await request("/api/revision", { authenticated: true });
  assert.equal(active.headers.get("Set-Cookie"), null);
  assert.equal((await db.prepare("SELECT expires_at FROM sessions").first()).expires_at, stored.expires_at);
  await db.prepare("UPDATE sessions SET expires_at = ?").bind(Math.floor(Date.now() / 1000) + 60).run();
  const renewed = await request("/", { authenticated: true });
  assert.equal(renewed.status, 200);
  assert.match(renewed.headers.get("Set-Cookie"), /Max-Age=2592000/);
  const sliding = await db.prepare("SELECT expires_at FROM sessions").first();
  assert.ok(sliding.expires_at > Math.floor(Date.now() / 1000) + 2591900);
  const downloadPath = fileDownloadPath(crypto.randomUUID(), "file.txt");
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
    ["POST", `/api/history/${crypto.randomUUID()}/share`],
    ["DELETE", `/api/history/${crypto.randomUUID()}/share`],
    ["PATCH", "/api/settings/registration"],
    ["POST", "/api/account/password"],
    ["POST", "/api/account/recovery-code"],
    ["DELETE", "/api/account"],
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

test("administrators manage users and every account change revokes active sessions", async () => {
  await signIn();
  assert.equal((await jsonRequest("/api/users", {
    username: "member", password: "weakpassword", role: "user",
  }, true)).status, 400);
  const created = await jsonRequest("/api/users", {
    username: "member", password: "MemberPass123!", role: "user",
  }, true);
  assert.equal(created.status, 201, await created.clone().text());
  const member = (await created.json()).user;
  assert.equal(member.username, "member");
  assert.equal(member.role, "user");
  assert.equal(Object.hasOwn(member, "password_verifier"), false);
  assert.equal((await jsonRequest("/api/users", {
    username: "member", password: "MemberPass123!",
  }, true)).status, 409);

  const memberLogin = await jsonRequest("/api/login", { username: "member", password: "MemberPass123!" });
  assert.equal(memberLogin.status, 200);
  let memberCookie = memberLogin.headers.get("Set-Cookie").split(";")[0];
  assert.equal((await request("/api/users", { headers: { Cookie: memberCookie } })).status, 403);

  const updated = await request(`/api/users/${member.id}`, {
    method: "PATCH", authenticated: true,
    body: JSON.stringify({ username: "member2", password: "ChangedPass456!", role: "user", enabled: true }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.equal((await request("/api/history", { headers: { Cookie: memberCookie } })).status, 401);
  assert.equal((await jsonRequest("/api/login", { username: "member", password: "MemberPass123!" })).status, 401);

  const changedLogin = await jsonRequest("/api/login", { username: "member2", password: "ChangedPass456!" });
  assert.equal(changedLogin.status, 200);
  memberCookie = changedLogin.headers.get("Set-Cookie").split(";")[0];
  assert.equal((await request(`/api/users/${member.id}`, {
    method: "PATCH", authenticated: true,
    body: JSON.stringify({ enabled: false }), headers: { "Content-Type": "application/json" },
  })).status, 200);
  assert.equal((await request("/api/history", { headers: { Cookie: memberCookie } })).status, 401);
  assert.equal((await jsonRequest("/api/login", { username: "member2", password: "ChangedPass456!" })).status, 401);

  assert.equal((await request(`/api/users/${member.id}`, {
    method: "PATCH", authenticated: true,
    body: JSON.stringify({ enabled: true }), headers: { "Content-Type": "application/json" },
  })).status, 200);
  assert.equal((await jsonRequest("/api/login", { username: "member2", password: "ChangedPass456!" })).status, 200);
  assert.equal((await request(`/api/users/${member.id}`, { method: "DELETE", authenticated: true })).status, 202);
  assert.equal((await jsonRequest("/api/login", { username: "member2", password: "ChangedPass456!" })).status, 401);

  const admin = await db.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  assert.equal((await request(`/api/users/${admin.id}`, {
    method: "PATCH", authenticated: true,
    body: JSON.stringify({ enabled: false }), headers: { "Content-Type": "application/json" },
  })).status, 409);
  assert.equal((await request(`/api/users/${admin.id}`, { method: "DELETE", authenticated: true })).status, 409);
});

test("concurrent administrator changes preserve one enabled administrator", async () => {
  await signIn();
  const primary = { cookie, csrf };
  const created = await jsonRequest("/api/users", {
    username: "second-admin", password: "SecondAdminPass123!", role: "admin",
  }, true);
  const secondAdmin = (await created.json()).user;
  const second = await credentialsFor("second-admin", "SecondAdminPass123!");
  const primaryAdmin = await db.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  const demoteSecond = deferredJsonBody({ role: "user" });
  const demotePrimary = deferredJsonBody({ role: "user" });

  const firstRequest = request(`/api/users/${secondAdmin.id}`, {
    method: "PATCH",
    body: demoteSecond.body,
    headers: {
      "Content-Type": "application/json",
      Cookie: primary.cookie,
      "X-CSRF-Token": primary.csrf,
    },
  });
  const secondRequest = request(`/api/users/${primaryAdmin.id}`, {
    method: "PATCH",
    body: demotePrimary.body,
    headers: {
      "Content-Type": "application/json",
      Cookie: second.cookie,
      "X-CSRF-Token": second.csrf,
    },
  });

  await Promise.all([demoteSecond.reading, demotePrimary.reading]);
  demoteSecond.release();
  demotePrimary.release();
  const responses = await Promise.all([firstRequest, secondRequest]);
  const statuses = responses.map((response) => response.status);
  assert.equal(statuses.filter((status) => status === 200).length, 1);
  assert.ok(statuses.some((status) => status === 401 || status === 409));
  const remaining = await db.prepare(
    `SELECT COUNT(*) AS count FROM users
     WHERE role = 'admin' AND enabled = 1 AND deletion_requested_at IS NULL`,
  ).first();
  assert.equal(remaining.count, 1);
});

test("self-registration is gated, pending approval and supports one-time recovery", async () => {
  assert.deepEqual(await (await request("/api/auth/config")).json(), { registrationEnabled: false });
  assert.equal((await jsonRequest("/api/register", {
    username: "new-member", password: "NewMemberPass123!",
  })).status, 403);

  await signIn();
  const opened = await request("/api/settings/registration", {
    method: "PATCH",
    authenticated: true,
    body: JSON.stringify({ enabled: true }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(opened.status, 200);
  assert.deepEqual(await (await request("/api/auth/config")).json(), { registrationEnabled: true });
  await db.prepare("INSERT INTO account_attempts VALUES (?, ?, 5)")
    .bind(`register:ip:${await digest("192.0.2.55")}`, Math.floor(Date.now() / 1000)).run();
  const blocked = await jsonRequest("/api/register", {
    username: "rate-blocked", password: "NewMemberPass123!",
  }, false, { "CF-Connecting-IP": "192.0.2.55" });
  assert.equal(blocked.status, 429);
  assert.equal(await db.prepare("SELECT * FROM account_attempts WHERE key = 'register:global'").first(), null);
  assert.equal((await jsonRequest("/api/register", {
    username: "cross-origin", password: "NewMemberPass123!",
  }, false, { Origin: "https://evil.test" })).status, 403);

  const registered = await jsonRequest("/api/register", {
    username: "New-Member",
    password: "NewMemberPass123!",
    role: "admin",
    enabled: true,
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  const registration = await registered.json();
  assert.equal(registration.pendingApproval, true);
  assert.match(registration.recoveryCode, /^(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/);
  const stored = await db.prepare("SELECT * FROM users WHERE username = 'new-member'").first();
  assert.equal(stored.role, "user");
  assert.equal(stored.enabled, 0);
  assert.equal(stored.approved_at, null);
  assert.equal(stored.recovery_code_hash, await digest(registration.recoveryCode.replaceAll("-", "")));
  assert.equal((await jsonRequest("/api/login", {
    username: "new-member", password: "NewMemberPass123!",
  })).status, 401);

  const users = await (await request("/api/users", { authenticated: true })).json();
  const pending = users.users.find((user) => user.username === "new-member");
  assert.equal(pending.pendingApproval, true);
  assert.equal((await request(`/api/users/${pending.id}`, {
    method: "PATCH",
    authenticated: true,
    body: JSON.stringify({ enabled: true }),
    headers: { "Content-Type": "application/json" },
  })).status, 200);
  const memberCredentials = await credentialsFor("new-member", "NewMemberPass123!");

  assert.equal((await jsonRequest("/api/password/reset", {
    username: "new-member",
    recoveryCode: "0".repeat(64),
    newPassword: "RecoveredPass456!",
  })).status, 401);
  assert.equal((await jsonRequest("/api/password/reset", {
    username: "new-member",
    recoveryCode: registration.recoveryCode,
    newPassword: "RecoveredPass456!",
  }, false, { Origin: "https://evil.test" })).status, 403);
  const reset = await jsonRequest("/api/password/reset", {
    username: "new-member",
    recoveryCode: registration.recoveryCode,
    newPassword: "RecoveredPass456!",
  });
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.equal((await request("/api/history", { headers: { Cookie: memberCredentials.cookie } })).status, 401);
  assert.equal((await jsonRequest("/api/login", {
    username: "new-member", password: "NewMemberPass123!",
  })).status, 401);
  assert.equal((await jsonRequest("/api/login", {
    username: "new-member", password: "RecoveredPass456!",
  })).status, 200);
  assert.equal((await jsonRequest("/api/password/reset", {
    username: "new-member",
    recoveryCode: registration.recoveryCode,
    newPassword: "AnotherPass789!",
  })).status, 401);
});

test("users manage credentials and account deletion purges their private content", async () => {
  await signIn();
  assert.equal((await request("/api/account", {
    method: "DELETE",
    authenticated: true,
    body: JSON.stringify({ username, currentPassword: password }),
    headers: { "Content-Type": "application/json" },
  })).status, 409);

  const created = await jsonRequest("/api/users", {
    username: "self-service", password: "SelfServicePass123!", role: "user",
  }, true);
  const member = (await created.json()).user;
  useCredentials(await credentialsFor("self-service", "SelfServicePass123!"));

  assert.equal((await jsonRequest("/api/account/recovery-code", {
    currentPassword: "WrongPassword123!",
  }, true)).status, 401);
  assert.equal((await request("/api/history", { authenticated: true })).status, 200);
  const recoveryResponse = await jsonRequest("/api/account/recovery-code", {
    currentPassword: "SelfServicePass123!",
  }, true);
  assert.equal(recoveryResponse.status, 201);
  const recoveryCode = (await recoveryResponse.json()).recoveryCode;
  assert.equal(
    (await db.prepare("SELECT recovery_code_hash FROM users WHERE id = ?").bind(member.id).first()).recovery_code_hash,
    await digest(recoveryCode.replaceAll("-", "")),
  );

  assert.equal((await jsonRequest("/api/account/password", {
    currentPassword: "WrongPassword123!", newPassword: "ChangedSelfPass456!",
  }, true)).status, 401);
  assert.equal((await request("/api/history", { authenticated: true })).status, 200);
  const changed = await jsonRequest("/api/account/password", {
    currentPassword: "SelfServicePass123!", newPassword: "ChangedSelfPass456!",
  }, true);
  assert.equal(changed.status, 200);
  assert.match(changed.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal((await request("/api/history", { authenticated: true })).status, 401);
  assert.equal(
    (await db.prepare("SELECT recovery_code_hash FROM users WHERE id = ?").bind(member.id).first()).recovery_code_hash,
    null,
  );

  useCredentials(await credentialsFor("self-service", "ChangedSelfPass456!"));
  const uploaded = await uploadFile("private-delete.txt", "private contents");
  const fileId = (await uploaded.json()).id;
  await jsonRequest("/api/text", { text: "private text" }, true);
  assert.equal((await request("/api/account", {
    method: "DELETE",
    authenticated: true,
    body: JSON.stringify({ username: "wrong-name", currentPassword: "ChangedSelfPass456!" }),
    headers: { "Content-Type": "application/json" },
  })).status, 400);
  assert.equal((await request("/api/account", {
    method: "DELETE",
    authenticated: true,
    body: JSON.stringify({ username: "self-service", currentPassword: "WrongPassword123!" }),
    headers: { "Content-Type": "application/json" },
  })).status, 401);
  assert.equal((await request("/api/history", { authenticated: true })).status, 200);
  const deleted = await request("/api/account", {
    method: "DELETE",
    authenticated: true,
    body: JSON.stringify({ username: "self-service", currentPassword: "ChangedSelfPass456!" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(deleted.status, 202);
  assert.match(deleted.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal((await request("/api/history", { authenticated: true })).status, 401);
  await maintenance({ DB: db, FILES: bucket });
  assert.equal(await db.prepare("SELECT id FROM users WHERE id = ?").bind(member.id).first(), null);
  assert.equal(await bucket.head(`files/${fileId}`), null);
});

test("account deletion rejects writes that passed authentication before deletion", async () => {
  await signIn();
  const created = await jsonRequest("/api/users", {
    username: "deletion-race", password: "DeletionRacePass123!", role: "user",
  }, true);
  const member = (await created.json()).user;
  useCredentials(await credentialsFor("deletion-race", "DeletionRacePass123!"));
  const memberCredentials = { cookie, csrf };
  const timestamp = Math.floor(Date.now() / 1000);
  await db.batch(Array.from({ length: 51 }, (_, index) => db.prepare(
    `INSERT INTO items(id, owner_user_id, type, content, state, created_at)
     VALUES (?, ?, 'text', ?, 'ready', ?)`,
  ).bind(crypto.randomUUID(), member.id, `existing-${index}`, timestamp)));

  const deferred = deferredJsonBody({ text: "must not survive deletion" });
  const staleWrite = request("/api/text", {
    method: "POST",
    body: deferred.body,
    headers: {
      "Content-Type": "application/json",
      Cookie: memberCredentials.cookie,
      "X-CSRF-Token": memberCredentials.csrf,
      "Idempotency-Key": crypto.randomUUID(),
    },
  });
  await deferred.reading;
  const deleted = await request("/api/account", {
    method: "DELETE",
    authenticated: true,
    body: JSON.stringify({ username: "deletion-race", currentPassword: "DeletionRacePass123!" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(deleted.status, 202);
  deferred.release();
  assert.equal((await staleWrite).status, 401);

  await maintenance({ DB: db, FILES: bucket });
  assert.equal(await db.prepare("SELECT id FROM users WHERE id = ?").bind(member.id).first(), null);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM items WHERE owner_user_id = ?").bind(member.id).first()).count, 0);
});

test("user tenants isolate history, files, mutations and idempotency keys", async () => {
  await signIn();
  const adminCredentials = { cookie, csrf };
  const created = await jsonRequest("/api/users", {
    username: "isolated-user", password: "IsolatedUserPass123!", role: "user",
  }, true);
  assert.equal(created.status, 201);
  const sharedKey = crypto.randomUUID();
  assert.equal((await jsonRequest("/api/text", {
    text: "admin private text",
  }, true, { "Idempotency-Key": sharedKey })).status, 201);
  const adminFile = await uploadFile("admin-private.png", "admin bytes", "image/png", webpPreview);
  const adminFileId = (await adminFile.json()).id;

  useCredentials(await credentialsFor("isolated-user", "IsolatedUserPass123!"));
  let history = await (await request("/api/history", { authenticated: true })).json();
  assert.equal(history.items.length, 0);
  assert.equal((await request(fileDownloadPath(adminFileId, "admin-private.png"), { authenticated: true })).status, 404);
  assert.equal((await request(`/previews/${adminFileId}`, { authenticated: true })).status, 404);
  assert.equal((await request(`/api/uploads/${adminFileId}/preview`, {
    method: "PUT", body: webpPreview, authenticated: true,
    headers: { "Content-Type": "image/webp", "Content-Length": String(webpPreview.length) },
  })).status, 404);
  assert.equal((await jsonRequest(`/api/history/${adminFileId}/share`, { hours: 1 }, true)).status, 404);
  assert.equal((await request(`/api/history/${adminFileId}`, { method: "DELETE", authenticated: true })).status, 404);
  assert.equal((await jsonRequest("/api/text", {
    text: "member private text",
  }, true, { "Idempotency-Key": sharedKey })).status, 201);
  history = await (await request("/api/history", { authenticated: true })).json();
  assert.deepEqual(history.items.map((item) => item.content), ["member private text"]);

  useCredentials(adminCredentials);
  history = await (await request("/api/history", { authenticated: true })).json();
  assert.equal(history.items.some((item) => item.content === "admin private text"), true);
  assert.equal(history.items.some((item) => item.content === "member private text"), false);

  useCredentials(await credentialsFor("isolated-user", "IsolatedUserPass123!"));
  await request("/api/clear_history", { method: "POST", authenticated: true });
  useCredentials(adminCredentials);
  history = await (await request("/api/history", { authenticated: true })).json();
  assert.equal(history.items.some((item) => item.content === "admin private text"), true);
});

test("login rate limits survive parallel requests and apply globally", async () => {
  await db.prepare("INSERT INTO login_attempts VALUES ('global', ?, 100)").bind(Math.floor(Date.now() / 1000)).run();
  const blocked = await jsonRequest("/api/login", { username, password }, false, { "CF-Connecting-IP": "192.0.2.9" });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
  await db.prepare("DELETE FROM login_attempts").run();
  await db.prepare("INSERT INTO login_attempts VALUES (?, ?, 9)")
    .bind(`ip:${await digest("192.0.2.1")}`, Math.floor(Date.now() / 1000)).run();
  const statuses = await Promise.all([1, 2, 3].map(async () =>
    (await jsonRequest("/api/login", { username, password: "wrong" })).status));
  assert.deepEqual(statuses.sort(), [401, 429, 429]);
  await db.prepare("UPDATE login_attempts SET started_at = 1").run();
  assert.equal((await jsonRequest("/api/login", { username, password })).status, 200);
});

test("text validation, preservation, pagination and revisions", async () => {
  await signIn();
  const admin = await db.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  for (const text of ["", "   ", null, 123]) assert.equal((await jsonRequest("/api/text", { text }, true)).status, 400);
  assert.equal((await jsonRequest("/api/text", { text: "a".repeat(131073) }, true)).status, 413);
  const text = "  <script>alert('text')</script>\n中文内容  ";
  assert.equal((await jsonRequest("/api/text", { text }, true)).status, 201);
  let history = await (await request("/api/history", { authenticated: true })).json();
  assert.equal(history.items[0].content, text);
  assert.equal(history.revision, 1);
  await db.batch(Array.from({ length: 53 }, (_, i) => db.prepare(
    "INSERT INTO items(id, owner_user_id, type, content, state, created_at) VALUES (?, ?, 'text', ?, 'ready', 1)",
  ).bind(crypto.randomUUID(), admin.id, `page-${i}`)));
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

async function multipartMetadata(name, body, chunkSize = 5 * 1024 * 1024, mediaType = "") {
  const partChecksums = [];
  for (let offset = 0; offset < body.length; offset += chunkSize) {
    partChecksums.push(await checksum(body.subarray(offset, Math.min(offset + chunkSize, body.length))));
  }
  const fileFingerprint = await checksum(Buffer.from(JSON.stringify([
    "multipart-file-v1", body.length, chunkSize, partChecksums,
  ])));
  return { name, size: body.length, mediaType, chunkSize, fileFingerprint, partChecksums };
}

async function uploadFile(name, value = "file contents", mediaType = "", preview = null) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const metadata = await multipartMetadata(name, body, 5 * 1024 * 1024, mediaType);
  const initiated = await jsonRequest("/api/uploads", metadata, true, { "Idempotency-Key": crypto.randomUUID() });
  if (!initiated.ok) return initiated;
  const upload = await initiated.clone().json();
  if (upload.complete) return initiated;
  if (preview) {
    const previewResponse = await request(`/api/uploads/${upload.id}/preview`, {
      method: "PUT", body: preview, authenticated: true,
      headers: { "Content-Type": "image/webp", "Content-Length": String(preview.length) },
    });
    if (!previewResponse.ok) return previewResponse;
  }
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
  const path = fileDownloadPath(id, "资料.html");
  const second = await uploadFile("资料.html");
  assert.notEqual((await second.json()).id, id);
  const response = await request(path, { authenticated: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
  assert.match(response.headers.get("Content-Disposition"), /^attachment;/);
  assert.match(response.headers.get("Content-Disposition"), /%E8%B5%84%E6%96%99/);
  assert.equal(await response.text(), "<script>alert(1)</script>");
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(`/uploads/${id}`, { authenticated: true })).status, 404);
  assert.equal((await request(fileDownloadPath(id, "different.html"), { authenticated: true })).status, 404);
  const head = await request(path, { authenticated: true, method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("Accept-Ranges"), "bytes");
  assert.match(head.headers.get("ETag"), /^".+"$/);
  assert.ok(Date.parse(head.headers.get("Last-Modified")));
  const partial = await request(path, { authenticated: true, headers: { Range: "bytes=1-6" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 1-6/25");
  assert.equal(await partial.text(), "script");
  const suffix = await request(path, { authenticated: true, headers: { Range: "bytes=-3" } });
  assert.equal(await suffix.text(), "pt>");
  const [left, right] = await Promise.all([
    request(path, { authenticated: true, headers: { Range: "bytes=0-7" } }),
    request(path, { authenticated: true, headers: { Range: "bytes=8-24" } }),
  ]);
  assert.equal(left.status, 206);
  assert.equal(right.status, 206);
  assert.equal(`${await left.text()}${await right.text()}`, "<script>alert(1)</script>");
  assert.equal((await request(path, { authenticated: true, headers: { Range: "bytes=999-" } })).status, 416);
  const empty = await uploadFile("empty.txt", "");
  assert.equal(empty.status, 201);
  const emptyId = (await empty.json()).id;
  assert.equal(await (await request(fileDownloadPath(emptyId, "empty.txt"), { authenticated: true })).text(), "");
});

test("temporary file links enforce duration, replace old tokens and download without authentication", async () => {
  await signIn();
  const uploaded = await uploadFile("temporary.txt", "temporary file contents");
  const { id } = await uploaded.json();
  for (const hours of [0, 169, 1.5, "24", null]) {
    const invalid = await jsonRequest(`/api/history/${id}/share`, { hours }, true);
    assert.equal(invalid.status, 400, `${hours}`);
  }
  assert.equal((await jsonRequest(`/api/history/${crypto.randomUUID()}/share`, { hours: 1 }, true)).status, 404);

  const startedAt = Math.floor(Date.now() / 1000);
  const created = await jsonRequest(`/api/history/${id}/share`, { hours: 1 }, true);
  assert.equal(created.status, 201, await created.clone().text());
  const first = await created.json();
  const firstUrl = new URL(first.url);
  const firstToken = firstUrl.pathname.split("/")[2];
  assert.equal(firstUrl.origin, origin);
  assert.match(firstUrl.pathname, /^\/shared\/[a-f0-9]{64}\/temporary\.txt$/);
  assert.ok(first.expiresAt >= startedAt + 3600 && first.expiresAt <= Math.floor(Date.now() / 1000) + 3600);
  const stored = await db.prepare("SELECT * FROM file_shares WHERE item_id = ?").bind(id).first();
  assert.equal(stored.token_hash, await digest(firstToken));
  assert.notEqual(stored.token_hash, firstToken);
  const history = await (await request("/api/history", { authenticated: true })).json();
  assert.equal(history.items.find((item) => item.id === id).share_expires_at, first.expiresAt);

  const publicDownload = await request(firstUrl.pathname);
  assert.equal(publicDownload.status, 200);
  assert.equal(await publicDownload.text(), "temporary file contents");
  assert.equal(publicDownload.headers.get("Set-Cookie"), null);
  const publicHead = await request(firstUrl.pathname, { method: "HEAD" });
  assert.equal(publicHead.status, 200);
  assert.equal(publicHead.headers.get("Content-Length"), "23");
  const publicRange = await request(firstUrl.pathname, { headers: { Range: "bytes=10-13" } });
  assert.equal(publicRange.status, 206);
  assert.equal(await publicRange.text(), "file");
  assert.equal((await request(fileDownloadPath(id, "temporary.txt"))).status, 401);
  const wrongTemporaryName = await request(`/shared/${firstToken}/different.txt`);
  assert.equal(wrongTemporaryName.status, 404);
  assert.deepEqual(await wrongTemporaryName.json(), {
    success: false,
    message: "Temporary file link not found or expired.",
  });

  const replaced = await jsonRequest(`/api/history/${id}/share`, { hours: 168 }, true);
  assert.equal(replaced.status, 201);
  const second = await replaced.json();
  assert.notEqual(second.url, first.url);
  const replacedLink = await request(firstUrl.pathname);
  assert.equal(replacedLink.status, 404);
  assert.deepEqual(await replacedLink.json(), {
    success: false,
    message: "Temporary file link not found or expired.",
  });
  assert.equal((await request(new URL(second.url).pathname)).status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM file_shares WHERE item_id = ?").bind(id).first()).n, 1);

  await db.prepare("UPDATE file_shares SET expires_at = ? WHERE item_id = ?").bind(startedAt - 1, id).run();
  const expiredLink = await request(new URL(second.url).pathname);
  assert.equal(expiredLink.status, 404);
  assert.deepEqual(await expiredLink.json(), {
    success: false,
    message: "Temporary file link not found or expired.",
  });
  const expiredHistory = await (await request("/api/history", { authenticated: true })).json();
  assert.equal(expiredHistory.items.find((item) => item.id === id).share_expires_at, null);
  assert.equal((await request(`/api/history/${id}/share`, { method: "DELETE", authenticated: true })).status, 200);
  assert.equal((await request(new URL(second.url).pathname)).status, 404);
  assert.equal((await request(`/api/history/${id}/share`, { method: "DELETE", authenticated: true })).status, 404);
  const invalidLink = await request("/shared/not-a-token");
  assert.equal(invalidLink.status, 404);
  assert.deepEqual(await invalidLink.json(), {
    success: false,
    message: "Temporary file link not found or expired.",
  });
});

test("image previews are authenticated, inline and limited to safe raster types", async () => {
  await signIn();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const uploaded = await uploadFile("pixel.png", png, "image/png", webpPreview);
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const { id } = await uploaded.json();
  const history = await (await request("/api/history", { authenticated: true })).json();
  assert.equal(history.items[0].media_type, "image/png");
  const imagePath = `/images/${id}/pixel.png`;
  assert.equal((await request(imagePath)).status, 401);
  const image = await request(imagePath, { authenticated: true });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("Content-Type"), "image/png");
  assert.match(image.headers.get("Content-Disposition"), /^inline;/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const imageHead = await request(imagePath, { authenticated: true, method: "HEAD" });
  assert.equal(imageHead.status, 200);
  assert.equal(await imageHead.text(), "");
  assert.equal(imageHead.headers.get("Accept-Ranges"), "bytes");
  const imageRange = await request(imagePath, { authenticated: true, headers: { Range: "bytes=0-7" } });
  assert.equal(imageRange.status, 206);
  assert.deepEqual(Buffer.from(await imageRange.arrayBuffer()), png.subarray(0, 8));
  assert.equal((await request(`/images/${id}/different.png`, { authenticated: true })).status, 404);
  assert.equal((await request(`/previews/${id}`)).status, 401);
  const preview = await request(`/previews/${id}`, { authenticated: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("Content-Type"), "image/webp");
  assert.equal(preview.headers.get("Content-Disposition"), "inline");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), webpPreview);
  const head = await request(`/previews/${id}`, { authenticated: true, method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await request(`/api/uploads/${id}/preview`, {
    method: "PUT", body: webpPreview,
    headers: { "Content-Type": "image/webp", "Content-Length": String(webpPreview.length) },
  })).status, 401);
  assert.equal((await request(`/api/uploads/${id}/preview`, {
    method: "PUT", body: webpPreview, authenticated: true,
    headers: { "Content-Type": "image/png", "Content-Length": String(webpPreview.length) },
  })).status, 415);
  assert.equal((await request(`/api/uploads/${id}/preview`, {
    method: "PUT", body: Buffer.alloc(12), authenticated: true,
    headers: { "Content-Type": "image/webp", "Content-Length": "12" },
  })).status, 400);

  const svg = await uploadFile("active.svg", "<svg><script>alert(1)</script></svg>", "image/svg+xml");
  const svgId = (await svg.json()).id;
  const updated = await (await request("/api/history", { authenticated: true })).json();
  assert.equal(updated.items.find((item) => item.id === svgId).media_type, null);
  assert.equal((await request(`/previews/${svgId}`, { authenticated: true })).status, 404);
  assert.equal((await request(`/images/${svgId}/active.svg`, { authenticated: true })).status, 404);
  assert.equal((await request(fileDownloadPath(svgId, "active.svg"), { authenticated: true })).headers.get("Content-Type"), "application/octet-stream");
  assert.equal((await request(`/api/history/${id}`, { method: "DELETE", authenticated: true })).status, 202);
  assert.equal((await request(`/previews/${id}`, { authenticated: true })).status, 404);
  assert.equal((await request(imagePath, { authenticated: true })).status, 404);
  await maintenance({ DB: db, FILES: bucket });
  assert.equal(await bucket.head(`files/${id}/preview`), null);

  const opaque = await uploadFile("opaque.webp", Buffer.from([0]), "application/octet-stream");
  const opaqueId = (await opaque.json()).id;
  const opaqueHistory = await (await request("/api/history", { authenticated: true })).json();
  assert.equal(opaqueHistory.items.find((item) => item.id === opaqueId).media_type, null);
  assert.equal((await request(`/previews/${opaqueId}`, { authenticated: true })).status, 404);
  assert.equal((await request(`/images/${opaqueId}/opaque.webp`, { authenticated: true })).status, 404);
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
  const object = Buffer.from(await (await request(fileDownloadPath(upload.id, "resume.bin"), { authenticated: true })).arrayBuffer());
  assert.deepEqual(object, Buffer.concat([firstPart, lastPart]));
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM multipart_uploads").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM multipart_parts").first()).n, 0);
});

test("invalid filenames and oversized uploads never publish history", async () => {
  await signIn();
  for (const name of ["", ".", "..", "../file", "path\\file", "nul\u0000.txt", "a".repeat(256)]) {
    assert.equal((await uploadFile(name)).status, 400);
  }
  const large = await jsonRequest("/api/uploads", { name: "large.bin", size: 6291457 }, true);
  assert.equal(large.status, 413);
  const malformed = await jsonRequest("/api/uploads", {
    name: "bad.bin", size: 1, chunkSize: 5 * 1024 * 1024, fileFingerprint: "invalid",
  }, true);
  assert.equal(malformed.status, 400);
  const invalidMediaType = await jsonRequest("/api/uploads", {
    name: "bad.bin", size: 1, mediaType: 123, chunkSize: 5 * 1024 * 1024, fileFingerprint: "0".repeat(64),
  }, true);
  assert.equal(invalidMediaType.status, 400);
  assert.equal((await (await request("/api/history", { authenticated: true })).json()).items.length, 0);
});

test("delete and clear revoke downloads immediately and cleanup removes R2 objects", async () => {
  await signIn();
  const admin = await db.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  const { id } = await (await uploadFile("delete.txt")).json();
  const response = await request(`/api/history/${id}`, { method: "DELETE", authenticated: true });
  assert.equal(response.status, 202);
  assert.equal((await request(fileDownloadPath(id, "delete.txt"), { authenticated: true })).status, 404);
  await maintenance({ DB: db, FILES: bucket });
  assert.equal(await bucket.head(`files/${id}`), null);
  await uploadFile("clear.txt");
  await jsonRequest("/api/text", { text: "clear text" }, true);
  const pendingId = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO items(id, owner_user_id, type, state, created_at) VALUES (?, ?, 'file', 'pending', ?)",
  ).bind(pendingId, admin.id, Math.floor(Date.now() / 1000)).run();
  assert.equal((await request("/api/clear_history", { method: "POST", authenticated: true })).status, 202);
  assert.equal((await (await request("/api/history", { authenticated: true })).json()).items.length, 0);
  // A pending upload cannot be published once clear has marked it (or removed it).
  const publish = await db.prepare("UPDATE items SET state = 'ready' WHERE id = ? AND state = 'pending'").bind(pendingId).run();
  assert.equal(publish.meta.changes, 0);
  await maintenance({ DB: db, FILES: bucket });
  assert.equal((await bucket.list()).objects.length, 0);
});

test("expired sessions, login counters and abandoned uploads are cleaned", async () => {
  await signIn();
  const admin = await db.prepare("SELECT id, auth_version FROM users WHERE username = ?").bind(username).first();
  await db.prepare("UPDATE sessions SET expires_at = 1").run();
  const id = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO items(id, owner_user_id, type, state, created_at) VALUES (?, ?, 'file', 'pending', 1)",
  ).bind(id, admin.id).run();
  await bucket.put(`files/${id}`, "partial");
  const multipartId = crypto.randomUUID();
  const operationKey = crypto.randomUUID();
  const multipart = await bucket.createMultipartUpload(`files/${multipartId}`);
  await db.batch([
    db.prepare(
      `INSERT INTO items(id, owner_user_id, type, name, size, state, created_at)
       VALUES (?, ?, 'file', 'expired.bin', 1, 'pending', 1)`,
    ).bind(multipartId, admin.id),
    db.prepare(
      `INSERT INTO operations(user_id, request_key, fingerprint, item_id, state, created_at)
       VALUES (?, ?, 'expired', ?, 'pending', 1)`,
    ).bind(admin.id, operationKey, multipartId),
    db.prepare(
      `INSERT INTO multipart_uploads(
        item_id, user_id, upload_id, operation_key, chunk_size, total_parts, state, updated_at
       ) VALUES (?, ?, ?, ?, 5242880, 1, 'uploading', 1)`,
    ).bind(multipartId, admin.id, multipart.uploadId, operationKey),
  ]);
  await db.prepare("INSERT INTO sessions VALUES ('old', ?, 'csrf', ?, 1)").bind(admin.id, admin.auth_version).run();
  await db.prepare("INSERT INTO login_attempts VALUES ('old', 1, 1)").run();
  await db.prepare("UPDATE login_attempts SET started_at = 1").run();
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
    assert.match(response.headers.get("Content-Security-Policy"), /manifest-src 'self'/);
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
    assert.equal((await jsonRequest("/api/login", { username, password: "wrong" })).status, 429);
  }
  assert.equal(await db.prepare("SELECT * FROM login_attempts WHERE key = 'global'").first(), null);
  assert.equal((await jsonRequest("/api/login", { username, password }, false, { "CF-Connecting-IP": "192.0.2.2" })).status, 200);
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
  const admin = await db.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  await db.batch(Array.from({ length: 120 }, () => db.prepare(
    `INSERT INTO items(id, owner_user_id, type, content, state, created_at)
     VALUES (?, ?, 'text', 'old', 'deleting', 1)`,
  ).bind(crypto.randomUUID(), admin.id)));
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
  const admin = await db.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  await db.prepare(
    `INSERT INTO operations(user_id, request_key, fingerprint, item_id, state, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).bind(admin.id, key, fingerprint, oldId, Math.floor(Date.now() / 1000)).run();
  const send = () => jsonRequest("/api/text", { text: "retry after failure" }, true, { "Idempotency-Key": key });
  assert.equal((await send()).status, 409);
  await db.prepare("UPDATE operations SET state = 'failed' WHERE request_key = ?").bind(key).run();
  const response = await send();
  assert.equal(response.status, 201);
  assert.notEqual((await response.json()).id, oldId);
  assert.equal((await send()).status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM items").first()).n, 1);
});
