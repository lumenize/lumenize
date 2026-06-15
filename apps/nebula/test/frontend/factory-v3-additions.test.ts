/**
 * v3 factory additions — the spike-port cleanup items, correctness items, and
 * test-gap fills called out in tasks/nebula-frontend.md § Phase 5.3.7-v3 that
 * the spike's carried-forward suites don't cover. These are NEW (not ported), so
 * each was mutation-checked (comment out the targeted code path → the test goes
 * red) per testing.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { effect, effectScope } from '@vue/reactivity';
import { setDebugSink, clearDebugSink, type DebugSink } from '@lumenize/debug';
import { createNebulaStore } from '../../src/frontend/create-nebula-client';
import { MockClient } from './mock-client';

type Entry = { level: string; namespace: string; message: string; data?: unknown };

function setup(initialState: Record<string, any> = {}) {
  const client = new MockClient({ quietMs: 0 });
  const factory = createNebulaStore(client, { initialState, unsubscribeGraceMs: 50 });
  return { client, factory, store: factory.store };
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

// ──────────────────────────────────────────────────────────────────────────
// Test-gap fill (a): store.ui / store.app pre-seed.
// ──────────────────────────────────────────────────────────────────────────
describe('ui/app pre-seed', () => {
  it('pre-seeds store.ui and store.app as reactive empty objects', () => {
    const { store } = setup({});
    expect(store.ui).toEqual({});
    expect(store.app).toEqual({});
  });

  it('does NOT deep auto-vivify under ui/app (only resources.* vivifies)', () => {
    const { store } = setup({});
    expect(store.ui.nothingHere).toBeUndefined();
    expect(store.app.alsoNothing?.deeper).toBeUndefined();
    // Reading a missing key under ui/app left no vivified container behind.
    expect(store.ui).toEqual({});
    expect(store.app).toEqual({});
  });

  it('writes to ui/app never reach the synced-state middleware (no transaction)', async () => {
    const { store, client } = setup({});
    store.ui = { panelOpen: true };
    store.ui.panelOpen = false;
    store.app = { count: 1 };
    store.app.count = 2;
    await flushMicrotasks();
    expect(client.txns).toHaveLength(0);
    expect(store.ui.panelOpen).toBe(false);
    expect(store.app.count).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Cleanup: synced-state middleware warns (and drops) when no meta.eTag exists;
// writes to meta.* pass through without submitting.
// ──────────────────────────────────────────────────────────────────────────
describe('synced-state middleware edge cases', () => {
  let entries: Entry[];
  const sink: DebugSink = (e) => entries.push(e as Entry);
  beforeEach(() => { entries = []; setDebugSink(sink); });
  afterEach(() => { clearDebugSink(); });

  const warns = () =>
    entries.filter((e) => e.namespace === 'lumenize.nebula-frontend' && e.level === 'warn');

  it('warns and drops a .value write when the resource has no meta.eTag', async () => {
    const { store, client } = setup({
      resources: { todo: { orphan: { value: { title: 'x' } } } }, // no meta.eTag
    });
    store.resources.todo.orphan.value.title = 'edited';
    await flushMicrotasks();
    expect(client.txns).toHaveLength(0);
    expect(warns().some((e) => /meta\.eTag/.test(e.message))).toBe(true);
  });

  it('writes to meta.* pass through without submitting a transaction', async () => {
    const { store, client } = setup({
      resources: { todo: { t1: { value: { title: 'x' }, meta: { eTag: 'e1' } } } },
    });
    store.resources.todo.t1.meta.eTag = 'user-tampered';
    await flushMicrotasks();
    expect(client.txns).toHaveLength(0); // meta path doesn't match the value regex
    expect(store.resources.todo.t1.meta.eTag).toBe('user-tampered'); // passes through
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test-gap fill (b): auto-subscribe error path.
// ──────────────────────────────────────────────────────────────────────────
describe('auto-subscribe error path', () => {
  let entries: Entry[];
  const sink: DebugSink = (e) => entries.push(e as Entry);
  beforeEach(() => { entries = []; setDebugSink(sink); });
  afterEach(() => { clearDebugSink(); });

  it('a failed subscribe warns, leaves the path undefined, and raises no unhandled rejection', async () => {
    const { store, client } = setup({});
    client.subscribeResponder = async () => { throw new Error('no read permission'); };

    const scope = effectScope();
    scope.run(() => {
      effect(() => { void store.resources?.bad?.['rid-x']?.value; });
    });

    // Subscribe was attempted (refcount 0→1).
    expect(client.subscribes).toEqual([{ rt: 'bad', rid: 'rid-x' }]);
    // Path stays undefined (no snapshot landed).
    expect(store.resources.bad['rid-x'].value).toBeUndefined();
    // The rejection is caught + surfaced as a debug warning (not swallowed).
    await vi.waitFor(() => {
      const warns = entries.filter(
        (e) => e.namespace === 'lumenize.nebula-frontend' && e.level === 'warn',
      );
      expect(warns.some((e) => /auto-subscribe failed/.test(e.message))).toBe(true);
    });

    // Refcount is still tracked → scope dispose unsubscribes after grace
    // (cleanup happens via the normal scope lifecycle, even on a failed subscribe).
    scope.stop();
    await vi.waitFor(() => {
      expect(client.unsubscribes).toEqual([{ rt: 'bad', rid: 'rid-x' }]);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Correctness: re-entrancy guard on the middleware chain.
// ──────────────────────────────────────────────────────────────────────────
describe('re-entrancy guard', () => {
  it('a middleware UNCONDITIONALLY writing back to its OWN path does not infinite-loop', () => {
    const { store, factory } = setup({ x: 0 });
    let calls = 0;
    factory.use(({ path, context }) => {
      if (path === 'x' && context.source === 'local') {
        calls++;
        // A DIFFERENT value each fire — without the re-entrancy guard this
        // re-enters the chain endlessly (deep-equal dedup can't stop it since
        // the value keeps changing) → stack overflow. The guard makes the
        // same-path write-back skip the chain (direct to Vue).
        store.x = 100 + calls;
      }
      return undefined;
    });
    expect(() => { store.x = 5; }).not.toThrow();
    // Middleware ran once for the outer write; the same-path write-back skipped
    // the chain (so `calls` stays 1), and the outer write's value wins.
    expect(calls).toBe(1);
    expect(store.x).toBe(5);
  });

  it('a middleware writing to a DIFFERENT resource path fires that path\'s chain exactly once and submits it', async () => {
    const { store, client, factory } = setup({
      resources: {
        todo: {
          a: { value: { title: 'A' }, meta: { eTag: 'eA' } },
          b: { value: { title: 'B' }, meta: { eTag: 'eB' } },
        },
      },
    });
    const seen: string[] = [];
    factory.use(({ path, context }) => {
      if (context.source !== 'local') return undefined;
      seen.push(path);
      if (path === 'resources.todo.a.value.title') {
        // Cross-path write-back — must NOT be suppressed by the guard.
        store.resources.todo.b.value.title = 'B-edited';
      }
      return undefined;
    });

    store.resources.todo.a.value.title = 'A-edited';
    await flushMicrotasks();

    // Each path's middleware fired exactly once (a guard keyed too coarsely —
    // a global flag or prefix — would suppress b's chain and fail this).
    expect(seen.filter((p) => p === 'resources.todo.a.value.title')).toHaveLength(1);
    expect(seen.filter((p) => p === 'resources.todo.b.value.title')).toHaveLength(1);
    // Both resources submitted.
    expect(client.txns.filter((t) => t.rid === 'a')).toHaveLength(1);
    expect(client.txns.filter((t) => t.rid === 'b')).toHaveLength(1);
    // Both painted optimistically.
    expect(store.resources.todo.a.value.title).toBe('A-edited');
    expect(store.resources.todo.b.value.title).toBe('B-edited');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// P8b: orgTree surfacing — the factory mirrors the tree to store.lmz.orgTree.value.
// ──────────────────────────────────────────────────────────────────────────
describe('orgTree surfacing', () => {
  it('pre-seeds store.lmz.orgTree and mirrors tree deliveries to store.lmz.orgTree.value', () => {
    const { store, client } = setup({});
    // Seeded so first-paint reads are defined; no value until first delivery.
    expect(store.lmz.orgTree).toEqual({});
    expect(store.lmz.orgTree.value).toBeUndefined();

    const tree = {
      nodes: new Map([[1, { slug: 'root', label: 'Root' }]]),
      edges: new Set<string>(),
      permissions: new Map(),
    };
    client.simulateOrgTree(tree);

    expect(store.lmz.orgTree.value.nodes.get(1).slug).toBe('root');
    expect(store.lmz.orgTree.value.nodes).toBeInstanceOf(Map);
  });

  it('a write under lmz.orgTree never reaches the synced-state middleware (no transaction)', async () => {
    const { store, client } = setup({});
    store.lmz.orgTree.value = { nodes: new Map(), edges: new Set(), permissions: new Map() };
    await flushMicrotasks();
    expect(client.txns).toHaveLength(0); // lmz.* structurally never matches the resources regex
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Cleanup: connection-state replay at creation (order-irrelevant).
// ──────────────────────────────────────────────────────────────────────────
describe('connection-state replay', () => {
  it('replays the client\'s current connection state at creation (not transitions-only)', () => {
    const client = new MockClient({ quietMs: 0 });
    // Drive to 'connected' BEFORE the factory exists — a transitions-only
    // implementation would never see this and would leave state 'disconnected'.
    client.simulateConnectionState('connected');

    const factory = createNebulaStore(client, {});
    expect(factory.store.lmz.connection.state).toBe('connected');
    expect(factory.store.lmz.connection.connected).toBe(true);
    expect(typeof factory.store.lmz.connection.lastConnectedAt).toBe('number');
  });
});
