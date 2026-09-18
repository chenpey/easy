import { unfinishedTasks } from '../shared/tasks';
import { idPattern, type SharedNote } from '../shared/types';
import type { Identity } from './auth';
import { ApiError, digest, json, readJson, token, type Env } from './core';
import { loadNote, toNote, type NoteRow } from './notes';
import type { StoredFileRow } from './images';

const shareTokenPattern = /^[a-f0-9]{64}$/;
const isImage = (mime: string) => ['image/jpeg', 'image/png', 'image/webp'].includes(mime);

function shareExpiryHours(data: Record<string, unknown>): number | null {
  const value = data.expiresInHours;
  if (Object.keys(data).some((key) => key !== 'expiresInHours') ||
      !(value === null || typeof value === 'number' && Number.isSafeInteger(value) &&
        value >= 1 && value <= 24 * 30)) {
    throw new ApiError(400, 'Share expiry must be permanent or between 1 and 720 hours.');
  }
  return value;
}

export async function featureRoutes(
  request: Request,
  env: Env,
  user: Identity,
  path: string,
): Promise<Response | null> {
  if (path === '/api/tasks' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT * FROM notes
      WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id`).bind(user.id).all<NoteRow>();
    return json({ tasks: rows.results.flatMap((row) => unfinishedTasks(toNote(row))) });
  }

  if (path === '/api/shares' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT s.note_id,s.created_at,s.expires_at,
      n.title,n.updated_at,n.archived
      FROM note_shares s JOIN notes n ON n.id=s.note_id
      WHERE n.user_id=? AND n.deleted_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at>?)
      ORDER BY s.expires_at IS NULL,s.expires_at,s.created_at DESC`)
      .bind(user.id, Date.now())
      .all<{
        note_id: string;
        created_at: number;
        expires_at: number | null;
        title: string;
        updated_at: number;
        archived: number;
      }>();
    return json({
      shares: rows.results.map((row) => ({
        noteId: row.note_id,
        title: row.title,
        noteUpdatedAt: row.updated_at,
        archived: Boolean(row.archived),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })),
    });
  }

  const match = /^\/api\/notes\/([^/]+)\/share$/.exec(path);
  if (!match) return null;
  const noteId = match[1];
  if (!idPattern.test(noteId)) throw new ApiError(404, 'Note not found.');
  const note = await loadNote(env, user.id, noteId);
  if (!note || note.deleted_at !== null) throw new ApiError(404, 'Note not found.');

  if (request.method === 'GET') {
    const share = await env.DB.prepare(`SELECT created_at,expires_at FROM note_shares
      WHERE note_id=? AND (expires_at IS NULL OR expires_at>?)`).bind(noteId, Date.now())
      .first<{ created_at: number; expires_at: number | null }>();
    return json({
      share: share ? { createdAt: share.created_at, expiresAt: share.expires_at } : null,
    });
  }
  if (request.method === 'POST') {
    const data = await readJson(request, 1024);
    const expiresInHours = shareExpiryHours(data);
    const value = token();
    const now = Date.now();
    const expiresAt = expiresInHours === null ? null : now + expiresInHours * 3600_000;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM note_shares WHERE note_id=?').bind(noteId),
      env.DB.prepare('INSERT INTO note_shares(token_hash,note_id,expires_at,created_at) VALUES(?,?,?,?)')
        .bind(await digest(value), noteId, expiresAt, now),
    ]);
    return json({
      share: { createdAt: now, expiresAt },
      url: `${new URL(request.url).origin}/shared/${value}`,
    }, 201);
  }
  if (request.method === 'PATCH') {
    const expiresInHours = shareExpiryHours(await readJson(request, 1024));
    const current = await env.DB.prepare(`SELECT created_at,expires_at FROM note_shares
      WHERE note_id=? AND (expires_at IS NULL OR expires_at>?)`).bind(noteId, Date.now())
      .first<{ created_at: number; expires_at: number | null }>();
    if (!current) throw new ApiError(404, 'Share link not found or expired.');
    const expiresAt = expiresInHours === null || current.expires_at === null
      ? null
      : current.expires_at + expiresInHours * 3600_000;
    await env.DB.prepare('UPDATE note_shares SET expires_at=? WHERE note_id=?')
      .bind(expiresAt, noteId).run();
    return json({ share: { createdAt: current.created_at, expiresAt } });
  }
  if (request.method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM note_shares WHERE note_id=? AND EXISTS
      (SELECT 1 FROM notes WHERE id=? AND user_id=?)`).bind(noteId, noteId, user.id).run();
    return json({ ok: true });
  }
  return null;
}

export async function publicShareRoutes(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const noteMatch = /^\/api\/public\/shares\/([a-f0-9]{64})$/.exec(path);
  if (noteMatch && request.method === 'GET') {
    const rawToken = noteMatch[1];
    const row = await env.DB.prepare(`SELECT n.*,s.expires_at AS share_expires_at
      FROM note_shares s JOIN notes n ON n.id=s.note_id
      JOIN users u ON u.id=n.user_id
      WHERE s.token_hash=? AND (s.expires_at IS NULL OR s.expires_at>?) AND n.deleted_at IS NULL
        AND u.enabled=1 AND u.deletion_requested_at IS NULL`)
      .bind(await digest(rawToken), Date.now()).first<NoteRow & { share_expires_at: number | null }>();
    if (!row) throw new ApiError(404, 'Share link not found or expired.');
    const note = toNote(row);
    const publicPrefix = `/api/public/shares/${rawToken}`;
    const shared: SharedNote = {
      title: note.title,
      content: note.content.replace(
        /\/api\/(images|files)\/([0-9a-f-]{36})(?![0-9a-f-])/gi,
        (_source, kind: string, id: string) => `${publicPrefix}/${kind.toLowerCase()}/${id}`,
      ),
      tags: note.tags,
      updatedAt: note.updatedAt,
      expiresAt: row.share_expires_at,
    };
    return json({ note: shared });
  }

  const fileMatch = /^\/api\/public\/shares\/([a-f0-9]{64})\/(images|files)\/([0-9a-f-]{36})$/.exec(path);
  if (!fileMatch || request.method !== 'GET') return null;
  const [, rawToken, route, id] = fileMatch;
  if (!shareTokenPattern.test(rawToken) || !idPattern.test(id)) throw new ApiError(404, 'Shared file not found.');
  const row = await env.DB.prepare(`SELECT i.* FROM note_shares s
    JOIN notes n ON n.id=s.note_id
    JOIN users u ON u.id=n.user_id
    JOIN image_refs r ON r.note_id=n.id AND r.revision=n.revision
    JOIN images i ON i.id=r.image_id AND i.user_id=n.user_id
    WHERE s.token_hash=? AND (s.expires_at IS NULL OR s.expires_at>?) AND n.deleted_at IS NULL
      AND u.enabled=1 AND u.deletion_requested_at IS NULL
      AND i.id=? AND i.status='ready'`)
    .bind(await digest(rawToken), Date.now(), id).first<StoredFileRow>();
  if (!row || route === 'images' && !isImage(row.mime)) throw new ApiError(404, 'Shared file not found.');
  const object = await env.IMAGES.get(`${row.user_id}/${row.id}`);
  if (!object) throw new ApiError(404, 'Shared file bytes not found.');
  return new Response(object.body, {
    headers: {
      'Content-Type': row.mime,
      'Content-Length': String(row.size),
      'Content-Disposition': `${route === 'images' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}
