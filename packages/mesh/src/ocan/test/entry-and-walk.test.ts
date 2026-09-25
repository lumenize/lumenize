/**
 * The entry rule and the walk rules, measured against the executor itself.
 *
 * **Why this tier and not `/live`** (`.claude/rules/live.md` puts that reason on the test file, not
 * on the task file that archives): every limb here is a property of `executeOperationChain` against
 * a stand-in object — no Gateway, no DO, no running system to reach. The *reachability* of these
 * same holes through a real browser session is a separate question, and it has its own `/live`
 * scenario (`apps/nebula/harness/scenarios/mesh-entry-reach.ts`); this file is what pins the
 * executor's own contract, including the response-leg and flag-off cases no wire path can address.
 *
 * ⚠️ **Every payload here is harmless by construction** — `svc.sql(['SELECT 1'])` proves arbitrary
 * SQL runs exactly as well as a `DELETE` would, and a skipped guard is proven by a recorder rather
 * than by a destructive call. That is a standing rule for this task's limbs, because the same
 * assertions run against a deployed worker via `HARNESS_TARGET_URL` in the `/live` lane.
 *
 * Written RED-first: on today's code every `REFUSED` limb below fails, which is the evidence that
 * the hole exists. They land `it.skip`ped and each fixing phase un-skips the ones it closes.
 */
import { describe, it, expect } from 'vitest';
import { executeOperationChain } from '../index.js';
import { mesh } from '../../mesh-decorator.js';
import type { OperationChain } from '../index.js';

/** A key nothing in the framework or the tests reads — never `scopeAdmin`, so a red run grants nobody anything. */
const PROBE_KEY = '__lumenizeFenceProbe';

/** The message the entry rule refuses on. `mesh-callable` is the shipped vocabulary (`isMeshCallable`). */
const NOT_MESH_CALLABLE = /is not mesh-callable/;

/** A stand-in for a node: the members a DO really carries, one of each kind the probes measured. */
class StandInNode {
  /** Stands in for a DO's `env` — a constructor-assigned own property holding secrets. */
  env = { SECRET: 'the-secret' };
  /** Stands in for `ctx` — also a constructor-assigned own property, so the descriptor walk cannot see it on a prototype. */
  ctx = { id: 'stand-in-id', storage: { deleteAll: () => 'wiped' } };
  /** Stands in for the `svc` plugin registry, whose getter is on the prototype in the real thing. */
  svc = {
    sql: (parts: string[]) => `ran: ${parts.join('')}`,
    fetch: { doInstance: null as any },
  };

  /** Records every undecorated call that should never have happened. */
  ran: string[] = [];

  /** A GATE: marked, and hands back a facade. The shape this task's design promotes. */
  @mesh()
  gate() {
    return {
      helper: () => 'facade helper ran',
      label: 'facade-string',
    };
  }

  /**
   * A gate handing back a plain object. The SAME object every call, deliberately: a write reached
   * through it is only observable afterwards if the test can hold the thing that was written to.
   */
  facade: Record<string, unknown> = { existing: 1 };

  @mesh()
  plainGate(): Record<string, unknown> {
    return this.facade;
  }

  @mesh()
  marked(x: number) {
    return x * 2;
  }

  /** Marked, and takes whatever its caller nests — the sink every nested-argument limb reads. */
  @mesh()
  sink(value: unknown) {
    return value;
  }

  /** Undecorated: the ONE thing today's member-level check already refuses. */
  plain() {
    this.ran.push('plain');
    return 'plain ran';
  }

  // ─── the single walk (§ Gotchas, item 6) ───────────────────────────────────────────────
  /** Every invocation of a gate body, and what argument it was handed. */
  gateCalls: unknown[][] = [];

  /** A counting gate. Synchronous, like the one gate on disk. */
  @mesh()
  countingGate(...args: unknown[]) {
    this.gateCalls.push(args);
    return { helper: () => 'helper ran' };
  }

  /** An ASYNC gate. Two of the three real zero-arg `@mesh` members on disk are `async`. */
  @mesh()
  async asyncGate() {
    await Promise.resolve();
    return { helper: () => 'async helper ran' };
  }
}

