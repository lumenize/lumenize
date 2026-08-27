/**
 * Entrypoint routing contract — exhaustive + collision-free.
 *
 * Drives the REAL Nebula entrypoint via `Browser().fetch` (baseline `index.ts` re-exports
 * `entrypoint as default`). The Worker routes the API prefixes (`/auth`, `/gateway`) and
 * **404s every non-API path** — the Studio SPA is served by Workers Assets in prod (vite in
 * dev), never this Worker. This pins the *collision-free* half of the contract: a
 * non-prefixed or mistyped path is NEVER silently served as anything but 404.
 *
 * The former direct-DO route (GET/HEAD `/dev-container/*` to the vite preview proxy) died
 * with the DevContainer node; the built app's `/app/*` serve lands with the Phase-3 route
 * table of tasks/nebula-galaxy-collapse-and-chat.md, which rewrites this contract.
 *
 * Capable-of-failing: the positive anchor (`/auth/discover` answered by the auth router,
 * not 404) proves the Worker isn't just 404ing everything, so the non-API 404s below are a
 * real split. If the entrypoint ever grew a catch-all SPA/asset fallback HERE, the non-API
 * 404 assertions go red.
 */
import { describe, it, expect } from 'vitest';
import { Browser } from '@lumenize/testing';

const ORIGIN = 'http://localhost';

describe('entrypoint routing contract — exhaustive + collision-free', () => {
  // Positive anchor: the Worker DOES route an API prefix — so the 404s below are a genuine split,
  // not a dead worker that 404s everything (guards against a vacuous all-404 pass).
  it('an API prefix (/auth/discover) is routed to the auth router, not 404', async () => {
    const res = await new Browser().fetch(`${ORIGIN}/auth/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'routing-contract@example.com' }),
    });
    // The auth router answers (an empty discovery is 200 with []); a 404 would mean the
    // prefix fell through to the entrypoint's fallback — the split under test.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  // Collision-free: non-API + mistyped paths must 404 (NOT be served as SPA / assets by the Worker).
  it.each([
    ['/', 'SPA root — Assets/vite-served, never the Worker'],
    ['/app', 'the NEBULA_AUTH_REDIRECT landing — SPA-owned; prod Assets-serves it, the Worker 404s'],
    ['/dev-container/acme.app.dev/', 'the RETIRED preview-proxy prefix — dead since the collapse'],
    ['/totally/unknown/deep-link', 'arbitrary non-API path'],
    ['/gatewayX', 'a MISTYPED API prefix — must not match /gateway nor be served as SPA'],
  ])('%s → 404 (not silently served as SPA)', async (path) => {
    const res = await new Browser().fetch(`${ORIGIN}${path}`);
    expect(res.status).toBe(404);
  });
});
