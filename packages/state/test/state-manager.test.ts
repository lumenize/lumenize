import { describe, it, expect, vi } from 'vitest';
import { createState, StateManager, ComputedSelfReferenceError } from '../src/index';
import type { Middleware } from '../src/index';

describe('createState / StateManager construction', () => {
  it('createState returns a StateManager', () => {
    const state = createState();
    expect(state).toBeInstanceOf(StateManager);
  });

  it('seeds initial state', () => {
    const state = createState({ count: 5, nested: { foo: 'bar' } });
    expect(state.getState('count')).toBe(5);
    expect(state.getState('nested.foo')).toBe('bar');
  });

  it('does not share state between instances (no singleton)', () => {
    const a = createState({ count: 1 });
    const b = createState({ count: 2 });
    a.setState('count', 99);
    expect(b.getState('count')).toBe(2);
  });
});

describe('getState / setState', () => {
  it('returns default when path missing', () => {
    const state = createState();
    expect(state.getState('missing', 'fallback')).toBe('fallback');
  });

  it('writes and reads scalar', () => {
    const state = createState();
    state.setState('count', 7);
    expect(state.getState('count')).toBe(7);
  });

  it('writes and reads nested path, creating intermediates', () => {
    const state = createState();
    state.setState('a.b.c.d', 'deep');
    expect(state.getState('a.b.c.d')).toBe('deep');
  });

  it('preserves siblings when writing nested path', () => {
    const state = createState();
    state.setState('a.b', 1);
    state.setState('a.c', 2);
    expect(state.getState('a.b')).toBe(1);
    expect(state.getState('a.c')).toBe(2);
  });

  it('returns default when traversal hits a non-object', () => {
    const state = createState();
    state.setState('a', 5);
    expect(state.getState('a.b.c', 'fallback')).toBe('fallback');
  });

  it('ignores invalid paths', () => {
    const state = createState();
    state.setState('', 'x');
    state.setState('a..b', 'y');
    expect(state.getState('', 'fallback')).toBe('fallback');
    expect(state.getState('a..b', 'fallback')).toBe('fallback');
  });
});