/** Build a get-only nested marker carrying `chain`, exactly as `processArgumentsForNesting` does. */
const nest = (chain: OperationChain) => ({ __isNestedOperation: true, __operationChain: chain });

describe('the entry op must name a mesh-callable member (request leg)', () => {
  it.skip('REFUSES a read of env with no call at all', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain(
      [{ type: 'get', key: 'env' }, { type: 'get', key: 'SECRET' }], node,
    )).rejects.toThrow(NOT_MESH_CALLABLE);
  });

  it.skip('REFUSES a read of ctx with no call at all', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain(
      [{ type: 'get', key: 'ctx' }, { type: 'get', key: 'id' }], node,
    )).rejects.toThrow(NOT_MESH_CALLABLE);
  });

  it.skip('REFUSES svc.sql — nothing exempts svc', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain(
      [{ type: 'get', key: 'svc' }, { type: 'get', key: 'sql' }, { type: 'apply', args: [['SELECT 1']] }], node,
    )).rejects.toThrow(NOT_MESH_CALLABLE);
  });

  it.skip('REFUSES a get-only nested marker reading env, passed as an argument to a MARKED member', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain(
      [{ type: 'get', key: 'sink' }, { type: 'apply', args: [
        nest([{ type: 'get', key: 'env' }, { type: 'get', key: 'SECRET' }]),
      ] }], node,
    )).rejects.toThrow(NOT_MESH_CALLABLE);
  });

  it.skip('REFUSES a nested svc chain passed as an argument to a MARKED member', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain(
      [{ type: 'get', key: 'sink' }, { type: 'apply', args: [
        nest([{ type: 'get', key: 'svc' }, { type: 'get', key: 'sql' }, { type: 'apply', args: [['SELECT 1']] }]),
      ] }], node,
    )).rejects.toThrow(NOT_MESH_CALLABLE);
  });

  // ── positive controls: green BEFORE and after. A rule that refuses everything satisfies
  //    every refusal limb above, and these are what catch it.
  it('PERMITS a marked method (positive control)', async () => {
    const node = new StandInNode();
    expect(await executeOperationChain(
      [{ type: 'get', key: 'marked' }, { type: 'apply', args: [21] }], node,
    )).toBe(42);
  });

  it('REFUSES an undecorated method as the entry (the one hole today already closes)', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain(
      [{ type: 'get', key: 'plain' }, { type: 'apply', args: [] }], node,
    )).rejects.toThrow(NOT_MESH_CALLABLE);
    expect(node.ran).toEqual([]);
  });
});

