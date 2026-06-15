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
import { describe, it, expect, vi, inject } from 'vitest';
import { createNebulaClient } from '@lumenize/nebula/frontend';
import { bootstrapAdmin } from './auth-bootstrap';
import { OntologyAdminClient } from './ontology-admin';
import { proxyBaseUrl, uniqueStar, ADMIN_EMAIL } from './factory-harness';

const ONTOLOGY = `interface todo { title: string; description?: string; status?: 'open' | 'done'; }`;

describe('async-modal conflict handler (real chromium, real WS + dialog)', () => {
  it('opens a real <dialog> on conflict; the user choice applies as a use-this verdict', async () => {
    const scope = uniqueStar();
    const baseUrl = proxyBaseUrl();
    const testToken = inject('emailTestToken');

    // Founder magic-link bootstrap (admin on ROOT → install ontology + write).
    await bootstrapAdmin({ baseUrl, scope, email: ADMIN_EMAIL, testToken });

    // Install the 'todo' ontology via the browser-safe admin client.
    const admin = new OntologyAdminClient({
      baseUrl, authScope: scope, activeScope: scope, appVersion: 'v1', onShouldRefreshUI: () => {},
    });
    await vi.waitFor(() => expect(admin.connectionState).toBe('connected'), { timeout: 15000 });
    const galaxyName = scope.split('.').slice(0, 2).join('.');
    admin.callGalaxyAppendOntologyVersion(galaxyName, { version: 'v1', types: ONTOLOGY });
    await vi.waitFor(() => expect(admin.callCompleted).toBe(true), { timeout: 10000 });

    // The factory client — the doc's `client` + `store`.
    const { client, store, ready, dispose } = createNebulaClient({
      baseUrl, authScope: scope, activeScope: scope, appVersion: 'v1', onShouldRefreshUI: () => {},
    });
    try {
      await ready;

      // Seed a todo to conflict on.
      const created = await client.resources.transaction({
        t1: { op: 'create', typeName: 'todo', nodeId: 1, value: { title: 'original', status: 'open' } },
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