describe('subscribe — three-direction notify', () => {
  it('fires on exact write', () => {
    const state = createState();
    const cb = vi.fn();
    state.subscribe('a.b.c', cb);
    state.setState('a.b.c', 'hello');
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('hello', undefined, 'a.b.c');
  });

  it('fires subscriber on ancestor write (bulk snapshot case)', () => {
    const state = createState();
    const cb = vi.fn();
    state.subscribe('a.b.c', cb);
    state.setState('a.b', { c: 'hello' });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('hello', undefined, 'a.b');
  });

  it('fires subscriber on descendant write (granular field-change case)', () => {
    const state = createState({ a: { b: { c: 'initial' } } });
    const cb = vi.fn();
    state.subscribe('a.b', cb);
    state.setState('a.b.c', 'updated');
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][0]).toEqual({ c: 'updated' });
    expect(cb.mock.calls[0][2]).toBe('a.b.c');
  });

  it('skips ancestor-write fanout when drilled value is unchanged (deep-equals dedup)', () => {
    const state = createState({ resources: { todo: { 'task-42': { title: 'A', body: 'X' } } } });
    const titleCb = vi.fn();
    const bodyCb = vi.fn();
    state.subscribe('resources.todo.task-42.title', titleCb);
    state.subscribe('resources.todo.task-42.body', bodyCb);
    // Bulk-snapshot push with body unchanged
    state.setState('resources.todo.task-42', { title: 'B', body: 'X' });
    expect(titleCb).toHaveBeenCalledOnce();
    expect(bodyCb).not.toHaveBeenCalled();
  });

  it('hierarchical=false fires only on exact match', () => {
    const state = createState();
    const cb = vi.fn();
    state.subscribe('a.b', cb, false);
    state.setState('a.b.c', 'descendant write');
    state.setState('a', { b: 'ancestor write' });
    expect(cb).not.toHaveBeenCalled();
    state.setState('a.b', 'exact');
    expect(cb).toHaveBeenCalledOnce();
  });

  it('disposer removes subscription', () => {
    const state = createState();
    const cb = vi.fn();
    const unsub = state.subscribe('count', cb);
    state.setState('count', 1);
    unsub();
    state.setState('count', 2);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('does not fire when write is dedup-equal to current value', () => {
    const state = createState({ count: 5 });
    const cb = vi.fn();
    state.subscribe('count', cb);
    state.setState('count', 5);
    expect(cb).not.toHaveBeenCalled();
  });

  it('isolates subscriber throws — others still fire', () => {
    const state = createState();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.subscribe('count', () => {
      throw new Error('boom');
    });
    const good = vi.fn();
    state.subscribe('count', good);
    state.setState('count', 1);
    expect(good).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});

describe('middleware', () => {
  it('constructor-installed middleware sees writes', () => {
    const seen: Array<{ path: string; newValue: unknown }> = [];
    const mw: Middleware = ({ path, newValue }) => {
      seen.push({ path, newValue });
    };
    const state = createState({}, [mw]);
    state.setState('count', 7);
    expect(seen).toEqual([{ path: 'count', newValue: 7 }]);
  });

  it('middleware can substitute the value by returning non-undefined', () => {
    const doubler: Middleware = ({ newValue }) => (typeof newValue === 'number' ? newValue * 2 : undefined);
    const state = createState({}, [doubler]);
    state.setState('count', 3);
    expect(state.getState('count')).toBe(6);
  });

  it('returning undefined leaves newValue unchanged', () => {
    const passthrough: Middleware = () => undefined;
    const state = createState({}, [passthrough]);
    state.setState('count', 3);
    expect(state.getState('count')).toBe(3);
  });

  it('state.use installs middleware post-construction and returns a remover', () => {
    const state = createState();
    const calls: string[] = [];
    const mw: Middleware = ({ path }) => {
      calls.push(path);
    };
    const remove = state.use(mw);
    state.setState('a', 1);
    expect(calls).toEqual(['a']);
    remove();
    state.setState('b', 2);
    expect(calls).toEqual(['a']);
  });

  it('isolates middleware throws — write still applies', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = createState();
    state.use(() => {
      throw new Error('mw boom');
    });
    state.setState('count', 1);
    expect(state.getState('count')).toBe(1);
    errorSpy.mockRestore();
  });
});

describe('track()', () => {
  it('collects every getState path read inside fn', () => {
    const state = createState({ a: 1, b: 2, c: 3 });
    const { result, deps } = state.track(() => {
      const a = state.getState('a') as number;
      const b = state.getState('b') as number;
      return a + b;
    });
    expect(result).toBe(3);
    expect(deps.sort()).toEqual(['a', 'b']);
  });

  it('skips dep collection when third arg to getState is false', () => {
    const state = createState({ a: 1, b: 2 });
    const { deps } = state.track(() => {
      state.getState('a');
      state.getState('b', undefined, false);
    });
    expect(deps).toEqual(['a']);
  });

  it('restores outer track on nested calls', () => {
    const state = createState({ a: 1, b: 2 });
    const { deps: outer } = state.track(() => {
      state.getState('a');
      state.track(() => {
        state.getState('b');
      });
      state.getState('a');
    });
    expect(outer).toEqual(['a']);
  });

  it('isolated=true returns empty deps and shields the outer track', () => {
    const state = createState({ a: 1, b: 2 });
    const { deps: outer } = state.track(() => {
      state.getState('a');
      const inner = state.track(
        () => {
          state.getState('b');
        },
        true,
      );
      expect(inner.deps).toEqual([]);
    });
    expect(outer).toEqual(['a']);
  });
});

describe('executeBatch', () => {
  it('coalesces multiple writes to same path to last-write-wins', () => {
    const state = createState();
    const cb = vi.fn();
    state.subscribe('count', cb);
    state.executeBatch(() => {
      state.setState('count', 1);
      state.setState('count', 2);
      state.setState('count', 3);
    });
    expect(state.getState('count')).toBe(3);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('flushes once per path at end of batch', () => {
    const state = createState();
    const aCb = vi.fn();
    const bCb = vi.fn();
    state.subscribe('a', aCb);
    state.subscribe('b', bCb);
    state.executeBatch(() => {
      state.setState('a', 1);
      state.setState('b', 1);
      state.setState('a', 2);
    });
    expect(aCb).toHaveBeenCalledOnce();
    expect(bCb).toHaveBeenCalledOnce();
    expect(aCb.mock.calls[0][0]).toBe(2);
  });

  it('supports Promise-returning callbacks', async () => {
    const state = createState();
    const cb = vi.fn();
    state.subscribe('count', cb);
    let resolveInner!: () => void;
    const inner = new Promise<void>((res) => {
      resolveInner = res;
    });
    const batchPromise = state.executeBatch(async () => {
      state.setState('count', 1);
      await inner;
      state.setState('count', 2);
    });
    expect(cb).not.toHaveBeenCalled(); // still batching
    resolveInner();
    await batchPromise;
    expect(state.getState('count')).toBe(2);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('Promise rejection still closes the batch', async () => {
    const state = createState();
    await expect(
      state.executeBatch(async () => {
        state.setState('a', 1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Batch closed: subsequent setState fires synchronously
    const cb = vi.fn();
    state.subscribe('b', cb);
    state.setState('b', 1);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('re-entrant executeBatch runs callback inline', () => {
    const state = createState();
    const cb = vi.fn();
    state.subscribe('count', cb);
    state.executeBatch(() => {
      state.executeBatch(() => {
        state.setState('count', 1);
        state.setState('count', 2);
      });
    });
    expect(state.getState('count')).toBe(2);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('synchronous throw inside batch closes the batch', () => {
    const state = createState();
    expect(() =>
      state.executeBatch(() => {
        state.setState('a', 1);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const cb = vi.fn();
    state.subscribe('b', cb);
    state.setState('b', 1);
    expect(cb).toHaveBeenCalledOnce();
  });
});

describe('computed', () => {
  it('writes initial result to targetPath', () => {
    const state = createState({ a: 2, b: 3 });
    state.computed('sum', () => (state.getState('a') as number) + (state.getState('b') as number));
    expect(state.getState('sum')).toBe(5);
  });

  it('re-runs and re-writes on dep change', () => {
    const state = createState({ a: 2, b: 3 });
    state.computed('sum', () => (state.getState('a') as number) + (state.getState('b') as number));
    state.setState('a', 10);
    expect(state.getState('sum')).toBe(13);
    state.setState('b', 1);
    expect(state.getState('sum')).toBe(11);
  });

  it('throws ComputedSelfReferenceError when fn reads the target path', () => {
    const state = createState({ x: 1 });
    expect(() =>
      state.computed('x', () => {
        state.getState('x');
        return 0;
      }),
    ).toThrow(ComputedSelfReferenceError);
  });

  it('throws when fn reads an ancestor of the target path', () => {
    const state = createState({ root: { nested: 1 } });
    expect(() =>
      state.computed('root.nested.derived', () => {
        state.getState('root');
        return 0;
      }),
    ).toThrow(ComputedSelfReferenceError);
  });

  it('throws when fn reads a descendant of the target path', () => {
    const state = createState({ derived: { child: 1 } });
    expect(() =>
      state.computed('derived', () => {
        state.getState('derived.child');
        return 0;
      }),
    ).toThrow(ComputedSelfReferenceError);
  });

  it('runtime fn-throw after registration: retain prior value + console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = createState({ a: 2 });
    let shouldThrow = false;
    state.computed('doubled', () => {
      const a = state.getState('a') as number;
      if (shouldThrow) throw new Error('compute boom');
      return a * 2;
    });
    expect(state.getState('doubled')).toBe(4);
    shouldThrow = true;
    state.setState('a', 5);
    expect(state.getState('doubled')).toBe(4); // retained
    shouldThrow = false;
    state.setState('a', 10);
    expect(state.getState('doubled')).toBe(20); // recovered
    errorSpy.mockRestore();
  });

  it('throws on invalid target path', () => {
    const state = createState();
    expect(() => state.computed('', () => 1)).toThrow(/invalid target path/);
    expect(() => state.computed('a..b', () => 1)).toThrow(/invalid target path/);
  });

  it('dispose stops re-evaluation', () => {
    const state = createState({ a: 1 });
    const dispose = state.computed('doubled', () => (state.getState('a') as number) * 2);
    expect(state.getState('doubled')).toBe(2);
    dispose();
    state.setState('a', 5);
    expect(state.getState('doubled')).toBe(2); // unchanged after dispose
  });

  it('re-tracks deps after dep set changes (conditional reads)', () => {
    const state = createState({ flag: true, a: 1, b: 100 });
    state.computed('picked', () => {
      return state.getState('flag') ? state.getState('a') : state.getState('b');
    });
    expect(state.getState('picked')).toBe(1);
    state.setState('b', 999); // b is not yet a dep
    expect(state.getState('picked')).toBe(1);
    state.setState('flag', false);
    expect(state.getState('picked')).toBe(999);
    state.setState('a', 42); // a is no longer a dep
    expect(state.getState('picked')).toBe(999);
    state.setState('b', 7);
    expect(state.getState('picked')).toBe(7);
  });
});

describe('circular-update guard', () => {
  it('blocks setState to the same path from inside its own subscriber', () => {
    const errorSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = createState();
    let cbCalls = 0;
    state.subscribe('count', () => {
      cbCalls++;
      // Attempt re-entrant write to same path — should be blocked.
      state.setState('count', 99);
    });
    state.setState('count', 1);
    expect(cbCalls).toBe(1);
    expect(state.getState('count')).toBe(1);
    errorSpy.mockRestore();
  });

  it('allows setState to a different path from inside a subscriber (cascading)', () => {
    const state = createState();
    state.subscribe('a', () => {
      state.setState('b', 'from-a');
    });
    state.setState('a', 1);
    expect(state.getState('b')).toBe('from-a');
  });
});

describe('rich-type round-trip (Map / Date / cycle invariant)', () => {
  it('stores and retrieves a Map at a path', () => {
    const state = createState();
    const m = new Map<string, number>([['x', 1]]);
    state.setState('mp', m);
    expect(state.getState('mp')).toBe(m);
  });

  it('stores and retrieves a Date at a path', () => {
    const state = createState();
    const d = new Date('2026-05-12T00:00:00Z');
    state.setState('when', d);
    expect(state.getState('when')).toBe(d);
  });

  it('stores and retrieves a cyclic value at a path', () => {
    const state = createState();
    const o: Record<string, unknown> = { x: 1 };
    o.self = o;
    state.setState('cyc', o);
    expect(state.getState('cyc')).toBe(o);
  });

  it('dedup recognizes a structurally-equal Map and skips notify', () => {
    const state = createState({ mp: new Map([['x', 1]]) });
    const cb = vi.fn();
    state.subscribe('mp', cb);
    state.setState('mp', new Map([['x', 1]])); // structurally equal
    expect(cb).not.toHaveBeenCalled();
  });
});
