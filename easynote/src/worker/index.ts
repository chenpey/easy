import { authRoute, requireIdentity } from './auth';
import { ApiError, json, localHttp, type Env } from './core';
import { cleanup, imageRoutes } from './images';
import { integrationIdentity, integrationRoutes, integrationTokenRoutes } from './integrations';
import { noteRoutes } from './notes';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (new URL(request.url).protocol !== 'https:' && !localHttp(request, env)) {
        throw new ApiError(403, 'HTTPS is required.');
      }
      const auth = await authRoute(request, env, path);
      if (auth) return auth;
      if (path === '/api/integrations/tokens' || path.startsWith('/api/integrations/tokens/')) {
        const user = await requireIdentity(request, env);
        const response = await integrationTokenRoutes(request, env, user, path);
        if (response) return response;
        throw new ApiError(404, 'Endpoint not found.');
      }
      if (path.startsWith('/api/integrations/')) {
        const integration = await integrationIdentity(request, env);
        const response = await integrationRoutes(request, env, integration, path);
        if (response) return response;
        throw new ApiError(404, 'Endpoint not found.');
      }
      const user = await requireIdentity(request, env);
      const response = await noteRoutes(request, env, user, path) ?? await imageRoutes(request, env, user, path);
      if (response) return response;
      throw new ApiError(404, 'Endpoint not found.');
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ error: { message: error.message, ...error.data } }, error.status);
      }
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({ requestId, method: request.method, path, error: String(error) }));
      return json({ error: { message: 'Internal server error.', requestId } }, 500);
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await cleanup(env);
  },
} satisfies ExportedHandler<Env>;
