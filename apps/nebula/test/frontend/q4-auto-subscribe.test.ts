/**
 * Q4 — Auto-subscribe via Vue component's effectScope.
 *
 * Load-bearing probe. The factory's `trackResourceRead` hooks into the Vue
 * component's effectScope to refcount resource reads. Ported to the mock:
 * subscribe/unsubscribe are asserted via `client.subscribes`/`unsubscribes`;
 * the initial snapshot is delivered via `client.simulateFanout(...)`.
 *
 * Asserts:
 *   1. Mounting a component reading `store.resources.<rt>[<rid>].value.*`
 *      calls subscribe exactly once.
 *   2. The component re-renders when the snapshot lands.
 *   3. Forcing extra re-renders does NOT re-subscribe (per-scope, not per-run).
 *   4. Unmounting disposes the scope; after the grace period, unsubscribe fires
 *      exactly once.
 */
import { describe, it, expect, vi } from 'vitest';
import { setupVueStore, loadVue } from './vue-harness';

describe('Q4 — Auto-subscribe via Vue component scope', () => {
  it('one mount → one subscribe; re-renders don\'t re-subscribe; unmount → one unsubscribe after grace', async () => {
    const { store, client } = setupVueStore({ unsubscribeGraceMs: 100 });
    const Vue = await loadVue();
    const { createApp, ref, nextTick } = Vue;

    const rid = crypto.randomUUID();

    document.body.innerHTML = `
      <div id="app">
        <span id="title">{{ store.resources.TestResource['${rid}']?.value?.title ?? 'pending' }}</span>
        <span id="counter">{{ counter }}</span>
      </div>
    `;

    const counter = ref(0);
    const app = createApp({
      setup() {
        return { store, counter };
      },
    });
    app.mount('#app');

    // Initial render: counter 0, title pending (subscribe just fired).
    await nextTick();
    expect(document.getElementById('counter')!.textContent).toBe('0');

    const subCallsForRid = () => client.subscribes.filter((s) => s.rt === 'TestResource' && s.rid === rid);
    expect(subCallsForRid()).toHaveLength(1);

    // Deliver the initial snapshot via fanout.
    client.simulateFanout('TestResource', rid, { value: { title: 'hello', status: 'todo' }, meta: { eTag: 'e1' } });
    await vi.waitFor(() => {
      expect(document.getElementById('title')!.textContent).toBe('hello');
    }, { timeout: 5000 });

    // Force multiple re-renders by mutating an unrelated reactive dep.
    counter.value = 1;
    await nextTick();
    counter.value = 2;
    await nextTick();
    counter.value = 3;
    await nextTick();
    expect(document.getElementById('counter')!.textContent).toBe('3');
    expect(document.getElementById('title')!.textContent).toBe('hello');

    // Re-renders must NOT re-subscribe.
    expect(subCallsForRid()).toHaveLength(1);
    expect(client.unsubscribes).toHaveLength(0);

    // Unmount → scope disposes → grace period starts.
    app.unmount();
    await nextTick();
    expect(client.unsubscribes).toHaveLength(0);

    // After grace, exactly one unsubscribe.
    await vi.waitFor(() => {
      const unsubForRid = client.unsubscribes.filter((s) => s.rt === 'TestResource' && s.rid === rid);
      expect(unsubForRid).toHaveLength(1);
    }, { timeout: 1000 });
  });

  it('two simultaneous mounts of same resource → one subscribe; both unmount → one unsubscribe', async () => {
    const { store, client } = setupVueStore({ unsubscribeGraceMs: 100 });
    const Vue = await loadVue();
    const { createApp } = Vue;

    const rid = crypto.randomUUID();
    client.simulateFanout('TestResource', rid, { value: { title: 'shared', status: 'todo' }, meta: { eTag: 'e1' } });

    document.body.innerHTML = `
      <div>
        <div id="app1"><span class="t">{{ store.resources.TestResource['${rid}']?.value?.title ?? '?' }}</span></div>
        <div id="app2"><span class="t">{{ store.resources.TestResource['${rid}']?.value?.title ?? '?' }}</span></div>
      </div>
    `;

    const app1 = createApp({ setup() { return { store }; } });
    const app2 = createApp({ setup() { return { store }; } });
    app1.mount('#app1');
    app2.mount('#app2');

    await vi.waitFor(() => {
      const titles = document.querySelectorAll('.t');
      expect(titles[0].textContent).toBe('shared');
      expect(titles[1].textContent).toBe('shared');
    }, { timeout: 5000 });

    // Two instances → two scopes → two refcount entries, but only ONE subscribe
    // (the 0→1 transition).
    const subsForRid = client.subscribes.filter((s) => s.rt === 'TestResource' && s.rid === rid);
    expect(subsForRid).toHaveLength(1);

    // Unmount one — refcount 2→1, no unsubscribe.
    app1.unmount();
    await new Promise((r) => setTimeout(r, 200));
    expect(client.unsubscribes).toHaveLength(0);

    // Unmount second — refcount 1→0, grace timer → unsubscribe.
    app2.unmount();
    await vi.waitFor(() => {
      const unsubForRid = client.unsubscribes.filter((s) => s.rt === 'TestResource' && s.rid === rid);
      expect(unsubForRid).toHaveLength(1);
    }, { timeout: 1000 });
  });
});
