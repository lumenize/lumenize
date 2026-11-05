/**
 * Only a page on the platform host may call a `POST` under `/auth/`, and only the refresh answers
 * CORS, for the one origin that asked.
 *
 * The platform host holds every session's cookies, and `SameSite=Lax` sends them on a `fetch` from
 * any page on the site — a Star's host included, whose code may be a user-developer's. So every
 * `POST` but the refresh refuses a request a browser marks as coming from anywhere but its own
 * origin, before the handler runs, and none answers CORS, so a refused page cannot read the answer
 * either. The refresh is the one route a scope host's page calls; it passes `same-site` and answers
 * CORS for that origin alone (`refresh-host-grammar.test.ts` owns which origins mint).
 *
 * In-lane because each case is a header a browser sets and this lane can set too; the `/live`
 * scenarios send the same requests from rendered pages.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { buildAuthRouteTable, routeAuthRequest } from '../../src/auth/router';
import { recordingHooks } from './test-worker-and-dos';
import { authUrl, foundUniverse, refreshCookie, scopeOrigin, PLATFORM } from './test-helpers';

const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;

/** Every `POST` path the route table registers, but the refresh. */
const SAME_ORIGIN_POSTS = buildAuthRouteTable(env as Env, recordingHooks)
  .filter((r) => r.method === 'POST' && r.path !== '/auth/refresh-token')
  .map((r) => r.path);

function post(path: string, headers: Record<string, string>, body: unknown = {}): Promise<Response> {
  return SELF.fetch(new Request(`${PLATFORM}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }));
}

describe('every POST but the refresh answers only its own origin', () => {
  it('the table registers the POSTs this file expects to walk', () => {
    // The walk below is only as good as its input: an empty list would pass every assertion.
    expect(SAME_ORIGIN_POSTS).toEqual(expect.arrayContaining([
      '/auth/home-summary', '/auth/pending-membership', '/auth/accept-membership', '/auth/logout',
      '/auth/magic-link', '/auth/magic-link/lookup', '/auth/email-magic-link', '/auth/signup',
    ]));
  });

  it.each(['cross-site', 'same-site', 'none'])('refuses Sec-Fetch-Site: %s on every one, naming the header, with no CORS', async (site) => {
    for (const path of SAME_ORIGIN_POSTS) {
      const resp = await post(path, { 'Sec-Fetch-Site': site, Origin: scopeOrigin('acme.crm.tenant1') });
      expect(resp.status, path).toBe(403);
      expect(await resp.json(), path).toEqual({
        error: 'cross_origin',
        error_description: `Only a page on this host may call this route (Sec-Fetch-Site: ${site})`,
      });
      expect(resp.headers.get('Access-Control-Allow-Origin'), path).toBeNull();
    }
  });

  it('refuses a request without the header whose Origin names another origin, naming Origin', async () => {
    for (const path of SAME_ORIGIN_POSTS) {
      const resp = await post(path, { Origin: scopeOrigin('acme') });
      expect(resp.status, path).toBe(403);
      expect((await resp.json() as { error_description: string }).error_description, path)
        .toBe('Only a page on this host may call this route (Origin)');
    }
  });

  // The positive control, and the case Home is: a page on the platform host reads its own summary.
  it('passes a same-origin request, and a header-less one naming no other origin', async () => {
    const u = uni();
    const { refreshToken } = await foundUniverse(SELF, u, `so-${u}@example.com`);
    const cases: Array<Record<string, string>> = [{ 'Sec-Fetch-Site': 'same-origin' }, { Origin: PLATFORM }, {}];
    for (const headers of cases) {
      const resp = await post('/auth/home-summary', { ...headers, Cookie: refreshCookie(u, refreshToken) });
      expect(resp.status, JSON.stringify(headers)).toBe(200);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });
});

describe('the refresh is the one route a page on another host calls', () => {
  it('passes same-site, answering CORS for that page alone', async () => {
    const u = uni();
    const { refreshToken } = await foundUniverse(SELF, u, `so-${u}@example.com`);
    const resp = await SELF.fetch(new Request(authUrl('refresh-token'), {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'same-site', Origin: scopeOrigin(u), Cookie: refreshCookie(u, refreshToken) },
    }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Access-Control-Allow-Origin')).toBe(scopeOrigin(u));
    expect(resp.headers.get('Vary')).toContain('Origin');
  });

  it('refuses cross-site with 403 and no CORS', async () => {
    const u = uni();
    const { refreshToken } = await foundUniverse(SELF, u, `so-${u}@example.com`);
    const resp = await SELF.fetch(new Request(authUrl('refresh-token'), {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site', Origin: scopeOrigin(u), Cookie: refreshCookie(u, refreshToken) },
    }));
    expect(resp.status).toBe(403);
    expect((await resp.json() as { error: string }).error).toBe('cross_site');
    expect(resp.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // The refresh carries no body and no `Content-Type`, so a browser sends it without a preflight;
  // nothing here answers one.
  it('answers a preflight with 405 and no CORS', async () => {
    const resp = await SELF.fetch(new Request(authUrl('refresh-token'), {
      method: 'OPTIONS',
      headers: { Origin: scopeOrigin('acme'), 'Access-Control-Request-Method': 'POST' },
    }));
    expect(resp.status).toBe(405);
    expect(resp.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('the router composes', () => {
  it('falls through to undefined for a path that is neither Home nor under /auth/', async () => {
    const response = await routeAuthRequest(
      new Request(`${PLATFORM}/gateway/foo/bar`, { method: 'POST' }), env as Env, { hooks: recordingHooks },
    );
    expect(response).toBeUndefined();
  });
});
