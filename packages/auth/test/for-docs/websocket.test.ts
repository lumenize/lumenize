/**
 * Documentation validation test for WebSocket example
 * 
 * The documented code appears below - the @check-example plugin validates it exists here.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createWebSocketAuthMiddleware } from '@lumenize/auth';
import { routeDORequest } from '@lumenize/utils';

describe('WebSocket Auth Example', () => {
  it('shows the WebSocket auth middleware pattern works', async () => {
    const request = new Request('http://localhost/LUMENIZE_AUTH/default', {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Protocol': 'lmz'
      }
    });

    const wsAuthMiddleware = await createWebSocketAuthMiddleware({
      publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE]
    });

    const response = await routeDORequest(request, env, {
      onBeforeConnect: wsAuthMiddleware
    });

    // Without a valid token in subprotocol, the middleware returns 401
    expect(response).toBeDefined();
    expect(response?.status).toBe(401);
  });
});
