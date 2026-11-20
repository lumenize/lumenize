/**
 * `@lumenize/crypto` — written FRESH, not lifted from `packages/auth`.
 *
 * Every `signJwt`/`verifyJwt`/`createJwtPayload` use in `packages/auth/test/auth.test.ts` is
 * fixture construction inside route/hook/DO integration tests; the two most crypto-shaped
 * (`'returns 403 when access gate fails'`, `'supports key rotation'`) assert on
 * `createRouteDORequestAuthHooks(...).onBeforeRequest` and so belong to `packages/auth` —
 * moving them would silently delete auth's only coverage of its access gate and of BLUE/GREEN
 * rotation, leaving that suite green and smaller.
 *
 * ⚠️ **Tier note.** These run under plain-Node vitest deliberately, and that is not the usual
 * cheap-tier reflex (`calibration.md` §6): every function here is a pure `crypto`-global
 * wrapper with no server, no env and no network, so a running system cannot make the
 * assertions more faithful. Running under Node instead buys something the Workers runtime
 * could not — it makes the suite double as the **Node-safety proof** for
 * `@lumenize/mesh/client`, which depends on this package being free of `cloudflare:workers`.
 * Keys are generated in-test, so there is no `.dev.vars` dependency and no fixture key to rotate.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  signJwt,
  verifyJwt,
  verifyJwtWithRotation,
  importPrivateKey,
  importPublicKey,
  generateRandomString,
  hashString,
  createJwtPayload,
  parseJwtUnsafe,
} from '../src/index';
import type { JwtPayload } from '../src/index';

/** PEM-wrap a DER key so `importPrivateKey`/`importPublicKey` are genuinely exercised. */
function toPem(der: ArrayBuffer, label: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

async function generateKeyPairPem(): Promise<{ privatePem: string; publicPem: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    privatePem: toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY'),
    publicPem: toPem(await crypto.subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY'),
  };
}

const basePayload = (over: Partial<JwtPayload> = {}): JwtPayload => ({
  iss: 'https://issuer.test',
  aud: 'https://audience.test',
  sub: 'subject-1',
  exp: Math.floor(Date.now() / 1000) + 900,
  iat: Math.floor(Date.now() / 1000),
  jti: crypto.randomUUID(),
  ...over,
});

let blue: { privatePem: string; publicPem: string };
let green: { privatePem: string; publicPem: string };

beforeAll(async () => {
  blue = await generateKeyPairPem();
  green = await generateKeyPairPem();
});

describe('key import', () => {
  it('imports PEM keys that round-trip a signature', async () => {
    const priv = await importPrivateKey(blue.privatePem);
    const pub = await importPublicKey(blue.publicPem);

    const token = await signJwt(basePayload(), priv, 'BLUE');
    expect(await verifyJwt(token, pub)).not.toBeNull();
  });

  it('accepts the escaped-newline PEM form environment variables produce', async () => {
    const escaped = blue.privatePem.replace(/\n/g, '\\n');
    const priv = await importPrivateKey(escaped);
    const pub = await importPublicKey(blue.publicPem.replace(/\n/g, '\\n'));

    const token = await signJwt(basePayload(), priv, 'BLUE');
    expect(await verifyJwt(token, pub)).not.toBeNull();
  });
});

describe('signJwt / verifyJwt', () => {
  it('round-trips the payload and stamps the key id in the header', async () => {
    const priv = await importPrivateKey(blue.privatePem);
    const pub = await importPublicKey(blue.publicPem);
    const payload = basePayload({ sub: 'round-trip' });

    const token = await signJwt(payload, priv, 'BLUE');
    const verified = await verifyJwt(token, pub);

    expect(verified).toMatchObject({ sub: 'round-trip', iss: 'https://issuer.test' });
    expect(parseJwtUnsafe(token)!.header).toMatchObject({ alg: 'EdDSA', typ: 'JWT', kid: 'BLUE' });
  });

  it('returns null when the signature does not match the key', async () => {
    const priv = await importPrivateKey(blue.privatePem);
    const wrongPub = await importPublicKey(green.publicPem);

    const token = await signJwt(basePayload(), priv, 'BLUE');
    expect(await verifyJwt(token, wrongPub)).toBeNull();
  });

  it('returns null for a tampered signature segment', async () => {
    const priv = await importPrivateKey(blue.privatePem);
    const pub = await importPublicKey(blue.publicPem);

    const parts = (await signJwt(basePayload(), priv, 'BLUE')).split('.');
    parts[2] = parts[2].split('').reverse().join('');
    expect(await verifyJwt(parts.join('.'), pub)).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const priv = await importPrivateKey(blue.privatePem);
    const pub = await importPublicKey(blue.publicPem);

    const token = await signJwt(
      basePayload({ exp: Math.floor(Date.now() / 1000) - 60 }),
      priv,
      'BLUE',
    );
    expect(await verifyJwt(token, pub)).toBeNull();
  });

  it('returns null for a token that is not three segments', async () => {
    const pub = await importPublicKey(blue.publicPem);
    expect(await verifyJwt('not.a.jwt.at.all', pub)).toBeNull();
    expect(await verifyJwt('', pub)).toBeNull();
  });
});

describe('verifyJwtWithRotation', () => {
  // Tested over its MECHANISM, not just its happy path: the point of rotation is that a key
  // which is not first in the array still verifies, so a body that only ever tried
  // `publicKeys[0]` would pass a first-key-only test and fail here.
  it('verifies a GREEN-signed token when GREEN is SECOND in the array', async () => {
    const greenPriv = await importPrivateKey(green.privatePem);
    const keys = [await importPublicKey(blue.publicPem), await importPublicKey(green.publicPem)];

    const token = await signJwt(basePayload({ sub: 'green-signed' }), greenPriv, 'GREEN');
    const verified = await verifyJwtWithRotation(token, keys);

    expect(verified).not.toBeNull();
    expect(verified!.sub).toBe('green-signed');
  });

  it('verifies a BLUE-signed token when BLUE is first', async () => {
    const bluePriv = await importPrivateKey(blue.privatePem);
    const keys = [await importPublicKey(blue.publicPem), await importPublicKey(green.publicPem)];

    const token = await signJwt(basePayload({ sub: 'blue-signed' }), bluePriv, 'BLUE');
    expect((await verifyJwtWithRotation(token, keys))!.sub).toBe('blue-signed');
  });

  it('returns null for a token signed with NEITHER key', async () => {
    const stranger = await generateKeyPairPem();
    const strangerPriv = await importPrivateKey(stranger.privatePem);
    const keys = [await importPublicKey(blue.publicPem), await importPublicKey(green.publicPem)];

    const token = await signJwt(basePayload(), strangerPriv, 'BLUE');
    expect(await verifyJwtWithRotation(token, keys)).toBeNull();
  });
});

describe('createJwtPayload', () => {
  it('computes exp from expiresInSeconds and mints a unique jti', async () => {
    const before = Math.floor(Date.now() / 1000);
    const a = createJwtPayload({
      issuer: 'https://issuer.test',
      audience: 'https://audience.test',
      subject: 'user-1',
      expiresInSeconds: 900,
    });
    const b = createJwtPayload({
      issuer: 'https://issuer.test',
      audience: 'https://audience.test',
      subject: 'user-1',
      expiresInSeconds: 900,
    });

    expect(a.exp).toBeGreaterThanOrEqual(before + 900);
    expect(a.jti).not.toBe(b.jti);
  });

  it('spreads customClaims FLAT onto the payload, never nested', async () => {
    const priv = await importPrivateKey(blue.privatePem);
    const pub = await importPublicKey(blue.publicPem);

    const payload = createJwtPayload({
      issuer: 'https://issuer.test',
      audience: 'https://audience.test',
      subject: 'user-1',
      expiresInSeconds: 900,
      customClaims: { isAdmin: true, tenant: 'acme' },
    });

    // Narrowed through an intersection rather than `Record<string, unknown>` — `JwtPayload`
    // deliberately has NO index signature, so the blunt cast is a type error. That is the
    // shape every real consumer uses to read a custom claim.
    type WithCustom = JwtPayload & { isAdmin?: boolean; tenant?: string };

    // Flat on the object...
    expect((payload as WithCustom).isAdmin).toBe(true);
    expect(payload.customClaims).toBeUndefined();

    // ...and flat across the wire, which is what mesh's Gateway copies to originAuth.claims.
    const decoded = (await verifyJwt(await signJwt(payload, priv, 'BLUE'), pub)) as WithCustom;
    expect(decoded.isAdmin).toBe(true);
    expect(decoded.tenant).toBe('acme');
    expect(decoded.customClaims).toBeUndefined();
  });

  it('registered claims win — a custom claim cannot shadow sub or exp', () => {
    const payload = createJwtPayload({
      issuer: 'https://issuer.test',
      audience: 'https://audience.test',
      subject: 'a',
      expiresInSeconds: 900,
      customClaims: { sub: 'b', exp: 9e9, iss: 'https://evil.test' },
    });

    expect(payload.sub).toBe('a');
    expect(payload.exp).not.toBe(9e9);
    expect(payload.iss).toBe('https://issuer.test');
  });

  it('includes act only when supplied', () => {
    const withAct = createJwtPayload({
      issuer: 'i',
      audience: 'a',
      subject: 's',
      expiresInSeconds: 60,
      act: { sub: 'actor-1' },
    });
    const without = createJwtPayload({
      issuer: 'i',
      audience: 'a',
      subject: 's',
      expiresInSeconds: 60,
    });

    expect(withAct.act).toEqual({ sub: 'actor-1' });
    expect('act' in without).toBe(false);
  });
});

describe('parseJwtUnsafe', () => {
  it('decodes header and payload without a key', async () => {
    const priv = await importPrivateKey(blue.privatePem);
    const token = await signJwt(basePayload({ sub: 'unverified' }), priv, 'GREEN');

    const parsed = parseJwtUnsafe(token);
    expect(parsed!.payload.sub).toBe('unverified');
    expect(parsed!.header.kid).toBe('GREEN');
  });

  it('decodes an EXPIRED token, unlike verifyJwt — it checks nothing', async () => {
    const priv = await importPrivateKey(blue.privatePem);
    const pub = await importPublicKey(blue.publicPem);
    const token = await signJwt(
      basePayload({ exp: Math.floor(Date.now() / 1000) - 60, sub: 'stale' }),
      priv,
      'BLUE',
    );

    expect(await verifyJwt(token, pub)).toBeNull();
    expect(parseJwtUnsafe(token)!.payload.sub).toBe('stale');
  });

  it('returns null for malformed input', () => {
    expect(parseJwtUnsafe('nope')).toBeNull();
    expect(parseJwtUnsafe('a.b')).toBeNull();
  });
});

describe('hashString / generateRandomString', () => {
  it('hashes deterministically and differs for different input', async () => {
    expect(await hashString('token-abc')).toBe(await hashString('token-abc'));
    expect(await hashString('token-abc')).not.toBe(await hashString('token-abd'));
  });

  it('produces base64url output — no +, / or = padding to escape in a URL', async () => {
    const hash = await hashString('any input');
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates distinct random strings whose length tracks the byte count', () => {
    expect(generateRandomString(32)).not.toBe(generateRandomString(32));
    expect(generateRandomString(8).length).toBeLessThan(generateRandomString(64).length);
  });
});
