import {
  HttpError, configuration, createPasswordVerifier, digest, getSession, localHttp, login, normalizeUsername,
  now, randomToken, readJson, requireCsrf, requireOrigin, sessionCookie, validatePassword, verifyStoredPassword,
} from "./auth.js";

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const revision = (env, userId) => env.DB.prepare(
  "UPDATE users SET content_revision = content_revision + 1 WHERE id = ? AND changes() > 0",
).bind(userId);
const objectKey = (id) => `files/${id}`;
const previewObjectKey = (id) => `${objectKey(id)}/preview`;
const previewLimit = 256 * 1024;
const validId = (id) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const encoder = new TextEncoder();
const publicAssets = new Map([
  ["/assets/app.js", "/assets/app.js"],
  ["/assets/style.css", "/assets/style.css"],
  ["/favicon.ico", "/favicon.svg"],
  ["/favicon.svg", "/favicon.svg"],
]);
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const temporaryShareToken = /^[a-f0-9]{64}$/;
const recoveryCodeToken = /^[a-f0-9]{64}$/;
const imageExtensions = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
]);
const sha256 = async (value) => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", value)),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");

function validFilename(name) {
  return typeof name === "string" && Boolean(name.trim()) && encoder.encode(name).length <= 255 &&
    ![".", ".."].includes(name) && !/[\/\\\u0000-\u001f\u007f]/.test(name);
}

function decodeFilename(value) {
  try {
    const name = decodeURIComponent(value || "");
    return validFilename(name) ? name : null;
  } catch {
    return null;
  }
}

function protectedDownloadPath(value) {
  const match = /^\/uploads\/([^/?#]+)\/([^/?#]+)$/.exec(value || "");
  const name = match && decodeFilename(match[2]);
  return match && validId(match[1]) && name ? { path: match[0], id: match[1], name } : null;
}

function safeDownloadPath(value) {
  return protectedDownloadPath(value)?.path || "/";
}

function validateFile(name, size, config) {
  if (!validFilename(name)) {
    throw new HttpError(400, "Invalid filename (maximum 255 UTF-8 bytes; no paths or control characters).");
  }
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "Invalid file size.");
  if (size > config.uploadLimit) throw new HttpError(413, `File exceeds ${config.uploadLimit} bytes.`);
}

function imageMediaType(value, name) {
  const supplied = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (imageTypes.has(supplied)) return supplied;
  if (supplied) return null;
  const extension = typeof name === "string" ? name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] : null;
  return imageExtensions.get(extension) || null;
}

function requireAdmin(session) {
  if (session.role !== "admin") throw new HttpError(403, "Administrator access required.");
}

async function requireAnotherEnabledAdmin(env, userId) {
  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM users
     WHERE role = 'admin' AND enabled = 1 AND id != ? AND deletion_requested_at IS NULL`,
  ).bind(userId).first();
  if (!remaining.count) throw new HttpError(409, "At least one enabled administrator is required.");
}

async function requireCurrentPassword(env, userId, password) {
  if (typeof password !== "string" || Array.from(password).length > 32) {
    throw new HttpError(400, "Invalid current password.");
  }
  const user = await env.DB.prepare(
    `SELECT id, role, enabled, password_verifier FROM users
     WHERE id = ? AND deletion_requested_at IS NULL`,
  ).bind(userId).first();
  if (!user || !await verifyStoredPassword(password, user.password_verifier)) {
    throw new HttpError(401, "Current password is incorrect.");
  }
  return user;
}

const userView = (user) => ({
  id: user.id,
  username: user.username,
  role: user.role,
  enabled: Boolean(user.enabled),
  pendingApproval: !user.approved_at,
  createdAt: user.created_at,
  updatedAt: user.updated_at,
});

async function listUsers(env, session) {
  requireAdmin(session);
  const { results } = await env.DB.prepare(
    `SELECT id, username, role, enabled, approved_at, created_at, updated_at
     FROM users WHERE deletion_requested_at IS NULL ORDER BY username COLLATE NOCASE`,
  ).all();
  return json({ users: results.map(userView) });
}

async function createUser(request, env, session) {
  requireAdmin(session);
  const data = await readJson(request, 4096);
  let username;
  let verifier;
  try {
    username = normalizeUsername(data.username);
    verifier = await createPasswordVerifier(data.password);
  } catch (error) {
    throw new HttpError(400, error.message);
  }
  const role = data.role === undefined ? "user" : data.role;
  if (!["admin", "user"].includes(role)) throw new HttpError(400, "Invalid user role.");
  if (await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first()) {
    throw new HttpError(409, "Username already exists.");
  }
  const id = crypto.randomUUID();
  const timestamp = now();
  try {
    await env.DB.prepare(
      `INSERT INTO users(
        id, username, password_verifier, role, enabled, auth_version, created_at, updated_at, approved_at
       ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`,
    ).bind(id, username, verifier, role, timestamp, timestamp, timestamp).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "Username already exists.");
    throw error;
  }
  return json({ success: true, user: userView({
    id, username, role, enabled: 1, approved_at: timestamp, created_at: timestamp, updated_at: timestamp,
  }) }, 201);
}

async function updateUser(request, env, session, id) {
  requireAdmin(session);
  if (!validId(id)) throw new HttpError(404, "User not found.");
  const target = await env.DB.prepare(
    "SELECT * FROM users WHERE id = ? AND deletion_requested_at IS NULL",
  ).bind(id).first();
  if (!target) throw new HttpError(404, "User not found.");
  const data = await readJson(request, 4096);
  let username = target.username;
  let verifier = target.password_verifier;
  try {
    if (data.username !== undefined) username = normalizeUsername(data.username);
    if (data.password !== undefined) verifier = await createPasswordVerifier(data.password);
  } catch (error) {
    throw new HttpError(400, error.message);
  }
  const role = data.role === undefined ? target.role : data.role;
  if (data.enabled !== undefined && typeof data.enabled !== "boolean") {
    throw new HttpError(400, "Invalid enabled state.");
  }
  const enabled = data.enabled === undefined ? target.enabled : Number(data.enabled);
  if (!["admin", "user"].includes(role)) {
    throw new HttpError(400, "Invalid user role or enabled state.");
  }
  if (id === session.user_id && (role !== "admin" || enabled !== 1)) {
    throw new HttpError(409, "The current administrator cannot disable or demote itself.");
  }
  if (target.role === "admin" && target.enabled === 1 && (role !== "admin" || enabled !== 1)) {
    await requireAnotherEnabledAdmin(env, id);
  }
  const duplicate = await env.DB.prepare("SELECT id FROM users WHERE username = ? AND id != ?").bind(username, id).first();
  if (duplicate) throw new HttpError(409, "Username already exists.");
  const timestamp = now();
  const passwordChanged = data.password !== undefined;
  const approvedAt = enabled ? (target.approved_at || timestamp) : target.approved_at;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users SET username = ?, password_verifier = ?, role = ?, enabled = ?,
         recovery_code_hash = ?, recovery_code_created_at = ?, approved_at = ?,
         auth_version = auth_version + 1, updated_at = ? WHERE id = ?`,
      ).bind(
        username, verifier, role, enabled,
        passwordChanged ? null : target.recovery_code_hash,
        passwordChanged ? null : target.recovery_code_created_at,
        approvedAt, timestamp, id,
      ),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "Username already exists.");
    throw error;
  }
  const signedOut = id === session.user_id;
  return json(
    { success: true, signedOut },
    200,
    signedOut ? { "Set-Cookie": sessionCookie(request, env, "", 0) } : {},
  );
}

