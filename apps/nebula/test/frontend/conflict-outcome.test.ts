/**
 * Conflict / outcome state machine — property tests ported from the isolation
 * detour (tasks/archive/factory-conflict-outcome.md § Tests; the vue-factory spike was
 * removed in 5.3.7/P11). The harness is a scripted mock
 * server + captured store effects / flash classes, with the REAL debounce queue
 * underneath (so occupancy, timeout, and connection-gate behavior are the
 * validated ones, not re-mocked).
 *
 * v3-port deltas vs the spike:
 *  - Top-level outcome reshaped to the round-4 five-kind shape
 *    (`committed` / `rejected`+`retryable` / `timeout` / `infrastructure-error`
 *    / `ontology-stale`), per api-reference § TransactionOutcome.
 *  - The spike's "mixed-fate" mock test is removed (it scripts a response the
 *    atomic all-or-nothing server cannot produce); the atomic-batch-precedence
 *    behavior is a real-Star e2e probe (§5.3.8) — placeholder it.skip below.
 *  - Mn7: per-conclusion-kind held-fanout DROP-vs-APPLY matrix.
 *  - Mn8: connection-gated rollback parameterized over every non-connected literal.
 *
 * NOTE (test-fidelity obligation, tasks/nebula-frontend.md): these script the
 * `ServerBatchResponse`/`ServerResourceResult` mock shape. They MUST be backed
 * by real-Star e2e coverage (§5.3.8 use-server/use-this/maxRetries/HITL/
 * permission-denied/atomic-batch-precedence) — the mock proves the engine's
 * branching, not the wire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createConflictOutcomeEngine,
  type ServerBatchResponse,
  type Snapshot,
  type TransactionOutcome,
  type TransactionResourceResolution,
} from '../../src/frontend/conflict-outcome';
import type { QueueSubmission } from '../../src/frontend/debounce';
import { makeLongformResolver } from '../../src/frontend/text-merge';

type Responder = (subs: QueueSubmission[]) => Promise<ServerBatchResponse>;

function makeHarness(opts: { quietMs?: number } = {}) {
  const store = new Map<string, { value: unknown; eTag?: string }>();
  const flashes: Array<{ key: string; cls: string }> = [];
  const refreshes: unknown[] = [];
  const submitted: QueueSubmission[] = [];
  let etagCounter = 0;
  let newETagCounter = 0;
  const keyOf = (rt: string, rid: string) => `${rt}:${rid}`;

  let respond: Responder = async (subs) => ({
    resources: subs.map(() => ({ result: 'committed' as const, eTag: `srv-${++etagCounter}` })),
  });

  const engine = createConflictOutcomeEngine({
    submitBatch: (subs) => {
      submitted.push(...subs.map((s) => ({ ...s })));
      return respond(subs);
    },
    readResource: (rt, rid) => store.get(keyOf(rt, rid)) ?? { value: undefined, eTag: undefined },
    applyServer: (rt, rid, snap) => store.set(keyOf(rt, rid), { value: snap.value, eTag: snap.meta.eTag }),
    applyFanout: (rt, rid, snap) => store.set(keyOf(rt, rid), { value: snap.value, eTag: snap.meta.eTag }),
    applyCommit: (rt, rid, eTag) => {
      store.get(keyOf(rt, rid))!.eTag = eTag;
    },
    rollbackTo: (rt, rid, value) => {
      store.get(keyOf(rt, rid))!.value = value;
    },
    applyResolvedValue: (rt, rid, value) => {
      store.get(keyOf(rt, rid))!.value = value;
    },
    applyOptimistic: (rt, rid, value, eTag) => store.set(keyOf(rt, rid), { value, eTag }),
    flash: (rt, rid, cls) => flashes.push({ key: keyOf(rt, rid), cls }),
    onShouldRefreshUI: (info) => refreshes.push(info),
    quietMs: opts.quietMs ?? 0,
    timeoutMs: 10_000,
    newETag: () => `ne-${++newETagCounter}`,
  });

  function seed(rt: string, rid: string, value: unknown, eTag = 'eTag-v1') {
    store.set(keyOf(rt, rid), { value, eTag });
  }
  /** A keystroke: optimistic store write, then notify the engine. */
  function type(rt: string, rid: string, value: unknown) {
    const entry = store.get(keyOf(rt, rid))!;
    const pre = structuredClone(entry.value);
    entry.value = value;
    engine.write(rt, rid, { preWriteValue: pre });
  }
  function valueOf(rt: string, rid: string) {
    return store.get(keyOf(rt, rid))?.value;
  }

  return {
    engine,
    store,
    flashes,
    refreshes,
    submitted,
    seed,
    type,
    valueOf,
    setResponder: (r: Responder) => {
      respond = r;
    },
  };
}

