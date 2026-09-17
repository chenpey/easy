import {
  fingerprintPattern,
  idPattern,
  noteFingerprint,
  noteInput,
  sameNoteInput,
  sameVersionedInput,
  storedFileIds,
  type Note,
  type NoteInput,
  type SyncChange,
  type Version,
} from '../shared/types';
import { ApiError, clientConfig, digest, json, numberSetting, readJson, type Env } from './core';
import type { Identity } from './auth';

export interface NoteRow {
  id: string; user_id: string; title: string; content: string; tags: string; pinned: number; archived: number;
  deleted_at: number | null; created_at: number; updated_at: number; revision: number;
  dedup_hash: string; mutation_id: string; mutation_hash: string;
}
interface VersionInputRow {
  title: string; content: string; tags: string; pinned: number; archived: number; deleted_at: number | null;
}
export const toNote = (row: NoteRow): Note => ({
  id: row.id, title: row.title, content: row.content, tags: JSON.parse(row.tags),
  pinned: !!row.pinned, archived: !!row.archived, deletedAt: row.deleted_at, createdAt: row.created_at,
  updatedAt: row.updated_at, revision: row.revision,
});
const versionInput = (row: VersionInputRow): NoteInput => ({
  title: row.title, content: row.content, tags: JSON.parse(row.tags),
  pinned: !!row.pinned, archived: !!row.archived, deletedAt: row.deleted_at,
});

export async function loadNote(env: Env, userId: string, id: string): Promise<NoteRow | null> {
  return env.DB.prepare('SELECT * FROM notes WHERE id=? AND user_id=?').bind(id, userId).first<NoteRow>();
}

const blankCondition = "title='' AND content='' AND tags='[]' AND archived=0 AND deleted_at IS NULL";

async function loadBlank(env: Env, userId: string): Promise<NoteRow | null> {
  return env.DB.prepare(`SELECT * FROM notes WHERE user_id=? AND ${blankCondition} LIMIT 1`)
    .bind(userId).first<NoteRow>();
}

function isBlank(input: NoteInput): boolean {
  return !input.title && !input.content && !input.tags.length && !input.archived && input.deletedAt === null;
}

function validate(data: Record<string, unknown>, env: Env): NoteInput {
  if (typeof data.title !== 'string' || data.title.length > 256 ||
      typeof data.content !== 'string' ||
      new TextEncoder().encode(data.content).length > clientConfig(env).maxNoteBytes ||
      !Array.isArray(data.tags) || data.tags.length > 20 ||
      data.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 40) ||
      typeof data.pinned !== 'boolean' ||
      typeof data.archived !== 'boolean' ||
      !(data.deletedAt === null || typeof data.deletedAt === 'number' && Number.isSafeInteger(data.deletedAt) && data.deletedAt > 0)) {
    throw new ApiError(400, 'Invalid note fields or note size limit exceeded.');
  }
  return {
    title: data.title.trim(), content: data.content,
    tags: [...new Set((data.tags as string[]).map((tag) => tag.trim()))],
    pinned: data.pinned, archived: data.archived, deletedAt: data.deletedAt as number | null,
  };
}

