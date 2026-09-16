import { ApiError, clientConfig, digest, hex, json, localHttp, numberSetting, readJson, requireOrigin, token, type Env } from './core';

interface Verifier { salt: string; proof: string }
interface UserRow {
  id: string;
  username: string;
  password_verifier: string;
  role: 'admin' | 'user';
  enabled: number;
  recovery_code_hash: string | null;
  recovery_code_created_at: number | null;
  approved_at: number | null;
  created_at: number;
  updated_at: number;
  deletion_requested_at: number | null;
}
export interface Identity {
  id: string;
  username: string;
  role: 'admin' | 'user';
  hasRecoveryCode: boolean;
  csrf: string;
  tokenHash: string;
  sessionExpiresAt: number | null;
  actorType: 'user' | 'ai';
  actorName: string;
}

const proofText = new TextEncoder().encode('easynote/password/v1');
const recoveryPattern = /^[a-f0-9]{64}$/;
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (v) => parseInt(v, 16));

function normalizeUsername(value: unknown): string {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new ApiError(400, 'Username must be 3-32 lowercase letters, digits, dots, underscores or hyphens.');
  }
  return username;
}

function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new ApiError(400, 'Password must be 12-128 characters.');
  }
  return value;
}

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

export async function passwordMatches(password: string, stored?: string): Promise<boolean> {
  let valid = false;
  let verifier: Verifier = { salt: '0'.repeat(64), proof: '0'.repeat(64) };
  try { verifier = parseVerifier(stored ?? ''); valid = true; } catch { /* Keep the password derivation path uniform. */ }
  const derived = await passwordVerifier(password, verifier.salt);
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= derived.proof.charCodeAt(i) ^ verifier.proof.charCodeAt(i);
  return valid && difference === 0;
}

function accountPasswords(data: Record<string, unknown>, includeNew: boolean): { currentPassword: string; newPassword?: string } {
  const allowed = includeNew ? ['currentPassword', 'newPassword'] : ['currentPassword'];
  if (Object.keys(data).some((key) => !allowed.includes(key)) ||
      typeof data.currentPassword !== 'string' || data.currentPassword.length > 128) {
    throw new ApiError(400, 'Current password is required.');
  }
  return {
    currentPassword: data.currentPassword,
    ...(includeNew ? { newPassword: validatePassword(data.newPassword) } : {}),
  };
}

async function requireCurrentPassword(env: Env, user: Identity, password: string): Promise<void> {
  const account = await env.DB.prepare('SELECT password_verifier FROM users WHERE id=? AND deletion_requested_at IS NULL')
    .bind(user.id).first<{ password_verifier: string }>();
  if (!account || !await passwordMatches(password, account.password_verifier)) {
    throw new ApiError(403, 'Current password is incorrect.');
  }
}

async function registrationEnabled(env: Env): Promise<boolean> {
  const state = await env.DB.prepare('SELECT self_registration_enabled AS enabled FROM app_state WHERE id=1')
    .first<{ enabled: number }>();
  return !!state?.enabled;
}

