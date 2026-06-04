/**
 * Q5 — `v-model` writes route through the factory's Proxy set trap and the
 * synced-state middleware → real Star transaction.
 *
 * The user is the source of truth here. They type into an input; that write
 * goes:
 *   v-model.set → factory outer Proxy set trap → middleware chain →
 *   synced-state middleware matches `resources.<rt>.<rid>.value.*` →
 *   forwards optimistic write to Vue reactive → schedules
 *   `client.transaction(...)` → server commits → factory.handleTransactionOutcome
 *   writes the new eTag.
 *
 * Asserts:
 *   1. Initial render: input shows the resource's title.
 *   2. After programmatic input change + dispatch, the store's value
 *      reflects the new title (optimistic apply).
 *   3. The server commits the transaction; the store's meta.eTag advances
 *      to a new UUID.
 */
import { describe, it, expect, vi } from 'vitest';
import { setupHarness, loadVue } from './harness';

describe('Q5 — v-model → middleware → real Star transaction', () => {
  it('typing into v-model input commits an optimistic write + real transaction', async () => {
    const h = await setupHarness();
    const Vue = await loadVue();
    const { createApp } = Vue;

    const rid = crypto.randomUUID();
    const initialETag = await h.createResource(rid, 'TestResource', {
      title: 'original',
      status: 'todo',
    });

    // v-model needs a real l-value path; guard with v-if until the snapshot
    // lands. The mirror span uses optional-chaining for the loading state.
    document.body.innerHTML = `
      <div id="app">
        <template v-if="store.resources.TestResource['${rid}']?.value">
          <input id="title-input" v-model="store.resources.TestResource['${rid}'].value.title" />
        </template>
        <span id="title-mirror">{{ store.resources.TestResource['${rid}']?.value?.title ?? 'loading' }}</span>
      </div>
    `;

    const app = createApp({
      setup() {
        return { store: h.store };
      },
    });
    app.mount('#app');

    // Wait for initial snapshot to land + render.
    await vi.waitFor(() => {
      expect(document.getElementById('title-mirror')!.textContent).toBe('original');
    }, { timeout: 5000 });

    const input = document.getElementById('title-input') as HTMLInputElement;
    expect(input.value).toBe('original');

    // Simulate the user typing a new title. v-model listens on the `input`
    // event by default; we set value + dispatch.
    input.value = 'edited via v-model';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Optimistic write should be visible immediately (post-tick).
    await vi.waitFor(() => {
      expect(document.getElementById('title-mirror')!.textContent).toBe('edited via v-model');
      expect(h.store.resources.TestResource[rid].value.title).toBe('edited via v-model');
    }, { timeout: 1000 });

    // The factory schedules `client.transaction(...)` via queueMicrotask;
    // the server commit returns a new eTag which the factory writes back to
    // `meta.eTag`. Wait for that to land.
    await vi.waitFor(() => {
      const newETag = h.store.resources.TestResource[rid].meta.eTag;
      expect(newETag).not.toBe(initialETag);
      expect(typeof newETag).toBe('string');
      expect(newETag.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    app.unmount();
    h.dispose();
  });
});
