/**
 * Entrypoint routing contract — exhaustive + collision-free, on the host model.
 *
 * The Worker takes three steps: the platform host's own routes (`/` and `/auth/*`, through the
 * platform-host binding); the routes every host answers by path (`/_version`, `/pictures`,
 * `/gateway/*`, and `/auth` refused); then the page a host names. Drives the REAL Nebula entrypoint
 * via `Browser().fetch`, which reaches the Worker through `SELF.fetch` whatever the host (baseline
 * `index.ts` re-exports `entrypoint as default`).
 *
 * The dev Star's leg is end-to-end: a page load on its host forwards to the owning GALAXY on the
 * page track, whose serve answers from its own VFS — a seeded `dist/index.html` comes back with the
 * server-derived `nebula-scope` meta, the deployment's origin and the caching pin, framed by the
 * galaxy's Studio alone. Capable-of-failing: the positive anchors (the auth route's own 400, the
 * served 200) prove the Worker isn't just 404ing everything, so the 404s below are a real split.
 *
 * This lane binds no assets, so a page the assets layer would serve (Studio, the auth app's
 * entries) answers 404 here; what the Worker itself decides is what this file asserts.
 */
import { describe, it, expect } from 'vitest';
import { Browser } from '@lumenize/testing';
import type { Galaxy } from '@lumenize/nebula';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import { universeAdminClient, ORIGIN, pageOf } from '../../test-helpers';
import { NebulaClientTest } from './index';

describe('entrypoint routing contract — exhaustive + collision-free', () => {
  // Positive anchor 1: the platform host DOES route an API path — so the 404s below are a genuine
  // split, not a dead worker that 404s everything (guards against a vacuous all-404 pass).
  it('/auth/* answers on the platform host alone', async () => {
    // ⚠️ A deliberately INVALID slug: this anchor only needs to prove the path reached the auth
    // router rather than falling through to a 404, and every open row that SUCCEEDS mints a scope or
    // sends mail. A 400 from the router's own grammar proves routing exactly as well as a 200 would,
    // and leaves nothing behind.
    const claim = (host: string) => new Browser().fetch(`${host}/auth/claim-universe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'Not A Valid Slug', appSlug: 'first', email: 'routing-contract@example.com' }),
    });
    const res = await claim(ORIGIN);
    expect(res.status).toBe(400);
    // The 404 this anchors against carries no JSON error body — so the SHAPE is what distinguishes
    // "routed and refused" from "never routed at all".
    expect((await res.json() as { error?: string }).error).toBeDefined();
    // The same request on a scope's host is the Worker's own 404, never the claim.
    expect((await claim(pageOf('acme.crm'))).status).toBe(404);
  });

  // Positive anchor 2 — the dev Star's page, end to end: seed a dist into the Galaxy's VFS through
  // the real mesh write, then load the page UNGATED (no Authorization — browsers send none on
  // document loads; that is the design, not an omission).
  it("a page load on the dev Star's host serves the built app from the Galaxy VFS", async () => {
    const scope = `erc-${crypto.randomUUID().slice(0, 8)}.app`;
    const { client } = await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, 'serve@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION,
      { resourceHostBinding: 'GALAXY' },
    );
    const html = '<!doctype html><html><head><title>app</title></head><body>BUILT</body></html>';
    await client.lmz.callAsync('GALAXY', scope, client.ctn<Galaxy>().writeSource('dist/index.html', html));
    await client.lmz.callAsync('GALAXY', scope,
      client.ctn<Galaxy>().writeSource('dist/assets/index-AbCdEf12.js', 'console.log(1)'));

    const star = pageOf(`${scope}.dev`);
    const res = await new Browser().fetch(`${star}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Security-Policy')).toBe(`frame-ancestors ${pageOf(scope)}`);
    const body = await res.text();
    expect(body).toContain('BUILT');
    // Server-derived page meta (never request-supplied): the dev Star, framed by its galaxy's Studio.
    expect(body).toContain('name="nebula-scope"');
    expect(body).toContain('"dev":true');
    expect(body).toContain(`"parentOrigin":"${pageOf(scope)}"`);
    expect(body).toContain('name="lumenize-origin"');

    // A hashed asset serves as itself, immutable; a deep link SPA-falls-back to the shell.
    const asset = await new Browser().fetch(`${star}/assets/index-AbCdEf12.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    const deep = await new Browser().fetch(`${star}/invoices/42`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('BUILT');

    // A NON-`.dev` star has no served tier yet (the published dist-prod/ is deferred).
    const prodStar = await new Browser().fetch(`${pageOf(`${scope}.tenant`)}/`);
    expect(prodStar.status).toBe(404);

    client[Symbol.dispose]();
  });

  it("a Star's page is GET/HEAD-bounded: POST answers 405 with Allow", async () => {
    const res = await new Browser().fetch(`${pageOf('a.b.dev')}/`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('/_version stays a table row on every host: GET answers the compare shape', async () => {
    for (const host of [ORIGIN, pageOf('acme.crm')]) {
      const res = await new Browser().fetch(`${host}/_version?sha=nope`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ match: false, dirty: true });
    }
  });

  // Collision-free: paths no step claims must 404 (NOT be served as a page by the Worker).
  it.each([
    [`${ORIGIN}/totally/unknown/deep-link`, 'an arbitrary path on the platform host — no page the Worker serves'],
    [`${ORIGIN}/app/acme.app.dev/`, 'the RETIRED /app prefix — dead since pages moved to their hosts'],
    [`${pageOf('acme.crm')}/auth/login`, "an auth page on a scope's host — the auth app lives on the platform host"],
    [`${pageOf('acme.crm')}/gatewayX`, 'a MISTYPED API prefix — must not match /gateway nor be served as a page'],
    ['http://a.b.c.d.lumenize.localhost/', 'a host four labels deep — the parse names no scope'],
  ])('%s → 404 (%s)', async (url) => {
    const res = await new Browser().fetch(url);
    expect(res.status).toBe(404);
  });
});
