/**
 * Entrypoint auth-scope verification (unit tests)
 *
 * Tests the belt-and-suspenders isAtOrAbove(authScope, aud) check
 * inside verifyNebulaAccessToken using crafted JWTs.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { signJwt, importPrivateKey } from '@lumenize/crypto';
import { NEBULA_AUTH_ISSUER } from '@lumenize/nebula-auth';

/**
 * Craft a JWT with specific authScope and aud for unit testing.
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

describe('isAtOrAbove(authScope, aud) verification', () => {
  it('allows JWT where an ancestor authScope covers aud', async () => {
    const token = await craftJwt({
      authScope: 'acme',
      aud: 'acme.app.tenant-a',
      scopeAdmin: true,
    });

    const { verifyNebulaAccessToken } = await import('@lumenize/nebula-auth');
    const result = await verifyNebulaAccessToken(token, env);
    expect(result).not.toBeNull();
    expect(result!.aud).toBe('acme.app.tenant-a');
    expect(result!.access.authScope).toBe('acme');
  });

  it('allows JWT where exact authScope matches aud', async () => {
    const token = await craftJwt({
      authScope: 'acme.app.tenant-a',
      aud: 'acme.app.tenant-a',
    });

    const { verifyNebulaAccessToken } = await import('@lumenize/nebula-auth');
    const result = await verifyNebulaAccessToken(token, env);
    expect(result).not.toBeNull();
    expect(result!.aud).toBe('acme.app.tenant-a');
  });

  it('rejects JWT where authScope is narrower than aud', async () => {
    const token = await craftJwt({
      authScope: 'acme.app.tenant-a',
      aud: 'acme.app',  // aud is broader than authScope
    });

    const { verifyNebulaAccessToken } = await import('@lumenize/nebula-auth');
    const result = await verifyNebulaAccessToken(token, env);
    expect(result).toBeNull();
  });
});
