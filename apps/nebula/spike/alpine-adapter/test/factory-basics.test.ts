/**
 * Phase 0a — Factory mechanics against a mock client.
 *
 * Each test targets a pinned-semantic invariant from
 * `tasks/alpine-adapter-spike.md`'s "Pinned semantics" table. Real-Star
 * integration happens in Phase 0b.
 */
import { describe, it, expect, vi } from 'vitest';
import { effect, effectScope } from '@vue/reactivity';
import { createNebulaClient } from '../src/create-nebula-client';
import { MockClient } from './mock-client';

function setup(initialState: Record<string, any> = {}) {
  const client = new MockClient();
  const factory = createNebulaClient(client, { initialState, unsubscribeGraceMs: 50 });
  return { client, factory, store: factory.store };
}

// ──────────────────────────────────────────────────────────────────────────
// PINNED #1, #2: Middleware fires on every write; substitution + abort work.
// ──────────────────────────────────────────────────────────────────────────
describe('middleware', () => {
  it('fires for nested writes with correct path/old/new/context', () => {
    const { store, factory } = setup({ a: { b: 1 } });
    const seen: Array<{ path: string; oldValue: unknown; newValue: unknown; source: string }> = [];
    factory.use(({ path, oldValue, newValue, context }) => {
      seen.push({ path, oldValue, newValue, source: context.source });
      return undefined;
    });
    store.a.b = 2;
    expect(seen).toEqual([{ path: 'a.b', oldValue: 1, newValue: 2, source: 'local' }]);
    expect(store.a.b).toBe(2);
  });

  it('top-level write also fires middleware with correct path', () => {
    const { store, factory } = setup({});
    const seen: string[] = [];
    factory.use(({ path }) => {
      seen.push(path);
      return undefined;
    });
    store.foo = { x: 1 };
    expect(seen).toEqual(['foo']);
  });

  it('middleware return value substitutes for newValue', () => {
    const { store, factory } = setup({ count: 0 });
    factory.use(({ newValue }) => {
      if (typeof newValue === 'number') return newValue * 10;
      return undefined;
    });
    store.count = 5;
    expect(store.count).toBe(50);
  });

  it('middleware sees context.source flowing through internal writes', () => {
    const { store, factory, client } = setup({});
    const seen: string[] = [];
    factory.use(({ context }) => {
      seen.push(context.source);
      return undefined;
    });
    store.foo = 'local-write';
    // Server fanout uses source: 'remote'
    client.simulateFanout('todo', 'task-1', { value: { title: 'hello' }, meta: { eTag: 'abc' } });
    // Connection state uses source: 'remote'
    client.simulateConnectionState('connected');

    expect(seen[0]).toBe('local');
    expect(seen.slice(1).every((s) => s === 'remote')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PINNED #3: Top-level deep-equal dedup. Equal write → no middleware fire,
// no effect re-fire.
// ──────────────────────────────────────────────────────────────────────────
describe('deep-equal dedup', () => {
  it('skips write entirely when newValue deep-equals current', () => {
    const { store, factory } = setup({ obj: { x: 1, y: 2 } });
    const mwFires = vi.fn(() => undefined);
    factory.use(mwFires);
    let effectFires = 0;
    effect(() => { JSON.stringify(store.obj); effectFires++; });
    expect(effectFires).toBe(1);

    // Structurally equal but new reference
    store.obj = { x: 1, y: 2 };
    expect(mwFires).not.toHaveBeenCalled();
    expect(effectFires).toBe(1);

    // Different — should fire
    store.obj = { x: 1, y: 3 };
    expect(mwFires).toHaveBeenCalledTimes(1);
    expect(effectFires).toBe(2);
  });

  it('skips identical primitive writes', () => {
    const { store, factory } = setup({ count: 5 });
    const mw = vi.fn(() => undefined);
    factory.use(mw);
    store.count = 5;
    expect(mw).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PINNED #4: Hierarchical reactivity — ancestor write fires descendant
// effects (Vue's standard property-chain tracking).
// ──────────────────────────────────────────────────────────────────────────
describe('hierarchical-notify (free from Vue)', () => {
  it('descendant-reading effect fires when ancestor object is replaced', () => {
    const { store } = setup({ resources: { todo: { 'task-1': { value: { title: 'orig' } } } } });
    const seen: string[] = [];
    effect(() => { seen.push(store.resources.todo['task-1'].value.title); });
    expect(seen).toEqual(['orig']);

    // Replace at .value
    store.resources.todo['task-1'].value = { title: 'replaced' };
    expect(seen).toEqual(['orig', 'replaced']);

    // Replace higher up — at the resource container
    store.resources.todo['task-1'] = { value: { title: 'higher-replace' } };
    expect(seen).toEqual(['orig', 'replaced', 'higher-replace']);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PINNED #5: Synced-state middleware emits transaction when user writes
// under resources.<rt>.<rid>.value.*
// ──────────────────────────────────────────────────────────────────────────
describe('synced-state middleware', () => {
  it('emits transaction with current eTag on local write under resources.*.value', async () => {
    // Seed with a subscribed-style resource (has meta.eTag).
    const { store, client } = setup({
      resources: {
        todo: {
          'task-1': {
            value: { title: 'original', status: 'todo' },
            meta: { eTag: 'eTag-v1' },
          },
        },
      },
    });

    store.resources.todo['task-1'].value.title = 'updated';

    // Wait for microtask scheduling to land the txn submission.
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    expect(client.txns).toHaveLength(1);
    expect(client.txns[0]).toMatchObject({
      rt: 'todo',
      rid: 'task-1',
      eTag: 'eTag-v1',
      value: { title: 'updated', status: 'todo' },
    });
    expect(client.txns[0].newETag).toBeTruthy();
  });

  it('does NOT emit transaction when no meta.eTag exists (never-subscribed resource)', async () => {
    const { store, client } = setup({});
    store.resources = { todo: { 'task-orphan': { value: { title: 'orphan' } } } };

    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    expect(client.txns).toHaveLength(0);
  });

  it('does NOT emit transaction for remote/rollback/computed writes', async () => {
    const { store, client } = setup({
      resources: {
        todo: { 'task-1': { value: { title: 'orig' }, meta: { eTag: 'eTag-v1' } } },
      },
    });

    // Simulate server fanout — should write through but NOT trigger a txn back.
    client.simulateFanout('todo', 'task-1', {
      value: { title: 'from-server' },
      meta: { eTag: 'eTag-v2' },
    });

    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    expect(client.txns).toHaveLength(0);
    expect(store.resources.todo['task-1'].value.title).toBe('from-server');
    expect(store.resources.todo['task-1'].meta.eTag).toBe('eTag-v2');
  });

  it('updates meta.eTag on committed outcome', async () => {
    const { store, client } = setup({
      resources: { todo: { 'task-1': { value: { title: 'orig' }, meta: { eTag: 'eTag-v1' } } } },
    });
    client.txnResponder = () => ({ resolution: 'committed', eTag: 'eTag-v2' });

    store.resources.todo['task-1'].value.title = 'changed';

    await vi.waitFor(() => {
      expect(store.resources.todo['task-1'].meta.eTag).toBe('eTag-v2');
    });
  });

  it('rolls back optimistic write on validation-failed outcome', async () => {
    const { store, client } = setup({
      resources: { todo: { 'task-1': { value: { title: 'orig' }, meta: { eTag: 'eTag-v1' } } } },
    });
    client.txnResponder = () => ({ resolution: 'validation-failed', errors: { bad: true } });

    store.resources.todo['task-1'].value.title = 'will-be-rolled-back';

    await vi.waitFor(() => {
      expect(store.resources.todo['task-1'].value.title).toBe('orig');
    });
  });

  it('writes server snapshot on use-server outcome', async () => {
    const { store, client } = setup({
      resources: { todo: { 'task-1': { value: { title: 'orig' }, meta: { eTag: 'eTag-v1' } } } },
    });
    client.txnResponder = () => ({
      resolution: 'use-server',
      snapshot: { value: { title: 'server-wins' }, meta: { eTag: 'eTag-srv' } },
    });

    store.resources.todo['task-1'].value.title = 'local-attempt';

    await vi.waitFor(() => {
      expect(store.resources.todo['task-1'].value.title).toBe('server-wins');
      expect(store.resources.todo['task-1'].meta.eTag).toBe('eTag-srv');
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PINNED #6: effectScope-driven auto-subscribe.
// ──────────────────────────────────────────────────────────────────────────
describe('auto-subscribe via effectScope', () => {
  it('subscribes on first resource read inside a scope', () => {
    const { store, client } = setup({});
    const scope = effectScope();
    scope.run(() => {
      effect(() => {
        // Read at descendant depth — should still trigger refcount on (rt, rid).
        void store.resources?.todo?.['task-1']?.value?.title;
      });
    });
    expect(client.subscribes).toEqual([{ rt: 'todo', rid: 'task-1' }]);
  });

  it('dedups multiple reads of the same resource in the same scope', () => {
    const { store, client } = setup({});
    const scope = effectScope();
    scope.run(() => {
      effect(() => { void store.resources?.todo?.['task-1']?.value?.title; });
      effect(() => { void store.resources?.todo?.['task-1']?.value?.status; });
      effect(() => { void store.resources?.todo?.['task-1']?.meta; });
    });
    expect(client.subscribes).toEqual([{ rt: 'todo', rid: 'task-1' }]);
  });

  it('subscribes once per distinct resource', () => {
    const { store, client } = setup({});
    const scope = effectScope();
    scope.run(() => {
      effect(() => { void store.resources?.todo?.['task-1']?.value; });
      effect(() => { void store.resources?.todo?.['task-2']?.value; });
      effect(() => { void store.resources?.note?.['note-1']?.value; });
    });
    expect(client.subscribes).toEqual([
      { rt: 'todo', rid: 'task-1' },
      { rt: 'todo', rid: 'task-2' },
      { rt: 'note', rid: 'note-1' },
    ]);
  });

  it('unsubscribes after scope.stop() + grace period', async () => {
    const { store, client } = setup({});
    const scope = effectScope();
    scope.run(() => {
      effect(() => { void store.resources?.todo?.['task-1']?.value; });
    });
    expect(client.subscribes).toHaveLength(1);
    expect(client.unsubscribes).toHaveLength(0);

    scope.stop();
    // Grace period is 50ms in test setup
    expect(client.unsubscribes).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(client.unsubscribes).toEqual([{ rt: 'todo', rid: 'task-1' }]);
  });

  it('grace-cancel: new binding during grace period prevents unsubscribe', async () => {
    const { store, client } = setup({});
    const scope1 = effectScope();
    scope1.run(() => { effect(() => { void store.resources?.todo?.['task-1']?.value; }); });
    scope1.stop();

    // Within grace, a new scope binds the same resource
    await new Promise((r) => setTimeout(r, 20));
    const scope2 = effectScope();
    scope2.run(() => { effect(() => { void store.resources?.todo?.['task-1']?.value; }); });

    // Let the original grace timer fire — should be canceled
    await new Promise((r) => setTimeout(r, 80));
    expect(client.unsubscribes).toEqual([]); // grace canceled by re-bind
    expect(client.subscribes).toHaveLength(1); // single subscribe, refcount survived

    // Now stop the second scope and let its grace fire
    scope2.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(client.unsubscribes).toEqual([{ rt: 'todo', rid: 'task-1' }]);
  });

  it('does NOT subscribe for reads outside any effect/scope', () => {
    const { store, client } = setup({ resources: { todo: { 'task-1': { value: { title: 'x' } } } } });
    // Read outside any scope/effect — no refcount, no subscribe
    void store.resources.todo['task-1'].value.title;
    expect(client.subscribes).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PINNED #7: Connection state surfaces at store.lmz.connection.*
// ──────────────────────────────────────────────────────────────────────────
describe('connection state', () => {
  it('writes through to store.lmz.connection.* on state change', () => {
    const { store, client } = setup({});
    client.simulateConnectionState('connecting');
    expect(store.lmz.connection.state).toBe('connecting');
    expect(store.lmz.connection.connected).toBe(false);

    client.simulateConnectionState('connected');
    expect(store.lmz.connection.state).toBe('connected');
    expect(store.lmz.connection.connected).toBe(true);
    expect(typeof store.lmz.connection.lastConnectedAt).toBe('number');
  });

  it('a binding on store.lmz.connection.connected re-fires on state change', () => {
    const { store, client } = setup({});
    const seen: boolean[] = [];
    effect(() => { seen.push(store.lmz?.connection?.connected ?? false); });

    client.simulateConnectionState('connecting');
    client.simulateConnectionState('connected');
    client.simulateConnectionState('reconnecting');

    expect(seen).toEqual([false, false, true, false]); // initial(undefined→false), connecting, connected, reconnecting
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PINNED #8: Server fanout writes through with remote context (middleware
// does not re-emit transaction).
// ──────────────────────────────────────────────────────────────────────────
describe('server fanout', () => {
  it('writes value + meta on resource update push', () => {
    const { store, client } = setup({});
    client.simulateFanout('todo', 'task-99', {
      value: { title: 'pushed-from-server', completed: false },
      meta: { eTag: 'push-eTag' },
    });
    expect(store.resources.todo['task-99'].value).toEqual({ title: 'pushed-from-server', completed: false });
    expect(store.resources.todo['task-99'].meta).toEqual({ eTag: 'push-eTag' });
  });

  it('a descendant-bound effect re-fires after fanout writes through', () => {
    const { store, client } = setup({});
    const seen: any[] = [];
    effect(() => {
      seen.push(store.resources?.todo?.['task-99']?.value?.title);
    });

    client.simulateFanout('todo', 'task-99', {
      value: { title: 'first-push' },
      meta: { eTag: 'e1' },
    });
    client.simulateFanout('todo', 'task-99', {
      value: { title: 'second-push' },
      meta: { eTag: 'e2' },
    });

    expect(seen).toEqual([undefined, 'first-push', 'second-push']);
  });

  it('fanout with structurally-equal value does not re-fire effect (deep-equal dedup)', () => {
    const { store, client } = setup({});
    client.simulateFanout('todo', 'task-1', { value: { title: 'x' }, meta: { eTag: 'e1' } });
    let fires = 0;
    effect(() => { void store.resources?.todo?.['task-1']?.value?.title; fires++; });
    expect(fires).toBe(1);

    // Identical structural value — should be deduped
    client.simulateFanout('todo', 'task-1', { value: { title: 'x' }, meta: { eTag: 'e1' } });
    expect(fires).toBe(1);

    // Different — should fire
    client.simulateFanout('todo', 'task-1', { value: { title: 'y' }, meta: { eTag: 'e2' } });
    expect(fires).toBe(2);
  });
});