const conflict = (value: unknown, eTag: string): { result: 'conflict'; snapshot: Snapshot } => ({
  result: 'conflict',
  snapshot: { value, meta: { eTag } },
});

/** Deferred batch responses, resolved/rejected manually per submission order. */
function deferredResponder() {
  const pending: Array<{
    subs: QueueSubmission[];
    resolve: (o: ServerBatchResponse) => void;
    reject: (e: unknown) => void;
  }> = [];
  const responder: Responder = (subs) =>
    new Promise((resolve, reject) => {
      pending.push({ subs, resolve, reject });
    });
  return { responder, pending };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

// ─── 1. Single resource — every terminal kind ───────────────────────────────

describe('single resource terminal kinds', () => {
  it("'committed': top-level committed + eTag writeback + commit flash", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'a' });
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome).toEqual({
      kind: 'committed',
      resources: { r1: { kind: 'committed', eTag: 'srv-1' } },
    });
    expect(h.store.get('doc:r1')!.eTag).toBe('srv-1');
    expect(h.flashes).toContainEqual({ key: 'doc:r1', cls: 'lumenize-commit-success' });
  });

  it("'use-server' (framework default — no handler): auto-resolved below the bucket → top-level committed", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'local' });
    h.setResponder(async () => ({ resources: [conflict({ body: 'server' }, 'e2')] }));
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome.kind).toBe('committed'); // the conflict auto-resolved (use-server) → every op landed
    expect((outcome as { resources: Record<string, TransactionResourceResolution> }).resources.r1)
      .toMatchObject({ kind: 'use-server' });
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'server' });
    expect(h.flashes).toContainEqual({ key: 'doc:r1', cls: 'lumenize-conflict-revert' });
  });

  it("'use-this' (1 retry → commit): re-submits the handler value at the server eTag → top-level committed", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'local' }, 'e1');
    h.engine.onTransactionResourceResolution('doc', (_rid, res) =>
      res.kind === 'conflict-pending' ? { kind: 'use-this', value: { body: 'merged' } } : undefined,
    );
    let call = 0;
    h.setResponder(async () => {
      call++;
      return call === 1
        ? { resources: [conflict({ body: 'server' }, 'e2')] }
        : { resources: [{ result: 'committed', eTag: 'e3' }] };
    });
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome).toMatchObject({ kind: 'committed', resources: { r1: { kind: 'committed', eTag: 'e3' } } });
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted[1]!).toMatchObject({ eTag: 'e2', value: { body: 'merged' } });
    expect(h.submitted[1]!.newETag).not.toBe(h.submitted[0]!.newETag);
  });

  it("'validation-failed': rolled back to pre-write, revert flash, errors surfaced", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'orig' });
    h.type('doc', 'r1', { body: 'bad' });
    h.setResponder(async () => ({
      resources: [{ result: 'validation-failed', errors: { body: 'too short' } }],
    }));
    const terminal: TransactionResourceResolution[] = [];
    h.engine.onTransactionResourceResolution('doc', (_rid, res) => {
      terminal.push(res);
      return undefined;
    });
    await flushMicrotasks(); // quietMs 0 — debounced write flushes
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'orig' });
    expect(terminal).toContainEqual({ kind: 'validation-failed', errors: { body: 'too short' } });
    expect(h.flashes).toContainEqual({ key: 'doc:r1', cls: 'lumenize-conflict-revert' });
  });

  it("'validation-failed' via transaction(): top-level rejected, retryable false", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'orig' }, 'e1');
    h.setResponder(async () => ({
      resources: [{ result: 'validation-failed', errors: { body: 'too short' } }],
    }));
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome).toEqual({
      kind: 'rejected',
      retryable: false,
      resources: { r1: { kind: 'validation-failed', errors: { body: 'too short' } } },
    });
  });

  it("'permission-denied': rolled back, revert flash; via transaction() → top-level rejected, retryable false", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'orig' }, 'e1');
    h.type('doc', 'r1', { body: 'forbidden' });
    h.setResponder(async () => ({ resources: [{ result: 'permission-denied' }] }));
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'orig' });
    expect(h.flashes).toContainEqual({ key: 'doc:r1', cls: 'lumenize-conflict-revert' });
    expect(outcome).toEqual({
      kind: 'rejected',
      retryable: false,
      resources: { r1: { kind: 'permission-denied' } },
    });
  });

  it("'human-in-the-loop': paint kept, NO flash, baseline advances; top-level rejected retryable false", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'local-paint' }, 'e1');
    h.engine.onTransactionResourceResolution('doc', (_rid, res) =>
      res.kind === 'conflict-pending' ? { kind: 'human-in-the-loop' } : undefined,
    );
    h.setResponder(async () => ({ resources: [conflict({ body: 'server' }, 'e2')] }));
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome).toMatchObject({
      kind: 'rejected',
      retryable: false,
      resources: { r1: { kind: 'human-in-the-loop', snapshot: { meta: { eTag: 'e2' } } } },
    });
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'local-paint' }); // paint kept
    expect(h.flashes).toHaveLength(0);
    // A later edit submits at the server's eTag (baseline advanced).
    h.setResponder(async () => ({ resources: [{ result: 'committed', eTag: 'e3' }] }));
    h.type('doc', 'r1', { body: 'follow-up' });
    await flushMicrotasks();
    expect(h.submitted.at(-1)!).toMatchObject({ eTag: 'e2', value: { body: 'follow-up' } });
  });
});

