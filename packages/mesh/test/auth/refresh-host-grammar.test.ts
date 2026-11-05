/**
 * The refresh takes its scope from the page's host, and nothing else names one.
 *
 * `Origin` names the page, and the deployment's parse (`parseHost`) turns its host into a scope —
 * `tenant.app.acme.lumenize.localhost` into `acme.app.tenant`. That parse is the only thing refusing
 * a scope no grammar can produce: `isAtOrAbove` is deliberately grammar-free, so a four-deep name
 * would sit "beneath" a legitimate membership and mint if anything let it through. A body, which
 * page script writes, is never read.
 *
 * ⚠️ **This file asserts 403 with its error code, never merely 4xx.** A parse that threw inside the
 * handler would answer `500 internal_error` through `router.ts`'s blanket catch — a refusal, and one
 * that would satisfy a 4xx-shaped criterion while proving the check was sited wrong. And the refusal
 * carries no CORS headers, so the script that asked cannot read even that.
 *
 * In-lane because the parse is a pure function of a header this lane sets; the `/live` scenarios
 * drive the same refresh from real pages. ADR-009 rung 2 — real server issuance, no client mint.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { authUrl, foundUniverse, refreshCookie, scopeOrigin, PLATFORM } from './test-helpers';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }

/** The refresh as a page at `origin` sends it, with an optional body page script might add. */
function refreshFrom(origin: string | undefined, cookie: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: cookie };
  if (origin !== undefined) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return SELF.fetch(new Request(authUrl('refresh-token'), {
    method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

describe('the refresh reads its scope from the page host, through the parse', () => {
  // Each origin is one the parse refuses or one that names no scope. The four-deep host is the
  // load-bearing case: its scope would sit BENEATH the admin's universe, so the containment check
  // alone would mint for it.
  it.each([
    ['a host four labels deep', (u: string) => `http://x.tenant.app.${u}.lumenize.localhost`],
    ['a label the slug grammar refuses', (u: string) => `http://my_app.${u}.lumenize.localhost`],
    ['a reserved universe label', () => 'http://www.lumenize.localhost'],
    ['a host outside the deployment', () => 'https://evil.example'],
    ['the platform host', () => PLATFORM],
    ['the apex', () => 'http://lumenize.localhost'],
    ['an opaque origin', () => 'null'],
  ])('refuses %s with 403 invalid_origin, no CORS, and mints nothing', async (_label, originOf) => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const resp = await refreshFrom(originOf(u), refreshCookie(u, admin.refreshToken));
    expect(resp.status).toBe(403);
    const body = await resp.json() as { error?: string; access_token?: string };
    expect(body.error).toBe('invalid_origin');
    expect(body.access_token).toBeUndefined();
    expect(resp.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('refuses a request with no Origin at all', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const resp = await refreshFrom(undefined, refreshCookie(u, admin.refreshToken));
    expect(resp.status).toBe(403);
    expect((await resp.json() as { error: string }).error).toBe('invalid_origin');
  });

  // The positive control. Without it, every refusal above stays green against a refresh that
  // refuses EVERY origin — a strictly worse bug than the one being closed.
  it('mints for a page at every tier beneath the membership, with CORS naming that page alone', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    for (const scope of [u, `${u}.app`, `${u}.app.tenant`]) {
      const resp = await refreshFrom(scopeOrigin(scope), refreshCookie(u, admin.refreshToken));
      expect(resp.status, `refresh on ${scope}'s host`).toBe(200);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe(scopeOrigin(scope));
      expect(resp.headers.get('Access-Control-Allow-Credentials')).toBe('true');
      const { access_token } = await resp.json() as { access_token: string };
      const payload = JSON.parse(atob(access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      expect(payload.aud, `aud on ${scope}'s host`).toBe(scope);
    }
  });

  // A page's script can add a body; the refresh never reads one. The sibling would be in reach of a
  // universe admin, which is what makes this fixture able to fail: a refresh that honoured the body
  // would mint for it.
  it('ignores a body naming another scope, and mints for the host', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const resp = await refreshFrom(scopeOrigin(`${u}.app.a`), refreshCookie(u, admin.refreshToken),
      { activeScope: `${u}.app.b` });
    expect(resp.status).toBe(200);
    const { access_token } = await resp.json() as { access_token: string };
    const payload = JSON.parse(atob(access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload.aud).toBe(`${u}.app.a`);
  });
});
