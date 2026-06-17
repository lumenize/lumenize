/**
 * Self-hosted platform assets — the Phase-1 headline check, in REAL chromium.
 *
 * A fixture SFC (DaisyUI `btn` class + `import House from
 * 'lucide-vue-next/icons/house'` + a `ref`) is compiled inside a real
 * wrangler-dev DevStar (`DevStar.compileSFC`, via the factory's admin session)
 * and served by `Star.onRequest`. The preview is loaded in a **same-origin
 * iframe** through the existing vite proxy, and we assert the app actually RUNS
 * the way the secure-by-default story promises:
 *
 *   - it **mounts** (Vue runtime-only + precompiled render, no `new Function`),
 *   - with **no CSP violation** (everything resolves same-origin; the bare
 *     `vue` / `lucide-vue-next/icons/house` specifiers were rewritten at the
 *     DevStar write boundary to `./vue.js` / `./vendor/lucide/house.js`),
 *   - **granularly** — only `house.js` + the shared `_core.js` cross the wire,
 *     no other `vendor/lucide/*`, and nothing from an external origin,
 *   - and **DaisyUI applies** (the `.btn` rule from the self-hosted stylesheet).
 *
 * @see tasks/nebula-self-hosted-assets.md § Phase 1
 */
import { describe, it, expect, vi } from 'vitest';
import { bootstrapFactory, proxyBaseUrl } from './factory-harness';

/** A `{u}.{g}.dev` sandbox scope (3rd segment `dev` → DEV_STAR binding). */
function uniqueDevScope(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app.dev`;
}

// The kind of SFC Studio's model emits: a DaisyUI component class, a granular
// Lucide icon import, and local reactive state. `house` (lucide v1 renamed
// `home`→`house`); the import is rewritten to `./vendor/lucide/house.js`.
const FIXTURE_SFC = `<template>
  <div class="wrap">
    <button class="btn" data-test="btn" @click="count++">Count {{ count }}</button>
    <House data-test="icon" />
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import House from 'lucide-vue-next/icons/house';
const count = ref<number>(0);
</script>`;

describe('self-hosted platform assets (real chromium)', () => {
  it('compiles, serves, and mounts a DaisyUI+Lucide SFC same-origin with no CSP violation', async () => {
    const dev = uniqueDevScope();
    const baseUrl = proxyBaseUrl();
    const { client, ready, dispose } = await bootstrapFactory({}, dev);
    const iframe = document.createElement('iframe');

    try {
      await ready;

      // Compile the fixture inside the dev Star (admin-gated DevStar.compileSFC).
      // Fire-and-forget; the served bytes are the observable signal.
      client.lmz.call('DEV_STAR', dev, (client.ctn() as any).compileSFC('App.vue', FIXTURE_SFC));

      // Poll the ungated static GET until the compiled component is resident — a
      // capable-of-failing gate (a rewrite/compile error persists nothing → 404
      // forever → timeout). The render fn proves it's the compiled module.
      await vi.waitFor(async () => {
        const r = await fetch(`${baseUrl}/dev-star/${dev}/App.js`);
        expect(r.status).toBe(200);
        const js = await r.text();
        expect(js).toContain('createElementBlock');     // compiled <template>
        expect(js).toContain('./vendor/lucide/house.js'); // rewritten lucide import
      }, { timeout: 20000 });

      // Load the served preview in a same-origin iframe and capture any CSP
      // violation it reports. The iframe uses the path-PRESERVING `/dev-star`
      // proxy (not the `/worker`-stripping one) so the document URL matches the
      // worker-injected `<base href="/dev-star/{dev}/">` — its relative asset
      // URLs (`./main.js`, `./vendor/lucide/house.js`) then resolve back through
      // the same proxy. (The compile/poll above use the `/worker` baseUrl for the
      // authed WS + admin call; the ungated static preview needs neither.)
      const violations: string[] = [];
      iframe.src = `${location.origin}/dev-star/${dev}/`;
      document.body.appendChild(iframe);
      await new Promise<void>((res) => iframe.addEventListener('load', () => res(), { once: true }));
      const win = iframe.contentWindow!;
      const doc = iframe.contentDocument!;
      win.addEventListener('securitypolicyviolation', (e) => {
        violations.push(`${e.violatedDirective} ${e.blockedURI}`);
      });

      // It MOUNTS: the button (with reactive `count`) + the Lucide-rendered
      // <svg> appear — proving every static import (vue.js → vendor/vue.js,
      // App.js, vendor/lucide/house.js → _core.js) resolved same-origin under the
      // CSP (a blocked module would never mount), the precompiled render ran on
      // runtime-only Vue, and the SFC's setup bindings + icon component resolved.
      let btn!: HTMLElement;
      await vi.waitFor(() => {
        btn = doc.querySelector('[data-test="btn"]') as HTMLElement;
        expect(btn).toBeTruthy();
        expect(btn.textContent).toContain('Count 0');             // reactive ref rendered
        expect(doc.querySelector('svg[data-test="icon"]')).toBeTruthy(); // Lucide icon rendered
      }, { timeout: 15000 });

      // DaisyUI applies: `.btn` sets `cursor: pointer` (a bare <button> computes
      // `default`/`auto`) — proves the self-hosted stylesheet loaded + parsed.
      expect(win.getComputedStyle(btn).cursor).toBe('pointer');

      // Reactive runtime works (runtime-only Vue, precompiled render) — and the
      // click exercises a code path that would trip a CSP violation if any.
      btn.click();
      await vi.waitFor(() => expect(btn.textContent).toContain('Count 1'));

      // Granular over the wire: only `house.js` + the shared `_core.js` of all
      // ~1700 vendored icons were fetched; nothing else under vendor/lucide.
      const resources = (win.performance.getEntriesByType('resource') as PerformanceResourceTiming[])
        .map((e) => e.name);
      const lucide = resources.filter((n) => n.includes('/vendor/lucide/'));
      expect(lucide.some((n) => n.endsWith('/house.js'))).toBe(true);
      expect(lucide.some((n) => n.endsWith('/_core.js'))).toBe(true);
      expect(lucide.filter((n) => !n.endsWith('/house.js') && !n.endsWith('/_core.js'))).toEqual([]);

      // Self-hosted: nothing loaded from an external origin (no CDN).
      expect(resources.filter((n) => !n.startsWith(location.origin))).toEqual([]);

      // No CSP violation surfaced (mount already proves the initial load; this
      // catches any runtime violation from the interaction above).
      expect(violations).toEqual([]);
    } finally {
      iframe.remove();
      await dispose();
    }
  });
});
