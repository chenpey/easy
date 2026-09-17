import type { IntegrationNoteSummary, Note, NoteInput } from '../shared/types.js';

export interface BridgeConfig {
  url: string;
  token: string;
}

export interface IntegrationStatus {
  account: string;
  integration: string;
  access: 'read' | 'read-write';
}

export interface SearchPage {
  notes: IntegrationNoteSummary[];
  nextOffset: number | null;
}

export class BridgeApiError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    public responseBody: string,
  ) {
    super(`${method} ${path} [${status}]\n${responseBody}`);
  }
}

export function validateServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('EasyNote URL must be an absolute URL.');
  }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('EasyNote URL must use HTTPS, except for a loopback development server.');
  if (url.username || url.password || url.search || url.hash) throw new Error('EasyNote URL must not include credentials, query parameters, or a fragment.');
  return url.href.replace(/\/+$/, '');
}

export class EasyNoteClient {
  readonly baseUrl: string;

  constructor(private config: BridgeConfig) {
    this.baseUrl = validateServerUrl(config.url);
    if (!/^enai_[a-f0-9]{64}$/.test(config.token)) throw new Error('The integration token has an invalid format.');
  }

  private async fetch(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const method = init.method ?? 'GET';
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.token}`,
          ...init.headers,
        },
      });
      if (!response.ok) throw new BridgeApiError(response.status, method, path, await response.text());
      return response;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${method} ${path}\nRequest timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await this.fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`${method} ${path} [${response.status}]\n${raw}`);
    }
  }

  status(): Promise<IntegrationStatus> {
    return this.json('/api/integrations/status');
  }

  search(query: {
    q?: string;
    view?: 'all' | 'archive';
    tag?: string;
    sort?: 'default' | 'updated';
    offset?: number;
    limit?: number;
  }): Promise<SearchPage> {
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') parameters.set(key, String(value));
    }
    return this.json(`/api/integrations/notes?${parameters}`);
  }

  note(id: string): Promise<{ note: Note }> {
    return this.json(`/api/integrations/notes/${encodeURIComponent(id)}`);
  }

  notes(ids: string[]): Promise<{ notes: Note[] }> {
    const parameters = new URLSearchParams({ ids: ids.join(',') });
    return this.json(`/api/integrations/notes/batch?${parameters}`);
  }

  save(id: string, input: NoteInput, revision: number, operationId: string): Promise<{ note: Note; unchanged?: boolean }> {
    return this.json(`/api/integrations/notes/${encodeURIComponent(id)}`, revision === 0 ? 'POST' : 'PUT', {
      ...input,
      revision,
      operationId,
      createVersion: true,
    });
  }

}
