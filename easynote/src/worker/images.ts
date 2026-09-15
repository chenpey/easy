import { imageDimensionsFromData } from 'image-dimensions';
import { idPattern, imagePath, type ImageRecord } from '../shared/types';
import type { Identity } from './auth';
import { ApiError, clientConfig, digest, json, numberSetting, readBytes, type Env } from './core';

interface ImageRow {
  id: string; user_id: string; filename: string; mime: string; size: number;
  width: number; height: number; sha256: string; status: string;
}
const objectKey = (row: Pick<ImageRow, 'user_id' | 'id'>) => `${row.user_id}/${row.id}`;
const record = (row: ImageRow): ImageRecord => ({
  id: row.id, filename: row.filename, mime: row.mime, size: row.size,
  width: row.width, height: row.height, sha256: row.sha256, url: imagePath(row.id),
});

export async function imageRoutes(request: Request, env: Env, user: Identity, path: string): Promise<Response | null> {
  const match = /^\/api\/images\/([^/]+)$/.exec(path);
  if (!match) return null;
  const id = match[1];
  if (!idPattern.test(id)) throw new ApiError(404, 'Image not found.');
  const row = await env.DB.prepare('SELECT * FROM images WHERE id=? AND user_id=?').bind(id, user.id).first<ImageRow>();
  if (request.method === 'GET') {
    if (!row || row.status !== 'ready') throw new ApiError(404, 'Image not found.');
    const object = await env.IMAGES.get(objectKey(row));
    if (!object) throw new ApiError(404, 'Image bytes not found.');
    return new Response(object.body, {
      headers: {
        'Content-Type': row.mime,
        'Content-Length': String(row.size),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    });
  }
  if (request.method !== 'PUT') return null;
  const config = clientConfig(env);
  const bytes = await readBytes(request, config.maxImageBytes);
  let info: ReturnType<typeof imageDimensionsFromData>;
  try { info = imageDimensionsFromData(bytes); } catch { throw new ApiError(415, 'Invalid image file.'); }
  if (!info) throw new ApiError(415, 'Invalid image file.');
  const mime = ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<string, string>)[info.type];
  if (!mime || !info.width || !info.height) throw new ApiError(415, 'Only JPEG, PNG and WebP images are supported.');
  if (request.headers.get('Content-Type') !== mime) throw new ApiError(415, 'Image content does not match its declared type.');
  if (info.width * info.height > config.maxImagePixels) throw new ApiError(413, 'Image dimensions exceed the configured limit.');
  let filename: string;
  try { filename = decodeURIComponent(request.headers.get('X-Filename') ?? 'image'); } catch { throw new ApiError(400, 'Invalid filename.'); }
  if (!filename || filename.length > 180 || /[/\\\u0000-\u001f]/.test(filename)) throw new ApiError(400, 'Invalid filename.');
  const sha256 = await digest(bytes);
  if (row) {
    if (row.status === 'ready' && row.sha256 === sha256 && row.filename === filename) return json({ image: record(row) });
    throw new ApiError(409, 'This image upload ID is already in use.');
  }
  const time = Date.now();
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO images
    (id,user_id,filename,mime,size,width,height,sha256,status,created_at,last_used_at)
    SELECT ?,?,?,?,?,?,?,?,'pending',?,?
    WHERE COALESCE((SELECT SUM(size) FROM images WHERE user_id=?),0)+?<=?`)
    .bind(id, user.id, filename, mime, bytes.length, info.width, info.height, sha256, time, time, user.id, bytes.length,
      numberSetting(env, 'IMAGE_QUOTA_BYTES', 1024, 10 * 1024 ** 3)).run();
  if (!inserted.meta.changes) throw new ApiError(409, 'Image quota exceeded or upload ID already exists.');
  try {
    await env.IMAGES.put(objectKey({ id, user_id: user.id }), bytes, { httpMetadata: { contentType: mime } });
    const published = await env.DB.prepare("UPDATE images SET status='ready' WHERE id=? AND user_id=? AND status='pending'")
      .bind(id, user.id).run();
    if (!published.meta.changes) throw new ApiError(409, 'Image upload expired.');
  } catch (error) {
    await env.DB.prepare("UPDATE images SET status='deleting' WHERE id=? AND user_id=? AND status='pending'").bind(id, user.id).run();
    throw error;
  }
  return json({ image: { id, filename, mime, size: bytes.length, width: info.width, height: info.height, sha256, url: imagePath(id) } }, 201);
}

export async function cleanup(env: Env): Promise<void> {
  const cutoff = Date.now() - numberSetting(env, 'IMAGE_GRACE_HOURS', 24, 2160) * 3600_000;
  // A note save inserts references only while the image is ready, inside the same D1 transaction.
  await env.DB.prepare(`UPDATE images SET status='deleting' WHERE id IN (
    SELECT id FROM images WHERE status!='deleting' AND last_used_at<?
      AND NOT EXISTS(SELECT 1 FROM image_refs WHERE image_id=images.id) LIMIT 50
  )`).bind(cutoff).run();
  const rows = await env.DB.prepare("SELECT id,user_id FROM images WHERE status='deleting' LIMIT 50")
    .all<Pick<ImageRow, 'id' | 'user_id'>>();
  for (const row of rows.results) {
    await env.IMAGES.delete(objectKey(row));
    await env.DB.prepare("DELETE FROM images WHERE id=? AND status='deleting'").bind(row.id).run();
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()),
    env.DB.prepare('DELETE FROM login_attempts WHERE started_at<?').bind(Date.now() - 86400_000),
    env.DB.prepare(`DELETE FROM integration_tokens
      WHERE (expires_at IS NOT NULL AND expires_at<?) OR (revoked_at IS NOT NULL AND revoked_at<?)`)
      .bind(Date.now() - 30 * 86400_000, Date.now() - 30 * 86400_000),
  ]);
}
