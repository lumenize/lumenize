/**
 * Conflict / outcome state machine. Doc-as-spec:
 * `website/docs/nebula/api-reference.md` § TransactionOutcome /
 * TransactionResourceResolution / ConflictResolverVerdict.
 *
 * The engine turns server transaction responses into (a) a top-level
 * `TransactionOutcome` the await-site sees (ALWAYS resolves, never rejects)
 * and (b) per-resource `TransactionResourceResolution`s delivered to handlers
 * (per-call layered over per-type over framework default `use-server`), while
 * driving optimistic-state effects (commit / rollback / repaint), default
 * flash classes, `use-this` chains bounded by `maxRetries`, B4 base
 * threading, and the hold-pending-fanouts contract.
 *
 * It builds ON `createDebounceQueue` (submission timing, eTag chain,
 * serial-per-resource occupancy, in-flight timeout, connection gating,
 * reconnect replay) — the engine is the queue's `onCommitted`/`onNonCommit`
 * consumer and drives conclusions through the `NonCommitApi`. Invariant 7
 * (async resolver suspends the timeout) holds by construction: the queue
 * cancels the in-flight timer when the outcome arrives, before the resolver
 * runs, and arms a fresh one on each re-submission.
 *
 * Round-4 top-level shape (pinned 2026-06-13): the server is strictly atomic
 * (all-or-nothing), so a "mixed top-level outcome" is impossible. The top-level
 * `kind` is `'committed'` when every op landed (after any below-the-bucket
 * auto-resolution — an op may still show `'use-server'` in `resources`),
 * `'rejected'` (with a `retryable` verdict) when an op was permission-denied /
 * validation-failed / human-in-the-loop / conflict-retries-exhausted, and the
 * transaction-wide `'timeout'` / `'infrastructure-error'` / `'ontology-stale'`
 * for whole-transaction failures.
 */
import {
  createDebounceQueue,
  isQueueSignal,
  type NonCommitApi,
  type QueueSubmission,
} from './debounce';
import type { ConflictResolverVerdict } from './text-merge';

export interface Snapshot {
  value: unknown;
  meta: { eTag: string; [k: string]: unknown };
}

/** Per-resource resolution (api-reference § TransactionResourceResolution). */
export type TransactionResourceResolution =
  | {
      kind: 'conflict-pending';
      local: { value: unknown; eTag: string };
      server: Snapshot;
      base: { value: unknown; eTag: string };
      context: { bindings: Map<string, HTMLElement[]> }; // bindings deferred-post-5.3.7; empty Map in 5.3.7
    }
  | { kind: 'committed'; eTag: string }
  | { kind: 'use-server'; snapshot: Snapshot }
  | { kind: 'human-in-the-loop'; snapshot: Snapshot }
  | { kind: 'retries-exhausted'; snapshot: Snapshot; attempts: number }
  | { kind: 'validation-failed'; errors: unknown }
  | { kind: 'permission-denied' };

type ResourceMap = Record<string, TransactionResourceResolution>;

/**
 * Top-level await-site outcome (api-reference § TransactionOutcome). Five kinds;
 * `retryable` on the failures answers the await-site's one question ("do I
 * resubmit?"). Atomicity ⟹ no mixed top-level: `'committed'` iff every op
 * landed; `'rejected'` for a per-op failure; the rest are transaction-wide.
 */
export type TransactionOutcome =
  | { kind: 'committed'; resources: ResourceMap }
  | { kind: 'rejected'; retryable: boolean; resources: ResourceMap }
  | { kind: 'timeout'; retryable: true }
  | { kind: 'infrastructure-error'; retryable: true; error: Error }
  | { kind: 'ontology-stale'; retryable: false; clientVersion: string; currentVersion: string };

export type ResourceHandler = (
  resourceId: string,
  resolution: TransactionResourceResolution,
) => ConflictResolverVerdict | undefined | void | Promise<ConflictResolverVerdict | undefined | void>;

/** What the mock (and later the real client layer) returns per submitted resource. */
export type ServerResourceResult =
  | { result: 'committed'; eTag: string }
  | { result: 'conflict'; snapshot: Snapshot }
  | { result: 'validation-failed'; errors: unknown }
  | { result: 'permission-denied' };

