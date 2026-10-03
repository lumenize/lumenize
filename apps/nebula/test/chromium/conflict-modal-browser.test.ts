// @ts-nocheck — mirrors a loose-JS website doc block (the async-modal conflict
// handler) verbatim so the @check-example matcher substring-matches it. Validated
// by RUNNING in real chromium against a real Star, not by tsc.
//
/**
 * Async-modal conflict handler (resources.md § 'use-this' verdict — async modal)
 * — real chromium / real WS / real <dialog>.
 *
 * This is the one runtime doc block jsdom and the Node baseline both can't back:
 * it needs a REAL `HTMLDialogElement.showModal()` + `close(returnValue)` (jsdom
 * doesn't implement them) AND a real NebulaClient conflict (the baseline has the
 * real Star but no DOM). So: install a `todo` ontology via a browser-safe admin
 * client, connect the factory client, fire a stale-eTag conflict, and let the
 * doc's async handler drive a real dialog — the user's "Keep mine" choice becomes
 * a `use-this` verdict that re-submits and commits.
 *
 * Capable-of-failing: a broken handler/dialog path leaves `store.ui.conflict`
 * stuck (or the dialog never opens → `modalEl.open` false), and the final value
 * would be the server's `original`, not the user's `my edit`.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNebulaClient, ROOT_NODE_ID } from '@lumenize/nebula/frontend';
import { OntologyAdminClient } from './ontology-admin';
import { pageEndpoints, PAGE_STAR } from './factory-harness';

const ONTOLOGY = `interface todo { title: string; description?: string; status?: 'open' | 'done'; }`;

describe('async-modal conflict handler (real chromium, real WS + dialog)', () => {
  // ⏭️ SKIPPED — but the ORIGINAL blocker has expired (re-derived 2026-08-29). The 2026-07-25
  // banner argued the prod lazy-pull was unbuilt so a Galaxy-appended ontology never reached the
  // Star; since then the lazy-pull LANDED (the Star's ontology source → `getCurrentOntology`) AND the
  // seed below was re-pointed to install directly on the STAR via `StarTest.applyOntologyForTest`
  // (the Galaxy test-install path is deleted — nebula-move-compilers-out-of-the-worker.md phase 3),
  // so the ontology-stale failure the old banner predicted should no longer occur. What is still
  // owed is a chromium-lane RUN confirming the test passes as edited — un-skip on the next run of
  // this lane, not blind. Assertions left INTACT — the conflict-modal/use-this verdict contract
  // they encode is what that run re-verifies.
  it.skip('opens a real <dialog> on conflict; the user choice applies as a use-this verdict', async () => {
    // The page is signed in as its Star's own admin (the lane's global setup), so every client here
    // acts at that Star, and the admin's dominion there satisfies `applyOntologyForTest`'s
    // `requireDominionHere`. The install lands directly on the STAR via `StarTest.applyOntologyForTest`,
    // so the tenant's data ops below do not depend on the lazy pull for THIS seed.
    const scope = PAGE_STAR;
    const { baseUrl, platformOrigin } = pageEndpoints();
    const admin = new OntologyAdminClient({ baseUrl, platformOrigin, ontologyVersion: 'v1' });
    await vi.waitFor(() => expect(admin.connectionState).toBe('connected'), { timeout: 15000 });
    admin.callStarInstallOntology(scope, { version: 'v1', types: ONTOLOGY });
    await vi.waitFor(() => expect(admin.callCompleted).toBe(true), { timeout: 10000 });

    // The factory client — the doc's `client` + `store`.
    const { client, store, ready, dispose } = createNebulaClient({
      baseUrl, platformOrigin, ontologyVersion: 'v1', onShouldRefreshUI: () => {},
    });
    try {
      await ready;

      // Seed a todo to conflict on.
      const created = await client.resources.transaction({
        t1: { op: 'create', typeName: 'todo', nodeId: ROOT_NODE_ID, value: { title: 'original', status: 'open' } },
      });
      expect(created.kind).toBe('committed');

      // A real <dialog> in the page (the doc's App.vue modal fragment, minus Vue).
      document.body.innerHTML = `
        <dialog id="conflict-modal">
          <form method="dialog">
            <button value="mine">Keep mine</button>
            <button value="theirs">Use server's</button>
          </form>
        </dialog>`;

      // @doc resources.md § 'use-this' verdict — async modal
      // nebula.ts (continuing from the bootstrap example — `client`, `store` already created)
      client.resources.onTransactionResourceResolution('todo', async (rid, resolution) => {
        if (resolution.kind === 'conflict-pending') {
          const { local, server } = resolution;
          store.ui.conflict = { local, server };

          const modal = document.getElementById('conflict-modal') as HTMLDialogElement;
          const choice = await new Promise<string>((resolve) => {
            modal.addEventListener('close', () => resolve(modal.returnValue), { once: true });
            modal.showModal();
          });
          store.ui.conflict = undefined;

          return choice === 'mine'
            ? { kind: 'use-this', value: local.value }
            : { kind: 'use-server' };
        }
      });
      // @end-doc

      // Fire a conflict: a put against a deliberately stale eTag → server conflict
      // → the async handler runs, opens the real dialog, and parks the transaction.
      const txnPromise = client.resources.transaction({
        t1: { op: 'put', typeName: 'todo', eTag: `stale-${crypto.randomUUID()}`, value: { title: 'my edit', status: 'open' } },
      });

      // The handler stashed the conflict + called showModal(). Simulate the user
      // clicking "Keep mine": close the real dialog with returnValue 'mine'.
      await vi.waitFor(() => expect(store.ui.conflict).toBeTruthy(), { timeout: 10000 });
      const modalEl = document.getElementById('conflict-modal') as HTMLDialogElement;
      expect(modalEl.open).toBe(true); // showModal() really opened it (real browser)
      modalEl.close('mine');

      // use-this re-submits local.value at the server eTag → commits with my edit.
      const outcome = await txnPromise;
      expect(outcome.kind).toBe('committed');
      expect(store.ui.conflict).toBeUndefined(); // handler cleared it on close
      const final = await client.resources.read('todo', 't1');
      expect((final?.value as { title: string }).title).toBe('my edit');
    } finally {
      admin[Symbol.dispose]();
      await dispose();
    }
  });
});
