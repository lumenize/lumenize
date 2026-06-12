/**
 * Q4 — Auto-subscribe via Vue component's effectScope.
 *
 * Load-bearing probe. The factory's `trackResourceRead` hooks into
 * `effectScope` to refcount resource reads. Vue component instances each
 * own an effectScope; render effects run inside that scope.
 *
 * Asserts:
 *   1. Mounting a component that reads `store.resources.<rt>[<rid>].value.*`
 *      causes the factory to call `client.subscribe(rt, rid)` exactly once.
 *   2. The component re-renders when the resource snapshot lands (DOM
 *      reflects the title).
 *   3. Forcing additional re-renders (via another reactive dep) does NOT
 *      cause additional subscribe calls — the read is per-scope, not
 *      per-effect-run.
 *   4. Unmounting the component disposes its scope. After the unsubscribe
 *      grace period (set to 100ms in harness), `client.unsubscribe(rt, rid)`
 *      is called exactly once.
 *   5. Cross-test: while the component is unmounted-but-within-grace, no
 *      unsubscribe has fired yet. (Spec sanity.)
 */
import { describe, it, expect, vi } from 'vitest';
import { setupHarness, loadVue } from './harness';

describe('Q4 — Auto-subscribe via Vue component scope', () => {
  it('one mount → one subscribe; re-renders don\'t re-subscribe; unmount → one unsubscribe after grace', async () => {
    const h = await setupHarness({ unsubscribeGraceMs: 100 });
    const Vue = await loadVue();
    const { createApp, ref, nextTick } = Vue;

    const rid = crypto.randomUUID();
    await h.createResource(rid, 'TestResource', { title: 'hello', status: 'todo' });

    // Spy on subscribe + unsubscribe on the adapter (factory.client).
    const subCalls: Array<[string, string]> = [];
    const unsubCalls: Array<[string, string]> = [];
    const origSub = h.factory.client.subscribe.bind(h.factory.client);
    const origUnsub = h.factory.client.unsubscribe.bind(h.factory.client);
    h.factory.client.subscribe = (rt, rid) => {
      subCalls.push([rt, rid]);
      return origSub(rt, rid);
    };
    h.factory.client.unsubscribe = (rt, rid) => {
      unsubCalls.push([rt, rid]);
      return origUnsub(rt, rid);
    };

    document.body.innerHTML = `
      <div id="app">
        <span id="title">{{ store.resources.TestResource['${rid}']?.value?.title ?? 'pending' }}</span>
        <span id="counter">{{ counter }}</span>
      </div>
    `;

    const counter = ref(0);
    const app = createApp({
      setup() {
        return { store: h.store, counter };
      },
    });
    app.mount('#app');

    // Initial render: counter shows 0, title is pending (subscribe just fired).
    await nextTick();
    expect(document.getElementById('counter')!.textContent).toBe('0');

    // Wait for the initial snapshot to land via fanout.
    await vi.waitFor(() => {
      expect(document.getElementById('title')!.textContent).toBe('hello');
    }, { timeout: 5000 });

    // Subscribe should have fired exactly once (for this rt/rid).
    const subCallsForRid = subCalls.filter(([rt, r]) => rt === 'TestResource' && r === rid);
    expect(subCallsForRid).toHaveLength(1);

    // Force multiple re-renders by mutating an unrelated reactive dep that
    // the component reads.
    counter.value = 1;
    await nextTick();
    counter.value = 2;
    await nextTick();
    counter.value = 3;
    await nextTick();
    expect(document.getElementById('counter')!.textContent).toBe('3');
    expect(document.getElementById('title')!.textContent).toBe('hello');

    // Re-renders must NOT re-subscribe.
    const subCallsAfterRerender = subCalls.filter(([rt, r]) => rt === 'TestResource' && r === rid);
    expect(subCallsAfterRerender).toHaveLength(1);

    // Should not have unsubscribed yet — component still mounted.
    expect(unsubCalls).toHaveLength(0);

    // Unmount → scope disposes → grace period starts.
    app.unmount();
    await nextTick();

    // Immediately after unmount, the grace timer is pending — no unsubscribe
    // yet.
    expect(unsubCalls).toHaveLength(0);

    // After grace (100ms) + a safety buffer, exactly one unsubscribe should
    // have fired.
    await vi.waitFor(() => {
      const unsubForRid = unsubCalls.filter(([rt, r]) => rt === 'TestResource' && r === rid);
      expect(unsubForRid).toHaveLength(1);
    }, { timeout: 1000 });

    h.dispose();
  });

  it('two simultaneous mounts of same resource → one subscribe; both unmount → one unsubscribe', async () => {
    const h = await setupHarness({ unsubscribeGraceMs: 100 });
    const Vue = await loadVue();
    const { createApp, nextTick } = Vue;

    const rid = crypto.randomUUID();
    await h.createResource(rid, 'TestResource', { title: 'shared', status: 'todo' });

    const subCalls: Array<[string, string]> = [];
    const unsubCalls: Array<[string, string]> = [];
    const origSub = h.factory.client.subscribe.bind(h.factory.client);
    const origUnsub = h.factory.client.unsubscribe.bind(h.factory.client);
    h.factory.client.subscribe = (rt, rid) => {
      subCalls.push([rt, rid]);
      return origSub(rt, rid);
    };
    h.factory.client.unsubscribe = (rt, rid) => {
      unsubCalls.push([rt, rid]);
      return origUnsub(rt, rid);
    };

    document.body.innerHTML = `
      <div>
        <div id="app1"><span class="t">{{ store.resources.TestResource['${rid}']?.value?.title ?? '?' }}</span></div>
        <div id="app2"><span class="t">{{ store.resources.TestResource['${rid}']?.value?.title ?? '?' }}</span></div>
      </div>
    `;

    const app1 = createApp({
      setup() { return { store: h.store }; },
    });
    const app2 = createApp({
      setup() { return { store: h.store }; },
    });
    app1.mount('#app1');
    app2.mount('#app2');

    await vi.waitFor(() => {
      const titles = document.querySelectorAll('.t');
      expect(titles[0].textContent).toBe('shared');
      expect(titles[1].textContent).toBe('shared');
    }, { timeout: 5000 });

    // Two component instances → two scopes → two refcount entries → but only
    // ONE subscribe should have fired (0→1 transition).
    const subsForRid = subCalls.filter(([rt, r]) => rt === 'TestResource' && r === rid);
    expect(subsForRid).toHaveLength(1);

    // Unmount one — refcount goes 2→1, no unsubscribe should fire.
    app1.unmount();
    await new Promise(r => setTimeout(r, 200));
    expect(unsubCalls).toHaveLength(0);

    // Unmount second — refcount goes 1→0, grace timer starts.
    app2.unmount();
    await vi.waitFor(() => {
      const unsubForRid = unsubCalls.filter(([rt, r]) => rt === 'TestResource' && r === rid);
      expect(unsubForRid).toHaveLength(1);
    }, { timeout: 1000 });

    h.dispose();
  });
});
