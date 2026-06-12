/**
 * Debounce + serial-per-resource queue — D0 property tests per
 * `tasks/debounce-serial-queue.md`. Each `it` maps to one pinned invariant
 * from the D0 checklist. Fake timers for determinism; the factory-level
 * integration (real store, middleware) is covered separately in
 * factory-basics / collection-sync suites.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDebounceQueue, type QueueSubmission, type NonCommitApi } from '../src/debounce-queue';
import type { TransactionOutcome } from '../src/types';

// ─── Harness: fake store + capture-submit mock ─────────────────────────────

type Responder = (subs: QueueSubmission[]) => Promise<TransactionOutcome[]>;

function makeHarness(opts: { quietMs?: number; maxWaitMs?: number; timeoutMs?: number } = {}) {
  const store = new Map<string, { value: unknown; eTag?: string }>();
  const submitted: QueueSubmission[] = [];
  const nonCommits: Array<{ outcome: unknown; submission: QueueSubmission }> = [];
  let etagCounter = 0;
  let newETagCounter = 0;

  // Default: auto-commit with a fresh server eTag, resolving on a microtask.
  let respond: Responder = async (subs) =>
    subs.map(() => ({ resolution: 'committed' as const, eTag: `srv-${++etagCounter}` }));
  // Default non-commit handling mirrors the factory: use-server → accept; else fail.
  let onNonCommitBehavior = (outcome: unknown, _s: QueueSubmission, api: NonCommitApi) => {
    const o = outcome as TransactionOutcome;
    if (o.resolution === 'use-server') api.accept(o.snapshot);
    else api.fail();
  };

  const queue = createDebounceQueue({
    submit: (subs) => {
      submitted.push(...subs.map((s) => ({ ...s })));
      return respond(subs);
    },
    readResource: (rt, rid) => store.get(`${rt}:${rid}`) ?? { value: undefined, eTag: undefined },
    onCommitted: (s, eTag) => {
      const entry = store.get(`${s.rt}:${s.rid}`);
      if (entry) entry.eTag = eTag;
    },
    onNonCommit: (outcome, s, api) => {
      nonCommits.push({ outcome, submission: { ...s } });
      onNonCommitBehavior(outcome, s, api);
    },
    newETag: () => `ne-${++newETagCounter}`,
    ...opts,
  });

  function seed(rt: string, rid: string, value: unknown, eTag = 'eTag-v1') {
    store.set(`${rt}:${rid}`, { value, eTag });
  }
  /** A keystroke: update the (already-optimistic) store, then notify the queue. */
  function type(rt: string, rid: string, value: unknown, writeOpts?: { quietMs?: number; preWriteValue?: unknown }) {
    const entry = store.get(`${rt}:${rid}`)!;
    const pre = structuredClone(entry.value);
    entry.value = value;
    queue.write(rt, rid, { preWriteValue: pre, ...writeOpts });
  }

  return {
    queue,
    store,
    submitted,
    nonCommits,
    seed,
    type,
    setResponder: (r: Responder) => {
      respond = r;
    },
    setNonCommitBehavior: (b: typeof onNonCommitBehavior) => {
      onNonCommitBehavior = b;
    },
  };
}

