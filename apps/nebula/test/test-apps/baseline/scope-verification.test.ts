/**
 * Entrypoint auth-scope verification (e2e)
 *
 * Tests that use SELF.fetch to hit the gateway route and require DO bindings.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { generateUuid, signJwt, importPrivateKey } from '@lumenize/auth';
import { env } from 'cloudflare:test';
import { NEBULA_AUTH_ISSUER } from '@lumenize/nebula-auth';

/**
 * Craft a JWT with specific authScopePattern and aud for testing.
 * Signs with the real private key so signature verification passes.
 */
async function craftJwt(options: {
  authScopePattern: string;
  aud: string;
  admin?: boolean;
  sub?: string;
}): Promise<string> {
  const privateKeyPem = (env as any).JWT_PRIVATE_KEY_BLUE;
  const privateKey = await importPrivateKey(privateKeyPem);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: NEBULA_AUTH_ISSUER,
    aud: options.aud,
    sub: options.sub ?? generateUuid(),
    exp: now + 900,
    iat: now,
    jti: generateUuid(),
    emailVerified: true,
    adminApproved: true,
    email: 'test@example.com',
    access: {
      authScopePattern: options.authScopePattern,
      admin: options.admin ?? false,
    },
  };

  return await signJwt(payload, privateKey, 'BLUE');
}

describe('entrypoint auth-scope verification (e2e)', () => {
  it('rejects JWT where authScopePattern does not cover aud', async () => {
    // JWT with aud = "acme.app.tenant-a" but authScopePattern = "acme.app.tenant-b"
    const token = await craftJwt({
      authScopePattern: 'acme.app.tenant-b',
      aud: 'acme.app.tenant-a',
    });

    // Attempt WebSocket upgrade through the gateway route
    // The entrypoint should reject this with 403 (matchAccess fails)
    const resp = await SELF.fetch('http://localhost/gateway/NEBULA_CLIENT_GATEWAY/test.tab1', {
      headers: {
        'Upgrade': 'websocket',
        'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${token}`,
      },
    });
    expect(resp.status).toBe(403);
  });
});