// ─── 2. Atomic-batch precedence (round-4 recast — real-Star e2e) ─────────────

describe('atomic-batch precedence', () => {
  // The spike's old "mixed-fate {A:use-server, B:permission-denied, C:committed}
  // → top-level ok" test scripted a response the atomic all-or-nothing server
  // CANNOT produce (server step precedence: permission before conflict ⟹ one
  // response = one failure class; a sibling's conflict snapshot is never
  // disclosed). The faithful test runs against a real Star, so it lives with the
  // §5.3.8 for-docs probes (atomic-batch precedence), not against this mock.
  it.skip('A would conflict + B permission-denied → whole batch rejected, A never disclosed (real-Star e2e — §5.3.8)', () => {});
});

// ─── 3. Handler fall-through (M9) ───────────────────────────────────────────

describe('handler fall-through (M9)', () => {
  it("per-call handles only A; B falls through to its per-type handler; C falls through to framework default", async () => {
    const h = makeHarness();
    h.seed('rtA', 'A', { v: 'a' }, 'eA');
    h.seed('rtB', 'B', { v: 'b' }, 'eB');
    h.seed('rtC', 'C', { v: 'c' }, 'eC');
    h.engine.onTransactionResourceResolution('rtB', (_rid, res) =>
      res.kind === 'conflict-pending' ? { kind: 'use-this', value: { v: 'b-union' } } : undefined,
    );
    const perRid = new Map<string, number>();
    h.setResponder(async (subs) => ({
      resources: subs.map((s) => {
        const n = (perRid.get(s.rid) ?? 0) + 1;
        perRid.set(s.rid, n);
        // First submission per resource conflicts; any re-submission commits.
        return n === 1
          ? conflict({ v: `${s.rid}-server` }, `e${s.rid}2`)
          : { result: 'committed' as const, eTag: `e${s.rid}3` };
      }),
    }));
    const outcome = await h.engine.transaction(
      [
        { rt: 'rtA', rid: 'A' },
        { rt: 'rtB', rid: 'B' },
        { rt: 'rtC', rid: 'C' },
      ],
      {
        onTransactionResourceResolution: (rid, res) =>
          rid === 'A' && res.kind === 'conflict-pending'
            ? { kind: 'use-this', value: { v: 'a-percall' } }
            : undefined, // falls through for B and C
      },
    );
    expect(outcome.kind).toBe('committed'); // A + B committed (use-this), C use-server → every op landed
    const resources = (outcome as { resources: Record<string, TransactionResourceResolution> }).resources;
    expect(resources.A).toMatchObject({ kind: 'committed' });
    expect(resources.B).toMatchObject({ kind: 'committed' });
    expect(resources.C).toMatchObject({ kind: 'use-server' }); // framework default
    // A resubmitted with the per-call value; B with the per-type value (not shadowed).
    expect(h.submitted.find((s) => s.rid === 'A' && s.eTag === 'eA2')!.value).toEqual({ v: 'a-percall' });
    expect(h.submitted.find((s) => s.rid === 'B' && s.eTag === 'eB2')!.value).toEqual({ v: 'b-union' });
    expect(h.valueOf('rtC', 'C')).toEqual({ v: 'C-server' });
  });
});

// ─── 4. base threading (B4) — all three re-anchor sites ─────────────────────

