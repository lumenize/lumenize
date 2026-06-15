/**
 * Q3 — Recursive Vue component renders a 3-level tree, each node a separate
 * subscribed resource.
 *
 * The hardest case in `coding-your-ui.md`: a TreeNode component referencing
 * itself in its template, instantiated per-resource-id, each instance
 * auto-subscribing to its own resource. Ported to the mock: the tree is seeded
 * via `initialState`; auto-subscribe is asserted via `client.subscribes`.
 *
 * Asserts:
 *   1. All four tree nodes render with their labels.
 *   2. Each TreeNode instance auto-subscribed to its own resource — N
 *      resources rendered ⇒ N distinct subscribe calls.
 */
import { describe, it, expect, vi } from 'vitest';
import { setupVueStore, loadVue } from './vue-harness';

describe('Q3 — Recursive TreeNode (3 levels)', () => {
  it('renders a 3-level tree, each node a distinct subscribed resource', async () => {
    // Build a small tree:
    //   root → [c1, c2]; c1 → [g1]; c2 → []; g1 → []
    const rootId = crypto.randomUUID();
    const c1Id = crypto.randomUUID();
    const c2Id = crypto.randomUUID();
    const g1Id = crypto.randomUUID();

    const node = (label: string, children: string[]) => ({
      value: { label, children },
      meta: { eTag: `eTag-${label}` },
    });

    const { store, client } = setupVueStore({
      initialState: {
        resources: {
          TreeNode: {
            [rootId]: node('root', [c1Id, c2Id]),
            [c1Id]: node('child-1', [g1Id]),
            [c2Id]: node('child-2', []),
            [g1Id]: node('grandchild-1', []),
          },
        },
      },
    });

    const Vue = await loadVue();
    const { createApp } = Vue;

    document.body.innerHTML = `
      <div id="app">
        <tree-node :node-id="rootId" />
      </div>
    `;

    const TreeNode = {
      name: 'TreeNode',
      props: ['nodeId'],
      // Each instance reads store.resources.TreeNode[nodeId] in its template →
      // the get-trap fires → trackResourceRead via the Vue component scope →
      // refcount 0→1 → subscribe. Template strings are parsed by Vue's runtime
      // compiler (not the browser), so PascalCase self-reference is allowed.
      template: `
        <span class="label" :data-id="nodeId">{{
          store.resources.TreeNode[nodeId]?.value?.label ?? '...'
        }}</span>
        <ul v-if="(store.resources.TreeNode[nodeId]?.value?.children?.length ?? 0) > 0">
          <li v-for="childId in store.resources.TreeNode[nodeId].value.children" :key="childId">
            <tree-node :node-id="childId" />
          </li>
        </ul>
      `,
      setup() {
        return { store };
      },
    };

    const app = createApp({
      setup() {
        return { rootId };
      },
    });
    app.component('TreeNode', TreeNode);
    app.mount('#app');

    // Wait for the deepest grandchild to render — proves all levels subscribed,
    // received their seeded snapshot, and rendered.
    await vi.waitFor(() => {
      const labels = Array.from(document.querySelectorAll('.label')).map((el) => el.textContent);
      expect(labels).toContain('root');
      expect(labels).toContain('child-1');
      expect(labels).toContain('child-2');
      expect(labels).toContain('grandchild-1');
    }, { timeout: 5000 });

    // 4 distinct resources rendered → 4 subscribe calls (one per node).
    const treeNodeSubs = new Set(
      client.subscribes.filter((s) => s.rt === 'TreeNode').map((s) => s.rid),
    );
    expect(treeNodeSubs.size).toBe(4);
    expect(treeNodeSubs.has(rootId)).toBe(true);
    expect(treeNodeSubs.has(c1Id)).toBe(true);
    expect(treeNodeSubs.has(c2Id)).toBe(true);
    expect(treeNodeSubs.has(g1Id)).toBe(true);

    app.unmount();
  });
});
