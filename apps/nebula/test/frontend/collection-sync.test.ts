/**
 * Collection-sync (M10, Option A) — property tests per
 * `tasks/archive/factory-collection-sync.md`, ported to the jsdom `frontend` project.
 * The MockClient runs the real conflict-outcome engine (quietMs 0 so rapid
 * mutations coalesce on a microtask); the factory injects its store adapter via
 * `bindStore`. Each `it` maps to one item of the spec's checklist.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNebulaStore } from '../../src/frontend/create-nebula-client';
import { MockClient } from './mock-client';

function setup(value: Record<string, any>) {
  const client = new MockClient({ quietMs: 0 });
  const factory = createNebulaStore(client, {
    initialState: {
      resources: { doc: { d1: { value, meta: { eTag: 'eTag-v1' } } } },
    },
  });
  return { client, factory, store: factory.store };
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('Map mutators submit transactions', () => {
  it('Map.set produces exactly one transaction carrying the full post-mutation value, and the commit writes back', async () => {
    const { store, client } = setup({ title: 'doc', tags: new Map([['a', 1]]) });
    client.txnResponder = () => ({ result: 'committed', eTag: 'eTag-v2' });

    store.resources.doc.d1.value.tags.set('b', 2);
    await flushMicrotasks();

    expect(client.txns).toHaveLength(1);
    const submitted = client.txns[0]!.value as { title: string; tags: Map<string, number> };
    expect(submitted.title).toBe('doc');
    expect(submitted.tags).toBeInstanceOf(Map);
    expect([...submitted.tags.entries()]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    await vi.waitFor(() => {
      expect(store.resources.doc.d1.meta.eTag).toBe('eTag-v2'); // round-trip writeback
    });
  });

  it('Map.delete and Map.clear each submit once with the post-mutation value', async () => {
    const { store, client } = setup({ tags: new Map([['a', 1], ['b', 2]]) });

    store.resources.doc.d1.value.tags.delete('a');
    await flushMicrotasks();
    expect(client.txns).toHaveLength(1);
    expect([...(client.txns[0]!.value as any).tags.keys()]).toEqual(['b']);

    store.resources.doc.d1.value.tags.clear();
    await flushMicrotasks();
    expect(client.txns).toHaveLength(2);
    expect((client.txns[1]!.value as any).tags.size).toBe(0);
  });
});

describe('Set mutators submit transactions', () => {
  it('Set.add / Set.delete / Set.clear each submit once', async () => {
    const { store, client } = setup({ labels: new Set(['x']) });

    store.resources.doc.d1.value.labels.add('y');
    await flushMicrotasks();
    expect(client.txns).toHaveLength(1);
    expect([...(client.txns[0]!.value as any).labels]).toEqual(['x', 'y']);

    store.resources.doc.d1.value.labels.delete('x');
    await flushMicrotasks();
    expect(client.txns).toHaveLength(2);
    expect([...(client.txns[1]!.value as any).labels]).toEqual(['y']);

    store.resources.doc.d1.value.labels.clear();
    await flushMicrotasks();
    expect(client.txns).toHaveLength(3);
    expect((client.txns[2]!.value as any).labels.size).toBe(0);
  });
});

describe('receiver binding — non-mutating reads work through the factory Proxy', () => {
  it('get / has / size / forEach / for…of / keys never throw "incompatible receiver" and return correct values', () => {
    const { store } = setup({
      tags: new Map<string, number>([['a', 1], ['b', 2]]),
      labels: new Set(['x', 'y']),
    });
    const tags = store.resources.doc.d1.value.tags;
    const labels = store.resources.doc.d1.value.labels;

    expect(tags.get('a')).toBe(1);
    expect(tags.has('b')).toBe(true);
    expect(tags.size).toBe(2);
    const viaForEach: string[] = [];
    tags.forEach((_v: number, k: string) => viaForEach.push(k));
    expect(viaForEach).toEqual(['a', 'b']);
    expect([...tags.keys()]).toEqual(['a', 'b']);
    const viaForOf: Array<[string, number]> = [];
    for (const entry of tags) viaForOf.push(entry);
    expect(viaForOf).toEqual([
      ['a', 1],
      ['b', 2],
    ]);

    expect(labels.has('x')).toBe(true);
    expect(labels.size).toBe(2);
    expect([...labels.values()]).toEqual(['x', 'y']);
  });
});

describe('deep nesting — wrapping recurses into collections anywhere in the value', () => {
  it('a Map at value.meta.labels syncs', async () => {
    const { store, client } = setup({ meta: { labels: new Map([['k', 'v']]) } });
    store.resources.doc.d1.value.meta.labels.set('k2', 'v2');
    await flushMicrotasks();
    expect(client.txns).toHaveLength(1);
    expect([...(client.txns[0]!.value as any).meta.labels.entries()]).toEqual([
      ['k', 'v'],
      ['k2', 'v2'],
    ]);
  });

  it('a Set inside an array element syncs', async () => {
    const { store, client } = setup({ items: [{ name: 'i0', tags: new Set(['t']) }] });
    store.resources.doc.d1.value.items[0].tags.add('t2');
    await flushMicrotasks();
    expect(client.txns).toHaveLength(1);
    expect([...(client.txns[0]!.value as any).items[0].tags]).toEqual(['t', 't2']);
  });
});

describe('parity with property writes — abort-capable middleware (the A-over-B differentiator)', () => {
  it('a middleware abort (throw) prevents the local mutation AND the submission, same as a property write', async () => {
    const { store, client, factory } = setup({ title: 'doc', tags: new Map([['a', 1]]) });
    factory.use(({ path }) => {
      if (path.endsWith('.tags') || path.endsWith('.title')) throw new Error('blocked');
      return undefined;
    });

    expect(() => store.resources.doc.d1.value.tags.set('b', 2)).toThrow('blocked');
    expect(store.resources.doc.d1.value.tags.has('b')).toBe(false); // no local mutation
    expect(() => {
      store.resources.doc.d1.value.title = 'nope';
    }).toThrow('blocked');
    expect(store.resources.doc.d1.value.title).toBe('doc');
    await flushMicrotasks();
    expect(client.txns).toHaveLength(0); // no submission either way
  });

  it('a middleware transform substitutes the applied AND submitted collection value', async () => {
    const { store, client, factory } = setup({ tags: new Map([['a', 1]]) });
    factory.use(({ path, newValue }) => {
      if (path.endsWith('.tags') && newValue instanceof Map) {
        return new Map([...newValue.entries(), ['stamped', 99]]);
      }
      return undefined;
    });

    store.resources.doc.d1.value.tags.set('b', 2);
    await flushMicrotasks();

    expect(store.resources.doc.d1.value.tags.get('stamped')).toBe(99); // applied locally
    expect(client.txns).toHaveLength(1);
    expect((client.txns[0]!.value as any).tags.get('stamped')).toBe(99); // and submitted
  });

  it('middleware sees mutator-driven invocations with the collection path and pre/post snapshots', async () => {
    const { store, factory } = setup({ tags: new Map([['a', 1]]) });
    const seen: Array<{ path: string; oldValue: unknown; newValue: unknown }> = [];
    factory.use(({ path, oldValue, newValue, context }) => {
      // Only the user-driven mutation — the commit's meta.eTag writeback also
      // flows through middleware (as a 'remote' write), which is not under test.
      if (context.source === 'local') seen.push({ path, oldValue, newValue });
      return undefined;
    });

    store.resources.doc.d1.value.tags.set('b', 2);
    await flushMicrotasks();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('resources.doc.d1.value.tags'); // the owning collection's path
    expect([...(seen[0]!.oldValue as Map<string, number>).keys()]).toEqual(['a']);
    expect([...(seen[0]!.newValue as Map<string, number>).keys()]).toEqual(['a', 'b']);
  });
});

describe('debounce coalescing — collection edits share the submission path', () => {
  it('N rapid collection mutations on one resource coalesce to one transaction', async () => {
    const { store, client } = setup({ tags: new Map<string, number>() });
    for (let i = 0; i < 10; i++) store.resources.doc.d1.value.tags.set(`k${i}`, i);
    await flushMicrotasks();
    expect(client.txns).toHaveLength(1);
    expect((client.txns[0]!.value as any).tags.size).toBe(10);
  });
});

describe('no echo', () => {
  it('a remote fanout writing a collection value does not trigger a resubmit', async () => {
    const { store, client } = setup({ tags: new Map([['a', 1]]) });
    client.simulateFanout('doc', 'd1', {
      value: { tags: new Map([['from-server', 7]]) },
      meta: { eTag: 'eTag-v2' },
    });
    await flushMicrotasks();
    expect(client.txns).toHaveLength(0);
    expect(store.resources.doc.d1.value.tags.get('from-server')).toBe(7);
  });
});

describe('array regression — arrays still sync via the set trap', () => {
  it('push and splice each emit a (coalesced) transaction', async () => {
    const { store, client } = setup({ list: [1, 2] });
    store.resources.doc.d1.value.list.push(3);
    await flushMicrotasks();
    expect(client.txns).toHaveLength(1);
    expect((client.txns[0]!.value as any).list).toEqual([1, 2, 3]);

    store.resources.doc.d1.value.list.splice(0, 1);
    await flushMicrotasks();
    expect(client.txns).toHaveLength(2);
    expect((client.txns[1]!.value as any).list).toEqual([2, 3]);
  });
});

describe('mutation during iteration', () => {
  it('deleting every key while iterating keys() coalesces to one transaction and empties the collection everywhere', async () => {
    const { store, client } = setup({ tags: new Map([['a', 1], ['b', 2], ['c', 3]]) });
    const tags = store.resources.doc.d1.value.tags;
    for (const k of tags.keys()) tags.delete(k);
    await flushMicrotasks();
    expect(tags.size).toBe(0); // locally empty
    expect(client.txns).toHaveLength(1); // one submission, not N
    expect((client.txns[0]!.value as any).tags.size).toBe(0); // empty on the mock too
  });
});

describe('no-op mutators produce zero submissions', () => {
  it('add(existing), set(k, sameValue), delete(absent), clear(empty) — parity with the set-trap deep-equals skip', async () => {
    const { store, client, factory } = setup({
      tags: new Map([['a', { n: 1 }]]),
      labels: new Set(['x']),
      empty: new Map(),
    });
    const seen: string[] = [];
    factory.use(({ path }) => {
      seen.push(path);
      return undefined;
    });

    const v = store.resources.doc.d1.value;
    v.labels.add('x'); // existing element
    v.tags.set('a', { n: 1 }); // deep-equal value
    expect(v.tags.delete('absent')).toBe(false);
    expect(v.labels.delete('absent')).toBe(false);
    v.empty.clear(); // clear on empty
    await flushMicrotasks();

    expect(client.txns).toHaveLength(0);
    expect(seen).toHaveLength(0); // middleware never ran (same as dedup'd property writes)
  });
});

describe('rich-type round-trip (the Phase 5 invariant through the factory)', () => {
  it('a value with Map, Set, Date, and a cycle survives mutate → submit → fanout → re-read', async () => {
    const cyclic: Record<string, any> = {
      tags: new Map([['a', 1]]),
      labels: new Set(['x']),
      createdAt: new Date(1700000000000),
    };
    cyclic.self = cyclic;
    const { store, client } = setup(cyclic);

    store.resources.doc.d1.value.tags.set('b', 2);
    await flushMicrotasks();
    expect(client.txns).toHaveLength(1);
    const sent = client.txns[0]!.value as any;
    expect(sent.tags).toBeInstanceOf(Map);
    expect(sent.labels).toBeInstanceOf(Set);
    expect(sent.createdAt).toBeInstanceOf(Date);
    expect(sent.self).toBe(sent); // cycle preserved through the clone

    // Server echoes the committed value back as a fanout.
    client.simulateFanout('doc', 'd1', {
      value: structuredClone(sent),
      meta: { eTag: 'eTag-v2' },
    });
    await flushMicrotasks();
    const after = store.resources.doc.d1.value;
    expect(after.tags.get('b')).toBe(2);
    expect(after.labels.has('x')).toBe(true);
    expect(after.createdAt.getTime()).toBe(1700000000000);
    expect(after.self.tags.get('b')).toBe(2); // cycle still walks
    expect(client.txns).toHaveLength(1); // the fanout did not echo a resubmit
  });
});
