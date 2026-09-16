import { imageDimensionsFromData } from 'image-dimensions';
import { filePath, idPattern, imagePath, type StoredFile } from '../shared/types';
import type { Identity } from './auth';
import { ApiError, clientConfig, digest, json, numberSetting, readBytes, type Env } from './core';

export interface StoredFileRow {
  id: string; user_id: string; filename: string; mime: string; size: number;
  width: number; height: number; sha256: string; status: string;
}
const objectKey = (row: Pick<StoredFileRow, 'user_id' | 'id'>) => `${row.user_id}/${row.id}`;
const isImage = (mime: string) => ['image/jpeg', 'image/png', 'image/webp'].includes(mime);
const record = (row: StoredFileRow): StoredFile => ({
  id: row.id, filename: row.filename, mime: row.mime, size: row.size,
  width: row.width, height: row.height, sha256: row.sha256,
  url: isImage(row.mime) ? imagePath(row.id) : filePath(row.id),
});

export async function imageRoutes(request: Request, env: Env, user: Identity, path: string): Promise<Response | null> {
  const match = /^\/api\/(images|files)\/([^/]+)$/.exec(path);
  if (!match) return null;
  const [, route, id] = match;
  if (!idPattern.test(id)) throw new ApiError(404, 'File not found.');
  const row = await env.DB.prepare('SELECT * FROM images WHERE id=? AND user_id=?').bind(id, user.id).first<StoredFileRow>();
  if (request.method === 'GET') {
    if (!row || row.status !== 'ready' || route === 'images' && !isImage(row.mime)) throw new ApiError(404, 'File not found.');
    const object = await env.IMAGES.get(objectKey(row));
    if (!object) throw new ApiError(404, 'File bytes not found.');
    const disposition = route === 'images' ? 'inline' : 'attachment';
    return new Response(object.body, {
      headers: {
        'Content-Type': row.mime,
        'Content-Length': String(row.size),
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    });
  }
  if (request.method !== 'PUT') return null;
  const config = clientConfig(env);
  const bytes = await readBytes(request, route === 'images' ? config.maxImageBytes : config.maxAttachmentBytes);
  let mime = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
  let width = 0;
  let height = 0;
  if (route === 'images') {
    let info: ReturnType<typeof imageDimensionsFromData>;
    try { info = imageDimensionsFromData(bytes); } catch { throw new ApiError(415, 'Invalid image file.'); }
    if (!info) throw new ApiError(415, 'Invalid image file.');
    const detected = ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<string, string>)[info.type];
    if (!detected || !info.width || !info.height) throw new ApiError(415, 'Only JPEG, PNG and WebP images are supported.');
    if (mime !== detected) throw new ApiError(415, 'Image content does not match its declared type.');
    if (info.width * info.height > config.maxImagePixels) throw new ApiError(413, 'Image dimensions exceed the configured limit.');
    width = info.width;
    height = info.height;
  } else {
    const textTypes = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);
    if (mime === 'application/pdf') {
      const header = new TextDecoder().decode(bytes.slice(0, 5));
      const trailer = new TextDecoder().decode(bytes.slice(Math.max(0, bytes.length - 2048)));
      if (header !== '%PDF-' || !trailer.includes('%%EOF')) throw new ApiError(415, 'Invalid PDF file.');
    } else if (textTypes.has(mime)) {
      let text = '';
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ApiError(415, 'Text attachments must use UTF-8.'); }
      if (text.includes('\0')) throw new ApiError(415, 'Text attachment contains invalid bytes.');
    } else {
      throw new ApiError(415, 'Only PDF, Markdown, plain text, CSV and JSON attachments are supported.');
    }
  }
  let filename: string;
  try { filename = decodeURIComponent(request.headers.get('X-Filename') ?? (route === 'images' ? 'image' : 'file')); } catch { throw new ApiError(400, 'Invalid filename.'); }
  if (!filename || filename.length > 180 || /[/\\\u0000-\u001f]/.test(filename)) throw new ApiError(400, 'Invalid filename.');
  const sha256 = await digest(bytes);
  if (row) {
    if (row.status === 'ready' && row.sha256 === sha256 && row.filename === filename) {
      return json(route === 'images' ? { image: record(row) } : { file: record(row) });
    }
    throw new ApiError(409, 'This image upload ID is already in use.');
  }
  const time = Date.now();
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO images
    (id,user_id,filename,mime,size,width,height,sha256,status,created_at,last_used_at)
    SELECT ?,?,?,?,?,?,?,?,'pending',?,?
    WHERE COALESCE((SELECT SUM(size) FROM images WHERE user_id=?),0)+?<=?`)
    .bind(id, user.id, filename, mime, bytes.length, width, height, sha256, time, time, user.id, bytes.length,
      numberSetting(env, 'IMAGE_QUOTA_BYTES', 1024, 10 * 1024 ** 3)).run();
  if (!inserted.meta.changes) throw new ApiError(409, 'Storage quota exceeded or upload ID already exists.');
  try {
    await env.IMAGES.put(objectKey({ id, user_id: user.id }), bytes, { httpMetadata: { contentType: mime } });
    const published = await env.DB.prepare("UPDATE images SET status='ready' WHERE id=? AND user_id=? AND status='pending'")
      .bind(id, user.id).run();
    if (!published.meta.changes) throw new ApiError(409, 'Image upload expired.');
  } catch (error) {
    await env.DB.prepare("UPDATE images SET status='deleting' WHERE id=? AND user_id=? AND status='pending'").bind(id, user.id).run();
    throw error;
  }
  const stored = { id, filename, mime, size: bytes.length, width, height, sha256, url: route === 'images' ? imagePath(id) : filePath(id) };
  return json(route === 'images' ? { image: stored } : { file: stored }, 201);
}

export async function cleanup(env: Env): Promise<void> {
  const cutoff = Date.now() - numberSetting(env, 'IMAGE_GRACE_HOURS', 24, 2160) * 3600_000;
  // A note save inserts references only while the image is ready, inside the same D1 transaction.
  await env.DB.prepare(`UPDATE images SET status='deleting' WHERE id IN (
    SELECT id FROM images WHERE status!='deleting' AND last_used_at<?
      AND NOT EXISTS(SELECT 1 FROM image_refs WHERE image_id=images.id) LIMIT 50
  )`).bind(cutoff).run();
  const rows = await env.DB.prepare("SELECT id,user_id FROM images WHERE status='deleting' LIMIT 50")
    .all<Pick<StoredFileRow, 'id' | 'user_id'>>();
  for (const row of rows.results) {
    await env.IMAGES.delete(objectKey(row));
    await env.DB.prepare("DELETE FROM images WHERE id=? AND status='deleting'").bind(row.id).run();
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()),
    env.DB.prepare('DELETE FROM login_attempts WHERE started_at<?').bind(Date.now() - 86400_000),
    env.DB.prepare('DELETE FROM account_attempts WHERE started_at<?').bind(Date.now() - 86400_000),
    env.DB.prepare('DELETE FROM note_shares WHERE expires_at<?').bind(Date.now()),
    env.DB.prepare(`DELETE FROM integration_tokens
      WHERE (expires_at IS NOT NULL AND expires_at<?) OR (revoked_at IS NOT NULL AND revoked_at<?)`)
      .bind(Date.now() - 30 * 86400_000, Date.now() - 30 * 86400_000),
    env.DB.prepare(`DELETE FROM users WHERE deletion_requested_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM images WHERE images.user_id=users.id)`),
  ]);
}
