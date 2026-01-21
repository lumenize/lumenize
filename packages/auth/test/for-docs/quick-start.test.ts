/**
 * Documentation validation test for Quick Start example
 * 
 * The documented code appears below - the @check-example plugin validates it exists here.
 */
import { describe, it, expect } from 'vitest';
import { LumenizeAuth, createAuthMiddleware } from '@lumenize/auth';
import { routeDORequest } from '@lumenize/utils';

export { LumenizeAuth };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Auth routes - no auth middleware (public endpoints)
    const authResponse = await routeDORequest(request, env, {
      prefix: 'auth',
      cors: true
    });
    if (authResponse) return authResponse;

    // Protected routes - with auth middleware
    const authMiddleware = await createAuthMiddleware({
      publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE]
    });
    
    const response = await routeDORequest(request, env, {
      onBeforeRequest: authMiddleware,
      onBeforeConnect: authMiddleware,
      cors: true
    });
    return response ?? new Response('Not Found', { status: 404 });
  }
};

describe('Quick Start Example', () => {
  it('validates the documented pattern compiles correctly', () => {
    expect(typeof LumenizeAuth).toBe('function');
    expect(typeof createAuthMiddleware).toBe('function');
  });
});