/** Deferred responder for controlled in-flight windows. */
function deferredResponder() {
  const pending: Array<{ subs: QueueSubmission[]; resolve: (o: TransactionOutcome[]) => void }> = [];
  const responder: Responder = (subs) =>
    new Promise<TransactionOutcome[]>((resolve) => {
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

// ─── D0 invariants ─────────────────────────────────────────────────────────

describe('debounce coalescing', () => {
  it('N keystrokes within quietMs produce exactly 1 transaction (with the final value)', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { title: '' });
    for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
      h.type('todo', 't1', { title: text });
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.value).toEqual({ title: 'hello' });
    expect(h.submitted[0]!.eTag).toBe('eTag-v1');
  });

  it('continuous typing over T > maxWaitMs produces ≤ ceil(T/maxWaitMs)+1 transactions', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { title: '' });
    const T = 4900;
    for (let t = 0; t <= T; t += 100) {
      h.type('todo', 't1', { title: 'x'.repeat(t / 100 + 1) });
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(2500); // drain trailing quiet window
    const cap = Math.ceil(T / 2000) + 1;
    expect(h.submitted.length).toBeGreaterThanOrEqual(2); // maxWait actually fired mid-burst
    expect(h.submitted.length).toBeLessThanOrEqual(cap);
    // No keystroke lost: the last submission carries the final value.
    expect(h.submitted.at(-1)!.value).toEqual({ title: 'x'.repeat(50) });
  });

  it('a quietMs:0 (@debounce(0)) write submits on the next microtask and flushes pending debounced edits on the same resource', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { title: 'a', done: false });
    h.type('todo', 't1', { title: 'ab', done: false }); // debounced field edit, pending
    await vi.advanceTimersByTimeAsync(100); // quiet window NOT elapsed
    h.type('todo', 't1', { title: 'ab', done: true }, { quietMs: 0 }); // eager field
    await flushMicrotasks();
    expect(h.submitted).toHaveLength(1); // one submission carries BOTH edits
    expect(h.submitted[0]!.value).toEqual({ title: 'ab', done: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.submitted).toHaveLength(1); // the pending debounced edit was folded, not double-sent
  });
});

describe('eTag chain + idempotency tokens', () => {
  it('all submitted newETags are unique across logical submissions', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { n: 0 });
    for (let burst = 0; burst < 3; burst++) {
      h.type('todo', 't1', { n: burst + 1 });
      await vi.advanceTimersByTimeAsync(600); // quiet elapse + commit
    }
    expect(h.submitted).toHaveLength(3);
    expect(new Set(h.submitted.map((s) => s.newETag)).size).toBe(3);
  });

  it("each submission's eTag equals the previous successful submission's resulting eTag — no stale or duplicate eTags", async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { n: 0 }, 'eTag-v1');
    for (let burst = 0; burst < 3; burst++) {
      h.type('todo', 't1', { n: burst + 1 });
      await vi.advanceTimersByTimeAsync(600);
    }
    expect(h.submitted.map((s) => s.eTag)).toEqual(['eTag-v1', 'srv-1', 'srv-2']);
    expect(new Set(h.submitted.map((s) => s.eTag)).size).toBe(3);
  });

  it('buffered writes during in-flight chain off the in-flight result eTag, not the pre-submit eTag', async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.seed('todo', 't1', { n: 0 }, 'eTag-v1');
    h.type('todo', 't1', { n: 1 });
    await vi.advanceTimersByTimeAsync(500); // S1 in flight
    expect(h.submitted).toHaveLength(1);
    h.type('todo', 't1', { n: 2 }); // buffered
    h.type('todo', 't1', { n: 3 }); // coalesces
    d.pending[0]!.resolve([{ resolution: 'committed', eTag: 'srv-after-s1' }]);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2500); // buffered burst re-enters debounce, then submits
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted[1]!.eTag).toBe('srv-after-s1');
    expect(h.submitted[1]!.value).toEqual({ n: 3 }); // latest-value coalescing
  });
});

describe('B4 — merge base re-anchors at the commit boundary', () => {
  it("a buffered write chaining onto a clean commit carries the committed value as its base, not the original pre-write value", async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.seed('doc', 'd1', { body: 'V0' }, 'eTag-v1');

    h.type('doc', 'd1', { body: 'V1' });
    await vi.advanceTimersByTimeAsync(500); // T1 in flight with value V1, base V0
    expect(h.submitted[0]!.base).toEqual({ body: 'V0' });
    h.type('doc', 'd1', { body: 'V2' }); // buffered behind T1
    d.pending[0]!.resolve([{ resolution: 'committed', eTag: 'srv-t1' }]); // T1 commits
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2500); // T2 (the buffered write) submits

    expect(h.submitted).toHaveLength(2);
    // A third party moved the server: T2 conflicts.
    d.pending[1]!.resolve([
      {
        resolution: 'use-server',
        snapshot: { value: { body: 'THIRD-PARTY' }, meta: { eTag: 'srv-3p' } },
      },
    ]);
    await flushMicrotasks();
    expect(h.nonCommits).toHaveLength(1);
    // The resolver's base is T1's committed value — NOT the stale original V0
    // (a base-not-re-anchored impl double-counts T1's edit in the merge).
    expect(h.nonCommits[0]!.submission.base).toEqual({ body: 'V1' });
  });
});