describe('base threading (B4)', () => {
  it('(a) first divergence: base = the pre-typing value, NOT the submit-time local value', async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'V0' }, 'e1');
    const bases: unknown[] = [];
    h.engine.onTransactionResourceResolution('doc', (_rid, res) => {
      if (res.kind === 'conflict-pending') bases.push(res.base.value);
      return undefined; // default use-server
    });
    h.type('doc', 'r1', { body: 'V0x' });
    h.type('doc', 'r1', { body: 'V0xy' }); // same burst — base stays at first divergence
    h.setResponder(async () => ({ resources: [conflict({ body: 'SRV' }, 'e2')] }));
    await flushMicrotasks();
    expect(bases).toEqual([{ body: 'V0' }]); // a submit-time capture would yield { body: 'V0xy' } === local
  });

  it("(b) commit boundary: a buffered write chaining onto T1's commit carries T1's value as base", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.seed('doc', 'r1', { body: 'V0' }, 'e1');
    const bases: unknown[] = [];
    h.engine.onTransactionResourceResolution('doc', (_rid, res) => {
      if (res.kind === 'conflict-pending') bases.push(res.base.value);
      return undefined;
    });
    h.type('doc', 'r1', { body: 'V1' });
    await flushMicrotasks(); // T1 in flight
    h.type('doc', 'r1', { body: 'V2' }); // buffered behind T1
    d.pending[0]!.resolve({ resources: [{ result: 'committed', eTag: 'e2' }] });
    await flushMicrotasks(); // T2 (buffered) submits, chained
    d.pending[1]!.resolve({ resources: [conflict({ body: 'THIRD-PARTY' }, 'e3')] }); // third party moved the server
    await flushMicrotasks();
    expect(bases).toEqual([{ body: 'V1' }]); // T1's committed value — NOT the stale V0
  });

  it("(c) use-this re-conflict: base = the previous conflict's server snapshot; @longform merge preserves every edit across the chain", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'the cat sat' }, 'e1');
    const bases: unknown[] = [];
    const longform = makeLongformResolver('body');
    h.engine.onTransactionResourceResolution('doc', (_rid, res) => {
      if (res.kind === 'conflict-pending') bases.push((res.base.value as { body: string }).body);
      return longform(res as never);
    });
    let call = 0;
    h.setResponder(async () => {
      call++;
      if (call === 1) return { resources: [conflict({ body: 'the cat sat quietly' }, 'e2')] };
      if (call === 2) return { resources: [conflict({ body: 'the cat sat quietly today' }, 'e3')] };
      return { resources: [{ result: 'committed', eTag: 'e4' }] };
    });
    h.type('doc', 'r1', { body: 'a cat sat' }); // local edits the start
    await flushMicrotasks();
    expect(bases).toEqual(['the cat sat', 'the cat sat quietly']); // site (a), then site (c)
    expect(h.submitted).toHaveLength(3);
    // Both server appends AND the local start-edit survive the whole chain.
    expect(h.submitted[2]!.value).toEqual({ body: 'a cat sat quietly today' });
  });
});

// ─── 5. maxRetries precedence ───────────────────────────────────────────────

describe('maxRetries precedence', () => {
  it("per-call 3 beats per-type 10 beats default 5: 'retries-exhausted', top-level rejected retryable true", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { v: 'local' }, 'e1');
    let serverV = 0;
    h.setResponder(async () => ({ resources: [conflict({ v: `srv-${++serverV}` }, `e${serverV + 1}`)] }));
    h.engine.onTransactionResourceResolution(
      'doc',
      (_rid, res) => (res.kind === 'conflict-pending' ? { kind: 'use-this', value: { v: 'mine' } } : undefined),
      { maxRetries: 10 },
    );
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }], { maxRetries: 3 });
    expect(outcome).toMatchObject({
      kind: 'rejected',
      retryable: true, // an exhausted conflict — a blind resubmit can still land once churn settles
      resources: { r1: { kind: 'retries-exhausted', attempts: 3 } },
    });
    expect(h.submitted).toHaveLength(4); // initial + 3 re-submits
    expect(h.flashes).toContainEqual({ key: 'doc:r1', cls: 'lumenize-conflict-revert' });
  });
});

// ─── 7. Async resolver suspends the timeout ─────────────────────────────────

