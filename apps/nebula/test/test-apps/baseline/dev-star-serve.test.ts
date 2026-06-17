/**
 * Studio compile pipeline — P2: serve the running app from `Star.onRequest()`.
 *
 * The static shell GET is **ungated** (no JWT) — the entrypoint's opened
 * direct-DO route passes only GET/HEAD to a Star/DevStar serving target
 * (405 other methods, 404 other bindings) through to `Star.onRequest`, which
 * reads the resident bundle, injects the base href + scope/version, and
 * SPA-falls-back to `index.html` on a miss. Scope injection is server-derived
 * from the serving instance (the wrong-Star footgun choke point).
 *
 * @see tasks/nebula-studio-compile-pipeline.md § Phase 2
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { createAuthenticatedClient, uniqueGalaxyScope } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ORIGIN = 'http://localhost';
const SFC = `<template><div id="todo">{{ title }}</div></template>
<script setup lang="ts">const props = defineProps<{ title: string }>();</script>`;

async function waitForSuccess(client: NebulaClientTest) {
  await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}

/** Compile a `.vue` into the dev Star so a complete servable bundle is resident. */
async function stageDevBundle(galaxy: string, dev: string) {
  const { client } = await createAuthenticatedClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com');
  client.callDevStarCompileSFC(dev, 'App.vue', SFC);
  await waitForSuccess(client);
  client[Symbol.dispose]();
}

describe('Studio compile P2 — serve the app from Star.onRequest()', () => {
  it('serves the shell over HTTP without a JWT, with a strict CSP (no unsafe-eval)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    await stageDevBundle(galaxy, dev);

    // Fresh, UNauthenticated browser — a 200 proves the shell GET is ungated.
    const res = await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('<div id="app">');
    expect(html).toContain(`<base href="/dev-star/${dev}/">`);   // base-href injected
    expect(html).not.toContain('__BASE_HREF__');                 // placeholder gone

    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('unsafe-eval');   // the CSP-soundness guarantee
  });

  it('SPA-falls-back to index.html on a deep link (not 404)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    await stageDevBundle(galaxy, dev);

    const res = await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/items/42`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<div id="app">');
  });

  it('injects activeScope = serving instanceName (3rd segment dev), authScope = galaxy', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    expect(dev.split('.')[2]).toBe('dev');   // fixture sanity
    await stageDevBundle(galaxy, dev);

    const js = await (await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/nebula.js`)).text();
    // Instance-derived (not hardcoded): `dev` is a per-test random name, so an
    // exact match can only come from injecting this.lmz.instanceName.
    expect(js).toContain(`activeScope: "${dev}"`);
    expect(js).toContain(`authScope: "${galaxy}"`);
    expect(js).toContain('appVersion: "dev"');   // no ontology applied yet → 'dev'
    expect(js).not.toContain('__ACTIVE_SCOPE__');
    expect(js).not.toContain('__AUTH_SCOPE__');
    // The guard the choke point enforces: activeScope is the FULL 3-segment dev
    // scope, never the 2-segment authScope. Injecting authScope here would drop
    // the `.dev` slug → the client's #starBinding() silently picks STAR.
    expect(dev).not.toBe(galaxy);
    expect(js).not.toContain(`activeScope: "${galaxy}"`);
  });

  it('stages runtime-only Vue (no template compiler / no new Function)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    await stageDevBundle(galaxy, dev);

    const js = await (await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/vue.js`)).text();
    // Capable-of-failing discriminator: the staged Vue references the runtime-ONLY
    // entry (`vue.runtime.esm-browser`) and NOT the full build (`/vue.esm-browser`,
    // which bundles the template compiler + `new Function`). Swapping to the full
    // build trips BOTH checks below — the CSP no-unsafe-eval guarantee rests on
    // Vue being runtime-only.
    expect(js).toContain('vue.runtime.esm-browser');
    expect(js).not.toContain('/vue.esm-browser');
  });

  it('responds to HEAD with headers and an empty body', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    await stageDevBundle(galaxy, dev);

    const res = await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);   // HEAD is in the gate's allow-set alongside GET
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('');   // onRequest returns a null body for HEAD
  });

  it('rejects a non-GET to a serving binding (405) and a GET to a non-serving binding (404)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    await stageDevBundle(galaxy, dev);

    const post = await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toContain('GET');

    // GALAXY is a real binding but NOT a serving target → 404 (never exposes the
    // raw Galaxy GET surface through the opened gate).
    const galaxyGet = await new Browser().fetch(`${ORIGIN}/galaxy/${galaxy}/`);
    expect(galaxyGet.status).toBe(404);
  });

  it('serves from a PROD Star with its own non-dev scope (base-class serving + injection)', async () => {
    const { galaxy, starA } = uniqueGalaxyScope();
    expect(starA.split('.')[2]).not.toBe('dev');   // a prod tenant slug, not dev

    // Stage the scaffold on the prod Star via the admin (onRequest lives on the
    // base Star, so a prod tenant serves identically — only the scope differs).
    const { client } = await createAuthenticatedClient(NebulaClientTest, new Browser(), galaxy, starA, 'admin@example.com');
    client.callStarStageScaffold(starA);
    await waitForSuccess(client);
    client[Symbol.dispose]();

    const js = await (await new Browser().fetch(`${ORIGIN}/star/${starA}/nebula.js`)).text();
    // The injected scope reflects THIS serving instance — its 3rd segment is the
    // tenant slug, not `dev`, proving onRequest derives the scope from the
    // instance it serves rather than a hardcoded value.
    expect(js).toContain(`activeScope: "${starA}"`);
    expect(js).not.toContain('__ACTIVE_SCOPE__');
  });
});
