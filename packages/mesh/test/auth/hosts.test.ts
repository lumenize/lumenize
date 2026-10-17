/**
 * Which host is which (`src/hosts.ts`), and which tokens a deployment accepts.
 *
 * The host table is a parser's, so vitest-plugin is the right tier: nothing here needs a running
 * system to mean something. The issuer limb uses the real payload builder and the real verify.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { importPrivateKey, signJwt } from '@lumenize/crypto';
import { parseHost, platformOrigin } from '../../src/auth/hosts';
import { buildAuthClaims } from '../../src/auth/access-claims';
import { verifyAccessToken } from '../../src/auth/verify';

const PROD = 'https://lumenize.dev';
const LOCAL = 'http://lumenize.localhost';

describe('parseHost reads ADR-021\'s grammar against the deployment\'s origin', () => {
  it.each([
    ['tenant1.crm.acme.lumenize.localhost:54321', LOCAL, { kind: 'scope', scope: 'acme.crm.tenant1' }],
    ['tenant1.crm.acme.lumenize.dev', PROD, { kind: 'scope', scope: 'acme.crm.tenant1' }],
    ['crm.acme.lumenize.dev', PROD, { kind: 'scope', scope: 'acme.crm' }],
    ['acme.lumenize.dev', PROD, { kind: 'scope', scope: 'acme' }],
    ['manny--dev.crm.acme.lumenize.dev', PROD, { kind: 'persona', persona: 'manny', scope: 'acme.crm.dev' }],
    ['platform.lumenize.dev', PROD, { kind: 'platform' }],
    ['platform.lumenize.localhost:8787', LOCAL, { kind: 'platform' }],
    ['lumenize.dev', PROD, { kind: 'apex' }],
  ])('%s → %j', (host, origin, expected) => {
    expect(parseHost(host, origin)).toEqual(expected);
  });

  it.each([
    ['x.tenant1.crm.acme.lumenize.dev', 'four labels deep'],
    [`${'a'.repeat(31)}.crm.acme.lumenize.dev`, 'a 31-character label'],
    ['a--b--c.crm.acme.lumenize.dev', 'two persona joins in one label'],
    ['manny--tenant1.crm.acme.lumenize.dev', 'a persona under a Star that is no environment'],
    ['ed--dev.crm.acme.lumenize.dev', 'a persona slug shorter than three characters'],
    ['manny--dev.acme.lumenize.dev', 'a persona above the Star level'],
    ['_platform.lumenize.dev', 'the platform SCOPE as a label'],
    ['x._platform.lumenize.dev', 'a label beneath the platform scope'],
    ['crm.platform.lumenize.dev', 'a universe label the platform keeps'],
    ['evil.example', 'a host outside the origin'],
    ['acme.lumenize.dev.evil.example', 'the origin as an infix'],
  ])('refuses %s (%s)', (host) => {
    expect(parseHost(host, PROD)).toBeNull();
  });
});

describe('a deployment accepts only its own tokens', () => {
  async function tokenIssuedBy(origin: string): Promise<string> {
    const payload = buildAuthClaims({
      issuer: platformOrigin(origin),
      sub: crypto.randomUUID(), instanceName: 'acme', activeScope: 'acme', scopeAdmin: true,
      profileId: crypto.randomUUID(),
    });
    return signJwt(payload as any, await importPrivateKey((env as any).JWT_PRIVATE_KEY_BLUE), 'BLUE');
  }

  it('a token issued under one origin fails verification under another, though the same key signed it', async () => {
    const token = await tokenIssuedBy('https://lumenize-test.dev');
    expect(await verifyAccessToken(token, { ...env, LUMENIZE_ORIGIN: PROD })).toBeNull();
    // Positive control: the same token verifies under its own origin.
    expect(await verifyAccessToken(token, { ...env, LUMENIZE_ORIGIN: 'https://lumenize-test.dev' }))
      .toMatchObject({ iss: 'https://platform.lumenize-test.dev', aud: 'acme' });
  });
});

describe("a plain membership's token is built only for its own scope's host", () => {
  // The mint-side half of verification's equality: passage reads `aud`, so a plain member of
  // `acme.crm` holding a token for a tenant's host would reach the tenant. No real mint asks for one
  // — the refresh mints a plain cookie only at its own host — so this is the construction check.
  const build = (activeScope: string, scopeAdmin: boolean) => () => buildAuthClaims({
    issuer: platformOrigin(LOCAL), sub: crypto.randomUUID(), instanceName: 'acme.crm', activeScope, scopeAdmin,
    profileId: crypto.randomUUID(),
  });

  it('refuses a plain membership below its own scope, and builds an admin\'s there', () => {
    expect(build('acme.crm.tenant1', false))
      .toThrow('A plain membership at "acme.crm" mints only for its own scope, not "acme.crm.tenant1"');
    expect(build('acme.crm.tenant1', true)).not.toThrow();
    expect(build('acme.crm', false)).not.toThrow(); // the positive control: its own scope
  });
});