describe('async resolver', () => {
  it('the in-flight timeout is suspended while the handler deliberates; a fresh timeout arms on the re-submit', async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.seed('doc', 'r1', { v: 'local' }, 'e1');
    h.engine.onTransactionResourceResolution('doc', async (_rid, res) => {
      if (res.kind !== 'conflict-pending') return undefined;
      await new Promise((r) => setTimeout(r, 30_000)); // modal open for 30 s
      return { kind: 'use-this', value: { v: 'after-modal' } };
    });
    let outcome: TransactionOutcome | null = null;
    void h.engine.transaction([{ rt: 'doc', rid: 'r1' }]).then((o) => {
      outcome = o;
    });
    await flushMicrotasks();
    d.pending[0]!.resolve({ resources: [conflict({ v: 'server' }, 'e2')] });
    await vi.advanceTimersByTimeAsync(30_000); // way past timeoutMs — but the resolver is deliberating
    expect(outcome).toBeNull(); // no timeout fired during deliberation
    expect(h.submitted).toHaveLength(2); // the re-submit went out after the modal
    await vi.advanceTimersByTimeAsync(10_000); // fresh timeout on the re-submit elapses unanswered
    expect(outcome).toEqual({ kind: 'timeout', retryable: true });
    expect(h.valueOf('doc', 'r1')).toEqual({ v: 'server' }); // rolled back to the re-anchored base
  });
});

// ─── 8. Hold-pending-fanouts ────────────────────────────────────────────────

describe('hold-pending-fanouts', () => {
  it('a fanout landing mid-edit is held; pre-fanout keystrokes survive via the @longform merge', async () => {
    const h = makeHarness({ quietMs: 500 });
    h.seed('doc', 'r1', { body: 'the cat sat' }, 'e1');
    const longform = makeLongformResolver('body');
    h.engine.onTransactionResourceResolution('doc', (_rid, res) => longform(res as never));

    h.type('doc', 'r1', { body: 'a cat sat' }); // keystrokes painted
    // Concurrent commit fans out mid-edit:
    h.engine.notifyFanout('doc', 'r1', { value: { body: 'the cat sat quietly' }, meta: { eTag: 'e2' } });
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'a cat sat' }); // held — paint NOT clobbered

    let call = 0;
    h.setResponder(async () => {
      call++;
      return call === 1
        ? { resources: [conflict({ body: 'the cat sat quietly' }, 'e2')] }
        : { resources: [{ result: 'committed', eTag: 'e3' }] };
    });
    await vi.advanceTimersByTimeAsync(500); // quiet elapses → submit → conflict → merge → commit
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'a cat sat quietly' }); // both edits survive
    expect(h.store.get('doc:r1')!.eTag).toBe('e3'); // held fanout consumed, not re-applied
  });

  it('a fanout for an idle resource applies immediately', () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'v0' }, 'e1');
    h.engine.notifyFanout('doc', 'r1', { value: { body: 'v1' }, meta: { eTag: 'e2' } });
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'v1' });
  });
});

// ─── Mn7: per-conclusion-kind held-fanout disposition matrix ─────────────────

