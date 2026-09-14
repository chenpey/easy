const encoder = new TextEncoder();
const ITERATIONS = 100000;
const VERIFIER_VERSION = 3;
const PROOF = encoder.encode("easydrop/password-verifier/v3");
const DUMMY_VERIFIER = {
  version: VERIFIER_VERSION,
  iterations: ITERATIONS,
  salt: "0".repeat(64),
  proof: "0".repeat(64),
};

export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export const now = () => Math.floor(Date.now() / 1000);
export const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (value) => Uint8Array.from(value.match(/../g), (byte) => parseInt(byte, 16));
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async (value) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

export function normalizeUsername(value) {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(username)) {
    throw new Error("Username must be 3-32 lowercase letters, digits, dots, underscores or hyphens.");
  }
  return username;
}

export function validatePassword(password) {
  const length = typeof password === "string" ? Array.from(password).length : 0;
  if (length < 12 || length > 32 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new Error("Password must be 12-32 characters and include uppercase, lowercase and a digit.");
  }
  return password;
}

async function passwordKey(password, salt, usages) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: unhex(salt), iterations: ITERATIONS },
    material, { name: "HMAC", hash: "SHA-256", length: 256 }, false, usages,
  );
}

export async function createPasswordVerifier(password) {
  validatePassword(password);
  const salt = randomToken();
  const key = await passwordKey(password, salt, ["sign"]);
  const proof = hex(await crypto.subtle.sign("HMAC", key, PROOF));
  return JSON.stringify({ version: VERIFIER_VERSION, iterations: ITERATIONS, salt, proof });
}

export async function verifyPassword(password, verifier) {
  const key = await passwordKey(password, verifier.salt, ["verify"]);
  return crypto.subtle.verify("HMAC", key, unhex(verifier.proof), PROOF);
}

function parseVerifier(value) {
  const verifier = typeof value === "string" ? JSON.parse(value) : value;
  if (verifier.version !== VERIFIER_VERSION || verifier.iterations !== ITERATIONS ||
      !/^[a-f0-9]{64}$/.test(verifier.salt) || !/^[a-f0-9]{64}$/.test(verifier.proof)) throw new Error();
  return verifier;
}

export async function createInitialAdmin(username, password) {
  return JSON.stringify({
    username: normalizeUsername(username),
    verifier: parseVerifier(await createPasswordVerifier(password)),
  });
}

export function configuration(env) {
  const number = (key, min, max) => {
    const raw = env[key];
    const value = Number(raw);
    if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new HttpError(503, `Invalid configuration: ${key}`);
    }
    return value;
  };
  let initialAdmin;
  try {
    const value = JSON.parse(env.INITIAL_ADMIN);
    initialAdmin = { username: normalizeUsername(value.username), verifier: parseVerifier(value.verifier) };
  } catch {
    throw new HttpError(503, "INITIAL_ADMIN is missing or invalid. Run the interactive setup.");
  }
  if (!["true", "false"].includes(env.ALLOW_LOCAL_HTTP)) {
    throw new HttpError(503, "Invalid configuration: ALLOW_LOCAL_HTTP");
  }
  return {
    initialAdmin,
    ttl: number("SESSION_TTL_SECONDS", 3600, 31536000),
    uploadLimit: number("MAX_UPLOAD_BYTES", 1, 200 * 1024 * 1024),
    uploadChunkBytes: number("UPLOAD_CHUNK_BYTES", 5 * 1024 * 1024, 95 * 1024 * 1024),
    uploadConcurrency: number("UPLOAD_CONCURRENCY", 1, 6),
    uploadSessionTtl: number("UPLOAD_SESSION_TTL_SECONDS", 3600, 6 * 86400),
    textLimit: number("MAX_TEXT_BYTES", 1, 1024 * 1024),
    pollSeconds: number("POLL_INTERVAL_SECONDS", 5, 3600),
    window: number("LOGIN_WINDOW_SECONDS", 60, 86400),
    ipLimit: number("LOGIN_IP_LIMIT", 1, 1000),
    globalLimit: number("LOGIN_GLOBAL_LIMIT", 1, 10000),
    pageSize: number("HISTORY_PAGE_SIZE", 1, 50),
    cleanupBatches: number("CLEANUP_BATCHES", 1, 8),
  };
}