export type ServerBatchResponse =
  | { resources: ServerResourceResult[] }
  | { ontologyStale: { clientVersion: string; currentVersion: string } };

const FLASH_COMMIT = 'lumenize-commit-success';
const FLASH_REVERT = 'lumenize-conflict-revert';
const DEFAULT_MAX_RETRIES = 5;

export interface ConflictOutcomeEngineConfig {
  /** The server (mock in tests). A throw becomes `infrastructure-error`. */
  submitBatch: (subs: QueueSubmission[]) => Promise<ServerBatchResponse>;
  /** Read the CURRENT (optimistic) resource state from the store. */
  readResource: (rt: string, rid: string) => { value: unknown; eTag?: string };
  /** Store effects (the factory writes through 'remote'/'rollback' contexts in v3). */
  applyServer: (rt: string, rid: string, snapshot: Snapshot) => void;
  applyCommit: (rt: string, rid: string, eTag: string) => void;
  rollbackTo: (rt: string, rid: string, value: unknown) => void;
  applyFanout: (rt: string, rid: string, snapshot: Snapshot) => void;
  /** Paint a `use-this` verdict value — it's a fresh optimistic write at the
   *  server baseline (the merged text must be visible while its re-submission
   *  is in flight, and stays painted when that re-submission commits). */
  applyResolvedValue: (rt: string, rid: string, value: unknown) => void;
  /** Default flash class application (DOM classes in v4; captured in the harness). */
  flash: (rt: string, rid: string, cssClass: string) => void;
  onShouldRefreshUI?: (info: { clientVersion: string; currentVersion: string; reason: 'ontology-stale' }) => void;
  quietMs?: number;
  maxWaitMs?: number;
  timeoutMs?: number;
  clone?: (v: unknown) => unknown;
  newETag?: () => string;
}

interface TxContext {
  resolutions: ResourceMap;
  expected: number;
  concluded: number;
  resolve: (o: TransactionOutcome) => void;
  perCallHandler?: ResourceHandler;
  perCallMaxRetries?: number;
  /** First transaction-wide failure wins; resolved in place of the per-op rollup. */
  transactionWide?: TransactionOutcome;
}

