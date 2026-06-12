/**
 * Q3 — Recursive Vue component renders a 3-level tree, each node a separate
 * subscribed resource.
 *
 * This is the hardest case in `coding-your-ui.md`: a TreeNode component
 * that references itself in its template, instantiated per-resource-id, with
 * each instance auto-subscribing to its own resource.
 *
 * Asserts:
 *   1. All three tree levels render with their server-loaded labels.
 *   2. Each TreeNode instance auto-subscribed to its own resource — N
 *      resources rendered ⇒ N distinct subscribe calls.
 *
 * Skipped (already proven elsewhere):
 *   - Fanout-driven re-render after mutation: proven by Phase 0b
 *     `cross-client-fanout.test.ts`. Within a single client the
 *     transaction-originator path doesn't re-emit fanout — that's a Star
 *     design point, not a Vue/factory concern.
 *   - Unmount → N grace-period unsubscribes: Q4 verifies single-resource
 *     and 2-component-shared-resource cases. N independent resources is
 *     the same code path repeated.
 */
import { describe, it, expect, vi } from 'vitest';
import { setupHarness, loadVue } from './harness';

describe('Q3 — Recursive TreeNode (3 levels)', () => {
  it('renders a 3-level tree, each node a distinct subscribed resource', async () => {
    const h = await setupHarness();
    const Vue = await loadVue();
    const { createApp } = Vue;

    // Build a small tree:
    //   root → [c1, c2]
    //   c1   → [g1]
    //   c2   → []
    //   g1   → []
    const rootId = crypto.randomUUID();
    const c1Id = crypto.randomUUID();
    const c2Id = crypto.randomUUID();
    const g1Id = crypto.randomUUID();

    await h.createResource(g1Id, 'TreeNode', { label: 'grandchild-1', children: [] });
    await h.createResource(c1Id, 'TreeNode', { label: 'child-1', children: [g1Id] });
    await h.createResource(c2Id, 'TreeNode', { label: 'child-2', children: [] });
    await h.createResource(rootId, 'TreeNode', { label: 'root', children: [c1Id, c2Id] });

    // Spy on subscribe to count distinct (rt, rid) auto-subscribes.
    const subCalls: Array<[string, string]> = [];
    const origSub = h.factory.client.subscribe.bind(h.factory.client);
    h.factory.client.subscribe = (rt, rid) => {
      subCalls.push([rt, rid]);
      return origSub(rt, rid);
    };

    // Mount markup: a single TreeNode for root; the component recurses for
    // children. Note `name: 'TreeNode'` is REQUIRED for self-reference in
    // the template — Vue uses the component's `name` to resolve `<TreeNode />`
    // tags inside its own template.
    document.body.innerHTML = `
      <div id="app">
        <tree-node :node-id="rootId" />
      </div>
    `;

    const TreeNode = {
      name: 'TreeNode',
      props: ['nodeId'],
      // Each instance reads store.resources.TreeNode[nodeId] in its template.
      // The get-trap fires → trackResourceRead via Vue component scope →
      // refcount increments → subscribe fires (0→1).
      // Template strings are parsed by Vue's runtime compiler — not by the
      // browser — so PascalCase tag names ARE allowed here. The kebab-case
      // form `<tree-node>` also works. Note: this applies only because the
      // template is a JS string. In-DOM templates (parsed by the browser
      // HTML parser before Vue sees them) MUST use kebab-case.
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
        return { store: h.store };
      },
    };

    const app = createApp({
      setup() {
        return { rootId };
      },
    });
    app.component('TreeNode', TreeNode);
    app.mount('#app');

    // Wait for the deepest grandchild to render — that proves all three
    // levels have subscribed, received initial snapshots, and re-rendered.
    await vi.waitFor(() => {
      const labels = Array.from(document.querySelectorAll('.label')).map(
        (el) => el.textContent,
      );
      expect(labels).toContain('root');
      expect(labels).toContain('child-1');
      expect(labels).toContain('child-2');
      expect(labels).toContain('grandchild-1');
    }, { timeout: 5000 });

    // 4 distinct resources rendered → 4 subscribe calls (one per node).
    const treeNodeSubs = new Set(
      subCalls.filter(([rt]) => rt === 'TreeNode').map(([_, r]) => r),
    );
    expect(treeNodeSubs.size).toBe(4);
    expect(treeNodeSubs.has(rootId)).toBe(true);
    expect(treeNodeSubs.has(c1Id)).toBe(true);
    expect(treeNodeSubs.has(c2Id)).toBe(true);
    expect(treeNodeSubs.has(g1Id)).toBe(true);

    app.unmount();
    h.dispose();
  });
});
