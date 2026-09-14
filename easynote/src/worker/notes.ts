import { idPattern, imageIds, type Note, type NoteInput } from '../shared/types';
import { ApiError, clientConfig, digest, json, numberSetting, readJson, type Env } from './core';
import type { Identity } from './auth';

interface Row {
  id: string; user_id: string; title: string; content: string; tags: string; pinned: number;
  deleted_at: number | null; created_at: number; updated_at: number; revision: number;
  mutation_id: string; mutation_hash: string;
}
const toNote = (row: Row): Note => ({
  id: row.id, title: row.title, content: row.content, tags: JSON.parse(row.tags),
  pinned: !!row.pinned, deletedAt: row.deleted_at, createdAt: row.created_at,
  updatedAt: row.updated_at, revision: row.revision,
});

async function load(env: Env, userId: string, id: string): Promise<Row | null> {
  return env.DB.prepare('SELECT * FROM notes WHERE id=? AND user_id=?').bind(id, userId).first<Row>();
}

function validate(data: Record<string, unknown>, env: Env): NoteInput {
  if (typeof data.title !== 'string' || data.title.length > 256 ||
      typeof data.content !== 'string' ||
      new TextEncoder().encode(data.content).length > clientConfig(env).maxNoteBytes ||
      !Array.isArray(data.tags) || data.tags.length > 20 ||
      data.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 40) ||
      typeof data.pinned !== 'boolean' ||
      !(data.deletedAt === null || typeof data.deletedAt === 'number' && Number.isSafeInteger(data.deletedAt) && data.deletedAt > 0)) {
    throw new ApiError(400, 'Invalid note fields or note size limit exceeded.');
  }
  return {
    title: data.title.trim(), content: data.content,
    tags: [...new Set((data.tags as string[]).map((tag) => tag.trim()))],
    pinned: data.pinned, deletedAt: data.deletedAt as number | null,
  };
}