async function deleteUser(env, ctx, session, id) {
  requireAdmin(session);
  if (!validId(id)) throw new HttpError(404, "User not found.");
  const target = await env.DB.prepare(
    "SELECT id, role, enabled FROM users WHERE id = ? AND deletion_requested_at IS NULL",
  ).bind(id).first();
  if (!target) throw new HttpError(404, "User not found.");
  if (id === session.user_id) throw new HttpError(409, "The current administrator cannot delete itself.");
  if (target.role === "admin" && target.enabled === 1) {
    await requireAnotherEnabledAdmin(env, id);
  }
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET enabled = 0, auth_version = auth_version + 1,
       deletion_requested_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(timestamp, timestamp, id),
    env.DB.prepare("UPDATE items SET state = 'deleting' WHERE owner_user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
  ]);
  backgroundCleanup(env, ctx);
  return json({ success: true }, 202);
}

function formatRecoveryCode(token) {
  return token.match(/.{8}/g).join("-");
}

function normalizeRecoveryCode(value) {
  const token = typeof value === "string" ? value.trim().toLowerCase().replaceAll("-", "") : "";
  if (!recoveryCodeToken.test(token)) throw new HttpError(400, "Invalid recovery code.");
  return token;
}

async function limitAccountAction(request, env, config, action, ipLimit, globalLimit) {
  const ip = request.headers.get("CF-Connecting-IP") || (localHttp(request, env) ? "local" : null);
  if (!ip) throw new HttpError(503, "Client IP unavailable.");
  const timestamp = now();
  for (const [key, limit] of [
    [`${action}:ip:${await digest(ip)}`, ipLimit],
    [`${action}:global`, globalLimit],
  ]) {
    const counter = await env.DB.prepare(`
      INSERT INTO account_attempts(key, started_at, attempts) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        attempts = CASE WHEN started_at <= ? THEN 1 ELSE MIN(attempts + 1, ?) END,
        started_at = CASE WHEN started_at <= ? THEN excluded.started_at ELSE started_at END
      RETURNING attempts, started_at
    `).bind(
      key, timestamp, timestamp - config.accountWindow, limit + 1, timestamp - config.accountWindow,
    ).first();
    if (counter.attempts > limit) {
      const retry = Math.max(counter.started_at + config.accountWindow - timestamp, 1);
      throw new HttpError(429, "Too many account requests. Try again later.", { "Retry-After": String(retry) });
    }
  }
}

async function authConfiguration(env) {
  const state = await env.DB.prepare(
    "SELECT self_registration_enabled FROM app_state WHERE id = 1",
  ).first();
  return json({ registrationEnabled: Boolean(state?.self_registration_enabled) });
}

async function updateRegistration(request, env, session) {
  requireAdmin(session);
  const data = await readJson(request, 1024);
  if (typeof data.enabled !== "boolean") throw new HttpError(400, "Invalid registration state.");
  await env.DB.prepare(
    "UPDATE app_state SET self_registration_enabled = ? WHERE id = 1",
  ).bind(Number(data.enabled)).run();
  return json({ success: true, registrationEnabled: data.enabled });
}

async function registerUser(request, env, config) {
  requireOrigin(request);
  const state = await env.DB.prepare(
    "SELECT self_registration_enabled FROM app_state WHERE id = 1",
  ).first();
  if (!state?.self_registration_enabled) throw new HttpError(403, "Self-registration is closed.");
  const data = await readJson(request, 4096);
  let username;
  try {
    username = normalizeUsername(data.username);
    validatePassword(data.password);
  } catch (error) {
    throw new HttpError(400, error.message);
  }
  await limitAccountAction(
    request, env, config, "register", config.registrationIpLimit, config.registrationGlobalLimit,
  );
  if (await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first()) {
    throw new HttpError(409, "Username already exists.");
  }
  const verifier = await createPasswordVerifier(data.password);
  const token = randomToken();
  const timestamp = now();
  try {
    await env.DB.prepare(
      `INSERT INTO users(
        id, username, password_verifier, role, enabled, auth_version, recovery_code_hash,
        recovery_code_created_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'user', 0, 1, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), username, verifier, await digest(token), timestamp, timestamp, timestamp,
    ).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "Username already exists.");
    throw error;
  }
  return json({
    success: true,
    pendingApproval: true,
    recoveryCode: formatRecoveryCode(token),
  }, 201);
}

async function resetPassword(request, env, config) {
  requireOrigin(request);
  const data = await readJson(request, 4096);
  let username;
  let recoveryCode;
  try {
    username = normalizeUsername(data.username);
    recoveryCode = normalizeRecoveryCode(data.recoveryCode);
    validatePassword(data.newPassword);
  } catch (error) {
    throw new HttpError(400, error.message);
  }
  await limitAccountAction(
    request, env, config, "reset", config.resetIpLimit, config.resetGlobalLimit,
  );
  const user = await env.DB.prepare(
    `SELECT id, recovery_code_hash FROM users
     WHERE username = ? AND deletion_requested_at IS NULL`,
  ).bind(username).first();
  if (!user || user.recovery_code_hash !== await digest(recoveryCode)) {
    throw new HttpError(401, "Username or recovery code is incorrect.");
  }
  const verifier = await createPasswordVerifier(data.newPassword);
  const timestamp = now();
  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET password_verifier = ?, recovery_code_hash = NULL,
       recovery_code_created_at = NULL, auth_version = auth_version + 1, updated_at = ?
       WHERE id = ? AND recovery_code_hash = ?`,
    ).bind(verifier, timestamp, user.id, user.recovery_code_hash),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
  ]);
  if (!updated.meta.changes) throw new HttpError(401, "Username or recovery code is incorrect.");
  return json({ success: true });
}