export async function ensureOwner(env: Env): Promise<boolean> {
  if (await env.DB.prepare('SELECT id FROM users LIMIT 1').first()) return true;
  if (!env.INITIAL_OWNER) return false;
  let owner: { username: string; verifier: Verifier };
  try {
    owner = JSON.parse(env.INITIAL_OWNER);
    owner.username = normalizeUsername(owner.username);
    parseVerifier(JSON.stringify(owner.verifier));
  } catch (error) {
    if (error instanceof ApiError) throw new ApiError(503, 'INITIAL_OWNER is invalid.');
    throw new ApiError(503, 'INITIAL_OWNER is invalid.');
  }
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO users
    (id,username,password_verifier,created_at,role,enabled,approved_at,updated_at)
    SELECT ?,?,?,?,'admin',1,?,? WHERE NOT EXISTS (SELECT 1 FROM users)`)
    .bind(crypto.randomUUID(), owner.username, JSON.stringify(owner.verifier), now, now, now).run();
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
  const row = await env.DB.prepare(`SELECT u.id,u.username,u.role,
      u.recovery_code_hash IS NOT NULL AS hasRecoveryCode,s.csrf,s.expires_at AS sessionExpiresAt
    FROM sessions s JOIN users u ON s.user_id=u.id
    WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1 AND u.deletion_requested_at IS NULL`)
    .bind(tokenHash, Date.now()).first<{
      id: string; username: string; role: 'admin' | 'user'; hasRecoveryCode: number;
      csrf: string; sessionExpiresAt: number;
    }>();
  return row ? {
    ...row,
    hasRecoveryCode: !!row.hasRecoveryCode,
    tokenHash,
    actorType: 'user',
    actorName: row.username,
  } : null;
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

function requireAdmin(user: Identity): void {
  if (user.role !== 'admin') throw new ApiError(403, 'Administrator access required.');
}

async function requireAnotherAdmin(env: Env, id: string): Promise<void> {
  const remaining = await env.DB.prepare(`SELECT COUNT(*) AS count FROM users
    WHERE id<>? AND role='admin' AND enabled=1 AND deletion_requested_at IS NULL`)
    .bind(id).first<{ count: number }>();
  if (!remaining?.count) throw new ApiError(409, 'At least one enabled administrator is required.');
}

const userView = (row: Pick<UserRow, 'id' | 'username' | 'role' | 'enabled' | 'approved_at' | 'created_at' | 'updated_at'>) => ({
  id: row.id,
  username: row.username,
  role: row.role,
  enabled: !!row.enabled,
  pendingApproval: row.approved_at === null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

async function limitAccountAction(request: Request, env: Env, action: string, ipLimitKey: keyof Env, globalLimitKey: keyof Env): Promise<void> {
  const ip = request.headers.get('CF-Connecting-IP') ?? (localHttp(request, env) ? 'local' : null);
  if (!ip) throw new ApiError(503, 'Client address is unavailable.');
  const window = numberSetting(env, 'ACCOUNT_WINDOW_SECONDS', 60, 86400) * 1000;
  for (const [key, limit] of [
    [`${action}:ip:${await digest(ip)}`, numberSetting(env, ipLimitKey, 1, 1000)],
    [`${action}:global`, numberSetting(env, globalLimitKey, 1, 10000)],
  ] as const) {
    const now = Date.now();
    const count = await env.DB.prepare(`INSERT INTO account_attempts(key,started_at,attempts) VALUES(?,?,1)
      ON CONFLICT(key) DO UPDATE SET
        attempts=CASE WHEN started_at<=? THEN 1 ELSE MIN(attempts+1,?) END,
        started_at=CASE WHEN started_at<=? THEN excluded.started_at ELSE started_at END
      RETURNING attempts`)
      .bind(key, now, now - window, limit + 1, now - window).first<{ attempts: number }>();
    if (!count || count.attempts > limit) throw new ApiError(429, 'Too many account requests. Try again later.');
  }
}

function formatRecoveryCode(value: string): string {
  return value.match(/.{8}/g)!.join('-');
}

function normalizeRecoveryCode(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase().replaceAll('-', '') : '';
  if (!recoveryPattern.test(normalized)) throw new ApiError(400, 'Invalid recovery code.');
  return normalized;
}

async function createSession(request: Request, env: Env, user: Pick<UserRow, 'id' | 'username' | 'role' | 'recovery_code_hash'>): Promise<Response> {
  const value = token();
  const csrf = token();
  const ttl = numberSetting(env, 'SESSION_DAYS', 1, 90) * 86400;
  const expiresAt = Date.now() + ttl * 1000;
  await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(value), user.id, csrf, expiresAt).run();
  return json({
    user: { id: user.id, username: user.username, role: user.role, hasRecoveryCode: user.recovery_code_hash !== null },
    csrf,
    configured: true,
    registrationEnabled: await registrationEnabled(env),
    config: clientConfig(env),
    expiresAt,
  }, 200, { 'Set-Cookie': cookie(request, env, value, ttl) });
}

async function register(request: Request, env: Env): Promise<Response> {
  requireOrigin(request);
  if (!await registrationEnabled(env)) throw new ApiError(403, 'Self-registration is closed.');
  const data = await readJson(request, 4096);
  if (Object.keys(data).some((key) => !['username', 'password'].includes(key))) throw new ApiError(400, 'Invalid registration fields.');
  const username = normalizeUsername(data.username);
  const password = validatePassword(data.password);
  await limitAccountAction(request, env, 'register', 'REGISTRATION_IP_LIMIT', 'REGISTRATION_GLOBAL_LIMIT');
  const recovery = token();
  const now = Date.now();
  try {
    await env.DB.prepare(`INSERT INTO users
      (id,username,password_verifier,created_at,role,enabled,recovery_code_hash,recovery_code_created_at,approved_at,updated_at)
      VALUES(?,?,?,?,'user',0,?,?,NULL,?)`)
      .bind(crypto.randomUUID(), username, JSON.stringify(await passwordVerifier(password)), now,
        await digest(recovery), now, now).run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ApiError(409, 'Username already exists.');
    throw error;
  }
  return json({ ok: true, pendingApproval: true, recoveryCode: formatRecoveryCode(recovery) }, 201);
}

async function resetPassword(request: Request, env: Env): Promise<Response> {
  requireOrigin(request);
  const data = await readJson(request, 4096);
  if (Object.keys(data).some((key) => !['username', 'recoveryCode', 'newPassword'].includes(key))) {
    throw new ApiError(400, 'Invalid password recovery fields.');
  }
  const username = normalizeUsername(data.username);
  const recovery = normalizeRecoveryCode(data.recoveryCode);
  const newPassword = validatePassword(data.newPassword);
  await limitAccountAction(request, env, 'reset', 'PASSWORD_RESET_IP_LIMIT', 'PASSWORD_RESET_GLOBAL_LIMIT');
  const recoveryHash = await digest(recovery);
  const row = await env.DB.prepare(`SELECT id,recovery_code_hash FROM users
    WHERE username=? AND deletion_requested_at IS NULL`).bind(username)
    .first<{ id: string; recovery_code_hash: string | null }>();
  if (!row || row.recovery_code_hash !== recoveryHash) throw new ApiError(401, 'Username or recovery code is incorrect.');
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE users SET password_verifier=?,recovery_code_hash=NULL,recovery_code_created_at=NULL,updated_at=?
      WHERE id=? AND recovery_code_hash=?`)
      .bind(JSON.stringify(await passwordVerifier(newPassword)), Date.now(), row.id, recoveryHash),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(row.id),
    env.DB.prepare('UPDATE integration_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(Date.now(), row.id),
  ]);
  if (!result[0].meta.changes) throw new ApiError(401, 'Username or recovery code is incorrect.');
  return json({ ok: true });
}

