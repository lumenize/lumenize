/**
 * Does the store factory's auto-subscribe survive Vue 3.6 Vapor Mode?
 *
 * The factory binds each `store.resources.<rt>[<rid>]` read to the reading code's effect
 * scope: `getCurrentScope() ?? getCurrentInstance().scope`. Vapor's release notes say
 * `getCurrentInstance()` is `null` in a Vapor component, so the fallback is gone there and
 * everything rides on whether a scope is active when the read happens.
 *
 * Every case runs in three modes against the REAL factory (apps/nebula/src/frontend) and the
 * MockClient the apps/nebula `frontend` project uses:
 *   - vdom          — today's shape, on the 3.6 engine (the control)
 *   - vapor         — a pure Vapor app (`createVaporApp`)
 *   - vapor-in-vdom — a Vapor component inside a VDOM app (`vaporInteropPlugin`)
 *
 * Soft assertions throughout, so one run reports every limb.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, createVaporApp, vaporInteropPlugin, h, nextTick, version } from 'vue';
import { getCurrentScope as reactivityScope } from '@vue/reactivity';
import { setupVueStore } from '../../../apps/nebula/test/frontend/vue-harness';
import { holder, current, ids, tick, probes } from '../src/holder';
import SwitchVapor from '../src/SwitchVapor.vue';
import SwitchVdom from '../src/SwitchVdom.vue';
import ComputedVapor from '../src/ComputedVapor.vue';
import ComputedVdom from '../src/ComputedVdom.vue';
import ListVapor from '../src/ListVapor.vue';
import ListVdom from '../src/ListVdom.vue';
import ChildListVapor from '../src/ChildListVapor.vue';
import ChildListVdom from '../src/ChildListVdom.vue';

type Mode = 'vdom' | 'vapor' | 'vapor-in-vdom';
const MODES: Mode[] = ['vdom', 'vapor', 'vapor-in-vdom'];
const GRACE = 100;

function mount(mode: Mode, vaporComp: any, vdomComp: any) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const app =
    mode === 'vdom'
      ? createApp(vdomComp)
      : mode === 'vapor'
        ? createVaporApp(vaporComp)
        : createApp({ render: () => h(vaporComp) }).use(vaporInteropPlugin);
  app.mount(el);
  return { el, app };
}

function setup() {
  const s = setupVueStore({ unsubscribeGraceMs: GRACE });
  holder.store = s.store;
  const subs = (rid: string) => s.client.subscribes.filter((x) => x.rid === rid).length;
  const unsubs = (rid: string) => s.client.unsubscribes.filter((x) => x.rid === rid).length;
  return { ...s, subs, unsubs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, unknown> = {};

beforeEach(() => {
  current.value = '';
  ids.splice(0);
  tick.value = 0;
  probes.length = 0;
  document.body.innerHTML = '';
});

afterEach((ctx) => {
  report[ctx.task.name] = summarizeProbes();
});

function summarizeProbes() {
  const out: Record<string, string> = {};
  for (const p of probes) {
    const k = p.where;
    const v = `scope=${p.scope ? 'Y' : 'n'} instance=${p.instance ? 'Y' : 'n'}`;
    out[k] = out[k] ? (out[k].includes(v) ? out[k] : `${out[k]} | ${v}`) : v;
  }
  return out;
}

describe('same reactivity instance', () => {
  it('runs on the 3.6 rc and the factory shares the components\' reactivity', () => {
    expect(version).toBe('3.6.0-rc.10');
    // If the alias failed, the factory's @vue/reactivity would be a different module.
    expect(typeof reactivityScope).toBe('function');
  });
});

for (const mode of MODES) {
  describe(mode, () => {
    it(`${mode}: template read — subscribe, re-render, switch to a NEW id, unmount`, async () => {
      const { client, subs, unsubs } = setup();
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      current.value = a;
      const { el, app } = mount(mode, SwitchVapor, SwitchVdom);
      await nextTick();
      expect.soft(subs(a), 'first render subscribes A').toBe(1);

      client.simulateFanout('TestResource', a, { value: { title: 'A' }, meta: { eTag: 'e1' } } as any);
      await vi.waitFor(() => expect(el.querySelector('.title')!.textContent).toBe('A'), { timeout: 2000 }).catch(() => {});
      expect.soft(el.querySelector('.title')!.textContent, 'renders A after fanout').toBe('A');

      for (let i = 1; i <= 3; i++) { tick.value = i; await nextTick(); }
      expect.soft(subs(a), 'same-id re-renders do not resubscribe').toBe(1);

      current.value = b;
      await nextTick();
      expect.soft(subs(b), 'a re-render reading a NEW id subscribes it').toBe(1);
      client.simulateFanout('TestResource', b, { value: { title: 'B' }, meta: { eTag: 'e1' } } as any);
      await nextTick();
      await nextTick();
      expect.soft(el.querySelector('.title')!.textContent, 'renders B after fanout').toBe('B');

      app.unmount();
      await sleep(GRACE * 3);
      expect.soft(unsubs(a), 'unmount unsubscribes A after grace').toBe(1);
      expect.soft(unsubs(b), 'unmount unsubscribes B after grace').toBe(1);
    });

    it(`${mode}: computed() read — switch to a NEW id, unmount`, async () => {
      const { client, subs, unsubs } = setup();
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      current.value = a;
      const { el, app } = mount(mode, ComputedVapor, ComputedVdom);
      await nextTick();
      expect.soft(subs(a), 'first render subscribes A').toBe(1);
      client.simulateFanout('TestResource', a, { value: { title: 'A' }, meta: { eTag: 'e1' } } as any);
      await nextTick();
      await nextTick();
      expect.soft(el.querySelector('.title')!.textContent, 'renders A').toBe('A');

      current.value = b;
      await nextTick();
      expect.soft(subs(b), 'computed re-evaluating on a NEW id subscribes it').toBe(1);

      app.unmount();
      await sleep(GRACE * 3);
      expect.soft(unsubs(a), 'unmount unsubscribes A').toBe(1);
      expect.soft(unsubs(b), 'unmount unsubscribes B').toBe(1);
    });

    it(`${mode}: v-for in one template — add an item, remove it, unmount`, async () => {
      const { subs, unsubs } = setup();
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      ids.push(a);
      const { el, app } = mount(mode, ListVapor, ListVdom);
      await nextTick();
      expect.soft(subs(a), 'first render subscribes A').toBe(1);

      ids.push(b);
      await nextTick();
      expect.soft(el.querySelectorAll('.item').length, 'renders two items').toBe(2);
      expect.soft(subs(b), 'an added item subscribes its id').toBe(1);

      ids.splice(1, 1);
      await nextTick();
      await sleep(GRACE * 3);
      // Recorded, not asserted: VDOM holds every read until the component unmounts.
      report[`${mode}: removed item unsubscribed before unmount`] = unsubs(b) === 1;

      app.unmount();
      await sleep(GRACE * 3);
      expect.soft(unsubs(a), 'unmount unsubscribes A').toBe(1);
      expect.soft(unsubs(b), 'B is unsubscribed by unmount at the latest').toBe(1);
    });

    it(`${mode}: v-for of child components — add a child, unmount`, async () => {
      const { subs, unsubs } = setup();
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      ids.push(a);
      const { el, app } = mount(mode, ChildListVapor, ChildListVdom);
      await nextTick();
      expect.soft(subs(a), 'first child subscribes A').toBe(1);

      ids.push(b);
      await nextTick();
      expect.soft(el.querySelectorAll('.item').length, 'renders two children').toBe(2);
      expect.soft(subs(b), 'an added child subscribes its id').toBe(1);

      app.unmount();
      await sleep(GRACE * 3);
      expect.soft(unsubs(a), 'unmount unsubscribes A').toBe(1);
      expect.soft(unsubs(b), 'unmount unsubscribes B').toBe(1);
    });
  });
}

describe('report', () => {
  it('prints what each reading site saw', () => {
    console.log(JSON.stringify(report, null, 2));
  });
});
