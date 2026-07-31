import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { verifyJwt, importPublicKey, parseJwtUnsafe } from '@lumenize/crypto';
import type { JwtPayload } from '@lumenize/crypto';
import { createTestRefreshFunction } from '../src/create-test-refresh-function';

/**
 * The custom claims `createTestRefreshFunction` mints. Declared locally rather than imported
 * from `@lumenize/auth`: mesh mints a token auth happens to gate on, and must not take on
 * auth's policy type.
 *
 * ⚠️ Read at the payload's **top level** on purpose — `createJwtPayload` spreads the
 * `customClaims` bag FLAT, and these assertions pin that at the token level. The consequence
 * of losing it is pinned end-to-end in `test/for-docs/security/`, where the Gateway copies the
 * verified payload into `originAuth.claims` and a nested bag would leave a guard reading
 * `undefined` (verified by mutation, 2026-07-31).
 */
type TestRefreshClaims = { emailVerified?: boolean; adminApproved?: boolean; isAdmin?: boolean };
const claimsOf = (parsed: { payload: JwtPayload } | null): JwtPayload & TestRefreshClaims =>
  parsed!.payload as JwtPayload & TestRefreshClaims;

describe('createTestRefreshFunction', () => {
  it('returns a function that produces { access_token, sub }', async () => {
    const refresh = createTestRefreshFunction();
    const result = await refresh();

    expect(result).toHaveProperty('access_token');
    expect(result).toHaveProperty('sub');
    expect(typeof result.access_token).toBe('string');
    expect(typeof result.sub).toBe('string');
  });

  it('mints a JWT verifiable with the corresponding public key', async () => {
    const refresh = createTestRefreshFunction();
    const { access_token } = await refresh();

    const publicKey = await importPublicKey(env.JWT_PUBLIC_KEY_BLUE);
    const payload = await verifyJwt(access_token, publicKey);

    expect(payload).not.toBeNull();
    expect(payload!.iss).toBe('https://lumenize.local');
    expect(payload!.aud).toBe('https://lumenize.local');
  });

  it('uses a stable sub across repeated calls', async () => {
    const refresh = createTestRefreshFunction();
    const r1 = await refresh();
    const r2 = await refresh();

    expect(r1.sub).toBe(r2.sub);
  });

  it('uses a random sub by default (UUID format)', async () => {
    const r1 = createTestRefreshFunction();
    const r2 = createTestRefreshFunction();

    const { sub: sub1 } = await r1();
    const { sub: sub2 } = await r2();

    expect(sub1).not.toBe(sub2);
    expect(sub1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('respects explicit sub option', async () => {
    const refresh = createTestRefreshFunction({ sub: 'test-user-123' });
    const { sub } = await refresh();

    expect(sub).toBe('test-user-123');
  });

  it('sets default claims: adminApproved=true, emailVerified=true, isAdmin absent', async () => {
    const refresh = createTestRefreshFunction();
    const { access_token } = await refresh();

    const parsed = parseJwtUnsafe(access_token);
    expect(parsed).not.toBeNull();
    expect(claimsOf(parsed).adminApproved).toBe(true);
    expect(claimsOf(parsed).emailVerified).toBe(true);
    expect(claimsOf(parsed).isAdmin).toBeUndefined();
  });

  it('respects adminApproved=false', async () => {
    const refresh = createTestRefreshFunction({ adminApproved: false });
    const { access_token } = await refresh();

    const parsed = parseJwtUnsafe(access_token);
    expect(claimsOf(parsed).adminApproved).toBe(false);
  });

  it('respects emailVerified=false', async () => {
    const refresh = createTestRefreshFunction({ emailVerified: false });
    const { access_token } = await refresh();

    const parsed = parseJwtUnsafe(access_token);
    expect(claimsOf(parsed).emailVerified).toBe(false);
  });

  it('respects isAdmin=true', async () => {
    const refresh = createTestRefreshFunction({ isAdmin: true });
    const { access_token } = await refresh();

    const parsed = parseJwtUnsafe(access_token);
    expect(claimsOf(parsed).isAdmin).toBe(true);
  });

  it('respects custom iss and aud', async () => {
    const refresh = createTestRefreshFunction({ iss: 'custom-issuer', aud: 'custom-audience' });
    const { access_token } = await refresh();

    const parsed = parseJwtUnsafe(access_token);
    expect(parsed!.payload.iss).toBe('custom-issuer');
    expect(parsed!.payload.aud).toBe('custom-audience');
  });

  it('sets exp based on ttl', async () => {
    const refresh = createTestRefreshFunction({ ttl: 120 });
    const { access_token } = await refresh();

    const parsed = parseJwtUnsafe(access_token);
    const expectedExp = parsed!.payload.iat + 120;
    expect(parsed!.payload.exp).toBe(expectedExp);
  });

  it('throws when expired=true (simulates expired refresh token)', async () => {
    const refresh = createTestRefreshFunction({ expired: true });

    await expect(refresh()).rejects.toThrow('Refresh token expired');
  });

  it('accepts an explicit privateKey instead of reading from env', async () => {
    const refresh = createTestRefreshFunction({
      privateKey: env.JWT_PRIVATE_KEY_BLUE,
    });
    const { access_token } = await refresh();

    const publicKey = await importPublicKey(env.JWT_PUBLIC_KEY_BLUE);
    const payload = await verifyJwt(access_token, publicKey);
    expect(payload).not.toBeNull();
  });

  it('uses BLUE key ID in JWT header', async () => {
    const refresh = createTestRefreshFunction();
    const { access_token } = await refresh();

    const parsed = parseJwtUnsafe(access_token);
    expect(parsed!.header.kid).toBe('BLUE');
    expect(parsed!.header.alg).toBe('EdDSA');
  });
});
