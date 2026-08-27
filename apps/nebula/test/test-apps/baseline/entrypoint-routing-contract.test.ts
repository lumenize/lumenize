/**
 * Entrypoint routing contract — exhaustive + collision-free, on the Phase-3 route
 * table (`createRouter`: /_version · /app/{star}/* · /auth/* · /gateway/*).
 *
 * Drives the REAL Nebula entrypoint via `Browser().fetch` (baseline `index.ts`
 * re-exports `entrypoint as default`). The Worker routes exactly its table and
 * **404s every other path** — `/studio/*` is Workers Assets' in prod by being
 * UNLISTED in `run_worker_first`, so the Worker 404ing it here IS the contract.
 *
 * The `/app/*` leg is end-to-end: the ungated GET forwards to the owning GALAXY
 * (strip `.{s}`), whose serve answers from its own VFS — a seeded `dist/index.html`
 * comes back with the injected `<base href>` + the server-derived `nebula-scope`
 * meta + the caching pin. Capable-of-failing: the positive anchors (auth 200, the
 * served 200) prove the Worker isn't just 404ing everything, so the non-API 404s
 * are a real split.
 */
import { describe, it, expect } from 'vitest';
import { Browser } from '@lumenize/testing';
import type { Galaxy } from '@lumenize/nebula';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import { universeAdminClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ORIGIN = 'http://localhost';

describe('entrypoint routing contract — exhaustive + collision-free', () => {
  // Positive anchor 1: the Worker DOES route an API prefix — so the 404s below are a genuine
  // split, not a dead worker that 404s everything (guards against a vacuous all-404 pass).
  it('an API prefix (/auth/discover) is routed to the auth router, not 404', async () => {
    const res = await new Browser().fetch(`${ORIGIN}/auth/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'routing-contract@example.com' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  // Positive anchor 2 — the /app/* serve, end to end: seed a dist into the Galaxy's VFS
  // through the real mesh write, then fetch the app UNGATED (no Authorization — browsers
  // send none on document loads; that is the design, not an omission).
  it('GET /app/{u}.{g}.dev/ serves the built app from the Galaxy VFS: 200 + <base> + nebula-scope + no-store', async () => {
    const scope = `erc-${crypto.randomUUID().slice(0, 8)}.app`;
    const { client } = await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, 'serve@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION,
      { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
    );
    const html = '<!doctype html><html><head><title>app</title></head><body>BUILT</body></html>';
    await client.lmz.callAsync('GALAXY', scope, client.ctn<Galaxy>().writeSource('dist/index.html', html));
    await client.lmz.callAsync('GALAXY', scope,
      client.ctn<Galaxy>().writeSource('dist/assets/index-AbCdEf12.js', 'console.log(1)'));

    const star = `${scope}.dev`;
    const res = await new Browser().fetch(`${ORIGIN}/app/${star}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('BUILT');
    expect(body).toContain(`<base href="/app/${star}/">`);
    // Server-derived scope meta (never request-supplied): activeScope = the star,
    // authScope = the owning galaxy.
    expect(body).toContain('name="nebula-scope"');
    expect(body).toContain(`"activeScope":"${star}"`);
    expect(body).toContain(`"authScope":"${scope}"`);

    // A hashed asset serves as itself, immutable; a deep link SPA-falls-back to the shell.
    const asset = await new Browser().fetch(`${ORIGIN}/app/${star}/assets/index-AbCdEf12.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    const deep = await new Browser().fetch(`${ORIGIN}/app/${star}/invoices/42`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('BUILT');

    // A NON-`.dev` star has no served tier yet (the published dist-prod/ is deferred).
    const prodStar = await new Browser().fetch(`${ORIGIN}/app/${scope}.tenant/`);
    expect(prodStar.status).toBe(404);

    client[Symbol.dispose]();
  });

  it('/app is GET/HEAD-bounded: POST answers 405 with Allow', async () => {
    const res = await new Browser().fetch(`${ORIGIN}/app/a.b.dev/`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('/_version stays a table row: GET answers the compare shape', async () => {
    const res = await new Browser().fetch(`${ORIGIN}/_version?sha=nope`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ match: false, dirty: true });
  });

  // Collision-free: non-table + mistyped paths must 404 (NOT be served as SPA / assets
  // by the Worker).
  it.each([
    ['/', 'SPA root — Assets/vite-served, never the Worker'],
    ['/studio/acme.crm', 'Studio — Assets-owned by being UNLISTED in run_worker_first'],
    ['/app', 'bare /app — no scope segment names no app'],
    ['/app/acme/', 'a non-star scope segment — only {u}.{g}.{s} names a dist'],
    ['/dev-container/acme.app.dev/', 'the RETIRED preview-proxy prefix — dead since the collapse'],
    ['/totally/unknown/deep-link', 'arbitrary non-API path'],
    ['/gatewayX', 'a MISTYPED API prefix — must not match /gateway nor be served as SPA'],
  ])('%s → 404 (not silently served as SPA)', async (path) => {
    const res = await new Browser().fetch(`${ORIGIN}${path}`);
    expect(res.status).toBe(404);
  });
});