describe('held-fanout disposition matrix (Mn7)', () => {
  // For each conclusion kind: a write goes in flight, a DISTINCT fanout
  // ({ body: 'HELD' }) arrives mid-flight (held because the key is occupied),
  // then the in-flight settles to that kind. DROP kinds must NOT apply the held
  // snapshot; APPLY-when-idle kinds must apply it once the key frees. A
  // regression that applies on use-server (double-paint) or drops on
  // permission-denied (loses real news the rollback hides) is caught here.
  const HELD: Snapshot = { value: { body: 'HELD' }, meta: { eTag: 'e-held' } };

  async function inFlightWithHeldFanout(h: ReturnType<typeof makeHarness>) {
    h.seed('doc', 'r1', { body: 'v0' }, 'e1');
    h.type('doc', 'r1', { body: 'LOCAL' });
    await flushMicrotasks(); // in flight (deferred responder)
    h.engine.notifyFanout('doc', 'r1', HELD); // occupied → held
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'LOCAL' }); // paint not clobbered by the hold
  }

  // NOTE on the conflict-derived DROP cases below (use-server / human-in-the-
  // loop / retries-exhausted): their drop is enforced by the conflict snapshot
  // SUPERSEDING the held (the early `heldFanouts.delete` at handleConflict
  // entry), not by their `conclude('drop-held')` argument — so these three are
  // end-state assertions of invariant 11, and the load-bearing mechanism is
  // covered capable-of-failing by the "conflict supersedes a held fanout" test
  // at the end of this block. The non-conflict DROP cases (committed,
  // ontology-stale) and all APPLY cases ARE capable-of-failing via `conclude`.

  // DROP kinds — held snapshot must be discarded.
  it("DROP: committed", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    await inFlightWithHeldFanout(h);
    d.pending[0]!.resolve({ resources: [{ result: 'committed', eTag: 'e2' }] });
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'LOCAL' }); // commit kept the local value, held dropped
    expect(h.store.get('doc:r1')!.eTag).toBe('e2');
  });

  it("DROP: use-server", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    await inFlightWithHeldFanout(h);
    d.pending[0]!.resolve({ resources: [conflict({ body: 'SERVER' }, 'e2')] }); // default → use-server
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'SERVER' }); // server applied, held dropped (NOT HELD)
  });

  it("DROP: human-in-the-loop", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.engine.onTransactionResourceResolution('doc', (_r, res) =>
      res.kind === 'conflict-pending' ? { kind: 'human-in-the-loop' } : undefined,
    );
    await inFlightWithHeldFanout(h);
    d.pending[0]!.resolve({ resources: [conflict({ body: 'SERVER' }, 'e2')] });
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'LOCAL' }); // paint kept, held dropped
  });

  it("DROP: retries-exhausted", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.engine.onTransactionResourceResolution(
      'doc',
      (_r, res) => (res.kind === 'conflict-pending' ? { kind: 'use-this', value: { body: 'mine' } } : undefined),
      { maxRetries: 0 },
    );
    await inFlightWithHeldFanout(h);
    d.pending[0]!.resolve({ resources: [conflict({ body: 'SERVER' }, 'e2')] });
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'v0' }); // rolled back to base, held dropped (NOT HELD)
  });

  it("DROP: ontology-stale", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    await inFlightWithHeldFanout(h);
    d.pending[0]!.resolve({ ontologyStale: { clientVersion: '1', currentVersion: '2' } });
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'LOCAL' }); // paint kept (reload remedy), held dropped
  });

  // APPLY-when-idle kinds — held snapshot is real news the rollback would hide.
  it("APPLY: validation-failed", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    await inFlightWithHeldFanout(h);
    d.pending[0]!.resolve({ resources: [{ result: 'validation-failed', errors: {} }] });
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'HELD' }); // rolled back, then held applied
  });

  it("APPLY: permission-denied", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    await inFlightWithHeldFanout(h);
    d.pending[0]!.resolve({ resources: [{ result: 'permission-denied' }] });
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'HELD' });
  });

  it("APPLY: timeout (while connected)", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    await inFlightWithHeldFanout(h);
    await vi.advanceTimersByTimeAsync(10_000); // in-flight timeout fires (connected)
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'HELD' });
  });

  it("APPLY: infrastructure-error", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    await inFlightWithHeldFanout(h);
    d.pending[0]!.reject(new Error('mesh exploded'));
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'HELD' });
  });

  // The load-bearing mechanism behind the conflict-derived DROP cases, made
  // capable-of-failing: a conflict supersedes the held fanout, so even when the
  // resulting use-this chain LATER rolls back (resubmit times out), the stale
  // pre-conflict snapshot must NOT resurface. An impl that dropped the early
  // `heldFanouts.delete` (relying only on conclude's disposition) would
  // wrongly apply { body: 'HELD' } here.
  it("conflict supersedes a held fanout — a use-this resubmit that then times out does NOT resurface the stale held", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.engine.onTransactionResourceResolution('doc', (_r, res) =>
      res.kind === 'conflict-pending' ? { kind: 'use-this', value: { body: 'merged' } } : undefined,
    );
    await inFlightWithHeldFanout(h); // LOCAL in flight, HELD held
    d.pending[0]!.resolve({ resources: [conflict({ body: 'SERVER' }, 'e2')] }); // conflict → held superseded → use-this resubmit
    await flushMicrotasks();
    expect(h.submitted).toHaveLength(2); // the resubmit went out (base re-anchored to SERVER)
    await vi.advanceTimersByTimeAsync(10_000); // the resubmit times out while connected → rollback
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).not.toEqual({ body: 'HELD' }); // stale held did NOT resurface
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'SERVER' }); // rolled back to the re-anchored (conflict) base
  });
});

// ─── 9 + 10. Always-resolve / ontology-stale ────────────────────────────────

