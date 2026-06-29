/**
 * Entrypoint routing contract — exhaustive + collision-free (Task ①: `nebula-studio-vite-proxy`).
 *
 * Drives the REAL Nebula entrypoint via `Browser().fetch` (baseline `index.ts` re-exports
 * `entrypoint as default`). Under the chosen serving model (A — `vite dev` + proxy), the Worker
 * routes the API prefixes (`/auth`, `/gateway`, GET/HEAD `/dev-container`) and **404s every non-API
 * path** — the Studio SPA is served by vite, never the Worker. This pins the *collision-free* half
 * of the contract: a non-prefixed or mistyped path is NEVER silently served as anything but 404 —
 * the failure mode that would otherwise surface only in prod once the deploy task wires model-B /
 * Workers-Assets and adds a real SPA `index.html` fallback (`/` + `/app` → SPA, owned there).
 *
 * Capable-of-failing: the positive anchor (`/dev-container` → 200) proves the Worker isn't just
 * 404ing everything, so the non-API 404s below are a real split. If the entrypoint ever grew a
 * catch-all SPA/asset fallback HERE (the model-B change belongs in the deploy task, NOT this one),
 * the non-API 404 assertions go red. **Mutation-validated 2026-06-24:** swapping the entrypoint
 * fallthrough `404 → 200 text/html` reds all 4 non-API cases; the positive anchor stays green.
 *
 * The full DEV_CONTAINER gate matrix (HEAD/405/501/WS) lives in `dev-container-serve-gate.test.ts`.
 * @see tasks/nebula-studio-vite-proxy.md — the prefix contract + the Phase-1 spike result (model A).
 */
import { describe, it, expect } from 'vitest';
import { Browser } from '@lumenize/testing';
import { uniqueGalaxyScope } from '../../test-helpers';

const ORIGIN = 'http://localhost';

describe('entrypoint routing contract — exhaustive + collision-free (model A)', () => {
  // Positive anchor: the Worker DOES route an API prefix — so the 404s below are a genuine split,
  // not a dead worker that 404s everything (guards against a vacuous all-404 pass).
  it('an API prefix (/dev-container) is routed to the DO, not 404', async () => {
    const { dev } = uniqueGalaxyScope();
    const res = await new Browser().fetch(`${ORIGIN}/dev-container/${dev}/`);
    expect(res.status).toBe(200);
    // Assert the stub body (not just 200) so the anchor is self-sufficient: a 200 here means
    // the request genuinely reached the DEV_CONTAINER DO, not some unrelated 200.
    expect(await res.text()).toContain('DEV_CONTAINER_STUB');
  });

  // Collision-free: non-API + mistyped paths must 404 (NOT be served as SPA / assets by the Worker).
  it.each([
    ['/', 'SPA root — vite-served in dev, never the Worker'],
    ['/app', 'the NEBULA_AUTH_REDIRECT landing — SPA-owned; prod (model B) Assets-serves it, dev Worker 404s'],
    ['/totally/unknown/deep-link', 'arbitrary non-API path'],
    ['/gatewayX', 'a MISTYPED API prefix — must not match /gateway nor be served as SPA'],
  ])('%s → 404 (not silently served as SPA)', async (path) => {
    const res = await new Browser().fetch(`${ORIGIN}${path}`);
    expect(res.status).toBe(404);
  });
});
