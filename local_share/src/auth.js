const encoder = new TextEncoder();
const ITERATIONS = 100000;
const PROOF = encoder.encode("local-share/password-verifier/v1");

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

async function passwordKey(password, salt, usages) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: unhex(salt), iterations: ITERATIONS },
    material, { name: "HMAC", hash: "SHA-256", length: 256 }, false, usages,
  );
}

export async function createPasswordVerifier(password) {
  if (typeof password !== "string" || password.length < 12 || encoder.encode(password).length > 1024) {
    throw new Error("Password must contain at least 12 characters and at most 1024 UTF-8 bytes.");
  }
  const salt = randomToken();
  const key = await passwordKey(password, salt, ["sign"]);
  const proof = hex(await crypto.subtle.sign("HMAC", key, PROOF));
  return JSON.stringify({ version: 1, iterations: ITERATIONS, salt, proof });
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
  let verifier;
  try {
    verifier = JSON.parse(env.PASSWORD_VERIFIER);
    if (verifier.version !== 1 || verifier.iterations !== ITERATIONS ||
        !/^[a-f0-9]{64}$/.test(verifier.salt) || !/^[a-f0-9]{64}$/.test(verifier.proof)) throw new Error();
  } catch {
    throw new HttpError(503, "PASSWORD_VERIFIER is missing or invalid. Run the interactive setup.");
  }
  if (!["true", "false"].includes(env.ALLOW_LOCAL_HTTP)) {
    throw new HttpError(503, "Invalid configuration: ALLOW_LOCAL_HTTP");
  }
  return {
    verifier,
    ttl: number("SESSION_TTL_SECONDS", 300, 2592000),
    uploadLimit: number("MAX_UPLOAD_BYTES", 1, 95 * 1024 * 1024),
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
  return localHttp(request, env) ? "local_share_dev" : "__Host-local_share";
}

export function sessionCookie(request, env, token, ttl) {
  const secure = localHttp(request, env) ? "" : "; Secure";
  return `${cookieName(request, env)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}${secure}`;
}

export async function getSession(request, env) {
  const cookies = (request.headers.get("Cookie") || "").split(";").map((part) => part.trim());
  const prefix = `${cookieName(request, env)}=`;
  const token = cookies.find((part) => part.startsWith(prefix))?.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/.test(token || "")) return null;
  const version = await digest(env.PASSWORD_VERIFIER);
  return env.DB.prepare(
    `SELECT token_hash, csrf_token, expires_at, revision FROM sessions
     CROSS JOIN app_state WHERE app_state.id = 1 AND token_hash = ? AND expires_at > ? AND auth_version = ?`,
  ).bind(await digest(token), now(), version).first();
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
  if (typeof data.password !== "string" || encoder.encode(data.password).length > 1024) {
    throw new HttpError(400, "Invalid password input.");
  }
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
  const key = await passwordKey(data.password, config.verifier.salt, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, unhex(config.verifier.proof), PROOF)) {
    throw new HttpError(401, "Incorrect password.");
  }
  const token = randomToken();
  const csrfToken = randomToken();
  await env.DB.prepare("INSERT INTO sessions(token_hash, csrf_token, auth_version, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await digest(token), csrfToken, await digest(env.PASSWORD_VERIFIER), timestamp + config.ttl).run();
  return { token, csrfToken };
}
