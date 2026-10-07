/**
 * Entrypoint auth-scope verification (e2e)
 *
 * Tests that use SELF.fetch to hit the gateway route and require DO bindings.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { signJwt, importPrivateKey } from '@lumenize/crypto';
import { env } from 'cloudflare:test';
import { deploymentOrigin, platformOrigin } from '@lumenize/nebula-auth/claims';
import { pageOf } from '../../test-helpers';

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
    iss: platformOrigin(deploymentOrigin(env)),
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
    // `sub: 'test'` begins the id, so the identity check passes, and the admin bit lifts the plain
    // membership's `aud`-equals-`authScope` rule, so only the containment check can refuse.
    const token = await craftJwt({
      authScope: 'acme.app.tenant-b',
      aud: 'acme.app.tenant-a',
      scopeAdmin: true,
      sub: 'test',
    });

    // Attempt a Client's upgrade on the page of the token's `aud`
    // The entrypoint should reject this with 403 (isAtOrAbove fails)
    const resp = await SELF.fetch(`${pageOf('acme.app.tenant-a')}/gateway/test.tab1`, {
      headers: {
        'Upgrade': 'websocket',
        'Sec-WebSocket-Protocol': `lmz.2, lmz.access-token.${token}`,
      },
    });
    expect(resp.status).toBe(403);
    // By message: an identity mismatch is also a 403.
    expect(await resp.text()).toBe('Forbidden: invalid JWT');
  });

  // A plain membership mints on its own host alone, so a token whose `aud` sits below its
  // `authScope` without the admin bit is one no real mint can produce — which is why this is a
  // rung-4 craft rather than a login. Without the equality, reading `aud` would widen a plain
  // member of `acme.app` into passage over `acme.app.tenant-a`.
  const upgrade = (token: string) => SELF.fetch(`${pageOf('acme.app.tenant-a')}/gateway/test.tab1`, {
    headers: { 'Upgrade': 'websocket', 'Sec-WebSocket-Protocol': `lmz.2, lmz.access-token.${token}` },
  });

  it("refuses a plain membership's token whose aud sits below its authScope", async () => {
    const token = await craftJwt({ authScope: 'acme.app', aud: 'acme.app.tenant-a', sub: 'test' });
    expect((await upgrade(token)).status).toBe(403);
  });

  it("accepts a plain membership's token at its own scope, and an admin's below it", async () => {
    // The positive controls: the same upgrade is answered once the token is consistent.
    const plain = await upgrade(await craftJwt({ authScope: 'acme.app.tenant-a', aud: 'acme.app.tenant-a', sub: 'test' }));
    expect(plain.status).toBe(101);
    plain.webSocket?.accept(); plain.webSocket?.close();
    const admin = await upgrade(await craftJwt({ authScope: 'acme.app', aud: 'acme.app.tenant-a', scopeAdmin: true, sub: 'test' }));
    expect(admin.status).toBe(101);
    admin.webSocket?.accept(); admin.webSocket?.close();
  });
});
