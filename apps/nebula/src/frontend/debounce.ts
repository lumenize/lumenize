/**
 * Debounce + serial-per-resource submission queue. Validated in isolation
 * (`tasks/debounce-serial-queue.md` D0/D1) and ported here verbatim (D2).
 *
 * Responsibilities (and only these): WHEN a transaction submits, WHAT eTag /
 * newETag / base it carries, and serial-per-`(rt, rid)` occupancy. The
 * optimistic store write happens before/outside the queue (every keystroke
 * paints immediately); conflict RESOLUTION (the TransactionOutcome /
 * ConflictResolverVerdict machine) lives in the conflict-outcome engine —
 * the queue delegates every non-committed outcome to `onNonCommit` and holds
 * the resource occupied until that handler concludes via the passed api
 * (async resolver deliberation therefore suspends the queue for that resource
 * while others proceed).
 *
 * The queue is **outcome-shape-agnostic**: commit detection is delegated to the
 * injected `interpretCommit` and every non-commit goes to `onNonCommit`. In
 * production the factory/conflict-outcome engine supplies an `interpretCommit`
 * that reads the v3 outcome shape; the built-in default below recognizes the
 * `{ resolution: 'committed', eTag }` shape used by the queue's own tests.
 *
 * Pinned semantics implemented here (see the task file for the full list):
 * - quiet window (default 500 ms, restarted per write) + max wait (default
 *   2000 ms, anchored at the burst's first write) + per-type config + a
 *   per-write `quietMs: 0` eager override (`@debounce(0)`) that flushes the
 *   whole resource;
 * - serial per resource: at most one in-flight transaction per key; writes
 *   during flight buffer (latest-value coalescing — the submission re-reads
 *   the store at submit time);
 * - eTag chain: each submission's `eTag` is the previous successful
 *   submission's resulting eTag (`baselineETag` advances on commit/accept);
 * - B4 base rule: `base` = value at the baseline eTag the next submission
 *   uses; re-anchors at the commit boundary (committed ⇒ base := the
 *   just-submitted value), on accept-server, and on conflict re-submission;
 * - connection gate: while not `'connected'`, flush + all timers (quiet,
 *   maxWait, in-flight timeout) suspend; a disconnect never rolls back; on
 *   reconnect an in-flight submission replays with its SAME `newETag`
 *   (server replay is idempotent) and held writes flush;
 * - multi-resource explicit batches (m9) occupy all their keys, fold pending
 *   debounced writes for those keys in, and park until every key is free.
 */
/**
 * Synthesized by the queue itself when no usable server outcome exists:
 * the in-flight timer fired (while connected), or the submit fn threw.
 * Delivered through `onNonCommit` like any other non-commit outcome.
 */
export type QueueSignal =
  | { queueSignal: 'timeout' }
  | { queueSignal: 'infrastructure-error'; error: Error };

export function isQueueSignal(o: unknown): o is QueueSignal {
  return typeof o === 'object' && o !== null && 'queueSignal' in o;
}

export interface QueueSubmission {
  rt: string;
  rid: string;
  /** Baseline this submission asserts (optimistic-concurrency check). */
  eTag: string;
  /** Idempotency token — stable across reconnect replays of this submission. */
  newETag: string;
  /** Coalesced value, read from the store at submit time (cloned). */
  value: unknown;
  /** Merge base: the value at `eTag` (B4 — what a conflict resolver hands textMerge). */
  base: unknown;
  /** Replay counter for this logical submission; 1 = first send. */
  attempt: number;
}

/** Handler conclusion api for non-committed outcomes; exactly one method must be called. */
export interface NonCommitApi {
  /** Server's value accepted (use-server): baseline advances to the snapshot; buffered writes chain off it. */
  accept(snapshot: { value: unknown; meta: { eTag: string } }): void;
  /** Terminal local failure (validation/permission/timeout after rollback): pending+buffered edits for the key are dropped. */
  fail(): void;
  /** Conflict re-submission (use-this): new attempt at the server's current eTag with a re-anchored base. */
  resubmit(args: { eTag: string; value: unknown; base: unknown }): void;
}

