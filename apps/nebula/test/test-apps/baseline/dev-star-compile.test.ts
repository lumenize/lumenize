/**
 * Studio compile pipeline — P1: compile a `.vue` SFC **inside the DevStar DO**.
 *
 * The exploratory part of #1a: a bare `import { transpileModule } from
 * 'typescript'` crashes the workerd isolate, so tsc is consumed from a
 * pre-bundled, Node-builtin-shimmed vendor bundle (`vendor/tsc-transpile.bundle.mjs`,
 * built by `scripts/bundle-tsc.mjs`). This suite proves the bundle actually
 * TRANSPILES inside the DO — not just loads: the emitted JS has the residual TS
 * (`interface`, `ref<T>`, `defineProps<…>`) the Vue compiler leaves behind
 * STRIPPED, which only `transpileModule` does (the spike's mutation-checked
 * bar). The "import the module + call an export" bar runs in node/jsdom
 * (`test/frontend/compile-module.test.ts`) since workerd can't `import()` a
 * module string.
 *
 * @see tasks/nebula-studio-compile-pipeline.md § Phase 1
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { createAuthenticatedClient, uniqueGalaxyScope } from '../../test-helpers';
import { NebulaClientTest } from './index';

// A todo SFC of the kind Studio's model generates: lang="ts", an interface, a
// typed defineProps macro, and `ref<T>()` type-args — the residual TS that
// `@vue/compiler-sfc` alone leaves behind (the transpile step removes it).
const TODO_SFC_TS = `<template>
  <div :class="{ done: completed }">
    <h2>{{ store.resources.todo[id]?.value?.title ?? 'Loading...' }}</h2>
    <input v-model="store.resources.todo[id].value.title" />
    <ul v-if="store.resources.todo[id]?.value?.items?.length">
      <li v-for="item in store.resources.todo[id].value.items" :key="item.id">
        {{ item.label }}
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

interface TodoItem {
  id: string;
  label: string;
  done: boolean;
}

const props = defineProps<{
  id: string;
  store: unknown;
  items: TodoItem[];
}>();

const completed = ref<boolean>(false);
const count = ref<number>(props.items.length);
</script>

<style scoped>
.done { text-decoration: line-through; }
</style>`;

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
}
async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}
async function devAdminClient(galaxy: string, dev: string) {
  return createAuthenticatedClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com');
}

describe('Studio compile P1 — compile a .vue SFC inside the DevStar DO', () => {
  it('transpiles lang="ts" SFC to a runnable ESM persisted in the bundle (tsc runs in-DO)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    client.callDevStarCompileSFC(dev, 'App.vue', TODO_SFC_TS);
    const result = await waitForSuccess(client) as { path: string; errors: string[] };
    expect(result.errors).toEqual([]);
    expect(result.path).toBe('App.js');   // .vue → .js served path

    // The persisted module is the assembled, runnable ESM (the spike's
    // assembly bar), stored under the documented key/shape via sync storage.
    client.callDevStarInspectBundleAsset(dev, 'App.js');
    const asset = await waitForSuccess(client) as { content: string; contentType: string } | undefined;
    expect(asset).toBeDefined();
    expect(asset!.contentType).toContain('text/javascript');
    expect(asset!.content).toContain('const __sfc_main =');
    expect(asset!.content).toContain('function render');
    expect(asset!.content).toContain('__sfc_main.render = render;');
    expect(asset!.content).toContain('export default __sfc_main;');

    // Capable-of-failing: the macro-resolved script STILL contains these (the
    // spike's kill-criterion proved it); only `transpileModule` strips them, so
    // their absence proves tsc actually executed inside the DO. Removing the
    // transpile step reintroduces them (mutation-checked).
    expect(asset!.content).not.toContain('interface TodoItem');
    expect(asset!.content).not.toContain('ref<boolean>');
    expect(asset!.content).not.toContain('ref<number>');
    expect(asset!.content).not.toContain('defineProps<');

    // The DevStar write-boundary specifier rewrite ran: the bare `vue` import the
    // SFC carries (`import { ref } from 'vue'`) resolves to the same-origin
    // `./vue.js`, never bare (which would 404 under script-src 'self'). Removing
    // the rewrite leaves `from 'vue'` and trips the second assertion.
    expect(asset!.content).toContain("from './vue.js'");
    expect(asset!.content).not.toMatch(/from\s*['"]vue['"]/);

    client[Symbol.dispose]();
  });

  it('rejects an SFC importing a non-self-hosted package (rewrite is a compile error)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    // `lodash` is USED (so compileScript's binding analysis keeps the import —
    // an unused import is tree-shaken and never reaches the browser). Only `vue`
    // + `lucide-vue-next/icons/*` are self-hosted; any other bare import is a
    // compile error fed to Studio's iterate-on-errors loop.
    const sfc = `<template><div>{{ y }}</div></template>
<script setup lang="ts">import _ from 'lodash'; const y = _.identity(1);</script>`;
    client.callDevStarCompileSFC(dev, 'Bad.vue', sfc);
    const result = await waitForSuccess(client) as { path: string; errors: string[] };
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("Unsupported bare import 'lodash'");
    expect(result.path).toBe('Bad.vue');   // unchanged — nothing persisted

    // Capable-of-failing: the rejected compile must NOT write the component asset.
    client.callDevStarInspectBundleAsset(dev, 'Bad.js');
    expect(await waitForSuccess(client)).toBeUndefined();

    client[Symbol.dispose]();
  });

  it('stages the fixed scaffold + runtime-only Vue alongside the compiled component', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    client.callDevStarCompileSFC(dev, 'App.vue', TODO_SFC_TS);
    await waitForSuccess(client);

    client.callDevStarListBundlePaths(dev);
    const paths = await waitForSuccess(client) as string[];
    // A complete servable bundle is resident: scaffold shell + runtime Vue + the
    // compiled component.
    expect(paths).toEqual(expect.arrayContaining(['index.html', 'main.js', 'nebula.js', 'vue.js', 'App.js']));

    client[Symbol.dispose]();
  });

  it('returns errors and persists nothing on a malformed SFC', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    client.callDevStarCompileSFC(dev, 'Bad.vue', '<template>{{ unclosed');
    const result = await waitForSuccess(client) as { path: string; errors: string[] };
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.path).toBe('Bad.vue');   // unchanged — not the .js served path

    // Capable-of-failing: a failed compile must NOT write the component asset.
    client.callDevStarInspectBundleAsset(dev, 'Bad.js');
    const asset = await waitForSuccess(client);
    expect(asset).toBeUndefined();

    client[Symbol.dispose]();
  });
});