async function adminRoutes(request: Request, env: Env, user: Identity, path: string): Promise<Response | null> {
  if (!path.startsWith('/api/admin/')) return null;
  requireAdmin(user);
  if (path === '/api/admin/users' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT id,username,role,enabled,approved_at,created_at,updated_at
      FROM users WHERE deletion_requested_at IS NULL ORDER BY username COLLATE NOCASE`).all<UserRow>();
    return json({ users: rows.results.map(userView) });
  }
  if (path === '/api/admin/users' && request.method === 'POST') {
    const data = await readJson(request, 4096);
    if (Object.keys(data).some((key) => !['username', 'password', 'role'].includes(key))) throw new ApiError(400, 'Invalid user fields.');
    const username = normalizeUsername(data.username);
    const password = validatePassword(data.password);
    const role = data.role ?? 'user';
    if (role !== 'admin' && role !== 'user') throw new ApiError(400, 'Invalid user role.');
    const now = Date.now();
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(`INSERT INTO users
        (id,username,password_verifier,created_at,role,enabled,approved_at,updated_at)
        VALUES(?,?,?,?,?,1,?,?)`)
        .bind(id, username, JSON.stringify(await passwordVerifier(password)), now, role, now, now).run();
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new ApiError(409, 'Username already exists.');
      throw error;
    }
    return json({ user: userView({
      id, username, role, enabled: 1, approved_at: now, created_at: now, updated_at: now,
    }) }, 201);
  }
  if (path === '/api/admin/settings/registration' && request.method === 'PATCH') {
    const data = await readJson(request, 1024);
    if (Object.keys(data).some((key) => key !== 'enabled') || typeof data.enabled !== 'boolean') {
      throw new ApiError(400, 'Invalid registration state.');
    }
    await env.DB.prepare('UPDATE app_state SET self_registration_enabled=? WHERE id=1').bind(Number(data.enabled)).run();
    return json({ registrationEnabled: data.enabled });
  }
  const match = /^\/api\/admin\/users\/([^/]+)$/.exec(path);
  if (!match) return null;
  const id = match[1];
  const target = await env.DB.prepare('SELECT * FROM users WHERE id=? AND deletion_requested_at IS NULL')
    .bind(id).first<UserRow>();
  if (!target) throw new ApiError(404, 'User not found.');
  if (request.method === 'PATCH') {
    const data = await readJson(request, 4096);
    if (Object.keys(data).some((key) => !['username', 'password', 'role', 'enabled'].includes(key))) {
      throw new ApiError(400, 'Invalid user fields.');
    }
    const username = data.username === undefined ? target.username : normalizeUsername(data.username);
    const role = data.role === undefined ? target.role : data.role;
    const enabled = data.enabled === undefined ? !!target.enabled : data.enabled;
    if (role !== 'admin' && role !== 'user' || typeof enabled !== 'boolean') throw new ApiError(400, 'Invalid role or enabled state.');
    if (id === user.id && (role !== 'admin' || !enabled)) {
      throw new ApiError(409, 'The current administrator cannot disable or demote itself.');
    }
    if (target.role === 'admin' && target.enabled && (role !== 'admin' || !enabled)) await requireAnotherAdmin(env, id);
    const password = data.password === undefined ? null : validatePassword(data.password);
    if (username === target.username && role === target.role && Number(enabled) === target.enabled && !password) {
      return json({ user: userView(target), signedOut: false });
    }
    const verifier = password ? JSON.stringify(await passwordVerifier(password)) : target.password_verifier;
    const now = Date.now();
    try {
      await env.DB.batch([
        env.DB.prepare(`UPDATE users SET username=?,password_verifier=?,role=?,enabled=?,
          recovery_code_hash=?,recovery_code_created_at=?,approved_at=?,updated_at=? WHERE id=?`)
          .bind(username, verifier, role, Number(enabled),
            password ? null : target.recovery_code_hash,
            password ? null : target.recovery_code_created_at,
            enabled ? target.approved_at ?? now : target.approved_at, now, id),
        env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
        ...(password || !enabled
          ? [env.DB.prepare('UPDATE integration_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now, id)]
          : []),
      ]);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new ApiError(409, 'Username already exists.');
      throw error;
    }
    return json({ user: userView({
      id, username, role, enabled: Number(enabled),
      approved_at: enabled ? target.approved_at ?? now : target.approved_at,
      created_at: target.created_at, updated_at: now,
    }), signedOut: id === user.id });
  }
  if (request.method === 'DELETE') {
    if (id === user.id) throw new ApiError(409, 'The current administrator cannot delete itself.');
    if (target.role === 'admin' && target.enabled) await requireAnotherAdmin(env, id);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET enabled=0,deletion_requested_at=?,updated_at=? WHERE id=?').bind(now, now, id),
      env.DB.prepare("UPDATE images SET status='deleting' WHERE user_id=?").bind(id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
      env.DB.prepare('UPDATE integration_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now, id),
    ]);
    return json({ ok: true }, 202);
  }
  return null;
}

export async function authRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/api/session' && request.method === 'GET') {
    const configured = await ensureOwner(env);
    const user = await identity(request, env);
    return json({
      user: user ? {
        id: user.id,
        username: user.username,
        role: user.role,
        hasRecoveryCode: user.hasRecoveryCode,
      } : null,
      csrf: user?.csrf ?? null,
      configured,
      registrationEnabled: await registrationEnabled(env),
      config: clientConfig(env),
      expiresAt: user?.sessionExpiresAt ?? null,
    });
  }
  if (path === '/api/register' && request.method === 'POST') return register(request, env);
  if (path === '/api/account/reset-password' && request.method === 'POST') return resetPassword(request, env);
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
      const now = Date.now();
      const count = await env.DB.prepare(`INSERT INTO login_attempts(key,started_at,attempts) VALUES(?,?,1)
        ON CONFLICT(key) DO UPDATE SET
          attempts=CASE WHEN started_at<=? THEN 1 ELSE MIN(attempts+1,?) END,
          started_at=CASE WHEN started_at<=? THEN excluded.started_at ELSE started_at END
        RETURNING attempts`).bind(key, now, now - window, limit + 1, now - window).first<{ attempts: number }>();
      if (!count || count.attempts > limit) throw new ApiError(429, 'Too many login attempts. Try again later.');
    }
    const username = data.username.trim().toLowerCase();
    const user = await env.DB.prepare(`SELECT * FROM users
      WHERE username=? AND enabled=1 AND deletion_requested_at IS NULL`)
      .bind(username).first<UserRow>();
    if (!await passwordMatches(data.password, user?.password_verifier) || !user) {
      throw new ApiError(401, 'Incorrect username or password.');
    }
    return createSession(request, env, user);
  }
  if (path === '/api/logout' && request.method === 'POST') {
    const user = await requireIdentity(request, env);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(user.tokenHash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, env, '', 0) });
  }
  if (path !== '/api/account' && !path.startsWith('/api/account/') && !path.startsWith('/api/admin/')) return null;
  const user = await requireIdentity(request, env);
  const admin = await adminRoutes(request, env, user, path);
  if (admin) return admin;
  if (path === '/api/account/password' && request.method === 'POST') {
    const passwords = accountPasswords(await readJson(request, 4096), true);
    await requireCurrentPassword(env, user, passwords.currentPassword);
    if (passwords.currentPassword === passwords.newPassword) throw new ApiError(400, 'The new password must be different.');
    const verifier = await passwordVerifier(passwords.newPassword!);
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET password_verifier=?,recovery_code_hash=NULL,
        recovery_code_created_at=NULL,updated_at=? WHERE id=?`)
        .bind(JSON.stringify(verifier), Date.now(), user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(user.id, user.tokenHash),
      env.DB.prepare('UPDATE integration_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(Date.now(), user.id),
    ]);
    return json({ ok: true, otherSessionsRevoked: true });
  }
  if (path === '/api/account/logout-all' && request.method === 'POST') {
    const passwords = accountPasswords(await readJson(request, 4096), false);
    await requireCurrentPassword(env, user, passwords.currentPassword);
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, env, '', 0) });
  }
  if (path === '/api/account/recovery-code' && request.method === 'POST') {
    const passwords = accountPasswords(await readJson(request, 4096), false);
    await requireCurrentPassword(env, user, passwords.currentPassword);
    const recovery = token();
    const now = Date.now();
    await env.DB.prepare('UPDATE users SET recovery_code_hash=?,recovery_code_created_at=?,updated_at=? WHERE id=?')
      .bind(await digest(recovery), now, now, user.id).run();
    return json({ recoveryCode: formatRecoveryCode(recovery) }, 201);
  }
  if (path === '/api/account' && request.method === 'DELETE') {
    const data = await readJson(request, 2048);
    if (Object.keys(data).some((key) => !['username', 'currentPassword'].includes(key)) ||
        data.username !== user.username || typeof data.currentPassword !== 'string' ||
        data.currentPassword.length > 128) throw new ApiError(400, 'Username and current password confirmation are required.');
    await requireCurrentPassword(env, user, data.currentPassword);
    if (user.role === 'admin') await requireAnotherAdmin(env, user.id);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET enabled=0,deletion_requested_at=?,updated_at=? WHERE id=?').bind(now, now, user.id),
      env.DB.prepare("UPDATE images SET status='deleting' WHERE user_id=?").bind(user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),
      env.DB.prepare('UPDATE integration_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now, user.id),
    ]);
    return json({ ok: true }, 202, { 'Set-Cookie': cookie(request, env, '', 0) });
  }
  return null;
}
