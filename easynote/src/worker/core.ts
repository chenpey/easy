import type { ClientConfig } from '../shared/types';

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  NOTE_EVENTS: DurableObjectNamespace;
  INITIAL_OWNER?: string;
  ALLOW_LOCAL_HTTP: string;
  MAX_NOTE_BYTES: string;
  MAX_IMAGE_BYTES: string;
  MAX_IMAGE_PIXELS: string;
  MAX_ATTACHMENT_BYTES: string;
  IMAGE_QUOTA_BYTES: string;
  MAX_NOTES: string;
  VERSIONS_KEPT: string;
  IMAGE_GRACE_HOURS: string;
  SESSION_DAYS: string;
  AUTOSAVE_MS: string;
  POLL_SECONDS: string;
  LOGIN_WINDOW_SECONDS: string;
  LOGIN_IP_LIMIT: string;
  LOGIN_GLOBAL_LIMIT: string;
  ACCOUNT_WINDOW_SECONDS: string;
  REGISTRATION_IP_LIMIT: string;
  REGISTRATION_GLOBAL_LIMIT: string;
  PASSWORD_RESET_IP_LIMIT: string;
  PASSWORD_RESET_GLOBAL_LIMIT: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, unknown> = {}) {
    super(message);
  }
}

export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

export function numberSetting(env: Env, key: keyof Env, min: number, max: number): number {
  const value = Number(env[key]);
  if (!/^\d+$/.test(String(env[key])) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError(503, `Invalid configuration: ${key}`);
  }
  return value;
}

export function clientConfig(env: Env): ClientConfig {
  return {
    maxNoteBytes: numberSetting(env, 'MAX_NOTE_BYTES', 1024, 1024 * 1024),
    maxImageBytes: numberSetting(env, 'MAX_IMAGE_BYTES', 1024, 20 * 1024 * 1024),
    maxImagePixels: numberSetting(env, 'MAX_IMAGE_PIXELS', 1, 100_000_000),
    maxAttachmentBytes: numberSetting(env, 'MAX_ATTACHMENT_BYTES', 1024, 50 * 1024 * 1024),
    autosaveMs: numberSetting(env, 'AUTOSAVE_MS', 300, 10_000),
    pollSeconds: numberSetting(env, 'POLL_SECONDS', 10, 600),
  };
}

export function localHttp(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  return env.ALLOW_LOCAL_HTTP === 'true' && url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function requireOrigin(request: Request): void {
  if (request.headers.get('Origin') !== new URL(request.url).origin ||
      request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new ApiError(403, 'Cross-origin request rejected.');
  }
}

export async function readBytes(request: Request, max: number): Promise<Uint8Array> {
  if (Number(request.headers.get('Content-Length')) > max) throw new ApiError(413, 'Request body too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'Request body required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > max) {
      await reader.cancel();
      throw new ApiError(413, 'Request body too large.');
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function readJson(request: Request, max = 8192): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    throw new ApiError(415, 'Expected application/json.');
  }
  const bytes = await readBytes(request, max);
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError(400, 'Invalid JSON object.'); }
}

export const hex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
export const token = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
export const digest = async (value: string | Uint8Array) =>
  hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)));