export async function saveNote(request: Request, env: Env, user: Identity, id: string, create: boolean): Promise<Response> {
  const data = await readJson(request, clientConfig(env).maxNoteBytes * 6 + 8192);
  const input = validate(data, env);
  if (!idPattern.test(id) || typeof data.operationId !== 'string' || !idPattern.test(data.operationId) ||
      !Number.isSafeInteger(data.revision) || Number(data.revision) < 0 ||
      data.createVersion !== undefined && typeof data.createVersion !== 'boolean' ||
      (create && data.revision !== 0) || (!create && data.revision === 0)) {
    throw new ApiError(400, 'Invalid revision or operation ID.');
  }
  const createVersion = user.actorType === 'ai' || data.createVersion === true;
  const dedupHash = await noteFingerprint(input.title, input.content);
  const hash = await digest(JSON.stringify({ ...input, revision: data.revision, createVersion }));
  const current = await loadNote(env, user.id, id);
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
  const currentInput = current ? noteInput(toNote(current)) : null;
  const latestVersion = createVersion && current
    ? await env.DB.prepare(`SELECT title,content,tags,pinned,archived,deleted_at
      FROM note_versions WHERE note_id=? ORDER BY revision DESC LIMIT 1`)
      .bind(id).first<VersionInputRow>()
    : null;
  const shouldCreateVersion = createVersion &&
    (!latestVersion || !sameVersionedInput(versionInput(latestVersion), input));
  if (current && currentInput && sameNoteInput(currentInput, input)) {
    if (!shouldCreateVersion) return json({ note: toNote(current), unchanged: true });
    const time = Date.now();
    const revision = current.revision;
    const mutation = data.operationId as string;
    const guard = 'EXISTS(SELECT 1 FROM notes WHERE id=? AND user_id=? AND revision=? AND mutation_id=?)';
    const guardBinds = [id, user.id, revision, mutation];
    const keep = numberSetting(env, 'VERSIONS_KEPT', 1, 100);
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE notes SET mutation_id=?,mutation_hash=?
        WHERE id=? AND user_id=? AND revision=?`)
        .bind(mutation, hash, id, user.id, revision),
      env.DB.prepare(`INSERT OR IGNORE INTO note_versions
        (note_id,revision,title,content,tags,pinned,deleted_at,saved_at,archived,actor_type,actor_name)
        SELECT id,revision,title,content,tags,pinned,deleted_at,?,archived,?,? FROM notes
        WHERE id=? AND user_id=? AND revision=? AND mutation_id=?`)
        .bind(time, user.actorType, user.actorName, ...guardBinds),
      env.DB.prepare(`DELETE FROM note_versions WHERE note_id=? AND revision NOT IN
        (SELECT revision FROM note_versions WHERE note_id=? ORDER BY revision DESC LIMIT ?) AND ${guard}`)
        .bind(id, id, keep, ...guardBinds),
      env.DB.prepare(`DELETE FROM image_refs WHERE note_id=? AND revision<>? AND revision NOT IN
        (SELECT revision FROM note_versions WHERE note_id=?) AND ${guard}`)
        .bind(id, revision, id, ...guardBinds),
    ]);
    const saved = await loadNote(env, user.id, id);
    if (!results[0].meta.changes || !saved) {
      throw new ApiError(409, 'The note changed on another device.', { current: saved ? toNote(saved) : undefined });
    }
    return json({ note: toNote(saved), unchanged: true });
  }
  const ids = storedFileIds(input.content);
  if (ids.length > 80) throw new ApiError(400, 'A note can reference at most 80 stored files.');
  const placeholders = ids.map(() => '?').join(',');
  const readyCondition = ids.length
    ? `(SELECT COUNT(*) FROM images WHERE user_id=? AND status='ready' AND id IN (${placeholders}))=?`
    : '1=1';
  const readyBinds = ids.length ? [user.id, ...ids, ids.length] : [];
  const time = Date.now();
  const revision = Number(data.revision) + 1;
  const mutation = data.operationId;
  const fields = [
    input.title, input.content, dedupHash, JSON.stringify(input.tags),
    input.pinned ? 1 : 0, input.archived ? 1 : 0, input.deletedAt,
  ];
  const statements: D1PreparedStatement[] = [];
  if (create) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO notes
      (id,user_id,title,content,dedup_hash,tags,pinned,archived,deleted_at,created_at,updated_at,revision,mutation_id,mutation_hash)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE ${readyCondition}
        AND NOT EXISTS(SELECT 1 FROM purged_notes WHERE id=?)
        AND (SELECT COUNT(*) FROM notes WHERE user_id=?)<?`)
      .bind(id, user.id, ...fields, time, time, revision, mutation, hash, ...readyBinds, id, user.id, numberSetting(env, 'MAX_NOTES', 1, 10000)));
  } else {
    statements.push(env.DB.prepare(`UPDATE notes SET title=?,content=?,dedup_hash=?,tags=?,pinned=?,archived=?,deleted_at=?,
      updated_at=?,revision=?,mutation_id=?,mutation_hash=?
      WHERE id=? AND user_id=? AND revision=? AND ${readyCondition}`)
      .bind(...fields, time, revision, mutation, hash, id, user.id, data.revision, ...readyBinds));
  }
  const guard = 'EXISTS(SELECT 1 FROM notes WHERE id=? AND user_id=? AND revision=? AND mutation_id=?)';
  const guardBinds = [id, user.id, revision, mutation];
  if (shouldCreateVersion) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO note_versions
      (note_id,revision,title,content,tags,pinned,deleted_at,saved_at,archived,actor_type,actor_name)
      SELECT id,revision,title,content,tags,pinned,deleted_at,updated_at,archived,?,? FROM notes
      WHERE id=? AND user_id=? AND revision=? AND mutation_id=?`)
      .bind(user.actorType, user.actorName, ...guardBinds));
  }
  statements.push(env.DB.prepare(`INSERT INTO note_changes(user_id,note_id,changed_at)
    SELECT ?,?,? WHERE ${guard}`).bind(user.id, id, time, ...guardBinds));
  if (input.deletedAt !== null) {
    statements.push(env.DB.prepare(`DELETE FROM note_shares WHERE note_id=? AND ${guard}`)
      .bind(id, ...guardBinds));
  }
  for (const imageId of ids) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO image_refs SELECT ?,?,? WHERE ${guard}`)
      .bind(id, imageId, revision, ...guardBinds));
    statements.push(env.DB.prepare(`UPDATE images SET last_used_at=? WHERE id=? AND user_id=? AND ${guard}`)
      .bind(time, imageId, user.id, ...guardBinds));
  }
  const keep = numberSetting(env, 'VERSIONS_KEPT', 1, 100);
  statements.push(env.DB.prepare(`DELETE FROM note_versions WHERE note_id=? AND revision NOT IN
    (SELECT revision FROM note_versions WHERE note_id=? ORDER BY revision DESC LIMIT ?) AND ${guard}`)
    .bind(id, id, keep, ...guardBinds));
  statements.push(env.DB.prepare(`DELETE FROM image_refs WHERE note_id=? AND revision<>? AND revision NOT IN
    (SELECT revision FROM note_versions WHERE note_id=?) AND ${guard}`)
    .bind(id, revision, id, ...guardBinds));
  statements.push(env.DB.prepare(`DELETE FROM note_changes WHERE user_id=? AND note_id=? AND sequence<
    (SELECT MAX(sequence) FROM note_changes WHERE user_id=? AND note_id=?) AND ${guard}`)
    .bind(user.id, id, user.id, id, ...guardBinds));
  const result = await env.DB.batch(statements);
  const saved = await loadNote(env, user.id, id);
  if (!result[0].meta.changes) {
    if (create && isBlank(input)) {
      const blank = await loadBlank(env, user.id);
      if (blank) return json({ note: toNote(blank), reused: true });
    }
    if (saved) throw new ApiError(409, 'The note changed on another device.', { current: toNote(saved) });
    throw new ApiError(409, 'An image is unavailable, the note was purged, or the note limit was reached.');
  }
  return json({ note: toNote(saved!) }, create ? 201 : 200);
}

