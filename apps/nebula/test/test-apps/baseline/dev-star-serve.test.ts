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
    expect(csp).toContain("script-src 'self'");
    // Strict script-src: no unsafe-eval (runtime-only Vue), no external/CDN
    // origin (everything self-hosted), and the shell carries no inline import map
    // (a strict script-src would block one without a nonce anyway).
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('https://');
    expect(html).not.toContain('importmap');
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

  it('serves Vue same-origin (runtime-only, no CDN, no new Function)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    await stageDevBundle(galaxy, dev);

    // The staged `vue.js` is a thin re-export of the self-hosted same-origin Vue
    // — no CDN host (the secure-by-default win: lets script-src drop to 'self').
    const shim = await (await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/vue.js`)).text();
    expect(shim).toContain('./vendor/vue.js');
    expect(shim).not.toContain('jsdelivr');
    expect(shim).not.toContain('http');

    // The backing runtime is served same-origin from code (platform asset). It is
    // the runtime-ONLY build: capable-of-failing discriminator — the FULL build
    // (`vue.esm-browser.prod.js`) carries exactly one `Function(` (the template
    // compiler's render-fn constructor → the `unsafe-eval` path); the runtime-only
    // build has zero. The CSP no-unsafe-eval guarantee rests on this.
    const runtime = await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/vendor/vue.js`);
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get('content-type')).toContain('text/javascript');
    const runtimeJs = await runtime.text();
    expect(runtimeJs.length).toBeGreaterThan(50_000);   // the real ~108 KB runtime, not a stub
    expect(runtimeJs).not.toContain('Function(');
  });

  it('serves self-hosted DaisyUI CSS + the imported Lucide icon same-origin', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    await stageDevBundle(galaxy, dev);

    // DaisyUI precompiled CSS — linked from the shell, served from code as text/css.
    const css = await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/daisyui.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('.btn');

    // A real Lucide icon resolves; an unknown icon does NOT (per-icon serving from
    // the vendored map — only what the app imports crosses the wire). The icon is
    // a tiny data module importing the SHARED `./_core.js` (no duplicated runtime).
    const house = await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/vendor/lucide/house.js`);
    expect(house.status).toBe(200);
    expect(house.headers.get('content-type')).toContain('text/javascript');
    const houseJs = await house.text();
    expect(houseJs).toContain("from './_core.js'");
    expect(houseJs).not.toContain('createLucideIcon.js');   // upstream import repointed
    expect(houseJs.length).toBeLessThan(2000);              // data-only, runtime not inlined

    // The shared core resolves Vue from the same-origin runtime, never bare `vue`.
    const core = await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/vendor/lucide/_core.js`);
    expect(core.status).toBe(200);
    expect(await core.text()).toContain('../../vue.js');

    // An unknown icon is not in the vendored map → SPA fallback (no such asset),
    // never a JS module — proves serving is map-backed, not a passthrough.
    const missing = await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/vendor/lucide/not-a-real-icon.js`);
    expect(missing.headers.get('content-type')).toContain('text/html');
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