async function changeOwnPassword(request, env, session) {
  const data = await readJson(request, 4096);
  try {
    validatePassword(data.newPassword);
  } catch (error) {
    throw new HttpError(400, error.message);
  }
  await requireCurrentPassword(env, session.user_id, data.currentPassword);
  const verifier = await createPasswordVerifier(data.newPassword);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET password_verifier = ?, recovery_code_hash = NULL,
       recovery_code_created_at = NULL, auth_version = auth_version + 1, updated_at = ? WHERE id = ?`,
    ).bind(verifier, now(), session.user_id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(session.user_id),
  ]);
  return json(
    { success: true },
    200,
    { "Set-Cookie": sessionCookie(request, env, "", 0) },
  );
}

async function createRecoveryCode(request, env, session) {
  const data = await readJson(request, 2048);
  await requireCurrentPassword(env, session.user_id, data.currentPassword);
  const token = randomToken();
  const timestamp = now();
  await env.DB.prepare(
    "UPDATE users SET recovery_code_hash = ?, recovery_code_created_at = ?, updated_at = ? WHERE id = ?",
  ).bind(await digest(token), timestamp, timestamp, session.user_id).run();
  return json({ success: true, recoveryCode: formatRecoveryCode(token) }, 201);
}

async function deleteOwnAccount(request, env, ctx, session) {
  const data = await readJson(request, 2048);
  if (data.username !== session.username) throw new HttpError(400, "Username confirmation does not match.");
  const target = await requireCurrentPassword(env, session.user_id, data.currentPassword);
  if (target.role === "admin" && target.enabled === 1) {
    await requireAnotherEnabledAdmin(env, target.id);
  }
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET enabled = 0, auth_version = auth_version + 1,
       deletion_requested_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(timestamp, timestamp, target.id),
    env.DB.prepare("UPDATE items SET state = 'deleting' WHERE owner_user_id = ?").bind(target.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id),
  ]);
  backgroundCleanup(env, ctx);
  return json(
    { success: true },
    202,
    { "Set-Cookie": sessionCookie(request, env, "", 0) },
  );
}

function harden(response, request, env, session) {
  const result = new Response(response.body, response);
  const publicAsset = publicAssets.has(new URL(request.url).pathname);
  if (session?.renewed && session.token && !result.headers.has("Set-Cookie")) {
    result.headers.set("Set-Cookie", sessionCookie(request, env, session.token, session.ttl));
  }
  result.headers.set("Cache-Control", publicAsset && (response.ok || response.status === 304) ? "public, max-age=0, must-revalidate" : "no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("X-Frame-Options", "DENY");
  result.headers.set("Referrer-Policy", "no-referrer");
  result.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  result.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  result.headers.set("Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
  if (new URL(request.url).protocol === "https:") {
    result.headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  return result;
}

async function asset(request, env, path) {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const headers = new Headers();
  for (const name of ["If-None-Match", "If-Modified-Since"]) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  }
  return env.ASSETS.fetch(new Request(url, { method: request.method, headers }));
}

async function beginOperation(request, env, userId, fingerprint) {
  const key = request.headers.get("Idempotency-Key") || crypto.randomUUID();
  if (!validId(key)) throw new HttpError(400, "Idempotency-Key must be a UUID v4.");
  const id = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `INSERT OR IGNORE INTO operations(user_id, request_key, fingerprint, item_id, state, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).bind(userId, key, fingerprint, id, now()).run();
  if (claimed.meta.changes) return { id, key };
  const previous = await env.DB.prepare(
    "SELECT * FROM operations WHERE user_id = ? AND request_key = ?",
  ).bind(userId, key).first();
  if (!previous || previous.fingerprint !== fingerprint) throw new HttpError(409, "Idempotency key belongs to different content.");
  if (previous.state === "failed") {
    const retry = await env.DB.prepare(
      `UPDATE operations SET state = 'pending', item_id = ?, created_at = ?
       WHERE user_id = ? AND request_key = ? AND state = 'failed' AND item_id = ?`,
    ).bind(id, now(), userId, key, previous.item_id).run();
    if (retry.meta.changes) return { id, key };
  }
  if (previous.state !== "done") {
    throw new HttpError(409, "Operation is still processing. Retry later with the same key.");
  }
  const item = await env.DB.prepare(
    "SELECT id FROM items WHERE id = ? AND owner_user_id = ? AND state = 'ready'",
  ).bind(previous.item_id, userId).first();
  if (!item) throw new HttpError(410, "This operation completed but its item has been deleted.");
  return { id: previous.item_id, key, replay: true };
}