export async function noteRoutes(request: Request, env: Env, user: Identity, path: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (path === '/api/sync' && request.method === 'GET') {
    const after = Number(url.searchParams.get('after') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new ApiError(400, 'Invalid sync cursor or limit.');
    }
    const result = await env.DB.prepare(`SELECT c.sequence,c.note_id AS change_note_id,n.*
      FROM note_changes c LEFT JOIN notes n ON n.id=c.note_id AND n.user_id=c.user_id
      WHERE c.user_id=? AND c.sequence>? ORDER BY c.sequence ASC LIMIT ?`)
      .bind(user.id, after, limit + 1).all<NoteRow & { sequence: number; change_note_id: string }>();
    const rows = result.results.slice(0, limit);
    const changes: SyncChange[] = rows.map((row) => ({
      sequence: row.sequence,
      noteId: row.change_note_id,
      note: row.id ? toNote(row) : null,
    }));
    return json({
      changes,
      cursor: changes.at(-1)?.sequence ?? after,
      hasMore: result.results.length > limit,
    });
  }
  if (path === '/api/notes' && request.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    const view = url.searchParams.get('view') ?? 'all';
    if (!['all', 'archive', 'trash', 'export'].includes(view)) throw new ApiError(400, 'Invalid note view.');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, 'Invalid offset.');
    const limit = Number(url.searchParams.get('limit') ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ApiError(400, 'Invalid limit.');
    const tag = (url.searchParams.get('tag') ?? '').slice(0, 40);
    const escape = (value: string) => value.replace(/[\\%_]/g, '\\$&');
    const filters = ['user_id=?'];
    const binds: unknown[] = [user.id];
    if (view === 'trash') filters.push('deleted_at IS NOT NULL');
    else if (view === 'archive') filters.push('deleted_at IS NULL', 'archived=1');
    else if (view === 'all') filters.push('deleted_at IS NULL', 'archived=0');
    if (q) { filters.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')"); binds.push(`%${escape(q)}%`, `%${escape(q)}%`); }
    if (tag) { filters.push('EXISTS(SELECT 1 FROM json_each(notes.tags) WHERE value=?)'); binds.push(tag); }
    const result = await env.DB.prepare(`SELECT id,title,substr(content,1,180) AS content,tags,pinned,archived,deleted_at,created_at,updated_at,revision
      FROM notes WHERE ${filters.join(' AND ')} ORDER BY pinned DESC,updated_at DESC,id ASC LIMIT ? OFFSET ?`)
      .bind(...binds, limit + 1, offset).all<NoteRow>();
    const notes = result.results.slice(0, limit).map((row) => {
      const { content, ...note } = toNote(row);
      return { ...note, excerpt: content };
    });
    return json({ notes, nextOffset: result.results.length > limit ? offset + limit : null });
  }
  if (path === '/api/tags' && request.method === 'GET') {
    const view = url.searchParams.get('view') ?? 'all';
    if (!['all', 'archive', 'trash'].includes(view)) throw new ApiError(400, 'Invalid note view.');
    const scope = view === 'trash'
      ? 'deleted_at IS NOT NULL'
      : `deleted_at IS NULL AND archived=${view === 'archive' ? 1 : 0}`;
    const result = await env.DB.prepare(`SELECT DISTINCT value AS name FROM notes,json_each(notes.tags)
      WHERE user_id=? AND ${scope} ORDER BY value LIMIT 200`).bind(user.id).all<{ name: string }>();
    return json({ tags: result.results.map((row) => row.name) });
  }
  if (path === '/api/notes/duplicates' && request.method === 'POST') {
    const data = await readJson(request, 96 * 1024);
    if (Object.keys(data).some((key) => key !== 'fingerprints') || !Array.isArray(data.fingerprints) ||
        data.fingerprints.length > 1200 ||
        data.fingerprints.some((fingerprint) => typeof fingerprint !== 'string' || !fingerprintPattern.test(fingerprint))) {
      throw new ApiError(400, 'Invalid note fingerprints.');
    }
    const fingerprints = [...new Set(data.fingerprints as string[])];
    const statements: D1PreparedStatement[] = [];
    for (let offset = 0; offset < fingerprints.length; offset += 80) {
      const chunk = fingerprints.slice(offset, offset + 80);
      statements.push(env.DB.prepare(`SELECT dedup_hash AS fingerprint,MIN(id) AS note_id FROM notes
        WHERE user_id=? AND dedup_hash IN (${chunk.map(() => '?').join(',')}) GROUP BY dedup_hash`)
        .bind(user.id, ...chunk));
    }
    const results = statements.length
      ? await env.DB.batch<{ fingerprint: string; note_id: string }>(statements)
      : [];
    return json({
      matches: results.flatMap((result) =>
        result.results.map((row) => ({ fingerprint: row.fingerprint, noteId: row.note_id }))),
    });
  }
  if (path === '/api/notes/trash' && request.method === 'DELETE') {
    const time = Date.now();
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM notes WHERE user_id=? AND deleted_at IS NOT NULL')
      .bind(user.id).first<{ count: number }>();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO note_changes(user_id,note_id,changed_at)
        SELECT user_id,id,? FROM notes WHERE user_id=? AND deleted_at IS NOT NULL`).bind(time, user.id),
      env.DB.prepare(`INSERT OR IGNORE INTO purged_notes
        SELECT id,user_id,? FROM notes WHERE user_id=? AND deleted_at IS NOT NULL`).bind(time, user.id),
      env.DB.prepare('DELETE FROM notes WHERE user_id=? AND deleted_at IS NOT NULL').bind(user.id),
      env.DB.prepare(`DELETE FROM note_changes WHERE user_id=? AND sequence NOT IN
        (SELECT MAX(sequence) FROM note_changes WHERE user_id=? GROUP BY note_id)`).bind(user.id, user.id),
    ]);
    return json({ deleted: count?.count ?? 0 });
  }
  if (path === '/api/notes/blank' && request.method === 'GET') {
    const row = await loadBlank(env, user.id);
    return json({ note: row ? toNote(row) : null });
  }
  const match = /^\/api\/notes\/([^/]+)(?:\/(versions|backlinks))?$/.exec(path);
  if (!match) return null;
  const id = match[1];
  if (!idPattern.test(id)) throw new ApiError(404, 'Note not found.');
  if (match[2] && request.method === 'GET') {
    if (!await loadNote(env, user.id, id)) throw new ApiError(404, 'Note not found.');
    if (match[2] === 'backlinks') {
      const escaped = id.replace(/[\\%_]/g, '\\$&');
      const rows = await env.DB.prepare(`SELECT id,title,substr(content,1,180) AS content,tags,pinned,archived,
        deleted_at,created_at,updated_at,revision FROM notes
        WHERE user_id=? AND deleted_at IS NULL AND content LIKE ? ESCAPE '\\'
        ORDER BY updated_at DESC,id ASC LIMIT 200`).bind(user.id, `%[[${escaped}|%`).all<NoteRow>();
      return json({
        notes: rows.results.map((row) => {
          const { content, ...note } = toNote(row);
          return { ...note, excerpt: content };
        }),
      });
    }
    const rows = await env.DB.prepare('SELECT * FROM note_versions WHERE note_id=? ORDER BY revision DESC')
      .bind(id).all<NoteRow & { saved_at: number; actor_type: 'user' | 'ai'; actor_name: string }>();
    const versions: Version[] = rows.results.map((row) => ({
      title: row.title, content: row.content, tags: JSON.parse(row.tags), pinned: !!row.pinned,
      archived: !!row.archived, deletedAt: row.deleted_at, revision: row.revision, savedAt: row.saved_at,
      actorType: row.actor_type, actorName: row.actor_name,
    }));
    return json({ versions });
  }
  if (match[2]) return null;
  if (request.method === 'GET') {
    const row = await loadNote(env, user.id, id);
    if (!row) throw new ApiError(404, 'Note not found.');
    return json({ note: toNote(row) });
  }
  if (request.method === 'POST' || request.method === 'PUT') return saveNote(request, env, user, id, request.method === 'POST');
  if (request.method === 'DELETE') {
    const data = await readJson(request);
    if (!Number.isSafeInteger(data.revision)) throw new ApiError(400, 'Revision required.');
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO note_changes(user_id,note_id,changed_at)
        SELECT user_id,id,? FROM notes WHERE id=? AND user_id=? AND deleted_at IS NOT NULL AND revision=?`)
        .bind(Date.now(), id, user.id, data.revision),
      env.DB.prepare(`INSERT OR IGNORE INTO purged_notes SELECT id,user_id,? FROM notes
        WHERE id=? AND user_id=? AND deleted_at IS NOT NULL AND revision=?`)
        .bind(Date.now(), id, user.id, data.revision),
      env.DB.prepare(`DELETE FROM notes WHERE id=? AND user_id=? AND deleted_at IS NOT NULL AND revision=?
        AND EXISTS(SELECT 1 FROM purged_notes WHERE id=?)`).bind(id, user.id, data.revision, id),
      env.DB.prepare(`DELETE FROM note_changes WHERE user_id=? AND note_id=? AND sequence<
        (SELECT MAX(sequence) FROM note_changes WHERE user_id=? AND note_id=?)`)
        .bind(user.id, id, user.id, id),
    ]);
    if (!results[2].meta.changes) throw new ApiError(409, 'Only an unchanged note in trash can be permanently deleted.');
    return json({ ok: true });
  }
  return null;
}
