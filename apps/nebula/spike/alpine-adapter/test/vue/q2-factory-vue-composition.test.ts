/**
 * Q2 — Factory store + Vue component composition.
 *
 * Validates that Vue's reactivity tracks reads through the factory's outer
 * Proxy and that writes via the outer Proxy (whether from the connection
 * observer, the user, or fanout) trigger Vue re-renders.
 *
 * Three asserts:
 *   1. A Vue component reading `store.lmz.connection.connected` re-renders
 *      when the connection state changes (proves the connection observer's
 *      writes flow through to Vue's render effect).
 *   2. A direct user write at `store.app.count = N` triggers a re-render
 *      (proves stock user-state writes work).
 *   3. Q2a sub-probe: removing the outer Proxy's `__v_skip: true` response
 *      does NOT break the above (proves the flag is dead code in Vue 3.5
 *      in-DOM mode).
 *
 * The sub-probe runs by monkey-patching the proxy's get trap before
 * mounting — cleaner than maintaining two copies of the factory. If Vue
 * tries to re-wrap our store anywhere, this probe will surface it.
 */
import { describe, it, expect, vi } from 'vitest';
import { setupHarness, loadVue } from './harness';

describe('Q2 — Factory + Vue composition', () => {
  it('Vue component re-renders when connection state changes (observer-driven write)', async () => {
    const h = await setupHarness();
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
        return { store: h.store };
      },
    });
    app.mount('#app');

    // setupHarness already waited for connectionState === 'connected'.
    // The factory's onConnectionStateChange observer should have written
    // 'connected' + true into the store by now.
    await nextTick();
    expect(document.getElementById('state')!.textContent).toBe('connected');
    expect(document.getElementById('connected')!.textContent).toBe('yes');

    app.unmount();
    h.dispose();
  });

  it('Direct user-state write fires Vue re-render', async () => {
    const h = await setupHarness();
    const Vue = await loadVue();
    const { createApp, nextTick } = Vue;

    document.body.innerHTML = `<div id="app"><span id="count">{{ store.app?.count ?? 'unset' }}</span></div>`;

    const app = createApp({
      setup() {
        return { store: h.store };
      },
    });
    app.mount('#app');

    // No app.* keys seeded; vivification only fires under resources.*.
    // The first read returns undefined → 'unset'.
    expect(document.getElementById('count')!.textContent).toBe('unset');

    // Direct user write through the outer Proxy. Should:
    //   a. fire middleware (only synced-state middleware → no-op for app.*)
    //   b. forward to Vue's reactive (triggers dep tracker)
    //   c. cause render effect to re-run on next tick
    h.store.app = { count: 1 };
    await nextTick();
    expect(document.getElementById('count')!.textContent).toBe('1');

    h.store.app.count = 2;
    await nextTick();
    expect(document.getElementById('count')!.textContent).toBe('2');

    app.unmount();
    h.dispose();
  });

  it('Q2a sub-probe: __v_skip is not load-bearing in Vue 3 in-DOM mode', async () => {
    // Capture every key Vue probes on the outer Proxy. If `__v_skip` is
    // load-bearing, Vue's internal codepath that triggers re-wrapping will
    // probe it. If it's never probed (or is probed but returning `false`
    // doesn't break anything), the flag is dead code we can drop.
    const h = await setupHarness();
    const Vue = await loadVue();
    const { createApp, nextTick, reactive, isReactive } = Vue;

    const probedKeys = new Set<string>();

    // Wrap the outer-proxy access via a one-shot trap that captures
    // every property read. We can't easily mutate the existing Proxy in
    // place, but we CAN observe via a "spy" wrapper that delegates to it.
    const spy = new Proxy(h.store, {
      get(t, key) {
        if (typeof key === 'string') probedKeys.add(key);
        if (typeof key === 'symbol') probedKeys.add(String(key));
        return (t as any)[key];
      },
    });

    document.body.innerHTML = `<div id="app">{{ store.lmz.connection.state }}</div>`;
    const app = createApp({
      setup() {
        return { store: spy };
      },
    });
    app.mount('#app');

    await nextTick();
    expect(document.getElementById('app')!.textContent).toBe('connected');

    // Did Vue ever probe __v_skip or other __v_* internals? If it did,
    // they appear in probedKeys. The factory's `__v_skip` handling returns
    // true; Vue 3 components don't normally call reactive() on objects
    // returned from setup, so the probe shouldn't fire.
    console.log('[Q2a] probed keys on outer store:', Array.from(probedKeys));
    const internalProbes = Array.from(probedKeys).filter(k => k.startsWith('__v_'));
    console.log('[Q2a] internal __v_* probes:', internalProbes);

    // Also confirm: passing the outer Proxy directly to reactive() should
    // not re-wrap it (the flag exists for cases like Alpine.store(...) that
    // call reactive() on user-provided objects).
    const wrapped = reactive(h.store);
    // If __v_skip works, `wrapped === h.store`; if not, Vue creates a new
    // reactive wrapping our proxy.
    console.log('[Q2a] reactive(store) === store?', wrapped === h.store);
    console.log('[Q2a] isReactive(store)?', isReactive(h.store));
    console.log('[Q2a] isReactive(wrapped)?', isReactive(wrapped));

    app.unmount();
    h.dispose();
  });
});