export interface DebounceQueueConfig {
  /** Send a batch (usually length 1). One outcome per submission, same order.
   *  A throw becomes a per-submission `{ queueSignal: 'infrastructure-error' }`. */
  submit: (submissions: QueueSubmission[]) => Promise<unknown[]>;
  /** Read the CURRENT (optimistic) resource state from the store. */
  readResource: (rt: string, rid: string) => { value: unknown; eTag?: string };
  /** Extract the committed eTag from an outcome, or null if not committed.
   *  Default reads the queue-test shape `{ resolution: 'committed', eTag }`;
   *  production supplies one that reads the v3 outcome shape. */
  interpretCommit?: (outcome: unknown) => string | null;
  /** Committed: the store should adopt `eTag` (the queue has already advanced its chain).
   *  `context` is the opaque value passed to `explicitBatch` (undefined for debounced writes). */
  onCommitted?: (submission: QueueSubmission, eTag: string, context?: unknown) => void;
  /** Every non-committed outcome (incl. QueueSignal). The key stays occupied until the api concludes. */
  onNonCommit: (outcome: unknown, submission: QueueSubmission, api: NonCommitApi, context?: unknown) => void;
  quietMs?: number;
  maxWaitMs?: number;
  /** In-flight infra timeout; suspended while disconnected. */
  timeoutMs?: number;
  /** Clone for captured value/base snapshots (factory passes a toRaw-aware clone). */
  clone?: (v: unknown) => unknown;
  /** Injectable for deterministic tests. */
  newETag?: () => string;
}

interface KeyState {
  rt: string;
  rid: string;
  /** A local edit awaits submission (timers running, held by disconnect, or buffered behind in-flight). */
  dirty: boolean;
  /** Submit buffered edits immediately on release instead of re-entering the quiet window. */
  flushOnRelease: boolean;
  quietTimer?: ReturnType<typeof setTimeout>;
  maxWaitTimer?: ReturnType<typeof setTimeout>;
  /** Shortest quietMs seen in the current burst (eager fields shrink the window for the whole resource). */
  burstQuietMs?: number;
  baselineETag?: string;
  baseValue?: unknown;
  inFlight?: Batch;
}

interface Batch {
  keys: KeyState[];
  submissions: QueueSubmission[];
  attempt: number;
  settled: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  suspendedByDisconnect: boolean;
  /** Opaque caller context threaded to onCommitted/onNonCommit (explicitBatch arg; resubmits inherit). */
  context?: unknown;
  /** Resolves when every key's outcome (incl. handler conclusion) released the key. */
  done: Promise<void>;
  resolveDone: () => void;
  openOutcomes: number;
}

const DEFAULT_QUIET_MS = 500;
const DEFAULT_MAX_WAIT_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10_000;

