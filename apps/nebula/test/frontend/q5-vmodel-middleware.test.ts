/**
 * Q5 — `v-model` writes route through the factory's Proxy set trap and the
 * synced-state middleware → a debounced transaction.
 *
 *   v-model.set → factory outer Proxy set trap → middleware chain →
 *   synced-state middleware matches resources.<rt>.<rid>.value.* →
 *   optimistic write paints + client.resources.write enqueues →
 *   (committed) → engine applyCommit advances meta.eTag.
 *
 * Ported to the mock (committed responder); the resource is seeded so v-model
 * has a baseline. The full real-Star round-trip is a §5.3.8 e2e probe (P10).
 */
import { describe, it, expect, vi } from 'vitest';
import { setupVueStore, loadVue } from './vue-harness';

describe('Q5 — v-model → middleware → transaction', () => {
  it('typing into v-model input commits an optimistic write + advances meta.eTag', async () => {
    const rid = crypto.randomUUID();
    const { store } = setupVueStore({
      initialState: {
        resources: {
          TestResource: {
            [rid]: { value: { title: 'original', status: 'todo' }, meta: { eTag: 'initial-eTag' } },
          },
        },
      },
    });

    const Vue = await loadVue();
    const { createApp } = Vue;

    // v-model needs a real l-value path; guard with v-if until the value exists.
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
        return { store };
      },
    });
    app.mount('#app');

    await vi.waitFor(() => {
      expect(document.getElementById('title-mirror')!.textContent).toBe('original');
    }, { timeout: 5000 });

    const input = document.getElementById('title-input') as HTMLInputElement;
    expect(input.value).toBe('original');

    // Simulate the user typing. v-model listens on `input` by default.
    input.value = 'edited via v-model';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Optimistic write visible immediately (post-tick).
    await vi.waitFor(() => {
      expect(document.getElementById('title-mirror')!.textContent).toBe('edited via v-model');
      expect(store.resources.TestResource[rid].value.title).toBe('edited via v-model');
    }, { timeout: 1000 });

    // The committed transaction's fresh eTag is written back to meta.eTag.
    await vi.waitFor(() => {
      const newETag = store.resources.TestResource[rid].meta.eTag;
      expect(newETag).not.toBe('initial-eTag');
      expect(typeof newETag).toBe('string');
      expect(newETag.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    app.unmount();
  });
});