describe('the walk rules fence the doors JavaScript opens on every object', () => {
  it('REFUSES a WRITE to Object.prototype reached by constructor, and nothing lands', async () => {
    const node = new StandInNode();
    try {
      // The chain really writes: `constructor` -> `prototype` -> `__defineGetter__`, whose function
      // argument arrives as a get-only nested marker. Reading `Object.prototype[key]` instead would
      // make the side-effect assertion below true whatever the executor did.
      await expect(executeOperationChain([
        { type: 'get', key: 'gate' }, { type: 'apply', args: [] },
        { type: 'get', key: 'constructor' },
        { type: 'get', key: 'prototype' },
        { type: 'get', key: '__defineGetter__' },
        { type: 'apply', args: [PROBE_KEY, nest([
          { type: 'get', key: 'gate' }, { type: 'apply', args: [] }, { type: 'get', key: 'helper' },
        ])] },
      ], node)).rejects.toThrow(/'constructor'/);
      // A refused chain that wrote before it threw is a pass by message and a failure in fact.
      expect(({} as any)[PROBE_KEY]).toBeUndefined();
    } finally {
      delete (Object.prototype as any)[PROBE_KEY];
    }
  });

  it('REFUSES constructor reached from a returned STRING', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain([
      { type: 'get', key: 'gate' }, { type: 'apply', args: [] },
      { type: 'get', key: 'label' },
      { type: 'get', key: 'constructor' },
    ], node)).rejects.toThrow(/'constructor'/);
  });

  it('REFUSES constructor reached from a returned FACADE — the case an ancestry rule missed', async () => {
    // A class instance, not a plain object: `constructor` own-resolves on its own prototype, so
    // the retired "refuse a get resolving on Object.prototype" rule never fired here -- and the
    // shape this task promotes is exactly this one, a gate handing back a facade.
    class Facade { ok() { return 1; } }
    const withFacade = new (class extends StandInNode {
      @mesh() override gate(): any { return new Facade(); }
    })();
    await expect(executeOperationChain([
      { type: 'get', key: 'gate' }, { type: 'apply', args: [] },
      { type: 'get', key: 'constructor' },
    ], withFacade)).rejects.toThrow(/'constructor'/);
  });

  it('REFUSES __proto__ past a gate, on its own message', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain([
      { type: 'get', key: 'gate' }, { type: 'apply', args: [] },
      { type: 'get', key: '__proto__' },
    ], node)).rejects.toThrow(/'__proto__'/);
  });

  it('REFUSES __lookupGetter__, which names neither fenced key and reaches the same prototype', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain([
      { type: 'get', key: 'gate' }, { type: 'apply', args: [] },
      { type: 'get', key: '__lookupGetter__' }, { type: 'apply', args: ['__proto__'] },
    ], node)).rejects.toThrow(/'__lookupGetter__'/);
  });

  it('REFUSES __lookupSetter__, on its own message', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain([
      { type: 'get', key: 'gate' }, { type: 'apply', args: [] },
      { type: 'get', key: '__lookupSetter__' }, { type: 'apply', args: ['__proto__'] },
    ], node)).rejects.toThrow(/'__lookupSetter__'/);
  });

  it('REFUSES __defineGetter__ — the only property WRITE a chain can name — and writes nothing', async () => {
    const node = new StandInNode();
    try {
      // The argument is a FUNCTION obtained as a get-only nested marker on a marked member: whether
      // a chain can produce one at all is what this limb measures (§ Criteria calls it unknown).
      const fn = nest([
        { type: 'get', key: 'gate' }, { type: 'apply', args: [] }, { type: 'get', key: 'helper' },
      ]);
      await expect(executeOperationChain([
        { type: 'get', key: 'plainGate' }, { type: 'apply', args: [] },
        { type: 'get', key: '__defineGetter__' }, { type: 'apply', args: [PROBE_KEY, fn] },
      ], node)).rejects.toThrow(/'__defineGetter__'/);
      // The object the gate handed back is the one this chain writes to, so this is the half with
      // teeth; `({})` is the criterion's own belt-and-braces check that nothing escaped further.
      expect(node.facade[PROBE_KEY]).toBeUndefined();
      expect(({} as any)[PROBE_KEY]).toBeUndefined();
    } finally {
      delete (Object.prototype as any)[PROBE_KEY];
    }
  });

  it('REFUSES __defineSetter__, on its own message', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain([
      { type: 'get', key: 'plainGate' }, { type: 'apply', args: [] },
      { type: 'get', key: '__defineSetter__' }, { type: 'apply', args: [PROBE_KEY, () => {}] },
    ], node)).rejects.toThrow(/'__defineSetter__'/);
    expect(Object.getOwnPropertyDescriptor(node.facade, PROBE_KEY)).toBeUndefined();
  });

  it('REFUSES a get that resolves on Function.prototype — reachable because the design hands back methods', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain([
      { type: 'get', key: 'gate' }, { type: 'apply', args: [] },
      { type: 'get', key: 'helper' },
      { type: 'get', key: 'call' }, { type: 'apply', args: [null] },
    ], node)).rejects.toThrow(/Function\.prototype/);
  });

  // ── the walk rules are UNCONDITIONAL: they are not the member-level check, so the flag that
  //    turns that off must not turn these off. Writing the fence inside the flag's branch is the
  //    plausible mistake, and these two limbs are what catch it.
  it('REFUSES constructor on the RESPONSE leg (requireMeshDecorator: false), at op 1', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain([
      { type: 'get', key: 'plainGate' }, { type: 'apply', args: [] },
      { type: 'get', key: 'constructor' },
    ], node, { requireMeshDecorator: false })).rejects.toThrow(/'constructor'/);
  });

  it('REFUSES constructor on the RESPONSE leg at OP 0, where no entry rule covers it', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain(
      [{ type: 'get', key: 'constructor' }, { type: 'get', key: 'prototype' }], node,
      { requireMeshDecorator: false },
    )).rejects.toThrow(/'constructor'/);
  });

  // ── positive controls for the fence: GREEN before and after. The fence names six keys rather
  //    than an ancestry precisely so these keep working.
  it('PERMITS the six benign Object.prototype members past a gate', async () => {
    const node = new StandInNode();
    for (const key of ['hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'toLocaleString', 'valueOf']) {
      const result = await executeOperationChain([
        { type: 'get', key: 'plainGate' }, { type: 'apply', args: [] },
        { type: 'get', key }, { type: 'apply', args: ['existing'] },
      ], node);
      expect(result, `${key} must stay reachable`).toBeDefined();
    }
  });

  it('PERMITS Array.prototype and Map.prototype members past a gate', async () => {
    const node = new (class extends StandInNode {
      @mesh() override gate(): any { return { list: [1, 2, 3], map: new Map([['k', 'v']]) }; }
    })();
    expect(await executeOperationChain([
      { type: 'get', key: 'gate' }, { type: 'apply', args: [] },
      { type: 'get', key: 'list' }, { type: 'get', key: 'length' },
    ], node)).toBe(3);
    expect(await executeOperationChain([
      { type: 'get', key: 'gate' }, { type: 'apply', args: [] },
      { type: 'get', key: 'map' }, { type: 'get', key: 'get' }, { type: 'apply', args: ['k'] },
    ], node)).toBe('v');
  });
});

