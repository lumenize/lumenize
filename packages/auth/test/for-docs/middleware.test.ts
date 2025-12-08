/**
 * Documentation validation test for Middleware example
 * 
 * The documented code appears below - the @check-example plugin validates it exists here.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createAuthMiddleware } from '@lumenize/auth';
import { routeDORequest } from '@lumenize/utils';

describe('Middleware Example', () => {
  it('shows the auth middleware pattern works', async () => {
    const request = new Request('http://localhost/LUMENIZE_AUTH/default/resource');

    // Create middleware once at startup
    const authMiddleware = await createAuthMiddleware({
      publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN],
      audience: 'https://myapp.com',
      issuer: 'https://myapp.com'
    });

    // Use in routeDORequest
    const response = await routeDORequest(request, env, {
      onBeforeRequest: authMiddleware,
      cors: true
    });

    // Without a valid token, middleware returns 401
    expect(response).toBeDefined();
    expect(response?.status).toBe(401);
  });
});
