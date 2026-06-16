/**
 * A Vue `computed()` driving a `v-if`: the derivation re-runs when its source
 * store path changes, and the conditional content mounts/unmounts accordingly
 * (§5.3.8 — "Vue `computed()` driving `v-if`").
 *
 * The other v-if probe (q3) gates on a DIRECT store read; this one proves the
 * derived-value path: a `computed` over a resource field is the `v-if` condition,
 * and a fanout that flips the field flips the rendered content — in BOTH
 * directions (mount on true, unmount on false).
 *
 * Capable-of-failing: if the `computed` didn't re-track its source (or `v-if`
 * didn't react to it), the badge would never appear after the done→true fanout,
 * or never disappear after the done→false fanout. The two-directional assertion
 * fails if either the re-run or the conditional (un)mount is broken.
 */
import { describe, it, expect, vi } from 'vitest';
import { setupVueStore, loadVue } from './vue-harness';

describe('Vue computed() driving v-if (§5.3.8)', () => {
  it('re-runs the computed and mounts/unmounts the conditional content on source change', async () => {
    const todoId = crypto.randomUUID();
    const { store, client } = setupVueStore({
      initialState: {
        resources: {
          Todo: { [todoId]: { value: { title: 'buy milk', done: false }, meta: { eTag: 'e0' } } },
        },
      },
    });

    const Vue = await loadVue();
    const { createApp, computed } = Vue;

    document.body.innerHTML = `<div id="app"><todo-badge /></div>`;

    const TodoBadge = {
      name: 'TodoBadge',
      // `isDone` is a computed over the resource field; v-if reads the computed.
      // Evaluating it during render reads store.resources.Todo[id] (auto-subscribe),
      // so a later fanout that changes `done` re-runs the computed and re-renders.
      template: `
        <span class="title">{{ store.resources.Todo[todoId]?.value?.title ?? '...' }}</span>
        <span class="badge" v-if="isDone">DONE</span>
      `,
      setup() {
        const isDone = computed(() => store.resources.Todo[todoId]?.value?.done === true);
        return { store, todoId, isDone };
      },
    };

    const app = createApp({ setup() { return {}; } });
    app.component('TodoBadge', TodoBadge);
    app.mount('#app');

    // Title renders; badge absent while done = false.
    await vi.waitFor(() => {
      expect(document.querySelector('.title')?.textContent).toBe('buy milk');
    }, { timeout: 5000 });
    expect(document.querySelector('.badge')).toBeNull();

    // Flip the source true → computed re-runs → v-if mounts the badge.
    client.simulateFanout('Todo', todoId, { value: { title: 'buy milk', done: true }, meta: { eTag: 'e1' } });
    await vi.waitFor(() => {
      expect(document.querySelector('.badge')?.textContent).toBe('DONE');
    }, { timeout: 5000 });

    // Flip back false → computed re-runs → v-if unmounts the badge.
    client.simulateFanout('Todo', todoId, { value: { title: 'buy milk', done: false }, meta: { eTag: 'e2' } });
    await vi.waitFor(() => {
      expect(document.querySelector('.badge')).toBeNull();
    }, { timeout: 5000 });

    app.unmount();
  });
});
