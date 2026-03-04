/**
 * Entrypoint auth-scope verification (unit tests)
 *
 * Tests the belt-and-suspenders matchAccess(authScopePattern, aud) check
 * inside verifyNebulaAccessToken using crafted JWTs.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { generateUuid, signJwt, importPrivateKey } from '@lumenize/auth';
import { NEBULA_AUTH_ISSUER } from '@lumenize/nebula-auth';

/**
 * Craft a JWT with specific authScopePattern and aud for unit testing.
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

describe('matchAccess(authScopePattern, aud) verification', () => {
  it('allows JWT where wildcard authScopePattern covers aud', async () => {
    const token = await craftJwt({
      authScopePattern: 'acme.*',
      aud: 'acme.app.tenant-a',
      admin: true,
    });

    const { verifyNebulaAccessToken } = await import('@lumenize/nebula-auth');
    const result = await verifyNebulaAccessToken(token, env);
    expect(result).not.toBeNull();
    expect(result!.aud).toBe('acme.app.tenant-a');
    expect(result!.access.authScopePattern).toBe('acme.*');
  });

  it('allows JWT where exact authScopePattern matches aud', async () => {
    const token = await craftJwt({
      authScopePattern: 'acme.app.tenant-a',
      aud: 'acme.app.tenant-a',
    });

    const { verifyNebulaAccessToken } = await import('@lumenize/nebula-auth');
    const result = await verifyNebulaAccessToken(token, env);
    expect(result).not.toBeNull();
    expect(result!.aud).toBe('acme.app.tenant-a');
  });

  it('rejects JWT where authScopePattern is narrower than aud', async () => {
    const token = await craftJwt({
      authScopePattern: 'acme.app.tenant-a',
      aud: 'acme.app',  // aud is broader than authScopePattern
    });

    const { verifyNebulaAccessToken } = await import('@lumenize/nebula-auth');
    const result = await verifyNebulaAccessToken(token, env);
    expect(result).toBeNull();
  });
});
