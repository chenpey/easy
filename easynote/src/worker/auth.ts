import { ApiError, clientConfig, digest, hex, json, localHttp, numberSetting, readJson, requireOrigin, token, type Env } from './core';

interface Verifier { salt: string; proof: string }
export interface Identity {
  id: string;
  username: string;
  csrf: string;
  tokenHash: string;
  actorType: 'user' | 'ai';
  actorName: string;
}
const proofText = new TextEncoder().encode('easynote/password/v1');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (v) => parseInt(v, 16));

export async function passwordVerifier(password: string, salt = token()): Promise<Verifier> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unhex(salt), iterations: 100_000, hash: 'SHA-256' },
    material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'],
  );
  return { salt, proof: hex(await crypto.subtle.sign('HMAC', key, proofText)) };
}

function parseVerifier(value: string): Verifier {
  const parsed = JSON.parse(value) as Verifier;
  if (!/^[a-f0-9]{64}$/.test(parsed.salt) || !/^[a-f0-9]{64}$/.test(parsed.proof)) throw new Error('Invalid verifier');
  return parsed;
}

async function matches(password: string, stored?: string): Promise<boolean> {
  let valid = false;
  let verifier: Verifier = { salt: '0'.repeat(64), proof: '0'.repeat(64) };
  try { verifier = parseVerifier(stored ?? ''); valid = true; } catch { /* Keep the password derivation path uniform. */ }
  const derived = await passwordVerifier(password, verifier.salt);
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= derived.proof.charCodeAt(i) ^ verifier.proof.charCodeAt(i);
  return valid && difference === 0;
}

export async function ensureOwner(env: Env): Promise<boolean> {
  if (await env.DB.prepare('SELECT id FROM users LIMIT 1').first()) return true;
  if (!env.INITIAL_OWNER) return false;
  let owner: { username: string; verifier: Verifier };
  try {
    owner = JSON.parse(env.INITIAL_OWNER);
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(owner.username)) throw new Error();
    parseVerifier(JSON.stringify(owner.verifier));
  } catch { throw new ApiError(503, 'INITIAL_OWNER is invalid.'); }
  await env.DB.prepare(`INSERT INTO users(id, username, password_verifier, created_at)
    SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`)
    .bind(crypto.randomUUID(), owner.username, JSON.stringify(owner.verifier), Date.now()).run();
  return true;
}

const cookieName = (request: Request, env: Env) => localHttp(request, env) ? 'easynote_dev' : '__Host-easynote';
function cookie(request: Request, env: Env, value: string, age: number) {
  return `${cookieName(request, env)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${localHttp(request, env) ? '' : '; Secure'}`;
}

export async function identity(request: Request, env: Env): Promise<Identity | null> {
  const name = `${cookieName(request, env)}=`;
  const value = request.headers.get('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(name))?.slice(name.length);
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  const tokenHash = await digest(value);
  const row = await env.DB.prepare(`SELECT u.id, u.username, s.csrf FROM sessions s JOIN users u ON s.user_id=u.id
    WHERE s.token_hash=? AND s.expires_at>?`).bind(tokenHash, Date.now()).first<{ id: string; username: string; csrf: string }>();
  return row ? { ...row, tokenHash, actorType: 'user', actorName: row.username } : null;
}

export async function requireIdentity(request: Request, env: Env): Promise<Identity> {
  const user = await identity(request, env);
  if (!user) throw new ApiError(401, 'Please sign in.');
  if (!['GET', 'HEAD'].includes(request.method)) {
    requireOrigin(request);
    if (request.headers.get('X-CSRF-Token') !== user.csrf) throw new ApiError(403, 'Invalid CSRF token.');
  }
  return user;
}

export async function authRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/api/session' && request.method === 'GET') {
    const configured = await ensureOwner(env);
    const user = await identity(request, env);
    return json({ user: user ? { id: user.id, username: user.username } : null, csrf: user?.csrf ?? null, configured, config: clientConfig(env) });
  }
  if (path === '/api/login' && request.method === 'POST') {
    requireOrigin(request);
    if (!await ensureOwner(env)) throw new ApiError(503, 'Owner account is not configured.');
    const data = await readJson(request);
    if (typeof data.username !== 'string' || typeof data.password !== 'string' || data.password.length > 128) {
      throw new ApiError(400, 'Invalid credentials format.');
    }
    const ip = request.headers.get('CF-Connecting-IP') ?? (localHttp(request, env) ? 'local' : null);
    if (!ip) throw new ApiError(503, 'Client address is unavailable.');
    const window = numberSetting(env, 'LOGIN_WINDOW_SECONDS', 60, 86400) * 1000;
    for (const [key, limit] of [
      [`ip:${await digest(ip)}`, numberSetting(env, 'LOGIN_IP_LIMIT', 1, 1000)],
      ['global', numberSetting(env, 'LOGIN_GLOBAL_LIMIT', 1, 10000)],
    ] as const) {
      const count = await env.DB.prepare(`INSERT INTO login_attempts(key, started_at, attempts) VALUES(?, ?, 1)
        ON CONFLICT(key) DO UPDATE SET
          attempts=CASE WHEN started_at<=? THEN 1 ELSE MIN(attempts+1, ?) END,
          started_at=CASE WHEN started_at<=? THEN excluded.started_at ELSE started_at END
        RETURNING attempts`).bind(key, Date.now(), Date.now() - window, limit + 1, Date.now() - window).first<{ attempts: number }>();
      if (!count || count.attempts > limit) throw new ApiError(429, 'Too many login attempts. Try again later.');
    }
    const user = await env.DB.prepare('SELECT id, username, password_verifier FROM users WHERE username=?')
      .bind(data.username.trim().toLowerCase()).first<{ id: string; username: string; password_verifier: string }>();
    if (!await matches(data.password, user?.password_verifier) || !user) throw new ApiError(401, 'Incorrect username or password.');
    const value = token();
    const csrf = token();
    const ttl = numberSetting(env, 'SESSION_DAYS', 1, 90) * 86400;
    await env.DB.prepare('INSERT INTO sessions VALUES(?, ?, ?, ?)').bind(await digest(value), user.id, csrf, Date.now() + ttl * 1000).run();
    return json({ user: { id: user.id, username: user.username }, csrf, configured: true, config: clientConfig(env) }, 200, {
      'Set-Cookie': cookie(request, env, value, ttl),
    });
  }
  if (path === '/api/logout' && request.method === 'POST') {
    const user = await requireIdentity(request, env);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(user.tokenHash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, env, '', 0) });
  }
  return null;
}