describe('serial per resource + conflict invocation count', () => {
  it('a cross-client commit landing while local tx is in flight invokes the resolver exactly once, not once per buffered write', async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.seed('todo', 't1', { n: 0 }, 'eTag-v1');
    h.type('todo', 't1', { n: 1 });
    await vi.advanceTimersByTimeAsync(500); // S1 in flight
    for (let i = 2; i <= 6; i++) h.type('todo', 't1', { n: i }); // 5 buffered writes
    d.pending[0]!.resolve([
      {
        resolution: 'use-server',
        snapshot: { value: { n: 99 }, meta: { eTag: 'srv-other' } },
      },
    ]);
    await flushMicrotasks();
    expect(h.nonCommits).toHaveLength(1);
  });

  it('different resources have independent timers and interleave freely', async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.seed('todo', 't1', { n: 0 });
    h.seed('todo', 't2', { n: 0 });
    h.type('todo', 't1', { n: 1 });
    await vi.advanceTimersByTimeAsync(500); // t1 in flight (deferred — stays occupied)
    h.type('todo', 't2', { n: 1 });
    await vi.advanceTimersByTimeAsync(500); // t2 proceeds despite t1 occupied
    expect(h.submitted.map((s) => s.rid)).toEqual(['t1', 't2']);
  });
});

describe('flush triggers', () => {
  it('flush on unmount: a write inside the quiet window submits exactly once via flush', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { n: 0 });
    h.type('todo', 't1', { n: 1 });
    await vi.advanceTimersByTimeAsync(100); // quiet NOT elapsed
    h.queue.flush('todo', 't1'); // unmount-driven flush
    await flushMicrotasks();
    expect(h.submitted).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.submitted).toHaveLength(1); // timers were cancelled — no double submit
  });

  it('flush on blur: same property through the same external trigger', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { n: 0 });
    h.type('todo', 't1', { n: 1 });
    h.queue.flush(); // blur-driven flush (no-args = all pending)
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.submitted).toHaveLength(1);
  });

  it('flush on dispose: pending writes flush before dispose resolves; nothing submits after', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { n: 0 });
    h.seed('todo', 't2', { n: 0 });
    h.type('todo', 't1', { n: 1 });
    h.type('todo', 't2', { n: 1 });
    const disposed = h.queue.dispose();
    await flushMicrotasks();
    await expect(disposed).resolves.toBeUndefined();
    expect(h.submitted.map((s) => s.rid).sort()).toEqual(['t1', 't2']);
    // Post-dispose writes and timers produce nothing.
    h.type('todo', 't1', { n: 2 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.submitted).toHaveLength(2);
  });
});

