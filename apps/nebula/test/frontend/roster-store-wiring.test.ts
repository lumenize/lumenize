/**
 * Subscriber-list roster store-wiring — the factory surfaces the query-in-path roster (Phase 5,
 * tasks/nebula-subscriber-lists.md): reading `store.lmz.querySubscribers.<typeName>.<field>[value]` — the
 * path segments ARE the parentChild query — auto-subscribes via the STANDALONE `subscribeQuerySubscribers`
 * (roster only, NOT the coupled data sub) and lands a reactive array of `{ sub, profileId }` (v-for-ready).
 * (This is the ONLY roster store surface; the named/byName form was cut — Decision 6.) Asserts on the
 * MockClient's `querySubscribersSubscribes`/`Unsubscribes` recorders + `simulateRoster`.
 */
import { describe, it, expect, vi } from 'vitest';
import { setupVueStore, loadVue } from './vue-harness';

describe('Subscriber-list roster store-wiring — store.lmz.querySubscribers.*', () => {
  it('(a) query-in-path — reading store.lmz.querySubscribers.<type>.<field>[value] auto-subscribes via the STANDALONE subscribeQuerySubscribers (not a data sub); the roster renders in v-for; unmount → unsubscribe after grace', async () => {
    const { store, client } = setupVueStore({ unsubscribeGraceMs: 100 });
    const Vue = await loadVue();
    const { createApp, nextTick } = Vue;
    const sessionId = crypto.randomUUID();

    document.body.innerHTML = `
      <div id="app"><ul>
        <li v-for="{ sub } in (store.lmz.querySubscribers.Message.session['${sessionId}'] ?? [])" :key="sub">{{ sub }}</li>
      </ul></div>
    `;
    const app = createApp({ setup() { return { store }; } });
    app.mount('#app');
    await nextTick();

    // The path segments ARE the parentChild query → exactly one STANDALONE subscribeQuerySubscribers
    // (roster only), NOT a coupled resource/query DATA sub.
    expect(client.querySubscribersSubscribes).toHaveLength(1);
    expect(client.querySubscribersSubscribes[0]).toMatchObject({
      query: { queryType: 'parentChild', typeName: 'Message', field: 'session', value: sessionId },
    });
    expect(client.subscribes).toHaveLength(0);

    // A roster push lands at the query-in-path as a reactive array → renders in the v-for.
    client.simulateRoster(
      { queryType: 'parentChild', typeName: 'Message', field: 'session', value: sessionId },
      [{ sub: 'alice' }, { sub: 'bob', profileId: 'p-bob' }],
    );
    await vi.waitFor(() => expect(document.querySelectorAll('#app li')).toHaveLength(2));
    expect([...document.querySelectorAll('#app li')].map((n) => n.textContent)).toEqual(['alice', 'bob']);

    // Unmount → scope disposes → after grace, exactly one roster-unsubscribe.
    app.unmount();
    await vi.waitFor(() => expect(client.querySubscribersUnsubscribes).toHaveLength(1), { timeout: 1000 });
  });
});
