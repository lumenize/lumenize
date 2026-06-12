/**
 * Conflict / outcome state machine — property tests per
 * `tasks/factory-conflict-outcome.md` § Tests. Each `describe` maps to a
 * checklist item; the harness is a scripted mock server + captured store
 * effects / flash classes, with the real debounce queue underneath (so
 * occupancy, timeout, and connection-gate behavior are the validated ones,
 * not re-mocked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createConflictOutcomeEngine,
  type ServerBatchResponse,
  type Snapshot,
  type TransactionOutcome,
  type TransactionResourceResolution,
} from '../src/conflict-outcome';
import type { QueueSubmission } from '../src/debounce-queue';
import { makeLongformResolver } from '../src/text-merge';

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

/** Deferred batch responses, resolved manually per submission order. */
function deferredResponder() {
  const pending: Array<{ subs: QueueSubmission[]; resolve: (o: ServerBatchResponse) => void }> = [];
  const responder: Responder = (subs) =>
    new Promise((resolve) => {
      pending.push({ subs, resolve });
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
  it("'committed': resolution + eTag writeback + commit flash", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'a' });
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome).toEqual({
      kind: 'ok',
      resources: { r1: { kind: 'committed', eTag: 'srv-1' } },
    });
    expect(h.store.get('doc:r1')!.eTag).toBe('srv-1');
    expect(h.flashes).toContainEqual({ key: 'doc:r1', cls: 'lumenize-commit-success' });
  });

  it("'use-server' (framework default — no handler): server value applied, revert flash", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'local' });
    h.setResponder(async () => ({ resources: [conflict({ body: 'server' }, 'e2')] }));
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome.kind).toBe('ok');
    expect((outcome as { resources: Record<string, TransactionResourceResolution> }).resources.r1)
      .toMatchObject({ kind: 'use-server' });
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'server' });
    expect(h.flashes).toContainEqual({ key: 'doc:r1', cls: 'lumenize-conflict-revert' });
  });

  it("'use-this' (1 retry → commit): re-submits the handler value at the server eTag", async () => {
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
    expect(outcome).toMatchObject({ kind: 'ok', resources: { r1: { kind: 'committed', eTag: 'e3' } } });
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

  it("'permission-denied': rolled back, revert flash", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'orig' });
    h.type('doc', 'r1', { body: 'forbidden' });
    h.setResponder(async () => ({ resources: [{ result: 'permission-denied' }] }));
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'orig' });
    expect(h.flashes).toContainEqual({ key: 'doc:r1', cls: 'lumenize-conflict-revert' });
  });

  it("'human-in-the-loop': optimistic stays painted, NO flash, baseline advances for later edits", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { body: 'local-paint' }, 'e1');
    h.engine.onTransactionResourceResolution('doc', (_rid, res) =>
      res.kind === 'conflict-pending' ? { kind: 'human-in-the-loop' } : undefined,
    );
    h.setResponder(async () => ({ resources: [conflict({ body: 'server' }, 'e2')] }));
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome).toMatchObject({
      kind: 'ok',
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

// ─── 2 + 6. Mixed fate / per-resource rollback ──────────────────────────────

describe('mixed-fate batch', () => {
  it("top-level 'ok' with per-resource resolutions: use-server / permission-denied / committed", async () => {
    const h = makeHarness();
    h.seed('doc', 'A', { v: 'a-local' }, 'eA');
    h.seed('doc', 'B', { v: 'b-orig' }, 'eB');
    h.seed('doc', 'C', { v: 'c' }, 'eC');
    h.type('doc', 'B', { v: 'b-local' }); // so B has something to roll back
    h.setResponder(async (subs) => ({
      resources: subs.map((s) =>
        s.rid === 'A'
          ? conflict({ v: 'a-server' }, 'eA2')
          : s.rid === 'B'
            ? { result: 'permission-denied' as const }
            : { result: 'committed' as const, eTag: 'eC2' },
      ),
    }));
    const outcome = await h.engine.transaction([
      { rt: 'doc', rid: 'A' },
      { rt: 'doc', rid: 'B' },
      { rt: 'doc', rid: 'C' },
    ]);
    expect(outcome.kind).toBe('ok');
    const resources = (outcome as { resources: Record<string, TransactionResourceResolution> }).resources;
    expect(resources.A).toMatchObject({ kind: 'use-server' });
    expect(resources.B).toEqual({ kind: 'permission-denied' });
    expect(resources.C).toEqual({ kind: 'committed', eTag: 'eC2' });
    expect(h.valueOf('doc', 'A')).toEqual({ v: 'a-server' }); // server applied
    expect(h.valueOf('doc', 'B')).toEqual({ v: 'b-orig' }); // only B rolled back…
    expect(h.valueOf('doc', 'C')).toEqual({ v: 'c' }); // …sibling committed untouched
    expect(h.store.get('doc:C')!.eTag).toBe('eC2');
  });
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
    expect(outcome.kind).toBe('ok');
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
  it("per-call 3 beats per-type 10 beats default 5: 'retries-exhausted' with attempts: 3", async () => {
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
      kind: 'ok',
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
    expect(outcome).toEqual({ kind: 'timeout' });
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

  it('a held fanout is released after a rollback conclusion (real news survives the failure)', async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.seed('doc', 'r1', { body: 'v0' }, 'e1');
    h.type('doc', 'r1', { body: 'v0-local' });
    await flushMicrotasks(); // in flight
    h.engine.notifyFanout('doc', 'r1', { value: { body: 'news' }, meta: { eTag: 'e9' } }); // held
    d.pending[0]!.resolve({ resources: [{ result: 'validation-failed', errors: {} }] });
    await flushMicrotasks();
    expect(h.valueOf('doc', 'r1')).toEqual({ body: 'news' }); // rollback happened, then the held news applied
  });
});

// ─── 9 + 10. Always-resolve / ontology-stale ────────────────────────────────

describe('transaction-wide failures', () => {
  it("a while-connected throw resolves 'infrastructure-error' — rolled back, promise never rejects", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { v: 'orig' }, 'e1');
    h.type('doc', 'r1', { v: 'attempt' });
    await flushMicrotasks(); // flush the debounced write first (committed by default responder)
    h.setResponder(async () => {
      throw new Error('mesh exploded');
    });
    h.type('doc', 'r1', { v: 'attempt-2' });
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome.kind).toBe('infrastructure-error');
    expect((outcome as { error: Error }).error.message).toBe('mesh exploded');
    expect(h.valueOf('doc', 'r1')).toEqual({ v: 'attempt' }); // rolled back to the committed baseline value
  });

  it("'ontology-stale': resolves with versions, fires onShouldRefreshUI, does NOT roll back", async () => {
    const h = makeHarness();
    h.seed('doc', 'r1', { v: 'orig' }, 'e1');
    h.type('doc', 'r1', { v: 'painted' });
    h.setResponder(async () => ({ ontologyStale: { clientVersion: '1.0', currentVersion: '2.0' } }));
    const outcome = await h.engine.transaction([{ rt: 'doc', rid: 'r1' }]);
    expect(outcome).toEqual({ kind: 'ontology-stale', clientVersion: '1.0', currentVersion: '2.0' });
    expect(h.refreshes).toEqual([{ clientVersion: '1.0', currentVersion: '2.0', reason: 'ontology-stale' }]);
    expect(h.valueOf('doc', 'r1')).toEqual({ v: 'painted' }); // paint kept — reload is the remedy
  });
});

// ─── 11. Connection-gated rollback ──────────────────────────────────────────

describe('connection-gated rollback (invariant 10)', () => {
  it('in-flight at disconnect: no timeout, no rollback; reconnect replays the SAME newETag and resolves committed', async () => {
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

    h.engine.setConnectionState('reconnecting');
    await vi.advanceTimersByTimeAsync(120_000); // way past timeoutMs
    expect(outcome).toBeNull(); // no timeout while disconnected…
    expect(h.valueOf('doc', 'r1')).toEqual({ v: 'painted' }); // …and no rollback

    h.engine.setConnectionState('connected');
    await flushMicrotasks();
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted[1]!.newETag).toBe(h.submitted[0]!.newETag); // idempotent replay
    d.pending[1]!.resolve({ resources: [{ result: 'committed', eTag: 'e2' }] });
    await flushMicrotasks();
    expect(outcome).toMatchObject({ kind: 'ok', resources: { r1: { kind: 'committed', eTag: 'e2' } } });
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
