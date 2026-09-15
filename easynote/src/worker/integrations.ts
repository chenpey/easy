import { idPattern, type IntegrationToken } from '../shared/types';
import type { Identity } from './auth';
import { ApiError, digest, json, readJson, token, type Env } from './core';
import { noteRoutes } from './notes';

interface TokenRow {
  id: string;
  user_id: string;
  username: string;
  name: string;
  token_hash: string;
  access: 'read' | 'read-write';
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}

export interface IntegrationIdentity extends Identity {
  access: 'read' | 'read-write';
  tokenId: string;
}

const tokenRecord = (row: Omit<TokenRow, 'user_id' | 'username' | 'token_hash'>): IntegrationToken => ({
  id: row.id,
  name: row.name,
  access: row.access,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
});

export async function integrationTokenRoutes(
  request: Request,
  env: Env,
  user: Identity,
  path: string,
): Promise<Response | null> {
  if (path === '/api/integrations/tokens' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT id,name,access,created_at,expires_at,last_used_at
      FROM integration_tokens WHERE user_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)
      ORDER BY created_at DESC`).bind(user.id, Date.now())
      .all<Omit<TokenRow, 'user_id' | 'username' | 'token_hash'>>();
    return json({ tokens: rows.results.map(tokenRecord) });
  }
  if (path === '/api/integrations/tokens' && request.method === 'POST') {
    const data = await readJson(request, 4096);
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const access = data.access;
    const expiresInDays = data.expiresInDays;
    if (!name || name.length > 40 || /[\u0000-\u001f]/.test(name) ||
        access !== 'read' && access !== 'read-write' ||
        !(expiresInDays === null || typeof expiresInDays === 'number' &&
          Number.isSafeInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 365) ||
        Object.keys(data).some((key) => !['name', 'access', 'expiresInDays'].includes(key))) {
      throw new ApiError(400, 'Invalid integration token settings.');
    }
    const value = `enai_${token()}`;
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = expiresInDays === null ? null : now + expiresInDays * 86400_000;
    const inserted = await env.DB.prepare(`INSERT INTO integration_tokens
      (id,user_id,name,token_hash,access,created_at,expires_at,last_used_at,revoked_at)
      SELECT ?,?,?,?,?,?,?,NULL,NULL
      WHERE (SELECT COUNT(*) FROM integration_tokens
        WHERE user_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?))<10`)
      .bind(id, user.id, name, await digest(value), access, now, expiresAt, user.id, now).run();
    if (!inserted.meta.changes) throw new ApiError(409, 'At most 10 active integration tokens are allowed.');
    return json({
      token: { id, name, access, createdAt: now, expiresAt, lastUsedAt: null },
      secret: value,
    }, 201);
  }
  const match = /^\/api\/integrations\/tokens\/([^/]+)$/.exec(path);
  if (match && request.method === 'DELETE') {
    if (!idPattern.test(match[1])) throw new ApiError(404, 'Integration token not found.');
    const result = await env.DB.prepare(`UPDATE integration_tokens SET revoked_at=?
      WHERE id=? AND user_id=? AND revoked_at IS NULL`).bind(Date.now(), match[1], user.id).run();
    if (!result.meta.changes) throw new ApiError(404, 'Integration token not found.');
    return json({ ok: true });
  }
  return null;
}

export async function integrationIdentity(request: Request, env: Env): Promise<IntegrationIdentity> {
  const authorization = request.headers.get('Authorization') ?? '';
  const match = /^Bearer (enai_[a-f0-9]{64})$/.exec(authorization);
  if (!match) throw new ApiError(401, 'A valid EasyNote integration token is required.');
  const tokenHash = await digest(match[1]);
  const now = Date.now();
  const row = await env.DB.prepare(`SELECT t.*,u.username FROM integration_tokens t
    JOIN users u ON u.id=t.user_id
    WHERE t.token_hash=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)`)
    .bind(tokenHash, now).first<TokenRow>();
  if (!row) throw new ApiError(401, 'The integration token is invalid, expired, or revoked.');
  if (row.last_used_at === null || row.last_used_at < now - 15 * 60_000) {
    await env.DB.prepare('UPDATE integration_tokens SET last_used_at=? WHERE id=?').bind(now, row.id).run();
  }
  return {
    id: row.user_id,
    username: row.username,
    csrf: '',
    tokenHash,
    actorType: 'ai',
    actorName: row.name,
    access: row.access,
    tokenId: row.id,
  };
}

export async function integrationRoutes(
  request: Request,
  env: Env,
  user: IntegrationIdentity,
  path: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (path === '/api/integrations/status' && request.method === 'GET') {
    return json({ account: user.username, integration: user.actorName, access: user.access });
  }
  if (path === '/api/integrations/notes' && request.method === 'GET') {
    const view = url.searchParams.get('view') ?? 'all';
    if (!['all', 'archive'].includes(view)) throw new ApiError(400, 'AI search only supports active or archived notes.');
    return noteRoutes(request, env, user, '/api/notes');
  }
  const noteMatch = /^\/api\/integrations\/notes\/([^/]+)$/.exec(path);
  if (noteMatch && ['GET', 'POST', 'PUT'].includes(request.method)) {
    if (request.method !== 'GET' && user.access !== 'read-write') {
      throw new ApiError(403, 'This integration token is read-only.');
    }
    return noteRoutes(request, env, user, `/api/notes/${noteMatch[1]}`);
  }
  return null;
}