export function createDebounceQueue(config: DebounceQueueConfig) {
  const quietDefault = config.quietMs ?? DEFAULT_QUIET_MS;
  const maxWaitDefault = config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clone = config.clone ?? ((v: unknown) => (v === undefined ? undefined : structuredClone(v)));
  const genETag = config.newETag ?? (() => globalThis.crypto.randomUUID());
  const interpretCommit =
    config.interpretCommit ??
    ((o: unknown) =>
      typeof o === 'object' && o !== null && (o as { resolution?: string }).resolution === 'committed'
        ? (o as { eTag: string }).eTag
        : null);

  const keys = new Map<string, KeyState>();
  const perType = new Map<string, { quietMs?: number; maxWaitMs?: number }>();
  /** Parked explicit batches waiting for all their keys to free (FIFO). */
  const parked: Array<{ keyStates: KeyState[]; context?: unknown }> = [];
  const openBatches = new Set<Batch>();
  let connected = true;
  let disposed = false;

  function keyOf(rt: string, rid: string): string {
    return `${rt}:${rid}`;
  }

  function getKey(rt: string, rid: string): KeyState {
    const k = keyOf(rt, rid);
    let ks = keys.get(k);
    if (!ks) {
      ks = { rt, rid, dirty: false, flushOnRelease: false };
      keys.set(k, ks);
    }
    return ks;
  }

  function clearTimers(ks: KeyState): void {
    if (ks.quietTimer) clearTimeout(ks.quietTimer);
    if (ks.maxWaitTimer) clearTimeout(ks.maxWaitTimer);
    ks.quietTimer = undefined;
    ks.maxWaitTimer = undefined;
  }

  function isFree(ks: KeyState): boolean {
    return ks.inFlight === undefined;
  }

  function isIdle(rt: string, rid: string): boolean {
    const ks = keys.get(keyOf(rt, rid));
    return !ks || (!ks.dirty && isFree(ks));
  }

  /** First-divergence baseline capture (B4 site a). No-op once initialized. */
  function ensureBaseline(ks: KeyState, preWriteValue: unknown, havePreWrite: boolean): boolean {
    if (ks.baselineETag !== undefined) return true;
    const { value, eTag } = config.readResource(ks.rt, ks.rid);
    if (eTag === undefined) return false; // never-subscribed — no transactions
    ks.baselineETag = eTag;
    ks.baseValue = havePreWrite ? preWriteValue : clone(value);
    return true;
  }

  function write(
    rt: string,
    rid: string,
    opts: { quietMs?: number; preWriteValue?: unknown } = {},
  ): void {
    if (disposed) return;
    const ks = getKey(rt, rid);
    const havePreWrite = Object.prototype.hasOwnProperty.call(opts, 'preWriteValue');
    if (!ensureBaseline(ks, opts.preWriteValue, havePreWrite)) return;

    const effQuiet = Math.min(
      opts.quietMs ?? perType.get(rt)?.quietMs ?? quietDefault,
      ks.burstQuietMs ?? Infinity,
    );
    ks.burstQuietMs = effQuiet;
    ks.dirty = true;

    if (!isFree(ks)) {
      // Buffered behind in-flight. An eager write makes the release flush immediately.
      if (effQuiet === 0) ks.flushOnRelease = true;
      return;
    }
    if (!connected) return; // held — timers stay suspended; reconnect flushes

    if (effQuiet === 0) {
      clearTimers(ks);
      queueMicrotask(() => {
        if (ks.dirty && isFree(ks) && connected && !disposed) submitKeys([ks], false);
      });
      return;
    }
    if (ks.quietTimer) clearTimeout(ks.quietTimer);
    ks.quietTimer = setTimeout(() => {
      ks.quietTimer = undefined;
      if (ks.dirty && isFree(ks) && connected) submitKeys([ks], false);
    }, effQuiet);
    if (!ks.maxWaitTimer) {
      ks.maxWaitTimer = setTimeout(() => {
        ks.maxWaitTimer = undefined;
        if (ks.dirty && isFree(ks) && connected) submitKeys([ks], false);
      }, perType.get(rt)?.maxWaitMs ?? maxWaitDefault);
    }
  }

  /** External flush trigger (unmount / blur / explicit). In-flight keys flush on release; disconnected holds. */
  function flush(rt?: string, rid?: string): void {
    const targets =
      rt !== undefined && rid !== undefined
        ? [keys.get(keyOf(rt, rid))].filter((k): k is KeyState => !!k)
        : [...keys.values()];
    for (const ks of targets) {
      if (!ks.dirty) continue;
      if (!isFree(ks)) {
        ks.flushOnRelease = true;
        continue;
      }
      if (!connected) continue; // held until reconnect
      submitKeys([ks], false);
    }
  }

  /**
   * Explicit multi-resource transaction (m9): folds pending debounced writes
   * for the touched resources into the batch, occupies all keys, parks until
   * every key is free.
   */
  function explicitBatch(batchKeys: Array<{ rt: string; rid: string }>, context?: unknown): void {
    if (disposed) return;
    const keyStates = batchKeys.map(({ rt, rid }) => {
      const ks = getKey(rt, rid);
      ensureBaseline(ks, undefined, false);
      ks.dirty = true; // the batch IS a write for this key
      clearTimers(ks); // pending debounced edits fold into the batch
      return ks;
    });
    if (keyStates.some((ks) => ks.baselineETag === undefined)) return; // never-subscribed member
    if (connected && keyStates.every(isFree)) {
      submitKeys(keyStates, false, context);
    } else {
      parked.push({ keyStates, context });
    }
  }

  function wakeParked(): void {
    if (!connected || disposed) return;
    for (let i = 0; i < parked.length; i++) {
      const b = parked[i]!;
      if (b.keyStates.every(isFree)) {
        parked.splice(i, 1);
        i--;
        submitKeys(b.keyStates, false, b.context);
      }
    }
  }

  function submitKeys(keyStates: KeyState[], fromDispose: boolean, context?: unknown): void {
    const submissions: QueueSubmission[] = keyStates.map((ks) => {
      clearTimers(ks);
      ks.dirty = false;
      ks.flushOnRelease = false;
      ks.burstQuietMs = undefined;
      return {
        rt: ks.rt,
        rid: ks.rid,
        eTag: ks.baselineETag!,
        newETag: genETag(),
        value: clone(config.readResource(ks.rt, ks.rid).value),
        base: ks.baseValue,
        attempt: 1,
      };
    });
    const batch: Batch = {
      keys: keyStates,
      submissions,
      attempt: 1,
      settled: false,
      suspendedByDisconnect: false,
      context,
      openOutcomes: keyStates.length,
      done: undefined as unknown as Promise<void>,
      resolveDone: () => {},
    };
    batch.done = new Promise<void>((r) => {
      batch.resolveDone = r;
    });
    for (const ks of keyStates) ks.inFlight = batch;
    openBatches.add(batch);
    send(batch, fromDispose);
  }

  function send(batch: Batch, fromDispose: boolean): void {
    const attempt = batch.attempt;
    for (const s of batch.submissions) s.attempt = attempt;
    if (!fromDispose && connected) {
      batch.timeoutTimer = setTimeout(() => {
        batch.timeoutTimer = undefined;
        settle(batch, attempt, batch.submissions.map(() => ({ queueSignal: 'timeout' as const })));
      }, timeoutMs);
    }
    void config
      .submit(batch.submissions)
      .then((outcomes) => settle(batch, attempt, outcomes))
      .catch((err: unknown) =>
        settle(
          batch,
          attempt,
          batch.submissions.map(() => ({
            queueSignal: 'infrastructure-error' as const,
            error: err instanceof Error ? err : new Error(String(err)),
          })),
        ),
      );
  }

  function settle(batch: Batch, attempt: number, outcomes: unknown[]): void {
    if (batch.settled || attempt !== batch.attempt) return; // stale attempt or already settled
    batch.settled = true;
    if (batch.timeoutTimer) {
      clearTimeout(batch.timeoutTimer);
      batch.timeoutTimer = undefined;
    }
    batch.keys.forEach((ks, i) => {
      const submission = batch.submissions[i]!;
      const outcome = outcomes[i] ?? { queueSignal: 'timeout' as const };
      const committedETag = interpretCommit(outcome);
      if (committedETag !== null) {
        // Commit boundary (B4 site b): the chain AND the merge base advance together.
        ks.baselineETag = committedETag;
        ks.baseValue = submission.value;
        config.onCommitted?.(submission, committedETag, batch.context);
        releaseKey(batch, ks);
      } else {
        // Key stays occupied until the handler concludes — async resolver
        // deliberation parks this resource; others proceed.
        config.onNonCommit(outcome, submission, makeApi(batch, ks), batch.context);
      }
    });
  }

  function makeApi(batch: Batch, ks: KeyState): NonCommitApi {
    let concluded = false;
    const once = (fn: () => void) => {
      if (concluded) return;
      concluded = true;
      fn();
    };
    return {
      accept(snapshot) {
        once(() => {
          ks.baselineETag = snapshot.meta.eTag;
          ks.baseValue = clone(snapshot.value);
          releaseKey(batch, ks);
        });
      },
      fail() {
        once(() => {
          // Terminal: drop buffered edits (the store was rolled back to base).
          ks.dirty = false;
          ks.flushOnRelease = false;
          releaseKey(batch, ks);
        });
      },
      resubmit({ eTag, value, base }) {
        once(() => {
          ks.baselineETag = eTag;
          ks.baseValue = clone(base);
          const followUp: QueueSubmission = {
            rt: ks.rt,
            rid: ks.rid,
            eTag,
            newETag: genETag(),
            value: clone(value),
            base: ks.baseValue,
            attempt: 1,
          };
          countOutcome(batch);
          const re: Batch = {
            keys: [ks],
            submissions: [followUp],
            attempt: 1,
            settled: false,
            suspendedByDisconnect: false,
            context: batch.context, // a use-this chain stays in its transaction's context
            openOutcomes: 1,
            done: undefined as unknown as Promise<void>,
            resolveDone: () => {},
          };
          re.done = new Promise<void>((r) => {
            re.resolveDone = r;
          });
          ks.inFlight = re;
          openBatches.add(re);
          send(re, false);
        });
      },
    };
  }

  function countOutcome(batch: Batch): void {
    batch.openOutcomes--;
    if (batch.openOutcomes === 0) {
      openBatches.delete(batch);
      batch.resolveDone();
    }
  }

  function releaseKey(batch: Batch, ks: KeyState): void {
    ks.inFlight = undefined;
    countOutcome(batch);
    if (ks.dirty && !disposed) {
      // Buffered edits chain off the just-advanced baseline.
      if (!connected) return; // held; reconnect flushes
      if (ks.flushOnRelease) {
        submitKeys([ks], false);
      } else {
        // Re-enter the debounce cycle as if the buffered burst's last write
        // arrived now (quiet window) with a fresh maxWait anchor.
        const quiet = ks.burstQuietMs ?? perType.get(ks.rt)?.quietMs ?? quietDefault;
        if (quiet === 0) {
          queueMicrotask(() => {
            if (ks.dirty && isFree(ks) && connected && !disposed) submitKeys([ks], false);
          });
        } else {
          ks.quietTimer = setTimeout(() => {
            ks.quietTimer = undefined;
            if (ks.dirty && isFree(ks) && connected) submitKeys([ks], false);
          }, quiet);
          ks.maxWaitTimer = setTimeout(() => {
            ks.maxWaitTimer = undefined;
            if (ks.dirty && isFree(ks) && connected) submitKeys([ks], false);
          }, perType.get(ks.rt)?.maxWaitMs ?? maxWaitDefault);
        }
      }
    }
    wakeParked();
  }

  function setConnectionState(state: string): void {
    const nowConnected = state === 'connected';
    if (nowConnected === connected) return;
    connected = nowConnected;
    if (!connected) {
      // Suspend: debounce timers stop (dirty persists), in-flight timeouts stop.
      // NOTHING rolls back from a disconnect.
      for (const ks of keys.values()) clearTimers(ks);
      for (const batch of openBatches) {
        if (!batch.settled) {
          batch.suspendedByDisconnect = true;
          if (batch.timeoutTimer) {
            clearTimeout(batch.timeoutTimer);
            batch.timeoutTimer = undefined;
          }
        }
      }
      return;
    }
    // Reconnected: replay in-flight (same newETag — server replay is
    // idempotent), then flush held writes.
    for (const batch of [...openBatches]) {
      if (batch.suspendedByDisconnect && !batch.settled) {
        batch.suspendedByDisconnect = false;
        batch.attempt++;
        send(batch, false);
      }
    }
    for (const ks of keys.values()) {
      if (ks.dirty && isFree(ks)) submitKeys([ks], false);
    }
    wakeParked();
  }

  /** Idle keys adopt a remote snapshot as the new baseline (fanout while no local edit pending). */
  function noteRemoteSnapshot(rt: string, rid: string): void {
    const ks = keys.get(keyOf(rt, rid));
    if (ks && !ks.dirty && isFree(ks)) keys.delete(keyOf(rt, rid)); // re-init from store on next write
  }

  function transactionDebounce(rt: string, opts: { quietMs?: number; maxWaitMs?: number }): void {
    perType.set(rt, { ...perType.get(rt), ...opts });
  }

  /** Flush everything, wait for open submissions to settle; nothing submits after resolution. */
  async function dispose(): Promise<void> {
    for (const ks of keys.values()) {
      clearTimers(ks);
      if (ks.dirty && isFree(ks)) submitKeys([ks], true);
    }
    disposed = true;
    while (openBatches.size > 0) {
      await Promise.all([...openBatches].map((b) => b.done));
    }
  }

  return {
    write,
    flush,
    explicitBatch,
    setConnectionState,
    noteRemoteSnapshot,
    transactionDebounce,
    dispose,
    isIdle,
  };
}

export type DebounceQueue = ReturnType<typeof createDebounceQueue>;
