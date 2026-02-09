/**
 * Documentation validation test for Auth Hooks example
 *
 * The documented code appears below - the @check-example plugin validates it exists here.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createRouteDORequestAuthHooks } from '@lumenize/auth';
import { routeDORequest } from '@lumenize/utils';

describe('Auth Hooks Example', () => {
  it('shows the auth hooks pattern works', async () => {
    const request = new Request('http://localhost/LUMENIZE_AUTH/default/resource');

    // Create hooks once at startup (reads keys from env)
    const { onBeforeRequest, onBeforeConnect } = await createRouteDORequestAuthHooks(env);

    // Use in routeDORequest
    const response = await routeDORequest(request, env, {
      onBeforeRequest,
      onBeforeConnect,
      cors: true
    });

    // Without a valid token, hooks return 401
    expect(response).toBeDefined();
    expect(response?.status).toBe(401);
  });
});