async function beginMultipartOperation(request, env, userId, fingerprint) {
  const key = request.headers.get("Idempotency-Key") || crypto.randomUUID();
  if (!validId(key)) throw new HttpError(400, "Idempotency-Key must be a UUID v4.");
  const id = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `INSERT OR IGNORE INTO operations(user_id, request_key, fingerprint, item_id, state, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).bind(userId, key, fingerprint, id, now()).run();
  if (claimed.meta.changes) return { id, key };

  const previous = await env.DB.prepare(
    "SELECT * FROM operations WHERE user_id = ? AND request_key = ?",
  ).bind(userId, key).first();
  if (!previous || previous.fingerprint !== fingerprint) throw new HttpError(409, "Idempotency key belongs to different content.");
  if (previous.state === "done") {
    const item = await env.DB.prepare(
      "SELECT id FROM items WHERE id = ? AND owner_user_id = ? AND state = 'ready'",
    ).bind(previous.item_id, userId).first();
    if (!item) throw new HttpError(410, "This operation completed but its item has been deleted.");
    return { id: previous.item_id, key, replay: true };
  }
  if (previous.state === "pending") {
    const active = await env.DB.prepare(
      `SELECT i.id, i.state, m.upload_id FROM items i
       LEFT JOIN multipart_uploads m ON m.item_id = i.id
       WHERE i.id = ? AND i.owner_user_id = ?`,
    ).bind(previous.item_id, userId).first();
    if (active?.state === "pending" && active.upload_id) return { id: previous.item_id, key, resume: true };
    const recovered = await env.DB.prepare(
      `UPDATE operations SET item_id = ?, created_at = ? WHERE user_id = ? AND request_key = ? AND item_id = ?
       AND state = 'pending' AND created_at < ?
       AND NOT EXISTS (SELECT 1 FROM multipart_uploads WHERE item_id = ?)`,
    ).bind(id, now(), userId, key, previous.item_id, now() - 30, previous.item_id).run();
    if (recovered.meta.changes) {
      await env.DB.prepare(
        "UPDATE items SET state = 'deleting' WHERE id = ? AND owner_user_id = ? AND state != 'ready'",
      ).bind(previous.item_id, userId).run();
      return { id, key };
    }
    throw new HttpError(409, "Upload is still being initialized. Retry later with the same key.");
  }

  const retry = await env.DB.prepare(
    `UPDATE operations SET state = 'pending', item_id = ?, created_at = ?
     WHERE user_id = ? AND request_key = ? AND state = 'failed' AND item_id = ?`,
  ).bind(id, now(), userId, key, previous.item_id).run();
  if (!retry.meta.changes) throw new HttpError(409, "Upload state changed. Retry later with the same key.");
  await env.DB.prepare(
    "UPDATE items SET state = 'deleting' WHERE id = ? AND owner_user_id = ? AND state != 'ready'",
  ).bind(previous.item_id, userId).run();
  return { id, key };
}

async function publishFile(env, id, key, userId) {
  const [published] = await env.DB.batch([
    env.DB.prepare(`UPDATE items SET state = 'ready' WHERE id = ? AND owner_user_id = ? AND state = 'pending'
      AND EXISTS (SELECT 1 FROM operations
       WHERE user_id = ? AND request_key = ? AND item_id = ? AND state = 'pending')`).bind(id, userId, userId, key, id),
    revision(env, userId),
    env.DB.prepare(`UPDATE operations SET state = 'done' WHERE user_id = ? AND request_key = ? AND item_id = ?
      AND EXISTS (SELECT 1 FROM items WHERE id = ? AND owner_user_id = ? AND state = 'ready')`)
      .bind(userId, key, id, id, userId),
    env.DB.prepare(`DELETE FROM multipart_parts WHERE item_id = ?
      AND EXISTS (SELECT 1 FROM items WHERE id = ? AND owner_user_id = ? AND state = 'ready')`).bind(id, id, userId),
    env.DB.prepare(`DELETE FROM multipart_uploads WHERE item_id = ?
      AND EXISTS (SELECT 1 FROM items WHERE id = ? AND owner_user_id = ? AND state = 'ready')`).bind(id, id, userId),
  ]);
  if (!published.meta.changes) throw new HttpError(409, "Upload was cancelled by a history clear.");
}

async function multipartPayload(env, id, config, userId, touch = false) {
  const item = await env.DB.prepare(
    `SELECT i.id, i.name, i.size, i.state, m.chunk_size, m.total_parts, m.updated_at, m.state AS upload_state
     FROM items i LEFT JOIN multipart_uploads m ON m.item_id = i.id
     WHERE i.id = ? AND i.owner_user_id = ? AND i.type = 'file'`,
  ).bind(id, userId).first();
  if (!item || item.state === "deleting") throw new HttpError(404, "Upload not found.");
  if (item.state === "ready") return { success: true, id, complete: true, uploadedParts: [] };
  if (!item.chunk_size) throw new HttpError(409, "Upload is still being initialized.");
  if (touch) {
    const timestamp = now();
    await env.DB.batch([
      env.DB.prepare("UPDATE multipart_uploads SET updated_at = ? WHERE item_id = ?").bind(timestamp, id),
      env.DB.prepare(
        `UPDATE operations SET created_at = ? WHERE user_id = ? AND item_id = ? AND state = 'pending'`,
      ).bind(timestamp, userId, id),
    ]);
    item.updated_at = timestamp;
  }
  const { results } = await env.DB.prepare(
    "SELECT part_number, size, checksum FROM multipart_parts WHERE item_id = ? ORDER BY part_number",
  ).bind(id).all();
  return {
    success: true,
    id,
    complete: false,
    chunkSize: item.chunk_size,
    totalParts: item.total_parts,
    uploadConcurrency: config.uploadConcurrency,
    expiresAt: item.updated_at + config.uploadSessionTtl,
    uploadedParts: results.map((part) => ({
      partNumber: part.part_number,
      size: part.size,
      sha256: part.checksum,
    })),
  };
}

async function initiateMultipart(request, env, config, session) {
  const data = await readJson(request, 4096);
  validateFile(data.name, data.size, config);
  if (data.mediaType !== undefined && (typeof data.mediaType !== "string" || data.mediaType.length > 100)) {
    throw new HttpError(400, "Invalid media type.");
  }
  const mediaType = imageMediaType(data.mediaType, data.name);
  if (data.chunkSize !== config.uploadChunkBytes || !/^[a-f0-9]{64}$/.test(data.fileFingerprint || "")) {
    throw new HttpError(400, "Upload chunk size or file fingerprint is invalid.");
  }
  const fingerprint = await digest(JSON.stringify([
    "multipart-file-v1", data.name, data.size, data.chunkSize, data.fileFingerprint,
  ]));
  const operation = await beginMultipartOperation(request, env, session.user_id, fingerprint);
  const { id, key } = operation;
  if (operation.replay) return json({ success: true, id, complete: true, replayed: true });
  if (operation.resume) return json(await multipartPayload(env, id, config, session.user_id, true));

  let multipart;
  try {
    await env.DB.prepare(
      `INSERT INTO items(id, owner_user_id, type, name, size, media_type, state, created_at)
       VALUES (?, ?, 'file', ?, ?, ?, 'pending', ?)`,
    ).bind(id, session.user_id, data.name, data.size, mediaType, now()).run();
    if (data.size === 0) {
      const object = await env.FILES.put(objectKey(id), new Uint8Array(), {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      if (!object || object.size !== 0) throw new HttpError(500, "Empty file could not be stored.");
      await publishFile(env, id, key, session.user_id);
      return json({ success: true, id, complete: true }, 201);
    }

    multipart = await env.FILES.createMultipartUpload(objectKey(id), {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const totalParts = Math.ceil(data.size / config.uploadChunkBytes);
    const created = await env.DB.prepare(
      `INSERT INTO multipart_uploads(
        item_id, user_id, upload_id, operation_key, chunk_size, total_parts, state, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, 'uploading', ? WHERE EXISTS
       (SELECT 1 FROM items WHERE id = ? AND owner_user_id = ? AND state = 'pending')`,
    ).bind(
      id, session.user_id, multipart.uploadId, key, config.uploadChunkBytes, totalParts,
      now(), id, session.user_id,
    ).run();
    if (!created.meta.changes) throw new HttpError(409, "Upload was cancelled while it was being initialized.");
    return json(await multipartPayload(env, id, config, session.user_id), 201);
  } catch (error) {
    if (multipart) await multipart.abort().catch(() => {});
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE items SET state = 'deleting' WHERE id = ? AND owner_user_id = ? AND state = 'pending'",
      ).bind(id, session.user_id),
      env.DB.prepare(
        `UPDATE operations SET state = 'failed'
         WHERE user_id = ? AND request_key = ? AND item_id = ?`,
      ).bind(session.user_id, key, id),
    ]);
    throw error;
  }
}

async function uploadMultipartPart(request, env, id, rawPartNumber, session) {
  if (!validId(id) || !/^[1-9]\d*$/.test(rawPartNumber)) throw new HttpError(404, "Upload part not found.");
  const partNumber = Number(rawPartNumber);
  const upload = await env.DB.prepare(
    `SELECT i.size, i.state AS item_state, m.upload_id, m.operation_key, m.chunk_size, m.total_parts, m.state
     FROM items i JOIN multipart_uploads m ON m.item_id = i.id
     WHERE i.id = ? AND i.owner_user_id = ? AND m.user_id = ?`,
  ).bind(id, session.user_id, session.user_id).first();
  if (!upload || upload.item_state !== "pending") throw new HttpError(404, "Upload not found.");
  if (upload.state !== "uploading") throw new HttpError(409, "Upload is being completed. Retry later.");
  if (partNumber > upload.total_parts) throw new HttpError(400, "Invalid upload part number.");

  const expectedSize = partNumber === upload.total_parts
    ? upload.size - upload.chunk_size * (partNumber - 1)
    : upload.chunk_size;
  const length = request.headers.get("Content-Length");
  if (length === null) throw new HttpError(411, "Content-Length is required for upload parts.");
  if (!/^\d+$/.test(length) || Number(length) !== expectedSize) {
    throw new HttpError(400, `Upload part must contain exactly ${expectedSize} bytes.`);
  }
  const checksum = request.headers.get("X-Part-SHA256") || "";
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new HttpError(400, "X-Part-SHA256 must be a lowercase SHA-256 hex digest.");

  const body = await request.arrayBuffer();
  if (body.byteLength !== expectedSize) throw new HttpError(400, `Upload part must contain exactly ${expectedSize} bytes.`);
  if (await sha256(body) !== checksum) throw new HttpError(400, "Upload part checksum does not match its body.");
  const previous = await env.DB.prepare(
    "SELECT size, checksum FROM multipart_parts WHERE item_id = ? AND part_number = ?",
  ).bind(id, partNumber).first();
  if (previous?.size === expectedSize && previous.checksum === checksum) {
    return json({ success: true, partNumber, replayed: true });
  }

  const multipart = env.FILES.resumeMultipartUpload(objectKey(id), upload.upload_id);
  const uploaded = await multipart.uploadPart(partNumber, body);
  const timestamp = now();
  const [saved] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO multipart_parts(item_id, part_number, etag, checksum, size, updated_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS
       (SELECT 1 FROM multipart_uploads m JOIN items i ON i.id = m.item_id
        WHERE m.item_id = ? AND m.user_id = ? AND m.state = 'uploading'
         AND i.owner_user_id = ? AND i.state = 'pending')`,
    ).bind(
      id, partNumber, uploaded.etag, checksum, expectedSize, timestamp,
      id, session.user_id, session.user_id,
    ),
    env.DB.prepare(
      "UPDATE multipart_uploads SET updated_at = ? WHERE item_id = ? AND user_id = ? AND state = 'uploading'",
    ).bind(timestamp, id, session.user_id),
    env.DB.prepare(
      `UPDATE operations SET created_at = ?
       WHERE user_id = ? AND request_key = ? AND state = 'pending'`,
    ).bind(timestamp, session.user_id, upload.operation_key),
  ]);
  if (!saved.meta.changes) throw new HttpError(409, "Upload was cancelled while this part was being stored.");
  return json({ success: true, partNumber }, 201);
}