describe('transaction-wide failures', () => {
  it("a while-connected throw resolves 'infrastructure-error' (retryable) — rolled back, never rejects", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { v: 'orig' }, 'e1');
    h.type('doc', 'r1', { v: 'attempt' });
    await flushMicrotasks(); // flush the debounced write first (committed by default responder)
    h.setResponder(async () => {
      throw new Error('mesh exploded');
    });
    h.type('doc', 'r1', { v: 'attempt-2' });
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome).toMatchObject({ kind: 'infrastructure-error', retryable: true });
    expect((outcome as { error: Error }).error.message).toBe('mesh exploded');
    expect(h.valueOf('doc', 'r1')).toEqual({ v: 'attempt' }); // rolled back to the committed baseline value
  });

  it("'ontology-stale': resolves with versions (retryable false), fires onShouldRefreshUI, does NOT roll back", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { v: 'orig' }, 'e1');
    h.type('doc', 'r1', { v: 'painted' });
    h.setResponder(async () => ({ ontologyStale: { clientVersion: '1.0', currentVersion: '2.0' } }));
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome).toEqual({
      kind: 'ontology-stale',
      retryable: false,
      clientVersion: '1.0',
      currentVersion: '2.0',
    });
    expect(h.refreshes).toEqual([{ clientVersion: '1.0', currentVersion: '2.0', reason: 'ontology-stale' }]);
    expect(h.valueOf('doc', 'r1')).toEqual({ v: 'painted' }); // paint kept — reload is the remedy
  });
});

// ─── 11. Connection-gated rollback — every non-connected literal (Mn8) ───────

describe('connection-gated rollback (invariant 10, Mn8)', () => {
  for (const downState of ['connecting', 'reconnecting', 'disconnected'] as const) {
    it(`in-flight during '${downState}': no timeout, no rollback; reconnect replays the SAME newETag → committed`, async () => {
      const h = makeHarness();
      const d = deferredResponder();
      h.setResponder(d.responder);
      h.seed('doc', 'r1', { v: 'painted' }, 'e1');
      let outcome: TransactionOutcome | null = null;
      void h.engine.transaction([{ rt: 'doc', rid: 'r1' }]).then((o) => {
        outcome = o;
      });
      await flushMicrotasks();
      expect(h.submitted).toHaveLength(1);

      h.engine.setConnectionState(downState);
      await vi.advanceTimersByTimeAsync(120_000); // way past timeoutMs
      expect(outcome).toBeNull(); // no timeout while not connected…
      expect(h.valueOf('doc', 'r1')).toEqual({ v: 'painted' }); // …and no rollback

      h.engine.setConnectionState('connected');
      await flushMicrotasks();
      expect(h.submitted).toHaveLength(2);
      expect(h.submitted[1]!.newETag).toBe(h.submitted[0]!.newETag); // idempotent replay
      d.pending[1]!.resolve({ resources: [{ result: 'committed', eTag: 'e2' }] });
      await flushMicrotasks();
      expect(outcome).toMatchObject({ kind: 'committed', resources: { r1: { kind: 'committed', eTag: 'e2' } } });
    });
  }
});

