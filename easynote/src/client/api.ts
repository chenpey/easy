import type { Note, NoteInput, NoteSummary, Session, Version, ImageRecord } from '../shared/types';

const API_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
let csrf: string | null = null;
let unauthorizedHandler: (() => void) | null = null;
export function setSession(session: Session) { csrf = session.csrf; }
export function setUnauthorizedHandler(handler: (() => void) | null) { unauthorizedHandler = handler; }

function handleUnauthorized(status: number, requestCsrf: string | null): void {
  if (status !== 401 || !requestCsrf || csrf !== requestCsrf) return;
  csrf = null;
  unauthorizedHandler?.();
}

async function timedFetch(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; raw: string }> {
  const controller = init.signal ? null : new AbortController();
  let timedOut = false;
  const timer = controller ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;
  const method = init.method ?? 'GET';
  try {
    const response = await fetch(path, { ...init, signal: init.signal ?? controller!.signal });
    return { response, raw: await response.text() };
  } catch (error) {
    if (timedOut) throw new Error(`${method} ${path}\nRequest timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    if (init.signal?.aborted) throw error;
    throw new Error(`${method} ${path}\n${String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ApiError extends Error {
  constructor(public status: number, public body: { error?: { message?: string; current?: Note } }, method: string, path: string) {
    super(`${method} ${path} [${status}]\n${JSON.stringify(body, null, 2)}`);
  }
}

export async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const requestCsrf = csrf;
  const { response, raw } = await timedFetch(path, {
    method, credentials: 'same-origin', signal,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(requestCsrf ? { 'X-CSRF-Token': requestCsrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, API_TIMEOUT_MS);
  handleUnauthorized(response.status, requestCsrf);
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error(`${method} ${path} [${response.status}]\n${raw}`); }
  if (!response.ok) throw new ApiError(response.status, result, method, path);
  return result as T;
}

export const api = {
  session: () => request<Session>('/api/session'),
  login: (username: string, password: string) => request<Session>('/api/login', 'POST', { username, password }),
  logout: () => request('/api/logout', 'POST', {}),
  list: (query: { q?: string; view?: string; tag?: string; offset?: number } = {}, signal?: AbortSignal) =>
    request<{ notes: NoteSummary[]; nextOffset: number | null }>(`/api/notes?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`, 'GET', undefined, signal),
  tags: (signal?: AbortSignal) => request<{ tags: string[] }>('/api/tags', 'GET', undefined, signal),
  note: (id: string, signal?: AbortSignal) => request<{ note: Note }>(`/api/notes/${id}`, 'GET', undefined, signal),
  save: (id: string, input: NoteInput, revision: number, operationId: string) =>
    request<{ note: Note }>(`/api/notes/${id}`, revision === 0 ? 'POST' : 'PUT', { ...input, revision, operationId }),
  purge: (note: Note) => request(`/api/notes/${note.id}`, 'DELETE', { revision: note.revision }),
  versions: (id: string) => request<{ versions: Version[] }>(`/api/notes/${id}/versions`),
};

export async function uploadImage(file: File, maxBytes: number, maxPixels: number): Promise<ImageRecord> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('仅支持 JPEG、PNG、WebP 图片。');
  if (file.size > maxBytes) throw new Error(`图片不能超过 ${Math.round(maxBytes / 1024 ** 2)} MiB。`);
  const bitmap = await createImageBitmap(file);
  const pixels = bitmap.width * bitmap.height;
  bitmap.close();
  if (pixels > maxPixels) throw new Error('图片尺寸超过限制。');
  const path = `/api/images/${crypto.randomUUID()}`;
  const requestCsrf = csrf;
  const { response, raw } = await timedFetch(path, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name), 'X-CSRF-Token': requestCsrf ?? '' },
    body: file,
  }, UPLOAD_TIMEOUT_MS);
  handleUnauthorized(response.status, requestCsrf);
  let body;
  try { body = JSON.parse(raw); } catch { throw new Error(`PUT ${path} [${response.status}]\n${raw}`); }
  if (!response.ok) throw new ApiError(response.status, body, 'PUT', path);
  return body.image;
}