async function completeMultipart(env, id, session) {
  if (!validId(id)) throw new HttpError(404, "Upload not found.");
  const item = await env.DB.prepare(
    "SELECT id, size, state FROM items WHERE id = ? AND owner_user_id = ? AND type = 'file'",
  ).bind(id, session.user_id).first();
  if (!item || item.state === "deleting") throw new HttpError(404, "Upload not found.");
  if (item.state === "ready") return json({ success: true, id, complete: true, replayed: true });

  const upload = await env.DB.prepare(
    "SELECT * FROM multipart_uploads WHERE item_id = ? AND user_id = ?",
  ).bind(id, session.user_id).first();
  if (!upload) throw new HttpError(409, "Upload is still being initialized.");
  const { results: parts } = await env.DB.prepare(
    "SELECT part_number, etag, size FROM multipart_parts WHERE item_id = ? ORDER BY part_number",
  ).bind(id).all();
  if (parts.length !== upload.total_parts ||
      parts.some((part, index) => part.part_number !== index + 1) ||
      parts.reduce((total, part) => total + part.size, 0) !== item.size) {
    throw new HttpError(409, "Upload is incomplete. Resume missing parts before completing it.");
  }

  const claimed = await env.DB.prepare(
    "UPDATE multipart_uploads SET state = 'completing', updated_at = ? WHERE item_id = ? AND state = 'uploading'",
  ).bind(now(), id).run();
  let object = await env.FILES.head(objectKey(id));
  if (!claimed.meta.changes && !object) throw new HttpError(409, "Upload is already being completed. Retry later.");

  try {
    if (!object) {
      const multipart = env.FILES.resumeMultipartUpload(objectKey(id), upload.upload_id);
      object = await multipart.complete(parts.map((part) => ({ partNumber: part.part_number, etag: part.etag })));
    }
    if (!object || object.size !== item.size) throw new HttpError(500, "Completed file size does not match the upload.");
    await publishFile(env, id, upload.operation_key, session.user_id);
    return json({ success: true, id, complete: true }, 201);
  } catch (error) {
    const committed = await env.DB.prepare(
      "SELECT state FROM operations WHERE user_id = ? AND request_key = ?",
    ).bind(session.user_id, upload.operation_key).first();
    if (committed?.state === "done") return json({ success: true, id, complete: true, replayed: true });
    await env.DB.prepare(
      "UPDATE multipart_uploads SET state = 'uploading', updated_at = ? WHERE item_id = ? AND state = 'completing'",
    ).bind(now(), id).run();
    throw error;
  }
}

async function cancelMultipart(env, ctx, id, session) {
  if (!validId(id)) throw new HttpError(404, "Upload not found.");
  const [cancelled] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE items SET state = 'deleting' WHERE id = ? AND owner_user_id = ? AND state = 'pending'",
    ).bind(id, session.user_id),
    env.DB.prepare(`UPDATE operations SET state = 'failed' WHERE item_id = ? AND state = 'pending'
      AND user_id = ?
      AND EXISTS (SELECT 1 FROM items WHERE id = ? AND owner_user_id = ? AND state = 'deleting')`)
      .bind(id, session.user_id, id, session.user_id),
  ]);
  if (!cancelled.meta.changes) throw new HttpError(404, "Upload not found.");
  backgroundCleanup(env, ctx);
  return json({ success: true }, 202);
}

function rangeFor(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  const invalid = () => { throw new HttpError(416, "Invalid byte range.", { "Content-Range": `bytes */${size}` }); };
  if (!match || (!match[1] && !match[2]) || size === 0) return invalid();
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return invalid();
  }
  return { offset: start, length: end - start + 1 };
}

async function download(request, env, id, expectedName, ownerUserId, knownItem = null) {
  if (!validId(id)) throw new HttpError(404, "File not found.");
  const item = knownItem || await env.DB.prepare(
    `SELECT name, size FROM items
     WHERE id = ? AND owner_user_id = ? AND type = 'file' AND state = 'ready'`,
  ).bind(id, ownerUserId).first();
  if (!item || item.name !== expectedName) throw new HttpError(404, "File not found.");
  const range = request.method === "HEAD" ? null : rangeFor(request.headers.get("Range"), item.size);
  const object = request.method === "HEAD"
    ? await env.FILES.head(objectKey(id))
    : await env.FILES.get(objectKey(id), range ? { range } : {});
  if (!object) throw new HttpError(404, "File not found.");
  const encoded = encodeURIComponent(item.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encoded}`,
    "Content-Length": String(range ? range.length : item.size),
    "Accept-Ranges": "bytes",
  };
  if (object.httpEtag) headers.ETag = object.httpEtag;
  if (object.uploaded) headers["Last-Modified"] = object.uploaded.toUTCString();
  if (range) headers["Content-Range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${item.size}`;
  return new Response(request.method === "HEAD" ? null : object.body, { status: range ? 206 : 200, headers });
}

