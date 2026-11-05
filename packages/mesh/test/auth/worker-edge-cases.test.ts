/**
 * Worker token-layer + router edge cases — the input-validation / error branches of the auth flows
 * (malformed bodies, missing fields, wrong methods, bogus tokens). Each asserts a specific status, so
 * gutting the guard reddens it.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { authUrl as url, refresh, refreshCookie, refreshCookiesSet } from './test-helpers';

const u = () => `u${crypto.randomUUID().slice(0, 8)}`;
const post = (path: string, body?: any, headers: Record<string, string> = {}) =>
  SELF.fetch(new Request(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }));

// The SCOPE-LESS route — the only form there is. Its `/auth/{scope}/…` sibling is retired.
describe('email-magic-link edge cases', () => {
  it('invalid JSON body → 400', async () => {
    const resp = await post('email-magic-link', 'not json{');
    expect(resp.status).toBe(400);
    expect((await resp.json() as any).error).toBe('invalid_request');
  });
  it('invalid email format → 400', async () => {
    const resp = await post('email-magic-link', { email: 'not-an-email' });
    expect(resp.status).toBe(400);
  });
  it('GET (wrong method) → 405', async () => {
    const resp = await SELF.fetch(new Request(url('email-magic-link'), { method: 'GET' }));
    expect(resp.status).toBe(405);
  });
});

describe('the link page\'s routes refuse a missing or unknown token', () => {
  it.each(['magic-link', 'magic-link/lookup'])('%s with no token → 400 invalid_request', async (path) => {
    const resp = await post(path, {});
    expect(resp.status).toBe(400);
    expect((await resp.json() as any).error).toBe('invalid_request');
  });
  it.each(['magic-link', 'magic-link/lookup'])('%s with a bogus token → 400 invalid_token, no cookie', async (path) => {
    const resp = await post(path, { token: 'bogus' });
    expect(resp.status).toBe(400);
    expect((await resp.json() as any).error).toBe('invalid_token');
    expect(resp.headers.getSetCookie()).toEqual([]);
  });
  it('the retired accept-invite route is gone → 404', async () => {
    expect((await SELF.fetch(new Request(url(`${u()}/accept-invite`)))).status).toBe(404);
    expect((await SELF.fetch(new Request(url('accept-invite')))).status).toBe(404);
  });
});

describe('refresh-token edge cases', () => {
  it('no refresh cookie → 401; bogus cookie (no record anywhere) → 401, and that cookie is expired', async () => {
    const scope = u();
    expect((await refresh(SELF, scope, '')).status).toBe(401);
    const bogus = await refresh(SELF, scope, refreshCookie(scope, 'bogus'));
    expect(bogus.status).toBe(401);
    // A miss in KV and the index alike is a revoked or forged cookie, so it is expired, and the
    // browser stops presenting a cookie that costs a Registry read every time.
    expect(refreshCookiesSet(bogus).get(scope)).toBe('');
    expect(bogus.headers.getSetCookie()[0]).toContain('Max-Age=0');
  });
});

describe('logout edge cases', () => {
  it('logout with no cookie still returns 200 and ends nothing', async () => {
    const resp = await SELF.fetch(new Request(url('logout'), { method: 'POST' }));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ended: 0 });
  });
});

describe('impersonation mint edge cases', () => {
  // The mint takes the subject as an argument the wire does not type-check, so a missing one must be
  // a refusal rather than a lookup of `undefined`.
  it('a missing subject is refused before any lookup', async () => {
    const { foundUniverse, verifiedClaims } = await import('./test-helpers');
    const { mintImpersonationToken } = await import('../../src/auth/worker-token');
    const scope = u();
    const admin = await foundUniverse(SELF, scope, 'admin@example.com');
    expect(await mintImpersonationToken(env as Env, await verifiedClaims(admin.access_token), undefined))
      .toEqual({ ok: false, message: 'Impersonation needs the subject\'s sub' });
  });
});

describe('Home\'s summary edge cases', () => {
  it('home-summary without a cookie → 401', async () => {
    expect((await post('home-summary', {})).status).toBe(401);
  });
  it("the superuser's summary reaches the platform root and stays BUDGET-BOUNDED", async () => {
    const { foundUniverse, platformLogin } = await import('./test-helpers');
    const { SCOPE_TREE_NODE_BUDGET, PLATFORM_SCOPE } = await import('../../src/auth/types');
    const scope = u();
    await foundUniverse(SELF, scope, 'someone@example.com');

    // ⚠️ A REAL bootstrap login, not a synthetic mint: the summary answers for a PERSON, so it needs
    // an accepted membership behind the cookie rather than a hand-built claim.
    const platform = await platformLogin(SELF, 'bootstrap-admin@example.com');
    const resp = await post('home-summary', {}, { Cookie: refreshCookie(PLATFORM_SCOPE, platform.refreshToken) });
    expect(resp.status).toBe(200);
    const { groups } = await resp.json() as any;
    const flat = (n: any): any[] => [n, ...(n.children ?? []).flatMap(flat)];
    const nodes = groups[0].summary.emails.flatMap((e: any) => e.memberships.flatMap(flat));
    expect(nodes.map((n: any) => n.scope)).toContain('_platform');
    // ⚠️ **The bound is the point.** The retired `myScopeTree` answered a platform admin with
    // `SELECT … FROM Scopes` entire — every scope in the system, unbounded, on the one singleton.
    // Reds if the descent stops honouring the budget.
    expect(nodes.length).toBeLessThanOrEqual(SCOPE_TREE_NODE_BUDGET);
  });
});
