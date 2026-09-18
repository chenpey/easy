import { idPattern } from '../shared/types';
import { ApiError, json, requireOrigin, type Env } from './core';

const sourceClient = (request: Request) => {
  const value = request.headers.get('X-EasyNote-Client') ?? '';
  return idPattern.test(value) ? value : '';
};

export class NoteEvents {
  constructor(private readonly state: DurableObjectState) {
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    if (path === '/connect') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return json({ error: { message: 'WebSocket upgrade required.' } }, 426);
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const source = sourceClient(request);
      this.state.acceptWebSocket(server, source ? [source] : undefined);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === '/notify' && request.method === 'POST') {
      const source = sourceClient(request);
      const message = JSON.stringify({ type: 'notes-changed' });
      for (const socket of this.state.getWebSockets()) {
        if (source && this.state.getTags(socket).includes(source)) continue;
        try { socket.send(message); } catch { socket.close(1011, 'Delivery failed'); }
      }
      return json({ ok: true });
    }
    return json({ error: { message: 'Endpoint not found.' } }, 404);
  }
}

export async function connectNoteEvents(request: Request, env: Env, userId: string): Promise<Response> {
  requireOrigin(request);
  const source = new URL(request.url).searchParams.get('client') ?? '';
  if (!idPattern.test(source)) throw new ApiError(400, 'Invalid client ID.');
  const headers = new Headers(request.headers);
  headers.set('X-EasyNote-Client', source);
  return env.NOTE_EVENTS.getByName(userId).fetch(new Request('https://events/connect', { headers }));
}

export async function publishNoteChanges(env: Env, userId: string, request: Request): Promise<void> {
  const source = sourceClient(request);
  try {
    await env.NOTE_EVENTS.getByName(userId).fetch('https://events/notify', {
      method: 'POST',
      headers: source ? { 'X-EasyNote-Client': source } : undefined,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'note-change-notification-failed', userId, error: String(error) }));
  }
}
