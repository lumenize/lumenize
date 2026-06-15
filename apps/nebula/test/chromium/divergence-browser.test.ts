/**
 * Real-browser divergence probes (§5.3.7-v4) — behaviors jsdom can't fake:
 * real focus/blur, real IME composition events, real debounce timers, real
 * Vue <KeepAlive> activate/deactivate lifecycle.
 *
 * MockClient-backed (the Q1–Q5 `vue-harness`): no magic-link bootstrap, so these
 * stay fast + split per behavior (the consolidate-into-one-narrative rule is for
 * the slow real-Star/magic-link e2e, not these). The MockClient runs the REAL
 * debounce queue + conflict-outcome engine, so transaction submissions
 * (`client.txns`) and optimistic store writes are the real factory↔engine flow.
 */
import { describe, it, expect, vi } from 'vitest';
import { setupVueStore, loadVue } from '../frontend/vue-harness';

const RT = 'TestResource';
function seeded(rid: string, title = 'original') {
  return { resources: { [RT]: { [rid]: { value: { title, status: 'todo' }, meta: { eTag: 'initial-eTag' } } } } };
}
const txnsFor = (client: { txns: Array<{ rt: string; rid: string }> }, rid: string) =>
  client.txns.filter((t) => t.rt === RT && t.rid === rid);

describe('v4 divergence — debounce flush-on-blur', () => {
  it('blurring a v-model input flushes its pending debounced write before the quiet window', async () => {
    const rid = crypto.randomUUID();
    // Long quiet AND long maxWait so NEITHER timer can flush within the assertion
    // window — blur must be the only thing that flushes (a clean, non-racy
    // capable-of-failing margin: disabling the focusout wiring leaves the write
    // un-submitted for 10s, well past the 2s waitFor).
    const { store, client } = setupVueStore({ initialState: seeded(rid), quietMs: 10_000, maxWaitMs: 10_000 });
    client.simulateConnectionState('connected');

    const Vue = await loadVue();
    document.body.innerHTML = `
      <div id="app">
        <template v-if="store.resources.${RT}['${rid}']?.value">
          <input id="inp" v-model="store.resources.${RT}['${rid}'].value.title" />
        </template>
      </div>`;
    const app = Vue.createApp({ setup: () => ({ store }) });
    app.mount('#app');
    await vi.waitFor(() => expect(document.getElementById('inp')).toBeTruthy());

    const input = document.getElementById('inp') as HTMLInputElement;
    input.focus();
    input.value = 'edited';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Optimistic paint landed, but nothing submitted yet (quiet window is 10s).
    await vi.waitFor(() => expect(store.resources[RT][rid].value.title).toBe('edited'));
    expect(txnsFor(client, rid)).toHaveLength(0);

    // Blur → focusout → factory flushes THIS resource immediately.
    input.blur();
    await vi.waitFor(() => expect(txnsFor(client, rid)).toHaveLength(1), { timeout: 2000 });
    // Capable-of-failing: without the focusout→flush wiring, txns stays 0 until 10s.

    app.unmount();
  });
});

describe('v4 divergence — debounce maxWait', () => {
  it('a pending write flushes at maxWait even when the quiet window is far longer', async () => {
    const rid = crypto.randomUUID();
    // quiet 10s, maxWait 200ms → the write must flush via maxWait, not quiet.
    const { store, client } = setupVueStore({ initialState: seeded(rid), quietMs: 10_000, maxWaitMs: 200 });
    client.simulateConnectionState('connected');

    const Vue = await loadVue();
    document.body.innerHTML = `
      <div id="app">
        <template v-if="store.resources.${RT}['${rid}']?.value">
          <input id="inp" v-model="store.resources.${RT}['${rid}'].value.title" />
        </template>
      </div>`;
    const app = Vue.createApp({ setup: () => ({ store }) });
    app.mount('#app');
    await vi.waitFor(() => expect(document.getElementById('inp')).toBeTruthy());

    const input = document.getElementById('inp') as HTMLInputElement;
    input.value = 'maxwait-edit';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Flushes within maxWait (200ms), well before the 10s quiet window.
    await vi.waitFor(() => expect(txnsFor(client, rid)).toHaveLength(1), { timeout: 3000 });
    // Capable-of-failing: without maxWait, the write waits 10s and this times out.

    app.unmount();
  });
});

