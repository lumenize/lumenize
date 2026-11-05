/**
 * Profile store-wiring — the factory surfaces `store.lmz.profiles[id].value` on a DEDICATED channel
 * (tasks/nebula-subscriber-lists.md Phase 2). Reading it auto-subscribes via `subscribeProfile` (routes to
 * the global PROFILE DO, NOT a Star resource sub), pushes land via `onProfileUpdate`, and unmount →
 * grace → `unsubscribeProfile`. Critically, a dev-user ontology type named `Profile` (a normal resource,
 * `store.resources.Profile[id]`) does NOT collide with the platform profile — distinct channels + paths.
 *
 * Mirrors q4-auto-subscribe (resources) for the profile channel; asserts on the MockClient's dedicated
 * `profileSubscribes`/`profileUnsubscribes` recorders + `simulateProfileFanout`.
 */
import { describe, it, expect, vi } from 'vitest';
import { setupVueStore, loadVue } from './vue-harness';

describe('Profile store-wiring — store.lmz.profiles[id] on the dedicated channel', () => {
  it('reading store.lmz.profiles[id].value auto-subscribes via subscribeProfile (NOT a resource sub); push lands; unmount → unsubscribe after grace', async () => {
    const { store, client } = setupVueStore({ unsubscribeGraceMs: 100 });
    const Vue = await loadVue();
    const { createApp, ref, nextTick } = Vue;
    const pid = crypto.randomUUID();

    document.body.innerHTML = `
      <div id="app">
        <span id="name">{{ store.lmz.profiles['${pid}']?.value?.name ?? 'pending' }}</span>
        <span id="counter">{{ counter }}</span>
      </div>
    `;
    const counter = ref(0);
    const app = createApp({ setup() { return { store, counter }; } });
    app.mount('#app');
    await nextTick();

    // Routes to the dedicated PROFILE channel (subscribeProfile), NOT a Star resource subscribe.
    expect(client.profileSubscribes.filter((s) => s.profileId === pid)).toHaveLength(1);
    expect(client.subscribes).toHaveLength(0);

    // A push on the profile channel lands at store.lmz.profiles[id].value → the component re-renders.
    client.simulateProfileFanout(pid, { value: { name: 'Ada' }, meta: { eTag: 'e1' } });
    await vi.waitFor(() => expect(document.getElementById('name')!.textContent).toBe('Ada'), { timeout: 5000 });

    // Re-renders (unrelated dep) must NOT re-subscribe.
    counter.value = 1; await nextTick();
    counter.value = 2; await nextTick();
    expect(client.profileSubscribes.filter((s) => s.profileId === pid)).toHaveLength(1);
    expect(client.profileUnsubscribes).toHaveLength(0);

    // Unmount → scope disposes → after grace, exactly one profile-unsubscribe.
    app.unmount();
    await nextTick();
    expect(client.profileUnsubscribes).toHaveLength(0);
    await vi.waitFor(
      () => expect(client.profileUnsubscribes.filter((s) => s.profileId === pid)).toHaveLength(1),
      { timeout: 1000 },
    );
  });

  it('a dev-user `Profile` RESOURCE and a global profile of the same id do NOT collide (distinct channels + store paths)', async () => {
    const { store, client } = setupVueStore({ unsubscribeGraceMs: 100 });
    const Vue = await loadVue();
    const { createApp, nextTick } = Vue;
    const id = crypto.randomUUID();

    document.body.innerHTML = `
      <div id="app">
        <span id="res">{{ store.resources.Profile['${id}']?.value?.title ?? '?' }}</span>
        <span id="glob">{{ store.lmz.profiles['${id}']?.value?.name ?? '?' }}</span>
      </div>
    `;
    const app = createApp({ setup() { return { store }; } });
    app.mount('#app');
    await nextTick();

    // The resource read → a Star resource subscribe; the profile read → the dedicated profile channel.
    // Same id string, DIFFERENT channels — no shared subscribe.
    expect(client.subscribes.filter((s) => s.rt === 'Profile' && s.rid === id)).toHaveLength(1);
    expect(client.profileSubscribes.filter((s) => s.profileId === id)).toHaveLength(1);

    // A resource fanout lands ONLY at resources.Profile[id]; a profile fanout ONLY at lmz.profiles[id].
    client.simulateFanout('Profile', id, { value: { title: 'dev-user resource' }, meta: { eTag: 'r1' } });
    client.simulateProfileFanout(id, { value: { name: 'Global Person' }, meta: { eTag: 'p1' } });
    await vi.waitFor(() => {
      expect(document.getElementById('res')!.textContent).toBe('dev-user resource');
      expect(document.getElementById('glob')!.textContent).toBe('Global Person');
    }, { timeout: 5000 });

    // No bleed between the two store subtrees (would fail if the platform-profile landing hijacked the
    // dev-user `Profile` resource, or vice versa — the collision the BLOCKER fix prevents).
    expect((store as any).resources.Profile[id].value.name).toBeUndefined();
    expect((store as any).lmz.profiles[id].value.title).toBeUndefined();

    app.unmount();
  });

  it('windowing — a 25-of-N v-for over profile ids opens exactly 25 profile subs, not N', async () => {
    const { store, client } = setupVueStore({ unsubscribeGraceMs: 100 });
    const Vue = await loadVue();
    const { createApp, nextTick } = Vue;
    const ids = Array.from({ length: 100 }, () => crypto.randomUUID());

    document.body.innerHTML = `
      <div id="app"><ul><li v-for="id in visible" :key="id">{{ store.lmz.profiles[id]?.value?.name ?? '?' }}</li></ul></div>
    `;
    // Only the first 25 ids are rendered (the window) — the other 75 are never read.
    const app = createApp({ setup() { return { store, visible: ids.slice(0, 25) }; } });
    app.mount('#app');
    await nextTick();

    const distinct = new Set(client.profileSubscribes.map((s) => s.profileId));
    expect(distinct.size).toBe(25);             // exactly the rendered window, not all 100
    expect(client.subscribes).toHaveLength(0);  // profiles only — no resource subs

    app.unmount();
  });
});