async function save(request: Request, env: Env, user: Identity, id: string, create: boolean): Promise<Response> {
  const data = await readJson(request, clientConfig(env).maxNoteBytes * 6 + 8192);
  const input = validate(data, env);
  if (!idPattern.test(id) || typeof data.operationId !== 'string' || !idPattern.test(data.operationId) ||
      !Number.isSafeInteger(data.revision) || Number(data.revision) < 0 ||
      (create && data.revision !== 0) || (!create && data.revision === 0)) {
    throw new ApiError(400, 'Invalid revision or operation ID.');
  }
  const hash = await digest(JSON.stringify({ ...input, revision: data.revision }));
  const current = await load(env, user.id, id);
  if (current?.mutation_id === data.operationId) {
    if (current.mutation_hash !== hash) throw new ApiError(409, 'Operation ID reused with different content.');
    return json({ note: toNote(current) });
  }
  if ((!create && !current) || await env.DB.prepare('SELECT id FROM purged_notes WHERE id=?').bind(id).first()) {
    throw new ApiError(410, 'This note no longer exists. Keep a new copy of your draft.');
  }
  if (current && (create || current.revision !== data.revision)) {
    throw new ApiError(409, 'The note changed on another device.', { current: toNote(current) });
  }
  const ids = imageIds(input.content);
  if (ids.length > 80) throw new ApiError(400, 'A note can reference at most 80 images.');
  const placeholders = ids.map(() => '?').join(',');
  const readyCondition = ids.length
    ? `(SELECT COUNT(*) FROM images WHERE user_id=? AND status='ready' AND id IN (${placeholders}))=?`
    : '1=1';
  const readyBinds = ids.length ? [user.id, ...ids, ids.length] : [];
  const time = Date.now();
  const revision = Number(data.revision) + 1;
  const mutation = data.operationId;
  const fields = [input.title, input.content, JSON.stringify(input.tags), input.pinned ? 1 : 0, input.deletedAt];
  const statements: D1PreparedStatement[] = [];
  if (create) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO notes
      (id,user_id,title,content,tags,pinned,deleted_at,created_at,updated_at,revision,mutation_id,mutation_hash)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?
      WHERE ${readyCondition}
        AND NOT EXISTS(SELECT 1 FROM purged_notes WHERE id=?)
        AND (SELECT COUNT(*) FROM notes WHERE user_id=?)<?`)
      .bind(id, user.id, ...fields, time, time, revision, mutation, hash, ...readyBinds, id, user.id, numberSetting(env, 'MAX_NOTES', 1, 10000)));
  } else {
    statements.push(env.DB.prepare(`UPDATE notes SET title=?,content=?,tags=?,pinned=?,deleted_at=?,
      updated_at=?,revision=?,mutation_id=?,mutation_hash=?
      WHERE id=? AND user_id=? AND revision=? AND ${readyCondition}`)
      .bind(...fields, time, revision, mutation, hash, id, user.id, data.revision, ...readyBinds));
  }
  const guard = 'EXISTS(SELECT 1 FROM notes WHERE id=? AND user_id=? AND revision=? AND mutation_id=?)';
  const guardBinds = [id, user.id, revision, mutation];
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO note_versions
    SELECT id,revision,title,content,tags,pinned,deleted_at,updated_at FROM notes
    WHERE id=? AND user_id=? AND revision=? AND mutation_id=?`).bind(...guardBinds));
  for (const imageId of ids) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO image_refs SELECT ?,?,? WHERE ${guard}`)
      .bind(id, imageId, revision, ...guardBinds));
    statements.push(env.DB.prepare(`UPDATE images SET last_used_at=? WHERE id=? AND user_id=? AND ${guard}`)
      .bind(time, imageId, user.id, ...guardBinds));
  }
  const keep = numberSetting(env, 'VERSIONS_KEPT', 1, 100);
  statements.push(env.DB.prepare(`DELETE FROM note_versions WHERE note_id=? AND revision<=? AND ${guard}`)
    .bind(id, revision - keep, ...guardBinds));
  statements.push(env.DB.prepare(`DELETE FROM image_refs WHERE note_id=? AND revision<=? AND ${guard}`)
    .bind(id, revision - keep, ...guardBinds));
  const result = await env.DB.batch(statements);
  const saved = await load(env, user.id, id);
  if (!result[0].meta.changes) {
    if (saved) throw new ApiError(409, 'The note changed on another device.', { current: toNote(saved) });
    throw new ApiError(409, 'An image is unavailable, the note was purged, or the note limit was reached.');
  }
  return json({ note: toNote(saved!) }, create ? 201 : 200);
}

export async function noteRoutes(request: Request, env: Env, user: Identity, path: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (path === '/api/notes' && request.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    const view = url.searchParams.get('view') ?? 'all';
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, 'Invalid offset.');
    const tag = (url.searchParams.get('tag') ?? '').slice(0, 40);
    const escape = (value: string) => value.replace(/[\\%_]/g, '\\$&');
    const filters = ['user_id=?'];
    const binds: unknown[] = [user.id];
    if (view !== 'export') filters.push(view === 'trash' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL');
    if (view === 'pinned') filters.push('pinned=1');
    if (q) { filters.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')"); binds.push(`%${escape(q)}%`, `%${escape(q)}%`); }
    if (tag) { filters.push('EXISTS(SELECT 1 FROM json_each(notes.tags) WHERE value=?)'); binds.push(tag); }
    const result = await env.DB.prepare(`SELECT id,title,substr(content,1,180) AS content,tags,pinned,deleted_at,created_at,updated_at,revision
      FROM notes WHERE ${filters.join(' AND ')} ORDER BY pinned DESC,updated_at DESC,id ASC LIMIT 51 OFFSET ?`)
      .bind(...binds, offset).all<Row>();
    const notes = result.results.slice(0, 50).map((row) => {
      const { content, ...note } = toNote(row);
      return { ...note, excerpt: content };
    });
    return json({ notes, nextOffset: result.results.length > 50 ? offset + 50 : null });
  }
  if (path === '/api/tags' && request.method === 'GET') {
    const result = await env.DB.prepare(`SELECT DISTINCT value AS name FROM notes,json_each(notes.tags)
      WHERE user_id=? AND deleted_at IS NULL ORDER BY value LIMIT 200`).bind(user.id).all<{ name: string }>();
    return json({ tags: result.results.map((row) => row.name) });
  }
  const match = /^\/api\/notes\/([^/]+)(?:\/(versions))?$/.exec(path);
  if (!match) return null;
  const id = match[1];
  if (!idPattern.test(id)) throw new ApiError(404, 'Note not found.');
  if (match[2] && request.method === 'GET') {
    if (!await load(env, user.id, id)) throw new ApiError(404, 'Note not found.');
    const rows = await env.DB.prepare('SELECT * FROM note_versions WHERE note_id=? ORDER BY revision DESC')
      .bind(id).all<Row & { saved_at: number }>();
    return json({ versions: rows.results.map((row) => ({
      title: row.title, content: row.content, tags: JSON.parse(row.tags), pinned: !!row.pinned,
      deletedAt: row.deleted_at, revision: row.revision, savedAt: row.saved_at,
    })) });
  }
  if (match[2]) return null;
  if (request.method === 'GET') {
    const row = await load(env, user.id, id);
    if (!row) throw new ApiError(404, 'Note not found.');
    return json({ note: toNote(row) });
  }
  if (request.method === 'POST' || request.method === 'PUT') return save(request, env, user, id, request.method === 'POST');
  if (request.method === 'DELETE') {
    const data = await readJson(request);
    if (!Number.isSafeInteger(data.revision)) throw new ApiError(400, 'Revision required.');
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO purged_notes SELECT id,user_id,? FROM notes
        WHERE id=? AND user_id=? AND deleted_at IS NOT NULL AND revision=?`)
        .bind(Date.now(), id, user.id, data.revision),
      env.DB.prepare(`DELETE FROM notes WHERE id=? AND user_id=? AND deleted_at IS NOT NULL AND revision=?
        AND EXISTS(SELECT 1 FROM purged_notes WHERE id=?)`).bind(id, user.id, data.revision, id),
    ]);
    if (!results[1].meta.changes) throw new ApiError(409, 'Only an unchanged note in trash can be permanently deleted.');
    return json({ ok: true });
  }
  return null;
}