async function temporaryDownload(request, env, token, expectedName) {
  if (!temporaryShareToken.test(token || "") || !expectedName) {
    throw new HttpError(404, "Temporary file link not found or expired.");
  }
  const item = await env.DB.prepare(
    `SELECT i.id, i.name, i.size
     FROM file_shares s JOIN items i ON i.id = s.item_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND i.type = 'file' AND i.state = 'ready'`,
  ).bind(await digest(token), now()).first();
  if (!item || item.name !== expectedName) throw new HttpError(404, "Temporary file link not found or expired.");
  return download(request, env, item.id, expectedName, null, item);
}

async function createTemporaryShare(request, env, id, session) {
  if (!validId(id)) throw new HttpError(404, "File not found.");
  const data = await readJson(request, 1024);
  if (!Number.isSafeInteger(data.hours) || data.hours < 1 || data.hours > 168) {
    throw new HttpError(400, "Temporary access duration must be an integer from 1 to 168 hours.");
  }
  const item = await env.DB.prepare(
    `SELECT id, name FROM items
     WHERE id = ? AND owner_user_id = ? AND type = 'file' AND state = 'ready'`,
  ).bind(id, session.user_id).first();
  if (!item) throw new HttpError(404, "File not found.");
  const token = randomToken();
  const timestamp = now();
  const expiresAt = timestamp + data.hours * 3600;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO file_shares(token_hash, item_id, expires_at, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
       token_hash = excluded.token_hash, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    ).bind(await digest(token), id, expiresAt, timestamp),
    revision(env, session.user_id),
  ]);
  return json({
    success: true,
    url: new URL(`/shared/${token}/${encodeURIComponent(item.name)}`, request.url).href,
    expiresAt,
  }, 201);
}

async function revokeTemporaryShare(env, id, session) {
  if (!validId(id)) throw new HttpError(404, "File not found.");
  const [deleted] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM file_shares WHERE item_id = ?
       AND EXISTS (SELECT 1 FROM items
        WHERE id = ? AND owner_user_id = ? AND type = 'file' AND state = 'ready')`,
    ).bind(id, id, session.user_id),
    revision(env, session.user_id),
  ]);
  if (!deleted.meta.changes) throw new HttpError(404, "Active temporary file link not found.");
  return json({ success: true });
}

async function uploadImagePreview(request, env, id, session) {
  if (!validId(id)) throw new HttpError(404, "Image upload not found.");
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "image/webp") {
    throw new HttpError(415, "Image preview must be WebP.");
  }
  const length = request.headers.get("Content-Length");
  if (length === null) throw new HttpError(411, "Content-Length is required for image previews.");
  if (!/^\d+$/.test(length) || Number(length) < 1 || Number(length) > previewLimit) {
    throw new HttpError(413, `Image preview must contain 1-${previewLimit} bytes.`);
  }
  const item = await env.DB.prepare(
    `SELECT name, media_type, state FROM items
     WHERE id = ? AND owner_user_id = ? AND type = 'file' AND state IN ('pending', 'ready')`,
  ).bind(id, session.user_id).first();
  if (!item || !imageMediaType(item.media_type, item.name)) {
    throw new HttpError(404, "Image upload not found.");
  }
  const body = await request.arrayBuffer();
  const bytes = new Uint8Array(body);
  if (bytes.byteLength !== Number(length) || bytes.byteLength > previewLimit) {
    throw new HttpError(400, "Image preview size does not match Content-Length.");
  }
  if (bytes.byteLength < 12 ||
      String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" ||
      String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") {
    throw new HttpError(400, "Invalid WebP image preview.");
  }
  const key = previewObjectKey(id);
  const existing = await env.FILES.head(key);
  if (existing?.size === bytes.byteLength) {
    return json({ success: true, replayed: true });
  }
  const stored = await env.FILES.put(key, body, { httpMetadata: { contentType: "image/webp" } });
  if (!stored || stored.size !== bytes.byteLength) throw new HttpError(500, "Image preview could not be stored.");
  if (item.state === "ready") await revision(env, session.user_id).run();
  return json({ success: true }, 201);
}

async function previewImage(request, env, id, session) {
  if (!validId(id)) throw new HttpError(404, "Image preview not found.");
  const item = await env.DB.prepare(
    `SELECT name, media_type FROM items
     WHERE id = ? AND owner_user_id = ? AND type = 'file' AND state = 'ready'`,
  ).bind(id, session.user_id).first();
  const contentType = item && imageMediaType(item.media_type, item.name);
  if (!contentType) throw new HttpError(404, "Image preview not found.");
  const object = request.method === "HEAD"
    ? await env.FILES.head(previewObjectKey(id))
    : await env.FILES.get(previewObjectKey(id));
  if (!object) throw new HttpError(404, "Image preview not found.");
  const headers = {
    "Content-Type": "image/webp",
    "Content-Length": String(object.size),
    "Content-Disposition": "inline",
  };
  if (object.httpEtag) headers.ETag = object.httpEtag;
  if (object.uploaded) headers["Last-Modified"] = object.uploaded.toUTCString();
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function cleanupDeleted(env) {
  const { results } = await env.DB.prepare("SELECT id, type FROM items WHERE state = 'deleting' ORDER BY seq LIMIT 50").all();
  if (results.length) {
    const fileIds = results.filter((item) => item.type === "file").map((item) => item.id);
    if (fileIds.length) {
      const slots = fileIds.map(() => "?").join(",");
      const { results: uploads } = await env.DB.prepare(
        `SELECT item_id, upload_id FROM multipart_uploads WHERE item_id IN (${slots})`,
      ).bind(...fileIds).all();
      await Promise.allSettled(uploads.map((upload) =>
        env.FILES.resumeMultipartUpload(objectKey(upload.item_id), upload.upload_id).abort()));
      await env.FILES.delete(fileIds.flatMap((id) => [objectKey(id), previewObjectKey(id)]));
    }
    const slots = results.map(() => "?").join(",");
    const ids = results.map((item) => item.id);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM file_shares WHERE item_id IN (${slots})`).bind(...ids),
      env.DB.prepare(`DELETE FROM multipart_parts WHERE item_id IN (${slots})`).bind(...ids),
      env.DB.prepare(`DELETE FROM multipart_uploads WHERE item_id IN (${slots})`).bind(...ids),
      env.DB.prepare(`DELETE FROM items WHERE state = 'deleting' AND id IN (${slots})`).bind(...ids),
    ]);
  }
  await env.DB.prepare(
    `DELETE FROM users WHERE deletion_requested_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM items WHERE owner_user_id = users.id)`,
  ).run();
  return results.length;
}