describe('a chain shape the executor cannot mean is refused, not fallen through', () => {
  it('REFUSES an empty chain rather than handing back the node itself', async () => {
    const node = new StandInNode();
    await expect(executeOperationChain([], node)).rejects.toThrow(/at least one operation/);
  });

  it('REFUSES an apply-first chain rather than calling the target', async () => {
    const called: string[] = [];
    const target = Object.assign((x: number) => { called.push('target'); return x * 2; }, {});
    await expect(executeOperationChain(
      [{ type: 'apply', args: [5] }], target,
    )).rejects.toThrow(/first operation/);
    expect(called).toEqual([]);
  });
});

describe('the executor walks a chain once, carrying the parent forward', () => {
  // Same tier reason as the rest of this file: how the executor finds the object a method hangs
  // off is a pure property of `executeOperationChain`, so a stand-in object is the whole system
  // under test.

  it('runs a gate body ONCE per chain', async () => {
    const node = new StandInNode();
    expect(await executeOperationChain([
      { type: 'get', key: 'countingGate' }, { type: 'apply', args: [] },
      { type: 'get', key: 'helper' }, { type: 'apply', args: [] },
    ], node)).toBe('helper ran');
    // Before the parent was carried along the walk, `findParentObject` restarted from the node and
    // re-ran every earlier op to find the object a method hangs off — so the gate body ran a second
    // time per later apply.
    expect(node.gateCalls).toHaveLength(1);
  });

  it('completes a chain through an ASYNC gate', async () => {
    const node = new StandInNode();
    // That re-run was synchronous and unawaited, so its parent was a Promise and the method lookup
    // on it yielded undefined — `parent[methodName] is not a function`.
    expect(await executeOperationChain([
      { type: 'get', key: 'asyncGate' }, { type: 'apply', args: [] },
      { type: 'get', key: 'helper' }, { type: 'apply', args: [] },
    ], node)).toBe('async helper ran');
  });

  it('hands a gate the RESOLVED value of a nested marker, on its only run', async () => {
    const node = new StandInNode();
    await executeOperationChain([
      { type: 'get', key: 'countingGate' },
      { type: 'apply', args: [nest([{ type: 'get', key: 'marked' }, { type: 'apply', args: [21] }])] },
      { type: 'get', key: 'helper' }, { type: 'apply', args: [] },
    ], node);
    // Two assertions, because they fail to different mutations: an extra invocation adds a second
    // call, and a walk that passed `operation.args` rather than the resolved ones would hand the
    // gate an unresolved `{ __isNestedOperation: true, … }` object on the run it does make.
    expect(node.gateCalls).toHaveLength(1);
    expect(node.gateCalls[0]).toEqual([42]);
  });
});
