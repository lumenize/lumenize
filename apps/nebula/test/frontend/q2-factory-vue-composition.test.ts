/**
 * Q2 — Factory store + Vue component composition.
 *
 * Vue's reactivity tracks reads through the factory's outer Proxy, and writes
 * via the outer Proxy (connection observer, user, fanout) trigger Vue
 * re-renders. Ported to the mock client: connection state is driven directly
 * via `client.simulateConnectionState(...)` (no real Star needed).
 */
import { describe, it, expect } from 'vitest';
import { setupVueStore, loadVue } from './vue-harness';

describe('Q2 — Factory + Vue composition', () => {
  it('Vue component re-renders when connection state changes (observer-driven write)', async () => {
    const { store, client } = setupVueStore();
    const Vue = await loadVue();
    const { createApp, nextTick } = Vue;

    document.body.innerHTML = `
      <div id="app">
        <span id="state">{{ store.lmz.connection.state }}</span>
        <span id="connected">{{ store.lmz.connection.connected ? 'yes' : 'no' }}</span>
      </div>
    `;

    const app = createApp({
      setup() {
        return { store };
      },
    });
    app.mount('#app');

    // Seeded state before any transition.
    await nextTick();
    expect(document.getElementById('state')!.textContent).toBe('disconnected');
    expect(document.getElementById('connected')!.textContent).toBe('no');

    // The factory's onConnectionStateChange observer writes 'connected' + true.
    client.simulateConnectionState('connected');
    await nextTick();
    expect(document.getElementById('state')!.textContent).toBe('connected');
    expect(document.getElementById('connected')!.textContent).toBe('yes');

    app.unmount();
  });

  it('Direct user-state write fires Vue re-render', async () => {
    const { store } = setupVueStore();
    const Vue = await loadVue();
    const { createApp, nextTick } = Vue;

    document.body.innerHTML = `<div id="app"><span id="count">{{ store.app?.count ?? 'unset' }}</span></div>`;

    const app = createApp({
      setup() {
        return { store };
      },
    });
    app.mount('#app');

    // app is seeded as an empty object; no count key → 'unset'.
    expect(document.getElementById('count')!.textContent).toBe('unset');

    // Direct user write through the outer Proxy. Should:
    //   a. fire middleware (synced-state is a no-op for app.*)
    //   b. forward to Vue's reactive (triggers dep tracker)
    //   c. cause render effect to re-run on next tick
    store.app = { count: 1 };
    await nextTick();
    expect(document.getElementById('count')!.textContent).toBe('1');

    store.app.count = 2;
    await nextTick();
    expect(document.getElementById('count')!.textContent).toBe('2');

    app.unmount();
  });

  it('Q2a: the outer Proxy interoperates with Vue reactive() (no __v_skip special-casing needed)', async () => {
    // The factory does NOT special-case `__v_skip`; it passes all `__v_*` reads
    // through to the underlying Vue reactive. The consequences Vue's machinery
    // relies on (so it never tries to re-wrap our store):
    const { store } = setupVueStore();
    const Vue = await loadVue();
    const { createApp, nextTick, reactive, isReactive } = Vue;

    expect(isReactive(store)).toBe(true);       // answers __v_isReactive via the passthrough
    const wrapped = reactive(store);
    expect(isReactive(wrapped)).toBe(true);     // reactive() of an already-reactive target stays reactive

    // And a component still renders correctly through the outer Proxy.
    document.body.innerHTML = `<div id="app">{{ store.lmz.connection.state }}</div>`;
    const app = createApp({
      setup() {
        return { store };
      },
    });
    app.mount('#app');

    await nextTick();
    expect(document.getElementById('app')!.textContent).toBe('disconnected');

    app.unmount();
  });
});
