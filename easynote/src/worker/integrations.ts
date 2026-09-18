import {
  idPattern,
  type IntegrationNoteSummary,
  type IntegrationToken,
  type NoteSearchMatch,
} from '../shared/types';
import type { Identity } from './auth';
import { ApiError, digest, json, readJson, token, type Env } from './core';
import { noteRoutes, toNote, type NoteRow } from './notes';

interface TokenRow {
  id: string;
  user_id: string;
  username: string;
  role: 'admin' | 'user';
  has_recovery_code: number;
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

const noteUri = (id: string) => `easynote://notes/${id}.md`;
const trigramLength = 3;
const titleSearchWeight = 8;

function snippetAround(value: string, index: number, length: number): string {
  const start = Math.max(0, index - 90);
  const end = Math.min(value.length, index + length + 90);
  const snippet = value.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '...' : ''}${snippet}${end < value.length ? '...' : ''}`;
}

function closestHeading(content: string, index: number): string | null {
  let heading: string | null = null;
  for (const match of content.slice(0, index).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    heading = match[1].trim();
  }
  return heading;
}

function searchMatches(row: NoteRow, query: string): NoteSearchMatch[] {
  if (!query) return [];
  const matches: NoteSearchMatch[] = [];
  const needle = query.toLowerCase();
  const titleIndex = row.title.toLowerCase().indexOf(needle);
  if (titleIndex >= 0) {
    matches.push({
      field: 'title',
      line: null,
      heading: null,
      snippet: snippetAround(row.title, titleIndex, query.length),
    });
  }

  const content = row.content;
  const normalizedContent = content.toLowerCase();
  const matchedLines = new Set<number>();
  let index = normalizedContent.indexOf(needle);
  while (index >= 0 && matches.length < 3) {
    const line = content.slice(0, index).split('\n').length;
    if (!matchedLines.has(line)) {
      matches.push({
        field: 'content',
        line,
        heading: closestHeading(content, index),
        snippet: snippetAround(content, index, query.length),
      });
      matchedLines.add(line);
    }
    index = normalizedContent.indexOf(needle, index + Math.max(needle.length, 1));
  }
  return matches;
}

async function searchNotes(request: Request, env: Env, user: IntegrationIdentity): Promise<Response> {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') ?? '').slice(0, 200);
  const ftsQuery = Array.from(query).length >= trigramLength && /\S/.test(query)
    ? `"${query.replaceAll('"', '""')}"`
    : null;
  const view = url.searchParams.get('view') ?? 'all';
  if (!['all', 'archive'].includes(view)) throw new ApiError(400, 'AI search only supports active or archived notes.');
  const offset = Number(url.searchParams.get('offset') ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, 'Invalid offset.');
  const limit = Number(url.searchParams.get('limit') ?? 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new ApiError(400, 'Invalid limit.');
  const sort = url.searchParams.get('sort') ?? 'default';
  if (!['default', 'updated'].includes(sort)) throw new ApiError(400, 'Invalid sort.');
  const tag = (url.searchParams.get('tag') ?? '').slice(0, 40);
  const escape = (value: string) => value.replace(/[\\%_]/g, '\\$&');
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (ftsQuery) {
    filters.push('notes_fts MATCH ?');
    binds.push(ftsQuery);
  }
  filters.push('n.user_id=?', 'n.deleted_at IS NULL', `n.archived=${view === 'archive' ? 1 : 0}`);
  binds.push(user.id);
  if (query && !ftsQuery) {
    filters.push("(n.title LIKE ? ESCAPE '\\' OR n.content LIKE ? ESCAPE '\\')");
    binds.push(`%${escape(query)}%`, `%${escape(query)}%`);
  }
  if (tag) {
    filters.push('EXISTS(SELECT 1 FROM json_each(n.tags) WHERE value=?)');
    binds.push(tag);
  }
  const orderBinds: unknown[] = [];
  let order = sort === 'updated' ? 'n.updated_at DESC,n.id ASC' : 'n.pinned DESC,n.updated_at DESC,n.id ASC';
  if (query && sort === 'default') {
    const escaped = escape(query);
    if (ftsQuery) {
      order = `CASE WHEN n.title = ? COLLATE NOCASE THEN 0 ELSE 1 END,
        bm25(notes_fts,${titleSearchWeight},1.0),n.pinned DESC,n.updated_at DESC,n.id ASC`;
      orderBinds.push(query);
    } else {
      order = `CASE WHEN n.title = ? COLLATE NOCASE THEN 0
        WHEN n.title LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
        ((length(lower(n.title))-length(replace(lower(n.title),?,'')))*8+
          length(lower(n.content))-length(replace(lower(n.content),?,''))) DESC,
        n.pinned DESC,n.updated_at DESC,n.id ASC`;
      orderBinds.push(query, `${escaped}%`, query.toLowerCase(), query.toLowerCase());
    }
  }
  const source = ftsQuery ? 'notes_fts JOIN notes n ON n.rowid=notes_fts.rowid' : 'notes n';
  const result = await env.DB.prepare(`SELECT n.* FROM ${source} WHERE ${filters.join(' AND ')}
    ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...binds, ...orderBinds, limit + 1, offset).all<NoteRow>();
  const notes: IntegrationNoteSummary[] = result.results.slice(0, limit).map((row) => {
    const { content, ...note } = toNote(row);
    const matches = searchMatches(row, query);
    return {
      ...note,
      excerpt: matches.find((match) => match.field === 'content')?.snippet ??
        matches[0]?.snippet ?? content.slice(0, 180),
      matches,
      uri: noteUri(row.id),
    };
  });
  return json({ notes, nextOffset: result.results.length > limit ? offset + limit : null });
}

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
  const row = await env.DB.prepare(`SELECT t.*,u.username,u.role,
      u.recovery_code_hash IS NOT NULL AS has_recovery_code FROM integration_tokens t
    JOIN users u ON u.id=t.user_id
    WHERE t.token_hash=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)
      AND u.enabled=1 AND u.deletion_requested_at IS NULL`)
    .bind(tokenHash, now).first<TokenRow>();
  if (!row) throw new ApiError(401, 'The integration token is invalid, expired, or revoked.');
  if (row.last_used_at === null || row.last_used_at < now - 15 * 60_000) {
    await env.DB.prepare('UPDATE integration_tokens SET last_used_at=? WHERE id=?').bind(now, row.id).run();
  }
  return {
    id: row.user_id,
    username: row.username,
    role: row.role,
    hasRecoveryCode: !!row.has_recovery_code,
    csrf: '',
    tokenHash,
    sessionExpiresAt: null,
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
    return searchNotes(request, env, user);
  }
  if (path === '/api/integrations/notes/batch' && request.method === 'GET') {
    const rawIds = url.searchParams.get('ids');
    const ids = rawIds?.split(',') ?? [];
    if (url.searchParams.getAll('ids').length !== 1 || ids.length < 1 || ids.length > 20 ||
        ids.some((id) => !idPattern.test(id))) {
      throw new ApiError(400, 'Provide between 1 and 20 valid note IDs.');
    }
    const rows = await env.DB.prepare(`SELECT * FROM notes WHERE user_id=? AND id IN
      (${ids.map(() => '?').join(',')})`).bind(user.id, ...ids).all<NoteRow>();
    const notesById = new Map(rows.results.map((row) => [row.id, toNote(row)]));
    const missingIds = ids.filter((id) => !notesById.has(id));
    if (missingIds.length) throw new ApiError(404, 'One or more notes were not found.', { missingIds });
    return json({ notes: ids.map((id) => notesById.get(id)!) });
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
