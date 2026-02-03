/**
 * Documentation validation test for Quick Start example
 *
 * The documented code appears below - the @check-example plugin validates it exists here.
 */
import { describe, it, expect } from 'vitest';
import { LumenizeAuth, createRouteDORequestAuthHooks, createAuthRoutes } from '@lumenize/auth';
import { routeDORequest } from '@lumenize/utils';

export { LumenizeAuth };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Auth routes - public endpoints
    const authRoutes = createAuthRoutes(env);
    const authResponse = await authRoutes(request);
    if (authResponse) return authResponse;

    // Protected routes - with auth hooks
    const authHooks = await createRouteDORequestAuthHooks(env);

    const response = await routeDORequest(request, env, {
      ...authHooks,
      cors: true
    });
    return response ?? new Response('Not Found', { status: 404 });
  }
};

describe('Quick Start Example', () => {
  it('validates the documented pattern compiles correctly', () => {
    expect(typeof LumenizeAuth).toBe('function');
    expect(typeof createRouteDORequestAuthHooks).toBe('function');
    expect(typeof createAuthRoutes).toBe('function');
  });
});
