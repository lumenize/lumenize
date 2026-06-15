/**
 * Shared harness for the Vue probes (Q1–Q5) in the jsdom `frontend` project.
 *
 * Self-contained: no wrangler-dev, no real Star. The MockClient runs the real
 * conflict-outcome engine over a recording transport; resource snapshots are
 * seeded via `initialState` or delivered via `client.simulateFanout(...)`. This
 * proves the Vue ↔ factory reactivity wiring (auto-subscribe, v-model,
 * connection surfacing). The full v-model → real-Star round-trip is a §5.3.8
 * e2e probe (P10); the real-browser variants are §5.3.7-v4.
 */
import { createNebulaStore } from '../../src/frontend/create-nebula-client';
import { MockClient } from './mock-client';

/**
 * Load Vue from the compiler-included bundler-flavored ESM build. The default
 * `vue` entry resolves to the runtime-only build (no template compiler), which
 * can't compile in-DOM template strings. The `-bundler` build re-exports from
 * the same `@vue/runtime-dom`/`@vue/runtime-core`/`@vue/reactivity` singletons
 * the factory imports, so Vue render effects, `getCurrentInstance()`, and the
 * factory's reactive store share reactivity state. Cached.
 */
let vueLoaded: any = null;
// Return type is `any`: the `-bundler` dist path has no bundled .d.ts, and the
// runtime surface matches `vue`'s public API (createApp, ref, reactive, …).
export async function loadVue(): Promise<any> {
  if (vueLoaded) return vueLoaded;
  // @ts-ignore — bundler-build dist path is not a typed module specifier.
  vueLoaded = await import('vue/dist/vue.esm-bundler.js');
  return vueLoaded;
}

export function setupVueStore(opts: {
  initialState?: Record<string, any>;
  unsubscribeGraceMs?: number;
  quietMs?: number;
} = {}) {
  const client = new MockClient({ quietMs: opts.quietMs ?? 0 });
  const factory = createNebulaStore(client, {
    initialState: opts.initialState,
    unsubscribeGraceMs: opts.unsubscribeGraceMs ?? 100,
  });
  return { client, factory, store: factory.store };
}
