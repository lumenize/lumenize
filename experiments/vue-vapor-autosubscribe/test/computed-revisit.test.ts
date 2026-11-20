/**
 * Runs under BOTH configs: vitest.config.js (3.6 rc) and vitest.config.35.js (the repo's 3.5).
 *
 * A computed() that switches to an id the store has ALREADY vivified (read before, by code
 * whose scope has since gone) — does the switch subscribe? For a never-seen id the read's
 * own vivification write re-dirties the computed and the re-run lands inside the render; an
 * already-vivified id has no such write.
 */
import { describe, it, expect } from 'vitest';
import { createApp, nextTick, version, effectScope } from 'vue';
import { setupVueStore } from '../../../apps/nebula/test/frontend/vue-harness';
import { holder, current, probes } from '../src/holder';
import ComputedVdom from '../src/ComputedVdom.vue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(`computed() revisiting a known id (vue ${version})`, () => {
  for (const how of ['vivified outside any scope', 'read and released by an earlier scope'] as const) {
    it(`computed switching to an id ${how} subscribes it`, async () => {
      const { store, client } = setupVueStore({ unsubscribeGraceMs: 50 });
      holder.store = store;
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      if (how === 'vivified outside any scope') {
        void store.resources.TestResource[b];
      } else {
        const scope = effectScope();
        scope.run(() => void store.resources.TestResource[b]);
        scope.stop();
        await sleep(150); // past grace: B is unsubscribed but stays vivified
      }
      const before = client.subscribes.filter((s) => s.rid === b).length;
      current.value = a;
      probes.length = 0;
      const el = document.createElement('div');
      document.body.appendChild(el);
      const app = createApp(ComputedVdom);
      app.mount(el);
      await nextTick();
      current.value = b;
      await nextTick();
      await nextTick();
      const after = client.subscribes.filter((s) => s.rid === b).length;
      console.log(`[vue ${version}] ${how}: subscribes for B before=${before} after switch=${after - before}; probes=${JSON.stringify(probes.map((p) => [p.where.slice(9, 13) === b.slice(0, 4) ? 'B' : 'A', p.scope, p.instance]))}`);
      expect(after - before).toBe(1);
      app.unmount();
    });
  }
});
