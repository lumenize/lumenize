/**
 * Probe 1 — basic deep-path binding with auto-subscribe.
 *
 * What this proves:
 *   - Stock Alpine `x-text` binds to a path on `$store.lmz.resources.<rt>[<rid>].value.<field>`
 *   - The read inside Alpine's effect triggers our factory's effectScope-based
 *     auto-subscribe → real Star.subscribe round-trip
 *   - Initial snapshot lands in the store → Alpine sees it → DOM updates
 *   - Fanout from a server-side mutation propagates into the bound text
 *
 * Caveat: jsdom isn't a real browser; see task file Phase -1 § 10. The
 * MutationObserver-driven Alpine init works in jsdom, but real browsers may
 * differ in input-event timing, paint, etc.
 */
import { describe, it, expect, vi } from 'vitest';
import { setupHarness, loadAlpine } from './harness';

describe('Probe 1 — x-text + auto-subscribe', () => {
  it('Alpine x-text binds to $store.lmz path, auto-subscribes, picks up server fanout', async () => {
    const h = await setupHarness();
    const Alpine = await loadAlpine();

    const rid = crypto.randomUUID();
    const initialETag = await h.createResource(rid, 'TestResource', {
      title: 'orig-from-server',
      status: 'todo',
    });

    // Register the factory store under Alpine's `$store.lmz`.
    Alpine.store('lmz', h.store);

    // Diagnostic: verify Alpine.store actually exposes our proxy
    const registered = Alpine.store('lmz');
    console.log('[probe-1] Alpine.store("lmz") === h.store?', registered === h.store);
    console.log('[probe-1] registered.resources is', typeof registered.resources, registered.resources);
    console.log('[probe-1] h.store.resources is', typeof h.store.resources, h.store.resources);

    // Mount a tiny page.
    document.body.innerHTML = `
      <div id="root">
        <span id="title" x-data x-text="$store.lmz.resources.TestResource['${rid}']?.value?.title"></span>
        <span id="status" x-data x-text="$store.lmz.resources.TestResource['${rid}']?.value?.status"></span>
      </div>
    `;
    Alpine.start();

    // Initially undefined (no data in the store yet); auto-subscribe fires
    // when Alpine reads through the path. Wait for fanout to arrive.
    await vi.waitFor(() => {
      const titleEl = document.getElementById('title')!;
      expect(titleEl.textContent).toBe('orig-from-server');
    }, { timeout: 5000 });

    expect(document.getElementById('status')!.textContent).toBe('todo');
    expect(h.store.resources.TestResource[rid].meta.eTag).toBe(initialETag);

    // Mutate from the server side via the test-init client (NOT through the
    // factory — exercises real fanout path).
    h.client.callStarTransaction(h.activeScope, 'v1', {
      [rid]: { op: 'put', eTag: initialETag, value: { title: 'mutated', status: 'in-progress' } },
    });
    await vi.waitFor(() => expect(h.client.callCompleted).toBe(true));

    // Fanout → store write → Alpine effect re-fire → DOM update.
    await vi.waitFor(() => {
      expect(document.getElementById('title')!.textContent).toBe('mutated');
      expect(document.getElementById('status')!.textContent).toBe('in-progress');
    }, { timeout: 5000 });

    h.dispose();
  });
});