describe('explicit multi-resource batch (m9)', () => {
  it('an explicit batch folds pending debounced writes for its resources — no lost write, no separate submission', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { n: 0 }, 'eTag-t1');
    h.seed('todo', 't2', { n: 0 }, 'eTag-t2');
    h.type('todo', 't1', { n: 1 }); // debounced, pending
    await vi.advanceTimersByTimeAsync(100);
    h.queue.explicitBatch([
      { rt: 'todo', rid: 't1' },
      { rt: 'todo', rid: 't2' },
    ]);
    await flushMicrotasks();
    // One batch of two submissions; t1's pending edit rode the batch.
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted.find((s) => s.rid === 't1')!.value).toEqual({ n: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.submitted).toHaveLength(2); // the folded write never re-submits
  });

  it('a batch occupies all its keys: buffered writes chain off the batch result; the batch parks until every key is free', async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.seed('todo', 't1', { n: 0 }, 'eTag-t1');
    h.seed('todo', 't2', { n: 0 }, 'eTag-t2');

    h.type('todo', 't1', { n: 1 });
    await vi.advanceTimersByTimeAsync(500); // t1 single in flight (deferred)
    h.queue.explicitBatch([
      { rt: 'todo', rid: 't1' },
      { rt: 'todo', rid: 't2' },
    ]);
    await flushMicrotasks();
    expect(h.submitted).toHaveLength(1); // batch parked behind t1's in-flight

    d.pending[0]!.resolve([{ resolution: 'committed', eTag: 'srv-t1-a' }]);
    await flushMicrotasks();
    expect(h.submitted).toHaveLength(3); // batch went out (2 submissions)
    const batchT1 = h.submitted.find((s, i) => i > 0 && s.rid === 't1')!;
    expect(batchT1.eTag).toBe('srv-t1-a'); // chained off the released in-flight result

    // Buffered write to a batch member while the batch is in flight…
    h.type('todo', 't1', { n: 5 });
    d.pending[1]!.resolve([
      { resolution: 'committed', eTag: 'srv-t1-b' },
      { resolution: 'committed', eTag: 'srv-t2-a' },
    ]);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2500);
    // …chains off the batch's resulting eTag for that resource.
    expect(h.submitted.at(-1)!).toMatchObject({ rid: 't1', eTag: 'srv-t1-b' });
  });
});

describe('connection gate (decided 2026-06-11)', () => {
  it('disconnect suspends the write path: no submission, no timers while disconnected; reconnect flushes exactly one coalesced submission', async () => {
    const h = makeHarness();
    h.seed('todo', 't1', { n: 0 }, 'eTag-v1');
    h.type('todo', 't1', { n: 1 });
    await vi.advanceTimersByTimeAsync(100);
    h.queue.setConnectionState('reconnecting');
    await vi.advanceTimersByTimeAsync(60_000); // quiet, maxWait, timeout — all suspended
    expect(h.submitted).toHaveLength(0);
    expect(h.nonCommits).toHaveLength(0); // nothing timed out / rolled back
    h.type('todo', 't1', { n: 2 }); // keeps coalescing while offline
    h.queue.flush('todo', 't1'); // a blur while offline holds too
    await vi.advanceTimersByTimeAsync(60_000); // offline writes must not arm timers either
    expect(h.submitted).toHaveLength(0);
    h.queue.setConnectionState('connected');
    await flushMicrotasks();
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!).toMatchObject({ eTag: 'eTag-v1', value: { n: 2 } });
  });

  it('in-flight at disconnect: never rolled back, timeout suspended; re-submits on reconnect with the SAME newETag', async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.seed('todo', 't1', { n: 0 }, 'eTag-v1');
    h.type('todo', 't1', { n: 1 });
    await vi.advanceTimersByTimeAsync(500); // S1 in flight (deferred — server never answers)
    expect(h.submitted).toHaveLength(1);

    h.queue.setConnectionState('reconnecting');
    await vi.advanceTimersByTimeAsync(120_000); // way past timeoutMs
    expect(h.nonCommits).toHaveLength(0); // the 10s timeout did NOT fire while disconnected

    h.queue.setConnectionState('connected');
    await flushMicrotasks();
    expect(h.submitted).toHaveLength(2); // replay
    expect(h.submitted[1]!.newETag).toBe(h.submitted[0]!.newETag); // idempotent token
    expect(h.submitted[1]!.eTag).toBe(h.submitted[0]!.eTag);
    expect(h.submitted[1]!.attempt).toBe(2);

    // Server replay short-circuits to committed; chain advances normally.
    d.pending[1]!.resolve([{ resolution: 'committed', eTag: 'srv-1' }]);
    await flushMicrotasks();
    h.type('todo', 't1', { n: 2 });
    await vi.advanceTimersByTimeAsync(600);
    expect(h.submitted.at(-1)!.eTag).toBe('srv-1');
  });

  it('a stale first-attempt response arriving after the replay is ignored (no double-settle)', async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.seed('todo', 't1', { n: 0 }, 'eTag-v1');
    h.type('todo', 't1', { n: 1 });
    await vi.advanceTimersByTimeAsync(500);
    h.queue.setConnectionState('reconnecting');
    h.queue.setConnectionState('connected');
    await flushMicrotasks();
    expect(h.submitted).toHaveLength(2);
    d.pending[1]!.resolve([{ resolution: 'committed', eTag: 'srv-replay' }]); // replay answers first
    await flushMicrotasks();
    d.pending[0]!.resolve([{ resolution: 'committed', eTag: 'srv-stale' }]); // original limps in late
    await flushMicrotasks();
    h.type('todo', 't1', { n: 2 });
    await vi.advanceTimersByTimeAsync(600);
    expect(h.submitted.at(-1)!.eTag).toBe('srv-replay'); // stale attempt did not move the chain
  });
});

