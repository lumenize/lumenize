/**
 * Phase 1.96: verifyNebulaAccessToken tests
 *
 * Tests the exported verification function directly with crafted JWTs.
 * Covers valid tokens, invalid tokens (each claim failure), and key rotation.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { signJwt, importPrivateKey, generateUuid } from '@lumenize/auth';
import { verifyNebulaAccessToken } from '../src/router';
import { NEBULA_AUTH_ISSUER } from '../src/types';
import type { NebulaJwtPayload, AccessEntry } from '../src/types';

/**
 * Helper: create a signed Nebula JWT with sensible defaults.
 * Uses BLUE key unless keyColor is specified.
 */
async function createToken(overrides: Record<string, unknown> = {}, keyColor: 'BLUE' | 'GREEN' = 'BLUE'): Promise<string> {
  const privateKeyPem = keyColor === 'BLUE' ? env.JWT_PRIVATE_KEY_BLUE : env.JWT_PRIVATE_KEY_GREEN;
  const privateKey = await importPrivateKey(privateKeyPem);
  const now = Math.floor(Date.now() / 1000);

  const defaults: Record<string, unknown> = {
    iss: NEBULA_AUTH_ISSUER,
    aud: 'acme.app.tenant-a',
    sub: generateUuid(),
    exp: now + 900,
    iat: now,
    jti: generateUuid(),
    email: 'test@example.com',
    adminApproved: true,
    access: { authScopePattern: 'acme.app.tenant-a', admin: false },
  };

  const payload = { ...defaults, ...overrides };
  return signJwt(payload as any, privateKey, keyColor);
}

describe('verifyNebulaAccessToken', () => {
  describe('valid tokens', () => {
    it('returns payload for exact authScopePattern/aud match', async () => {
      const token = await createToken({
        aud: 'acme.app.tenant-a',
        access: { authScopePattern: 'acme.app.tenant-a', admin: false },
      });

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).not.toBeNull();
      expect(result!.aud).toBe('acme.app.tenant-a');
      expect(result!.access.authScopePattern).toBe('acme.app.tenant-a');
    });

    it('returns payload for wildcard authScopePattern covering aud', async () => {
      const token = await createToken({
        aud: 'acme.app.tenant-a',
        access: { authScopePattern: 'acme.*', admin: true },
      });

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).not.toBeNull();
      expect(result!.aud).toBe('acme.app.tenant-a');
      expect(result!.access.authScopePattern).toBe('acme.*');
    });

    it('returns payload for universe-level token (aud matches prefix of wildcard)', async () => {
      const token = await createToken({
        aud: 'acme',
        access: { authScopePattern: 'acme.*', admin: true },
      });

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).not.toBeNull();
      expect(result!.aud).toBe('acme');
    });

    it('returns payload with all expected fields', async () => {
      const sub = generateUuid();
      const token = await createToken({
        sub,
        aud: 'acme.app.tenant-a',
        email: 'alice@example.com',
        access: { authScopePattern: 'acme.app.tenant-a', admin: true },
      });

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        iss: NEBULA_AUTH_ISSUER,
        aud: 'acme.app.tenant-a',
        sub,
        email: 'alice@example.com',
        access: { authScopePattern: 'acme.app.tenant-a', admin: true },
      });
    });
  });

  describe('invalid tokens', () => {
    it('returns null for expired token', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createToken({ exp: now - 60 });

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).toBeNull();
    });

    it('returns null for bad signature (signed with unknown key)', async () => {
      // Create a token signed with a completely different key
      // We'll use a raw signJwt with a key that doesn't match the env public keys
      // Simplest approach: tamper with the token after signing
      const token = await createToken();
      // Corrupt the signature portion (last segment)
      const parts = token.split('.');
      parts[2] = parts[2]!.split('').reverse().join('');
      const tampered = parts.join('.');

      const result = await verifyNebulaAccessToken(tampered, env);
      expect(result).toBeNull();
    });

    it('returns null for missing aud', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      // Sign without aud field
      const token = await signJwt({
        iss: NEBULA_AUTH_ISSUER,
        sub: generateUuid(),
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
        access: { authScopePattern: 'acme.*', admin: true },
      } as any, privateKey, 'BLUE');

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).toBeNull();
    });

    it('returns null for missing sub', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({
        iss: NEBULA_AUTH_ISSUER,
        aud: 'acme',
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
        access: { authScopePattern: 'acme.*', admin: true },
      } as any, privateKey, 'BLUE');

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).toBeNull();
    });

    it('returns null for wrong issuer', async () => {
      const token = await createToken({ iss: 'https://wrong-issuer.example.com' });

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).toBeNull();
    });

    it('returns null for missing access.authScopePattern', async () => {
      const token = await createToken({ access: {} });

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).toBeNull();
    });

    it('returns null for missing access object entirely', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({
        iss: NEBULA_AUTH_ISSUER,
        aud: 'acme',
        sub: generateUuid(),
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
      } as any, privateKey, 'BLUE');

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).toBeNull();
    });

    it('returns null when aud is not covered by authScopePattern', async () => {
      const token = await createToken({
        aud: 'acme.app.tenant-a',
        access: { authScopePattern: 'acme.app.tenant-b', admin: true },
      });

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).toBeNull();
    });

    it('returns null when aud is a sibling not covered by non-wildcard pattern', async () => {
      const token = await createToken({
        aud: 'acme.other',
        access: { authScopePattern: 'acme.app', admin: true },
      });

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).toBeNull();
    });

    it('returns null for empty string token', async () => {
      const result = await verifyNebulaAccessToken('', env);
      expect(result).toBeNull();
    });

    it('returns null for garbage token', async () => {
      const result = await verifyNebulaAccessToken('not.a.jwt', env);
      expect(result).toBeNull();
    });
  });

  describe('key rotation', () => {
    it('accepts token signed with BLUE key when both keys present', async () => {
      const token = await createToken({}, 'BLUE');

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).not.toBeNull();
    });

    it('accepts token signed with GREEN key when both keys present', async () => {
      const token = await createToken({}, 'GREEN');

      const result = await verifyNebulaAccessToken(token, env);
      expect(result).not.toBeNull();
    });

    it('rejects token signed with unknown key', async () => {
      const token = await createToken();
      // Corrupt the signature
      const parts = token.split('.');
      parts[2] = parts[2]!.split('').reverse().join('');

      const result = await verifyNebulaAccessToken(parts.join('.'), env);
      expect(result).toBeNull();
    });
  });
});