export function localHttp(request, env) {
  const url = new URL(request.url);
  return env.ALLOW_LOCAL_HTTP === "true" && url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

export function requireOrigin(request) {
  if (request.headers.get("Origin") !== new URL(request.url).origin ||
      request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new HttpError(403, "Cross-origin request rejected.");
  }
}

function cookieName(request, env) {
  return localHttp(request, env) ? "easydrop_dev" : "__Host-easydrop";
}

export function sessionCookie(request, env, token, ttl) {
  const secure = localHttp(request, env) ? "" : "; Secure";
  return `${cookieName(request, env)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}${secure}`;
}

export async function getSession(request, env, ttl) {
  const cookies = (request.headers.get("Cookie") || "").split(";").map((part) => part.trim());
  const prefix = `${cookieName(request, env)}=`;
  const token = cookies.find((part) => part.startsWith(prefix))?.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/.test(token || "")) return null;
  const timestamp = now();
  const tokenHash = await digest(token);
  const session = await env.DB.prepare(
    `SELECT s.token_hash, s.user_id, s.csrf_token, s.expires_at, u.username, u.role, u.auth_version, a.revision
     FROM sessions s JOIN users u ON u.id = s.user_id CROSS JOIN app_state a
     WHERE a.id = 1 AND s.token_hash = ? AND s.expires_at > ? AND s.auth_version = u.auth_version AND u.enabled = 1`,
  ).bind(tokenHash, timestamp).first();
  if (!session) return null;
  const expiresAt = timestamp + ttl;
  const renewed = await env.DB.prepare(
    `UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND user_id = ? AND auth_version = ?
     AND EXISTS (SELECT 1 FROM users WHERE id = ? AND enabled = 1 AND auth_version = ?)`,
  ).bind(expiresAt, tokenHash, session.user_id, session.auth_version, session.user_id, session.auth_version).run();
  if (!renewed.meta.changes) return null;
  return { ...session, expires_at: expiresAt, token };
}

export function requireCsrf(request, session) {
  requireOrigin(request);
  if (request.headers.get("X-CSRF-Token") !== session.csrf_token) {
    throw new HttpError(403, "Invalid CSRF token.");
  }
}

export async function readJson(request, maxBytes) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
  if (Number(request.headers.get("Content-Length")) > maxBytes) throw new HttpError(413, "Request body too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "JSON body is required.");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "Request body too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error();
    return data;
  } catch {
    throw new HttpError(400, "Invalid JSON object.");
  }
}

export async function login(request, env, config) {
  requireOrigin(request);
  const data = await readJson(request, 8192);
  let username;
  try { username = normalizeUsername(data.username); } catch { throw new HttpError(400, "Invalid username input."); }
  if (typeof data.password !== "string" || Array.from(data.password).length > 32) throw new HttpError(400, "Invalid password input.");
  const ip = request.headers.get("CF-Connecting-IP") || (localHttp(request, env) ? "local" : null);
  if (!ip) throw new HttpError(503, "Client IP unavailable.");
  const timestamp = now();
  // An already-blocked IP must not be able to exhaust the global budget.
  for (const [counterKey, limit] of [[`ip:${await digest(ip)}`, config.ipLimit], ["global", config.globalLimit]]) {
    const counter = await env.DB.prepare(`
    INSERT INTO login_attempts(key, started_at, attempts) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN started_at <= ? THEN 1 ELSE MIN(attempts + 1, ?) END,
      started_at = CASE WHEN started_at <= ? THEN excluded.started_at ELSE started_at END
    RETURNING attempts, started_at
    `).bind(counterKey, timestamp, timestamp - config.window, limit + 1, timestamp - config.window).first();
    if (counter.attempts > limit) {
      const retry = Math.max(counter.started_at + config.window - timestamp, 1);
      throw new HttpError(429, "Too many login attempts. Try again later.", { "Retry-After": String(retry) });
    }
  }
  let user = await env.DB.prepare(
    "SELECT id, username, password_verifier, role, enabled, auth_version FROM users WHERE username = ?",
  ).bind(username).first();
  if (!user && username === config.initialAdmin.username) {
    const createdAt = now();
    await env.DB.prepare(
      `INSERT INTO users(id, username, password_verifier, role, enabled, auth_version, created_at, updated_at)
       SELECT ?, ?, ?, 'admin', 1, 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
    ).bind(
      crypto.randomUUID(), username, JSON.stringify(config.initialAdmin.verifier), createdAt, createdAt,
    ).run();
    user = await env.DB.prepare(
      "SELECT id, username, password_verifier, role, enabled, auth_version FROM users WHERE username = ?",
    ).bind(username).first();
  }
  let verifier = DUMMY_VERIFIER;
  try {
    if (user) verifier = JSON.parse(user.password_verifier);
  } catch { /* Invalid stored verifier fails authentication below. */ }
  const verifierValid = verifier.version === VERIFIER_VERSION && verifier.iterations === ITERATIONS &&
    /^[a-f0-9]{64}$/.test(verifier.salt || "") && /^[a-f0-9]{64}$/.test(verifier.proof || "");
  const passwordMatches = await verifyPassword(data.password, verifierValid ? verifier : DUMMY_VERIFIER);
  if (!user?.enabled || !verifierValid || !passwordMatches) {
    throw new HttpError(401, "Incorrect username or password.");
  }
  const token = randomToken();
  const csrfToken = randomToken();
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash, user_id, csrf_token, auth_version, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(await digest(token), user.id, csrfToken, user.auth_version, timestamp + config.ttl).run();
  return { token, csrfToken, user: { id: user.id, username: user.username, role: user.role } };
}