describe('v4 divergence — IME composition', () => {
  it('a multi-key composition updates the model once (on compositionend), not per intermediate input', async () => {
    const rid = crypto.randomUUID();
    const { store, client } = setupVueStore({ initialState: seeded(rid), quietMs: 0 });
    client.simulateConnectionState('connected');

    const Vue = await loadVue();
    document.body.innerHTML = `
      <div id="app">
        <template v-if="store.resources.${RT}['${rid}']?.value">
          <input id="inp" v-model="store.resources.${RT}['${rid}'].value.title" />
        </template>
      </div>`;
    const app = Vue.createApp({ setup: () => ({ store }) });
    app.mount('#app');
    await vi.waitFor(() => expect(document.getElementById('inp')).toBeTruthy());

    const input = document.getElementById('inp') as HTMLInputElement;
    input.focus();

    // Begin IME composition (e.g. romaji → kana). Vue's v-model suppresses the
    // model update while composing; intermediate `input` events must NOT reach
    // the store.
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'に';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    input.value = 'にほ';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));

    // During composition the store is unchanged — the load-bearing divergence
    // (real browser only; jsdom doesn't model `composing`).
    expect(store.resources[RT][rid].value.title).toBe('original');

    // Composition ends → Vue commits the final value once.
    input.value = 'にほん';
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'にほん' }));

    await vi.waitFor(() => expect(store.resources[RT][rid].value.title).toBe('にほん'));
    // Exactly one transaction — one model commit on compositionend, not one per keystroke.
    expect(txnsFor(client, rid)).toHaveLength(1);

    app.unmount();
  });
});

describe('v4 divergence — <KeepAlive> activate/deactivate', () => {
  it('a KeepAlive-cached component stays subscribed across deactivate→activate (no unsub/resub)', async () => {
    const rid = crypto.randomUUID();
    const { store, client } = setupVueStore({ initialState: seeded(rid), unsubscribeGraceMs: 100 });
    client.simulateConnectionState('connected');

    const Vue = await loadVue();
    const { createApp, ref, nextTick } = Vue;

    // <KeepAlive> caches the child's component instance + its effectScope across
    // deactivation, so the resource read stays tracked — the factory should NOT
    // unsubscribe on deactivate nor re-subscribe on re-activate.
    document.body.innerHTML = `
      <div id="app">
        <keep-alive>
          <viewer v-if="shown" />
        </keep-alive>
      </div>`;
    const shown = ref(true);
    const app = createApp({ setup: () => ({ shown }) });
    app.component('viewer', {
      template: `<span id="t">{{ store.resources.${RT}['${rid}']?.value?.title ?? '?' }}</span>`,
      setup: () => ({ store }),
    });
    app.mount('#app');

    await vi.waitFor(() => {
      expect(client.subscribes.filter((s) => s.rid === rid)).toHaveLength(1);
    });
    expect(client.unsubscribes.filter((s) => s.rid === rid)).toHaveLength(0);

    // Deactivate (KeepAlive caches it — does NOT unmount).
    shown.value = false;
    await nextTick();
    // Re-activate.
    shown.value = true;
    await nextTick();

    // Give any (incorrect) grace-period unsubscribe a chance to fire.
    await vi.waitFor(() => expect(document.getElementById('t')?.textContent).toBe('original'));
    expect(client.subscribes.filter((s) => s.rid === rid)).toHaveLength(1); // still exactly one
    expect(client.unsubscribes.filter((s) => s.rid === rid)).toHaveLength(0); // never unsubscribed

    app.unmount();
  });
});