export function createConflictOutcomeEngine(config: ConflictOutcomeEngineConfig) {
  const perType = new Map<string, { handler: ResourceHandler; maxRetries?: number }>();
  /** Per-key use-this re-submission count for the ACTIVE chain (serial per resource ⇒ one chain at a time). */
  const chainAttempts = new Map<string, number>();
  /** Hold-pending-fanouts (invariant 8): latest held snapshot per key while the resource has pending optimistic state. */
  const heldFanouts = new Map<string, Snapshot>();

  const keyOf = (rt: string, rid: string) => `${rt}:${rid}`;

  const queue = createDebounceQueue({
    quietMs: config.quietMs,
    maxWaitMs: config.maxWaitMs,
    timeoutMs: config.timeoutMs,
    clone: config.clone,
    newETag: config.newETag,
    readResource: config.readResource,
    submit: async (subs) => {
      const resp = await config.submitBatch(subs); // a throw → queue's infrastructure-error signal
      if ('ontologyStale' in resp) return subs.map(() => ({ ontologyStale: resp.ontologyStale }));
      return resp.resources;
    },
    interpretCommit: (o) =>
      typeof o === 'object' && o !== null && (o as { result?: string }).result === 'committed'
        ? (o as { eTag: string }).eTag
        : null,
    onCommitted: (s, eTag, context) => {
      config.applyCommit(s.rt, s.rid, eTag);
      config.flash(s.rt, s.rid, FLASH_COMMIT);
      const resolution: TransactionResourceResolution = { kind: 'committed', eTag };
      void deliverTerminal(context as TxContext | undefined, s, resolution).then(() => {
        conclude(context as TxContext | undefined, s, resolution, 'drop-held');
      });
    },
    onNonCommit: (outcome, s, api, context) => {
      void handleNonCommit(outcome, s, api, context as TxContext | undefined);
    },
  });

  // ─── Per-resource outcome handling ────────────────────────────────────────

  async function handleNonCommit(
    outcome: unknown,
    s: QueueSubmission,
    api: NonCommitApi,
    ctx: TxContext | undefined,
  ): Promise<void> {
    if (isQueueSignal(outcome)) {
      // Transaction-wide while-connected failure (the queue never fires these
      // while disconnected — invariant 10): roll back to the asserted
      // baseline's value (the same capture the merge base uses).
      config.rollbackTo(s.rt, s.rid, s.base);
      setTransactionWide(
        ctx,
        outcome.queueSignal === 'timeout'
          ? { kind: 'timeout', retryable: true }
          : { kind: 'infrastructure-error', retryable: true, error: outcome.error },
      );
      api.fail();
      conclude(ctx, s, undefined, 'apply-held'); // a held fanout is real news after a rollback
      return;
    }
    if (typeof outcome === 'object' && outcome !== null && 'ontologyStale' in outcome) {
      const info = (outcome as { ontologyStale: { clientVersion: string; currentVersion: string } })
        .ontologyStale;
      // No rollback — "client stale, reload" signal, not a per-write rejection.
      config.onShouldRefreshUI?.({ ...info, reason: 'ontology-stale' });
      setTransactionWide(ctx, { kind: 'ontology-stale', retryable: false, ...info });
      api.fail();
      conclude(ctx, s, undefined, 'drop-held'); // reload re-syncs; don't clobber the kept paint
      return;
    }

    const r = outcome as ServerResourceResult;
    switch (r.result) {
      case 'validation-failed': {
        const resolution: TransactionResourceResolution = {
          kind: 'validation-failed',
          errors: r.errors,
        };
        config.rollbackTo(s.rt, s.rid, s.base);
        config.flash(s.rt, s.rid, FLASH_REVERT);
        await deliverTerminal(ctx, s, resolution);
        api.fail();
        conclude(ctx, s, resolution, 'apply-held');
        return;
      }
      case 'permission-denied': {
        const resolution: TransactionResourceResolution = { kind: 'permission-denied' };
        config.rollbackTo(s.rt, s.rid, s.base);
        config.flash(s.rt, s.rid, FLASH_REVERT);
        await deliverTerminal(ctx, s, resolution);
        api.fail();
        conclude(ctx, s, resolution, 'apply-held');
        return;
      }
      case 'conflict':
        await handleConflict(r.snapshot, s, api, ctx);
        return;
      default:
        // Unknown shape — treat as infrastructure error (always-resolve).
        config.rollbackTo(s.rt, s.rid, s.base);
        setTransactionWide(ctx, {
          kind: 'infrastructure-error',
          retryable: true,
          error: new Error(`unrecognized server result: ${JSON.stringify(outcome)}`),
        });
        api.fail();
        conclude(ctx, s, undefined, 'apply-held');
    }
  }

  async function handleConflict(
    snapshot: Snapshot,
    s: QueueSubmission,
    api: NonCommitApi,
    ctx: TxContext | undefined,
  ): Promise<void> {
    const key = keyOf(s.rt, s.rid);
    // The conflict snapshot is at least as new as any fanout held before this
    // response — it supersedes the hold. This is THE drop mechanism for every
    // conflict-derived conclusion (use-server / human-in-the-loop /
    // retries-exhausted): the held is already gone before they `conclude`, so it
    // is never re-applied even when the chain later ends in a rollback — e.g. a
    // `use-this` resubmit that times out must roll back to the conflict's server
    // value, NOT resurface the stale pre-conflict snapshot (covered by the
    // "conflict supersedes a held fanout" test). Those conclusions still pass
    // `'drop-held'` for consistency, but it is defensive there, not load-bearing.
    // (Do NOT remove this delete in favor of `conclude('drop-held')` alone —
    // that breaks the conflict-then-rollback case above.)
    heldFanouts.delete(key);
    const pending: TransactionResourceResolution = {
      kind: 'conflict-pending',
      local: { value: s.value, eTag: s.eTag },
      server: snapshot,
      base: { value: s.base, eTag: s.eTag }, // B4: the value at the asserted baseline
      context: { bindings: new Map() },
    };
    const verdict = (await dispatchConflictVerdict(ctx, s, pending)) ?? { kind: 'use-server' as const };

    if (verdict.kind === 'use-server') {
      config.applyServer(s.rt, s.rid, snapshot);
      config.flash(s.rt, s.rid, FLASH_REVERT);
      const resolution: TransactionResourceResolution = { kind: 'use-server', snapshot };
      await deliverTerminal(ctx, s, resolution);
      api.accept(snapshot);
      conclude(ctx, s, resolution, 'drop-held');
      return;
    }
    if (verdict.kind === 'human-in-the-loop') {
      // Optimistic stays painted; no flash; app owns the follow-up. The
      // baseline still advances to the server snapshot so a later edit
      // submits at the server's eTag with the server value as its base.
      const resolution: TransactionResourceResolution = { kind: 'human-in-the-loop', snapshot };
      await deliverTerminal(ctx, s, resolution);
      api.accept(snapshot);
      conclude(ctx, s, resolution, 'drop-held');
      return;
    }
    // use-this
    const used = chainAttempts.get(key) ?? 0;
    const maxRetries =
      ctx?.perCallMaxRetries ?? perType.get(s.rt)?.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (used >= maxRetries) {
      const resolution: TransactionResourceResolution = {
        kind: 'retries-exhausted',
        snapshot,
        attempts: used,
      };
      // Unified-rule rollback target: the value at the current baseline (for
      // a chain, the previous conflict's server snapshot — see task file).
      config.rollbackTo(s.rt, s.rid, s.base);
      config.flash(s.rt, s.rid, FLASH_REVERT);
      await deliverTerminal(ctx, s, resolution);
      api.fail();
      conclude(ctx, s, resolution, 'drop-held');
      return;
    }
    chainAttempts.set(key, used + 1);
    // Paint the verdict value (a fresh optimistic write at the server
    // baseline), then re-submit at the server's eTag; base re-anchors to the
    // server snapshot (B4 site c). Fresh newETag, fresh timeout.
    config.applyResolvedValue(s.rt, s.rid, verdict.value);
    api.resubmit({ eTag: snapshot.meta.eTag, value: verdict.value, base: snapshot.value });
  }

  /** conflict-pending verdict chain: per-call → per-type → framework default (first non-undefined wins). */
  async function dispatchConflictVerdict(
    ctx: TxContext | undefined,
    s: QueueSubmission,
    pending: TransactionResourceResolution,
  ): Promise<ConflictResolverVerdict | undefined> {
    for (const handler of [ctx?.perCallHandler, perType.get(s.rt)?.handler]) {
      if (!handler) continue;
      try {
        const verdict = await handler(s.rid, pending);
        if (verdict !== undefined && verdict !== null) return verdict as ConflictResolverVerdict;
      } catch {
        // Resolver error → fall through (framework default use-server), same
        // as the shipped client's fallback behavior.
      }
    }
    return undefined;
  }

  /** Terminal resolutions: per-call layers additively over per-type; returns ignored. */
  async function deliverTerminal(
    ctx: TxContext | undefined,
    s: QueueSubmission,
    resolution: TransactionResourceResolution,
  ): Promise<void> {
    for (const handler of [ctx?.perCallHandler, perType.get(s.rt)?.handler]) {
      if (!handler) continue;
      try {
        await handler(s.rid, resolution);
      } catch {
        // Terminal-handler errors don't affect the outcome.
      }
    }
  }

  // ─── Conclusion accounting + held-fanout disposition ──────────────────────

  function setTransactionWide(ctx: TxContext | undefined, outcome: TransactionOutcome): void {
    if (ctx && !ctx.transactionWide) ctx.transactionWide = outcome;
  }

  /**
   * Roll the per-resource resolutions up to the top-level outcome (round-4):
   * `'committed'` iff every op landed (committed / use-server); else `'rejected'`
   * with `retryable` true only for a pure exhausted-conflict rejection (a
   * permission/validation/human-in-the-loop failure makes a blind resubmit
   * pointless → false).
   */
  function computeTopLevel(resources: ResourceMap): TransactionOutcome {
    const kinds = Object.values(resources).map((r) => r.kind);
    const hardFail = kinds.some(
      (k) => k === 'permission-denied' || k === 'validation-failed' || k === 'human-in-the-loop',
    );
    const exhausted = kinds.some((k) => k === 'retries-exhausted');
    if (!hardFail && !exhausted) return { kind: 'committed', resources };
    return { kind: 'rejected', retryable: exhausted && !hardFail, resources };
  }

  function conclude(
    ctx: TxContext | undefined,
    s: QueueSubmission,
    resolution: TransactionResourceResolution | undefined,
    held: 'drop-held' | 'apply-held',
  ): void {
    const key = keyOf(s.rt, s.rid);
    chainAttempts.delete(key);
    const heldSnapshot = heldFanouts.get(key);
    if (heldSnapshot) {
      if (held === 'drop-held') {
        heldFanouts.delete(key);
      } else if (queue.isIdle(s.rt, s.rid)) {
        heldFanouts.delete(key);
        config.applyFanout(s.rt, s.rid, heldSnapshot);
        queue.noteRemoteSnapshot(s.rt, s.rid);
      }
      // else: still pending/buffered — keep holding.
    }
    if (!ctx) return;
    if (resolution) ctx.resolutions[s.rid] = resolution;
    ctx.concluded++;
    if (ctx.concluded >= ctx.expected) {
      ctx.resolve(ctx.transactionWide ?? computeTopLevel(ctx.resolutions));
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Debounced write entry (the synced-state middleware in v3). */
  function write(rt: string, rid: string, opts: { quietMs?: number; preWriteValue?: unknown } = {}): void {
    queue.write(rt, rid, opts);
  }

  /** Explicit transaction over current store values for `keys`. ALWAYS resolves. */
  function transaction(
    keys: Array<{ rt: string; rid: string }>,
    opts: { onTransactionResourceResolution?: ResourceHandler; maxRetries?: number } = {},
  ): Promise<TransactionOutcome> {
    return new Promise<TransactionOutcome>((resolve) => {
      // Mirrors the real client's auto-derive throw: a member with no local
      // baseline can't submit — fail fast instead of hanging the promise
      // (explicitBatch would silently drop the batch).
      for (const { rt, rid } of keys) {
        if (config.readResource(rt, rid).eTag === undefined) {
          resolve({
            kind: 'infrastructure-error',
            retryable: true,
            error: new Error(`no baseline eTag for ${rt}:${rid} (never subscribed)`),
          });
          return;
        }
      }
      const ctx: TxContext = {
        resolutions: {},
        expected: keys.length,
        concluded: 0,
        resolve,
        perCallHandler: opts.onTransactionResourceResolution,
        perCallMaxRetries: opts.maxRetries,
      };
      queue.explicitBatch(keys, ctx);
    });
  }

  /** Per-type handler registration (api-reference § onTransactionResourceResolution). */
  function onTransactionResourceResolution(
    rt: string,
    handler: ResourceHandler,
    opts: { maxRetries?: number } = {},
  ): void {
    perType.set(rt, { handler, maxRetries: opts.maxRetries });
  }

  /** Fanout entry implementing hold-pending-fanouts (invariant 8). */
  function notifyFanout(rt: string, rid: string, snapshot: Snapshot): void {
    if (queue.isIdle(rt, rid)) {
      config.applyFanout(rt, rid, snapshot);
      queue.noteRemoteSnapshot(rt, rid);
    } else {
      heldFanouts.set(keyOf(rt, rid), snapshot); // latest wins
    }
  }

  return {
    write,
    transaction,
    onTransactionResourceResolution,
    notifyFanout,
    setConnectionState: queue.setConnectionState,
    flush: queue.flush,
    transactionDebounce: queue.transactionDebounce,
    dispose: queue.dispose,
  };
}

export type ConflictOutcomeEngine = ReturnType<typeof createConflictOutcomeEngine>;
