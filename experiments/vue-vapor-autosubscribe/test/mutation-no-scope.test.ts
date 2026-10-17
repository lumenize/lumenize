/**
 * Capable-of-failing witness for autosubscribe.test.ts. Blank out `getCurrentScope()` (what the
 * factory tries FIRST) and check each mode loses — or keeps — auto-subscribe. If Vapor's pass in
 * the main file came from the scope path, it must fail here; VDOM must survive on its
 * `getCurrentInstance().scope` fallback.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@vue/reactivity', async (orig) => ({ ...(await orig<any>()), getCurrentScope: () => null }));

const { createApp, createVaporApp, nextTick } = await import('vue');
const { setupVueStore } = await import('../../../apps/nebula/test/frontend/vue-harness');
const { holder, current } = await import('../src/holder');
// (first render subscribes via the instance fallback in both modes; see the test body)
const SwitchVapor = (await import('../src/SwitchVapor.vue')).default;
const SwitchVdom = (await import('../src/SwitchVdom.vue')).default;

describe('getCurrentScope() blanked', () => {
  for (const [mode, comp, make] of [
    ['vdom', SwitchVdom, createApp],
    ['vapor', SwitchVapor, createVaporApp],
  ] as const) {
    it(`${mode}`, async () => {
      const { store, client } = setupVueStore({ unsubscribeGraceMs: 100 });
      holder.store = store;
      const a = crypto.randomUUID();
      current.value = a;
      const el = document.createElement('div');
      document.body.appendChild(el);
      (make as any)(comp).mount(el);
      await nextTick();
      const first = client.subscribes.filter((s) => s.rid === a).length;
      // First render runs during setup, where getCurrentInstance() still answers in Vapor too.
      expect(first).toBe(1);
      // The Vapor-only limb: a RE-RENDER reading a new id, where getCurrentInstance() is null.
      const b = crypto.randomUUID();
      current.value = b;
      await nextTick();
      const n = client.subscribes.filter((s) => s.rid === b).length;
      console.log(`${mode}: re-render new-id subscribes with getCurrentScope blanked = ${n}`);
      expect(n).toBe(mode === 'vdom' ? 1 : 0);
    });
  }
});