function backgroundCleanup(env, ctx) {
  ctx.waitUntil(cleanupDeleted(env).catch((error) => console.error("R2 cleanup deferred to cron:", error)));
}

async function route(request, env, ctx, responseState) {
  const config = configuration(env);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (url.protocol !== "https:" && !localHttp(request, env)) throw new HttpError(426, "HTTPS is required.");

  if (method === "POST" && path === "/api/login") {
    const result = await login(request, env, config);
    return json(
      { success: true, user: result.user },
      200,
      { "Set-Cookie": sessionCookie(request, env, result.token, config.ttl) },
    );
  }
  if (method === "GET" && path === "/api/auth/config") return authConfiguration(env);
  if (method === "POST" && path === "/api/register") return registerUser(request, env, config);
  if (method === "POST" && path === "/api/password/reset") return resetPassword(request, env, config);
  if ((method === "GET" || method === "HEAD") && publicAssets.has(path)) {
    return asset(request, env, publicAssets.get(path));
  }
  if ((method === "GET" || method === "HEAD") && path.startsWith("/shared/")) {
    const match = /^\/shared\/([a-f0-9]{64})\/([^/?#]+)$/.exec(path);
    return temporaryDownload(request, env, match?.[1], decodeFilename(match?.[2]));
  }
  const session = await getSession(request, env, config.ttl, config.sessionRenewInterval);
  if (session) responseState.session = { ...session, ttl: config.ttl };
  if ((method === "GET" || method === "HEAD") && ["/login", "/register", "/reset-password"].includes(path)) {
    const target = path === "/login" ? safeDownloadPath(url.searchParams.get("next")) : "/";
    return session ? Response.redirect(`${url.origin}${target}`, 303) : asset(request, env, "/login.html");
  }
  if (!session) {
    if ((method === "GET" || method === "HEAD") && ["/", "/index.html"].includes(path)) {
      return Response.redirect(`${url.origin}/login`, 303);
    }
    const browserNavigation = request.headers.get("Sec-Fetch-Mode") === "navigate" ||
      request.headers.get("Accept")?.split(",").some((type) => type.trim().startsWith("text/html"));
    const downloadPath = safeDownloadPath(path);
    if (method === "GET" && downloadPath !== "/" && browserNavigation) {
      return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(downloadPath)}`, 303);
    }
    throw new HttpError(401, "Authentication required.");
  }
  if (!["GET", "HEAD"].includes(method)) requireCsrf(request, session);

  if ((method === "GET" || method === "HEAD") && ["/", "/index.html"].includes(path)) return asset(request, env, "/index.html");
  if (method === "GET" && path === "/api/session") {
    return json({
      csrfToken: session.csrf_token, expiresAt: session.expires_at,
      user: {
        id: session.user_id,
        username: session.username,
        role: session.role,
        hasRecoveryCode: Boolean(session.has_recovery_code),
      },
      maxUploadBytes: config.uploadLimit,
      uploadChunkBytes: config.uploadChunkBytes,
      uploadConcurrency: config.uploadConcurrency,
      uploadSessionTtlSeconds: config.uploadSessionTtl,
      maxTextBytes: config.textLimit,
      pollSeconds: config.pollSeconds,
    });
  }
  if (method === "POST" && path === "/api/logout") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.token_hash).run();
    return json({ success: true }, 200, { "Set-Cookie": sessionCookie(request, env, "", 0) });
  }
  if (method === "GET" && path === "/api/revision") {
    return json({ revision: session.revision });
  }
  if (method === "PATCH" && path === "/api/settings/registration") {
    return updateRegistration(request, env, session);
  }
  if (method === "POST" && path === "/api/account/password") {
    return changeOwnPassword(request, env, session);
  }
  if (method === "POST" && path === "/api/account/recovery-code") {
    return createRecoveryCode(request, env, session);
  }
  if (method === "DELETE" && path === "/api/account") {
    return deleteOwnAccount(request, env, ctx, session);
  }
  if (method === "GET" && path === "/api/users") return listUsers(env, session);
  if (method === "POST" && path === "/api/users") return createUser(request, env, session);
  const userRoute = path.match(/^\/api\/users\/([a-f0-9-]+)$/);
  if (userRoute) {
    if (method === "PATCH") return updateUser(request, env, session, userRoute[1]);
    if (method === "DELETE") return deleteUser(env, ctx, session, userRoute[1]);
  }
  if (method === "GET" && path === "/api/history") {
    const raw = url.searchParams.get("before");
    if (raw !== null && (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))) throw new HttpError(400, "Invalid history cursor.");
    const cursor = raw ? Number(raw) : Number.MAX_SAFE_INTEGER;
    // Bound the worst-case text allocation before fetching full bodies from D1.
    const pageSize = Math.min(config.pageSize, Math.max(1, Math.floor(1048576 / config.textLimit)));
    const items = await env.DB.prepare(
      `SELECT i.seq, i.id, i.type, i.content, i.name, i.size, i.media_type, i.created_at,
       CASE WHEN s.expires_at > ? THEN s.expires_at ELSE NULL END AS share_expires_at
       FROM items i LEFT JOIN file_shares s ON s.item_id = i.id
       WHERE i.owner_user_id = ? AND i.state = 'ready' AND i.seq < ?
       ORDER BY i.seq DESC LIMIT ?`,
    ).bind(now(), session.user_id, cursor, pageSize + 1).all();
    return json({
      items: items.results.slice(0, pageSize).map((item) => ({
        ...item,
        media_type: item.type === "file" ? imageMediaType(item.media_type, item.name) : null,
      })),
      nextCursor: items.results.length > pageSize ? items.results[pageSize - 1].seq : null,
      revision: session.revision,
    });
  }
  if (method === "POST" && path === "/api/text") {
    const data = await readJson(request, config.textLimit * 6 + 1024);
    if (typeof data.text !== "string" || !data.text.trim()) throw new HttpError(400, "Text cannot be empty.");
    if (encoder.encode(data.text).length > config.textLimit) throw new HttpError(413, `Text exceeds ${config.textLimit} UTF-8 bytes.`);
    const operation = await beginOperation(
      request, env, session.user_id, await digest(JSON.stringify(["text", data.text])),
    );
    const { id, key } = operation;
    if (operation.replay) return json({ success: true, id, replayed: true });
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO items(id, owner_user_id, type, content, state, created_at)
           VALUES (?, ?, 'text', ?, 'ready', ?)`,
        ).bind(id, session.user_id, data.text, now()),
        revision(env, session.user_id),
        env.DB.prepare(
          `UPDATE operations SET state = 'done'
           WHERE user_id = ? AND request_key = ? AND item_id = ?`,
        ).bind(session.user_id, key, id),
      ]);
    } catch (error) {
      const committed = await env.DB.prepare(
        `SELECT state FROM operations WHERE user_id = ? AND request_key = ? AND item_id = ?`,
      ).bind(session.user_id, key, id).first();
      if (committed?.state === "done") return json({ success: true, id, replayed: true });
      await env.DB.prepare(
        `UPDATE operations SET state = 'failed'
         WHERE user_id = ? AND request_key = ? AND item_id = ?`,
      ).bind(session.user_id, key, id).run();
      throw error;
    }
    return json({ success: true, id }, 201);
  }
  if (method === "POST" && path === "/api/uploads") return initiateMultipart(request, env, config, session);
  const previewUploadRoute = path.match(/^\/api\/uploads\/([a-f0-9-]+)\/preview$/);
  if (method === "PUT" && previewUploadRoute) {
    return uploadImagePreview(request, env, previewUploadRoute[1], session);
  }
  const multipartRoute = path.match(/^\/api\/uploads\/([a-f0-9-]+)(?:\/(complete|parts\/([1-9]\d*)))?$/);
  if (multipartRoute) {
    const [, id, action, partNumber] = multipartRoute;
    if (method === "GET" && !action) return json(await multipartPayload(env, id, config, session.user_id));
    if (method === "DELETE" && !action) return cancelMultipart(env, ctx, id, session);
    if (method === "POST" && action === "complete") return completeMultipart(env, id, session);
    if (method === "PUT" && partNumber) return uploadMultipartPart(request, env, id, partNumber, session);
  }
  if ((method === "GET" || method === "HEAD") && path.startsWith("/previews/")) {
    return previewImage(request, env, path.slice(10), session);
  }
  if ((method === "GET" || method === "HEAD") && path.startsWith("/uploads/")) {
    const target = protectedDownloadPath(path);
    if (!target) throw new HttpError(404, "File not found.");
    return download(request, env, target.id, target.name, session.user_id);
  }
  const temporaryShareRoute = path.match(/^\/api\/history\/([a-f0-9-]+)\/share$/);
  if (temporaryShareRoute) {
    if (method === "POST") return createTemporaryShare(request, env, temporaryShareRoute[1], session);
    if (method === "DELETE") return revokeTemporaryShare(env, temporaryShareRoute[1], session);
  }
  if (method === "DELETE" && path.startsWith("/api/history/")) {
    const id = path.slice("/api/history/".length);
    if (!validId(id)) throw new HttpError(404, "Item not found.");
    const [result] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE items SET state = 'deleting'
         WHERE id = ? AND owner_user_id = ? AND state = 'ready'`,
      ).bind(id, session.user_id),
      revision(env, session.user_id),
    ]);
    if (!result.meta.changes) throw new HttpError(404, "Item not found.");
    backgroundCleanup(env, ctx);
    return json({ success: true }, 202);
  }
  if (method === "POST" && path === "/api/clear_history") {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE items SET state = 'deleting' WHERE owner_user_id = ? AND state != 'deleting'",
      ).bind(session.user_id),
      revision(env, session.user_id),
    ]);
    backgroundCleanup(env, ctx);
    return json({ success: true }, 202);
  }
  throw new HttpError(404, "Route not found.");
}

export async function maintenance(env) {
  const timestamp = now();
  const configuredTtl = Number(env.UPLOAD_SESSION_TTL_SECONDS || 86400);
  const uploadTtl = Number.isSafeInteger(configuredTtl)
    ? Math.min(Math.max(configuredTtl, 3600), 6 * 86400)
    : 86400;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(timestamp),
    env.DB.prepare("DELETE FROM login_attempts WHERE started_at < ?").bind(timestamp - 86400),
    env.DB.prepare("DELETE FROM account_attempts WHERE started_at < ?").bind(timestamp - 86400),
    env.DB.prepare("DELETE FROM file_shares WHERE expires_at <= ?").bind(timestamp),
    env.DB.prepare(
      `UPDATE items SET state = 'deleting' WHERE state = 'pending' AND (
       EXISTS (SELECT 1 FROM multipart_uploads m WHERE m.item_id = items.id AND m.updated_at < ?)
       OR (NOT EXISTS (SELECT 1 FROM multipart_uploads m WHERE m.item_id = items.id) AND created_at < ?)
      )`,
    ).bind(timestamp - uploadTtl, timestamp - 3600),
    env.DB.prepare(
      `UPDATE operations SET state = 'failed' WHERE state = 'pending'
       AND EXISTS (SELECT 1 FROM items WHERE items.id = operations.item_id AND items.state = 'deleting')`,
    ),
    env.DB.prepare("DELETE FROM operations WHERE state != 'pending' AND created_at < ?").bind(timestamp - 86400),
  ]);
  const batches = Number(env.CLEANUP_BATCHES || 4);
  for (let i = 0; i < Math.min(Math.max(batches, 1), 8); i++) {
    if (await cleanupDeleted(env) < 50) break;
  }
  // Reconcile a bounded R2 page to recover from crashes between R2 and D1 writes.
  const state = await env.DB.prepare("SELECT sweep_cursor FROM app_state WHERE id = 1").first();
  const page = await env.FILES.list({ prefix: "files/", limit: 50, cursor: state.sweep_cursor || undefined });
  if (page.objects.length) {
    const ids = [...new Set(page.objects.map((object) => object.key.slice(6).split("/")[0]))];
    const { results } = await env.DB.prepare(`SELECT id FROM items WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    const existing = new Set(results.map((item) => item.id));
    const abandoned = page.objects.filter((object) =>
      !existing.has(object.key.slice(6).split("/")[0]) && object.uploaded.getTime() < Date.now() - 3600000);
    if (abandoned.length) await env.FILES.delete(abandoned.map((object) => object.key));
  }
  await env.DB.prepare("UPDATE app_state SET sweep_cursor = ? WHERE id = 1")
    .bind(page.truncated ? page.cursor : "").run();
}

export default {
  async fetch(request, env, ctx) {
    const responseState = {};
    try {
      return harden(await route(request, env, ctx, responseState), request, env, responseState.session);
    } catch (error) {
      const path = new URL(request.url).pathname;
      const known = error instanceof HttpError;
      const temporaryShareMiss = known && error.status === 404 && path.startsWith("/shared/");
      const unauthenticatedDownload = known && error.status === 401 && path.startsWith("/uploads/");
      const minimalError = temporaryShareMiss || unauthenticatedDownload;
      const requestId = minimalError ? null : crypto.randomUUID();
      if (!known) console.error(JSON.stringify({ requestId, method: request.method, path }), error);
      const body = {
        success: false,
        message: temporaryShareMiss ? "Temporary file link not found or expired."
          : known ? error.message : "Internal server error.",
      };
      if (!minimalError) Object.assign(body, { method: request.method, path, requestId });
      return harden(json(body, known ? error.status : 500, known ? error.headers : {}),
        request, env, responseState.session);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(maintenance(env));
  },
};