describe('in-flight infra timeout (while connected)', () => {
  it('a non-answering server while CONNECTED fires the timeout outcome once', async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.seed('todo', 't1', { n: 0 });
    h.type('todo', 't1', { n: 1 });
    await vi.advanceTimersByTimeAsync(500); // in flight
    await vi.advanceTimersByTimeAsync(10_000); // timeoutMs elapses
    expect(h.nonCommits).toHaveLength(1);
    expect(h.nonCommits[0]!.outcome).toEqual({ queueSignal: 'timeout' });
  });
});

describe('per-type configuration', () => {
  it('transactionDebounce(rt, …) overrides quiet/maxWait for that type only', async () => {
    const h = makeHarness();
    h.queue.transactionDebounce('chat', { quietMs: 50 });
    h.seed('chat', 'c1', { text: '' });
    h.seed('todo', 't1', { n: 0 });
    h.type('chat', 'c1', { text: 'hi' });
    h.type('todo', 't1', { n: 1 });
    await vi.advanceTimersByTimeAsync(60);
    expect(h.submitted.map((s) => s.rt)).toEqual(['chat']); // chat flushed at 50ms; todo still quiet
    await vi.advanceTimersByTimeAsync(500);
    expect(h.submitted.map((s) => s.rt)).toEqual(['chat', 'todo']);
  });
});

describe('conflict re-submission (use-this chain plumbing for detour #4)', () => {
  it('api.resubmit sends a fresh newETag at the server eTag with the re-anchored base, and buffered writes chain after it', async () => {
    const h = makeHarness();
    const d = deferredResponder();
    h.setResponder(d.responder);
    h.setNonCommitBehavior((outcome, _s, api) => {
      const o = outcome as TransactionOutcome;
      if (o.resolution === 'use-server') {
        // a use-this style resolver: merged value at the server's eTag
        api.resubmit({
          eTag: o.snapshot.meta.eTag,
          value: { merged: true },
          base: o.snapshot.value,
        });
      } else {
        api.fail();
      }
    });
    h.seed('doc', 'd1', { body: 'L' }, 'eTag-v1');
    h.type('doc', 'd1', { body: 'L1' });
    await vi.advanceTimersByTimeAsync(500);
    d.pending[0]!.resolve([
      { resolution: 'use-server', snapshot: { value: { body: 'S1' }, meta: { eTag: 'srv-s1' } } },
    ]);
    await flushMicrotasks();
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted[1]!).toMatchObject({ eTag: 'srv-s1', value: { merged: true } });
    expect(h.submitted[1]!.base).toEqual({ body: 'S1' }); // base = previous conflict's server snapshot
    expect(h.submitted[1]!.newETag).not.toBe(h.submitted[0]!.newETag); // new logical submission
    d.pending[1]!.resolve([{ resolution: 'committed', eTag: 'srv-final' }]);
    await flushMicrotasks();
    h.type('doc', 'd1', { body: 'L2' });
    await vi.advanceTimersByTimeAsync(600);
    expect(h.submitted.at(-1)!.eTag).toBe('srv-final');
  });
});
