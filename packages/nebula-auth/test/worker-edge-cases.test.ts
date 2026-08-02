/**
 * Worker token-layer + router edge cases — the input-validation / error branches of the auth flows
 * (malformed bodies, missing fields, wrong methods, bogus tokens). Each asserts a specific status, so
 * gutting the guard reddens it.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

const u = () => `u${crypto.randomUUID().slice(0, 8)}`;
const url = (path: string) => `http://localhost/auth/${path}`;
const post = (path: string, body?: any, headers: Record<string, string> = {}) =>
  SELF.fetch(new Request(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }));

describe('email-magic-link edge cases', () => {
  it('invalid JSON body → 400', async () => {
    const resp = await post(`${u()}/email-magic-link`, 'not json{');
    expect(resp.status).toBe(400);
    expect((await resp.json() as any).error).toBe('invalid_request');
  });
  it('invalid email format → 400', async () => {
    const resp = await post(`${u()}/email-magic-link`, { email: 'not-an-email' });
    expect(resp.status).toBe(400);
  });
  it('GET (wrong method) → 405', async () => {
    const resp = await SELF.fetch(new Request(url(`${u()}/email-magic-link`), { method: 'GET' }));
    expect(resp.status).toBe(405);
  });
});

describe('magic-link / accept-invite click edge cases', () => {
  it('magic-link with no one_time_token → 400', async () => {
    const resp = await SELF.fetch(new Request(url(`${u()}/magic-link`), { redirect: 'manual' }));
    expect(resp.status).toBe(400);
  });
  it('magic-link with a bogus token → 302 error (consume returns null)', async () => {
    const resp = await SELF.fetch(new Request(url(`${u()}/magic-link?one_time_token=bogus`), { redirect: 'manual' }));
    expect(resp.status).toBe(302);
    expect(resp.headers.get('Location')).toContain('error=invalid_token');
  });
  it('accept-invite with no invite_token → 400', async () => {
    const resp = await SELF.fetch(new Request(url(`${u()}/accept-invite`), { redirect: 'manual' }));
    expect(resp.status).toBe(400);
  });
});

describe('refresh-token edge cases', () => {
  it('no refresh cookie → 401; bogus cookie (no KV record) → 401', async () => {
    const scope = u();
    expect((await post(`${scope}/refresh-token`, { activeScope: scope })).status).toBe(401);
    expect((await post(`${scope}/refresh-token`, { activeScope: scope }, { Cookie: 'refresh-token=bogus' })).status).toBe(401);
  });

  it('with a VALID cookie: missing Content-Type / invalid JSON / missing activeScope all → 400 (post-KV-read guards)', async () => {
    const { foundUniverse } = await import('./test-helpers');
    const scope = u();
    const admin = await foundUniverse(SELF, scope, 'admin@example.com');
    const cookie = `refresh-token=${admin.refreshToken}`;

    const noCt = await SELF.fetch(new Request(url(`${scope}/refresh-token`), { method: 'POST', headers: { Cookie: cookie }, body: '{}' }));
    expect(noCt.status).toBe(400);
    const badJson = await post(`${scope}/refresh-token`, 'not json{', { Cookie: cookie });
    expect(badJson.status).toBe(400);
    const noScope = await post(`${scope}/refresh-token`, {}, { Cookie: cookie });
    expect(noScope.status).toBe(400);
  });
});

describe('logout edge cases', () => {
  it('logout with no cookie still returns 200 + clears the cookie', async () => {
    const resp = await SELF.fetch(new Request(url(`${u()}/logout`), { method: 'POST' }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

describe('mint-narrower-token edge cases (after the Bearer gate)', () => {
  // These need a valid Bearer to pass the router's verifyInstanceJwt; use a star-scoped admin token.
  it('missing subOfNarrowerToken → 400; missing activeScope → 400; invalid JSON → 400', async () => {
    const { foundUniverse, adminRequest } = await import('./test-helpers');
    const scope = u();
    const admin = await foundUniverse(SELF, scope, 'admin@example.com');

    const noSubject = await adminRequest(SELF, scope, 'mint-narrower-token', admin.access_token, {
      method: 'POST', body: { activeScope: scope },
    });
    expect(noSubject.status).toBe(400);

    const noScope = await adminRequest(SELF, scope, 'mint-narrower-token', admin.access_token, {
      method: 'POST', body: { subOfNarrowerToken: 'x' },
    });
    expect(noScope.status).toBe(400);

    const badJson = await SELF.fetch(new Request(url(`${scope}/mint-narrower-token`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
      body: 'not json{',
    }));
    expect(badJson.status).toBe(400);
  });
});

describe('registry dispatch edge cases (malformed body / missing JWT)', () => {
  it('delete-scope with a non-JSON body (after a valid admin JWT) → 400', async () => {
    const { foundUniverse } = await import('./test-helpers');
    const scope = u();
    const admin = await foundUniverse(SELF, scope, 'admin@example.com');
    const resp = await post('delete-scope', 'not json{', { Authorization: `Bearer ${admin.access_token}` });
    expect(resp.status).toBe(400);
  });
  it('create-star / my-scopes without a JWT → 401', async () => {
    expect((await post('create-star', { universeGalaxyStarId: 'a.b.c' })).status).toBe(401);
    expect((await post('my-scopes', {})).status).toBe(401);
  });
  it('delete-scope-plan through the Worker returns the read-only plan (200)', async () => {
    const { foundUniverse } = await import('./test-helpers');
    const scope = u();
    const admin = await foundUniverse(SELF, scope, 'admin@example.com');
    const resp = await post('delete-scope-plan', { target: scope }, { Authorization: `Bearer ${admin.access_token}` });
    expect(resp.status).toBe(200);
    const plan = await resp.json() as any;
    expect(plan.affectedUsers).toEqual({ total: 0, sample: [] });
    expect(plan.affected.map((a: any) => a.instanceName)).toContain(scope);
  });
  it('my-scopes for a platform admin lists every scope (`*` branch)', async () => {
    const { foundUniverse } = await import('./test-helpers');
    const scope = u();
    await foundUniverse(SELF, scope, 'someone@example.com');
    // Mint a `*` platform-admin token directly (no login) to exercise the wildcard scope-tree branch.
    const { createNebulaTestToken } = await import('../src/create-nebula-test-token');
    const { env } = await import('cloudflare:test');
    const platform = await createNebulaTestToken({
      privateKey: (env as any).JWT_PRIVATE_KEY_BLUE, instanceName: 'nebula-platform', activeScope: 'nebula-platform', isAdmin: true,
    })();
    const resp = await post('my-scopes', {}, { Authorization: `Bearer ${platform.access_token}` });
    expect(resp.status).toBe(200);
    const { scopes } = await resp.json() as any;
    expect(scopes.map((s: any) => s.instanceName)).toContain(scope);
  });
});