// ─── 12. transactionOps — explicit create/put/move/delete ops (v3-port add) ──
//
// The public `client.resources.transaction(ops)` entry. Unlike `transaction`
// (put-from-store), each op carries its own value/baseline + an opaque `op`
// the wire layer turns into the real operation. These exercise: optimistic
// paint, op carriage to submitBatch, create-without-a-store-baseline, the
// stashed-eTag conflict path, rollback of an optimistic create, fail-fast on a
// missing baseline, and the keyed-by-rid per-call handler (v3 delta). The mock
// proves the engine's branching; §5.3.8 backs it through a real Star.
describe('transactionOps — explicit ops (v3-port)', () => {
  it('create: paints optimistically, carries op:create to the wire, commits', async () => {
    const h = makeHarness();
    const outcome = await h.engine.transactionOps({
      t1: { rt: 'todo', op: 'create', typeName: 'Todo', nodeId: 1, value: { title: 'buy milk' } },
    });
    expect(outcome.kind).toBe('committed');
    expect((outcome as { resources: Record<string, TransactionResourceResolution> }).resources.t1!.kind).toBe('committed');
    expect(h.valueOf('todo', 't1')).toEqual({ title: 'buy milk' }); // optimistic paint (gut applyOptimistic → undefined)
    expect(h.submitted[0]!.op).toMatchObject({ op: 'create', typeName: 'Todo', nodeId: 1 }); // op carriage (gut submitKeys op → undefined)
    expect(h.store.get('todo:t1')!.eTag).toBe('srv-1'); // committed eTag written through
  });

  it('put (auto-derived eTag): submits at the store baseline, carries op:put', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { title: 'old' }, 'e1');
    const outcome = await h.engine.transactionOps({
      t1: { rt: 'todo', op: 'put', typeName: 'Todo', value: { title: 'new' } },
    });
    expect(outcome.kind).toBe('committed');
    expect(h.submitted[0]!.eTag).toBe('e1'); // baseline auto-derived from the store
    expect(h.submitted[0]!.op).toMatchObject({ op: 'put' });
    expect(h.valueOf('todo', 't1')).toEqual({ title: 'new' });
  });

  it('put (stashed eTag) → conflict → default use-server adopts the server value', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { title: 'mine' }, 'e1');
    h.setResponder(async () => ({ resources: [conflict({ title: 'theirs' }, 'srv-9')] }));
    const outcome = await h.engine.transactionOps({
      t1: { rt: 'todo', op: 'put', typeName: 'Todo', value: { title: 'mine-edit' }, eTag: 'stale' },
    });
    expect(h.submitted[0]!.eTag).toBe('stale'); // submitted at the stashed baseline, not the store's e1
    expect(outcome.kind).toBe('committed'); // use-server is below the bucket → committed top-level
    expect((outcome as { resources: Record<string, TransactionResourceResolution> }).resources.t1!.kind).toBe('use-server');
    expect(h.valueOf('todo', 't1')).toEqual({ title: 'theirs' });
  });

  it('delete: carries op:delete (no value) at the stashed eTag, commits', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { title: 'x' }, 'e1');
    const outcome = await h.engine.transactionOps({
      t1: { rt: 'todo', op: 'delete', typeName: 'Todo', eTag: 'e1' },
    });
    expect(outcome.kind).toBe('committed');
    expect(h.submitted[0]!.op).toMatchObject({ op: 'delete' });
    expect(h.submitted[0]!.eTag).toBe('e1');
  });

  it('create → permission-denied → rolls back the optimistic create (slot empties), rejected non-retryable', async () => {
    const h = makeHarness();
    h.setResponder(async () => ({ resources: [{ result: 'permission-denied' }] }));
    const outcome = await h.engine.transactionOps({
      t1: { rt: 'todo', op: 'create', typeName: 'Todo', nodeId: 1, value: { title: 'nope' } },
    });
    expect(outcome).toMatchObject({ kind: 'rejected', retryable: false });
    expect((outcome as { resources: Record<string, TransactionResourceResolution> }).resources.t1!.kind).toBe('permission-denied');
    expect(h.valueOf('todo', 't1')).toBeUndefined(); // rolled back to the pre-create base (undefined)
  });

  it('put with no local baseline + no stashed eTag → infrastructure-error, nothing submitted', async () => {
    const h = makeHarness();
    const outcome = await h.engine.transactionOps({
      t1: { rt: 'todo', op: 'put', typeName: 'Todo', value: { title: 'x' } },
    });
    expect(outcome.kind).toBe('infrastructure-error');
    expect(h.submitted).toHaveLength(0);
  });

  it('per-call handler keyed by rid: the listed resource is overridden on conflict', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { title: 'mine' }, 'e1');
    h.setResponder(async () => ({ resources: [conflict({ title: 'srv' }, 'srv-1')] }));
    let calledWith: string | null = null;
    const outcome = await h.engine.transactionOps(
      { t1: { rt: 'todo', op: 'put', typeName: 'Todo', value: { title: 'edit' }, eTag: 'e1' } },
      {
        onTransactionResourceResolution: {
          t1: (rid, res) => {
            if (res.kind === 'conflict-pending') {
              calledWith = rid;
              return { kind: 'use-server' };
            }
          },
        },
      },
    );
    expect(calledWith).toBe('t1'); // keyed lookup found t1's handler (gut perCallHandlers?.[rid] → stays null)
    expect((outcome as { resources: Record<string, TransactionResourceResolution> }).resources.t1!.kind).toBe('use-server');
  });
});

// ─── 12. Reconnect snapshot held ────────────────────────────────────────────

describe('reconnect snapshot held (invariant 8 extension)', () => {
  it("pre-disconnect keystrokes survive the reconnect's auto-resubscribe snapshot push", async () => {
    const h = makeHarness({ quietMs: 500 });
    h.seed('doc', 'r1', { body: 'v0' }, 'e1');
    h.type('doc', 'r1', { body: 'v0 plus my edit' });
    h.engine.setConnectionState('reconnecting'); // write held through the disconnect
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.submitted).toHaveLength(0);

    // Reconnect: auto-resubscribe pushes the server's snapshot (unchanged here).
    h.engine.notifyFanout('doc', 'r1', { value: { body: 'v0' }, meta: { eTag: 'e1' } });
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'v0 plus my edit' }); // held — NOT clobbered

    h.engine.setConnectionState('connected');
    await flushMicrotasks(); // held write flushes and commits (default responder)
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!).toMatchObject({ eTag: 'e1', value: { body: 'v0 plus my edit' } });
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'v0 plus my edit' }); // keystrokes survived
    expect(h.store.get('doc:r1')!.eTag).toBe('srv-1'); // committed; stale held snapshot dropped
  });
});
