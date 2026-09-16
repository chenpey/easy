import { unfinishedTasks } from '../shared/tasks';
import { idPattern, type SharedNote } from '../shared/types';
import type { Identity } from './auth';
import { ApiError, digest, json, readJson, token, type Env } from './core';
import { loadNote, toNote, type NoteRow } from './notes';
import type { StoredFileRow } from './images';

const shareTokenPattern = /^[a-f0-9]{64}$/;
const isImage = (mime: string) => ['image/jpeg', 'image/png', 'image/webp'].includes(mime);

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

  const match = /^\/api\/notes\/([^/]+)\/share$/.exec(path);
  if (!match) return null;
  const noteId = match[1];
  if (!idPattern.test(noteId)) throw new ApiError(404, 'Note not found.');
  const note = await loadNote(env, user.id, noteId);
  if (!note || note.deleted_at !== null) throw new ApiError(404, 'Note not found.');

  if (request.method === 'GET') {
    const share = await env.DB.prepare(`SELECT created_at,expires_at FROM note_shares
      WHERE note_id=? AND expires_at>?`).bind(noteId, Date.now())
      .first<{ created_at: number; expires_at: number }>();
    return json({
      share: share ? { createdAt: share.created_at, expiresAt: share.expires_at } : null,
    });
  }
  if (request.method === 'POST') {
    const data = await readJson(request, 1024);
    if (Object.keys(data).some((key) => key !== 'expiresInHours') ||
        typeof data.expiresInHours !== 'number' || !Number.isSafeInteger(data.expiresInHours) ||
        data.expiresInHours < 1 || data.expiresInHours > 24 * 30) {
      throw new ApiError(400, 'Share expiry must be between 1 and 720 hours.');
    }
    const value = token();
    const now = Date.now();
    const expiresAt = now + data.expiresInHours * 3600_000;
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
      WHERE s.token_hash=? AND s.expires_at>? AND n.deleted_at IS NULL
        AND u.enabled=1 AND u.deletion_requested_at IS NULL`)
      .bind(await digest(rawToken), Date.now()).first<NoteRow & { share_expires_at: number }>();
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
    WHERE s.token_hash=? AND s.expires_at>? AND n.deleted_at IS NULL
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
