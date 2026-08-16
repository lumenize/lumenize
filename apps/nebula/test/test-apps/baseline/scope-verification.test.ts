/**
 * Entrypoint auth-scope verification (e2e)
 *
 * Tests that use SELF.fetch to hit the gateway route and require DO bindings.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { signJwt, importPrivateKey } from '@lumenize/crypto';
import { env } from 'cloudflare:test';
import { NEBULA_AUTH_ISSUER } from '@lumenize/nebula-auth';

/**
 * Craft a JWT with specific authScope and aud for testing.
 * Signs with the real private key so signature verification passes.
 */
async function craftJwt(options: {
  authScope: string;
  aud: string;
  scopeAdmin?: boolean;
  sub?: string;
}): Promise<string> {
  const privateKeyPem = (env as any).JWT_PRIVATE_KEY_BLUE;
  const privateKey = await importPrivateKey(privateKeyPem);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: NEBULA_AUTH_ISSUER,
    aud: options.aud,
    sub: options.sub ?? crypto.randomUUID(),
    exp: now + 900,
    iat: now,
    jti: crypto.randomUUID(),
    emailVerified: true,
    adminApproved: true,
    email: 'test@example.com',
    access: {
      authScope: options.authScope,
      scopeAdmin: options.scopeAdmin ?? false,
    },
  };

  return await signJwt(payload, privateKey, 'BLUE');
}

describe('entrypoint auth-scope verification (e2e)', () => {
  it('rejects JWT where authScope does not cover aud', async () => {
    // JWT with aud = "acme.app.tenant-a" but authScope = "acme.app.tenant-b"
    const token = await craftJwt({
      authScope: 'acme.app.tenant-b',
      aud: 'acme.app.tenant-a',
    });

    // Attempt WebSocket upgrade through the gateway route
    // The entrypoint should reject this with 403 (isAtOrAbove fails)
    const resp = await SELF.fetch('http://localhost/gateway/NEBULA_CLIENT_GATEWAY/test.tab1', {
      headers: {
        'Upgrade': 'websocket',
        'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${token}`,
      },
    });
    expect(resp.status).toBe(403);
  });
});
