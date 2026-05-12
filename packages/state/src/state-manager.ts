import { debug } from '@lumenize/debug';
import { isValidPath, getPathParts, deepEquals } from './helpers';

const log = debug('lumenize.state');

/**
 * Middleware fires on every write through `setState` (and on each unique path during
 * batch flush). Return a value to substitute for `newValue`; return `undefined` to
 * leave `newValue` unchanged.
 */
export type Middleware = (args: {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  context: unknown;
  state: Record<string, unknown>;
}) => unknown;

/**
 * Subscriber callbacks are invoked with the value at the subscriber's path
 * (not the write path), plus the write path that triggered the fire.
 *
 * `oldValue` is `undefined` when the subscriber is an ancestor of the write
 * path — reconstructing the old value at the ancestor would require snapshotting
 * the subtree on every write, and no current consumer needs it.
 */
export type SubscriberCallback = (
  newValue: unknown,
  oldValue: unknown,
  changedPath: string,
) => void;

export type ComputedFn = () => unknown;

/**
 * Thrown synchronously from `computed()` registration when the derivation
 * function reads `targetPath` itself, an ancestor, or a descendant — any
 * dep relationship that would re-fire the computed via hierarchical notify.
 */
export class ComputedSelfReferenceError extends Error {
  constructor(public readonly targetPath: string, public readonly conflictingDep: string) {
    super(
      `computed("${targetPath}", fn) would self-trigger: fn reads "${conflictingDep}", which overlaps the target path. ` +
        `A computed cannot depend on its own target path or any ancestor/descendant of it.`,
    );
    this.name = 'ComputedSelfReferenceError';
  }
}

type Subscription = {
  cb: SubscriberCallback;
  hierarchical: boolean;
};

type BatchUpdate = {
  path: string;
  value: unknown;
  context: unknown;
};

const drill = (value: unknown, parts: string[]): unknown => {
  let current = value;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

/**
 * Path-based reactive store.
 *
 * Construct via the `createState()` factory rather than `new StateManager()`
 * directly when at all possible — the factory keeps call sites tidy and leaves
 * the door open for instance-construction wrapping later.
 *
 * Subscribe semantics: `subscribe(path, cb, hierarchical = true)` fires on
 * three write directions when hierarchical:
 *
 * 1. **Exact** — write at `path`.
 * 2. **Ancestor write** — write at any prefix of `path` (the bulk-snapshot case).
 *    Old/new values are drilled along the suffix.
 * 3. **Descendant write** — write at any extension of `path` (the granular
 *    field-change case). `oldValue` is passed as `undefined`; `newValue` is the
 *    current state at the subscriber's path.
 *
 * Deep-equals dedup gates per-subscriber re-fires during ancestor-write fanout
 * — only subscribers whose drilled value actually changed are notified.
 */
export class StateManager {
  #state: Record<string, unknown>;
  #middlewares: Middleware[];
  #subscribers = new Map<string, Set<Subscription>>();
  #deps: Set<string> | null = null;
  #newSubs = new Set<string>();
  #isBatching = false;
  #batchQueue: BatchUpdate[] = [];
  #batchedPaths = new Set<string>();

  constructor(initialState: Record<string, unknown> = {}, middleware: Middleware[] = []) {
    this.#state = { ...initialState };
    this.#middlewares = [...middleware];
  }

  getState(path: string, defaultValue: unknown = undefined, track = true): unknown {
    if (!isValidPath(path)) return defaultValue;
    if (track && this.#deps) this.#deps.add(path);
    const parts = getPathParts(path);
    let current: unknown = this.#state;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return defaultValue;
      const next = (current as Record<string, unknown>)[part];
      if (next === undefined) return defaultValue;
      current = next;
    }
    return current;
  }

  setState(path: string, value: unknown, context: unknown = {}): void {
    if (!isValidPath(path)) {
      log.warn('setState rejected: invalid path', { path });
      return;
    }
    if (this.#newSubs.has(path)) {
      log.warn('setState rejected: circular update during notify', { path });
      return;
    }
    if (this.#isBatching) {
      this.#queueBatchedUpdate(path, value, context);
      return;
    }
    this.#setStateImmediate(path, value, context);
  }

  /**
   * Register a path subscriber. Returns the disposer.
   *
   * With `hierarchical = true` (default), fires on exact, ancestor, and
   * descendant writes; with `false`, fires only on exact writes.
   */
  subscribe(path: string, callback: SubscriberCallback, hierarchical = true): () => void {
    if (!this.#subscribers.has(path)) this.#subscribers.set(path, new Set());
    const subscription: Subscription = { cb: callback, hierarchical };
    this.#subscribers.get(path)!.add(subscription);
    return () => {
      const subs = this.#subscribers.get(path);
      if (subs) {
        subs.delete(subscription);
        if (subs.size === 0) this.#subscribers.delete(path);
      }
    };
  }

  /**
   * Install a middleware. Returns a disposer that removes it.
   * Middlewares fire in install order.
   */
  use(middleware: Middleware): () => void {
    this.#middlewares.push(middleware);
    return () => {
      const idx = this.#middlewares.indexOf(middleware);
      if (idx >= 0) this.#middlewares.splice(idx, 1);
    };
  }

  /**
   * Run `fn`, collecting every `getState` path read as a dependency.
   * Nested `track` calls save & restore the outer dep set.
   *
   * `isolated: true` disables dep collection for this call (still saves the outer).
   */
  track<T>(fn: () => T, isolated = false): { result: T; deps: string[] } {
    const saved = this.#deps;
    const deps = isolated ? null : new Set<string>();
    this.#deps = deps;
    let result: T;
    try {
      result = fn();
    } finally {
      this.#deps = saved;
    }
    return { result, deps: deps ? [...deps] : [] };
  }

  /**
   * Collect writes inside `callback` and flush them as a single notify pass
   * at the end. Re-entrant calls execute the callback inline (no nested batch).
   *
   * If `callback` returns a Promise, batching stays open until it settles.
   */
  executeBatch<T>(callback: () => T): T;
  executeBatch<T>(callback: () => Promise<T>): Promise<T>;
  executeBatch<T>(callback: () => T | Promise<T>): T | Promise<T> {
    if (this.#isBatching) return callback() as T;
    this.#beginBatch();
    try {
      const result = callback();
      if (result && typeof (result as PromiseLike<T>).then === 'function') {
        return (result as Promise<T>).then(
          (value) => {
            this.#endBatch();
            return value;
          },
          (error) => {
            this.#endBatch();
            throw error;
          },
        );
      }
      this.#endBatch();
      return result as T;
    } catch (error) {
      this.#endBatch();
      throw error;
    }
  }

  /**
   * Derive `targetPath` from `fn`. Re-runs and re-writes whenever any dep changes.
   *
   * Throws `ComputedSelfReferenceError` immediately if `fn`'s deps overlap
   * `targetPath` (exact, ancestor, or descendant) — that would cause
   * hierarchical notify to re-fire the computed indefinitely.
   *
   * Runtime throws inside `fn` (after registration) surface to `console.error`
   * and retain the prior value; the next dep change re-tries.
   *
   * Returns a disposer that detaches the computed.
   */
  computed(targetPath: string, fn: ComputedFn): () => void {
    if (!isValidPath(targetPath)) {
      throw new Error(`computed: invalid target path: ${String(targetPath)}`);
    }

    // Initial evaluation — surfaces errors to the caller intentionally.
    const initial = this.track(fn);

    for (const dep of initial.deps) {
      if (
        dep === targetPath ||
        dep.startsWith(targetPath + '.') ||
        targetPath.startsWith(dep + '.')
      ) {
        throw new ComputedSelfReferenceError(targetPath, dep);
      }
    }

    this.setState(targetPath, initial.result, { source: 'computed' });

    let unsubs: Array<() => void> = [];
    let disposed = false;

    const reEvaluate = () => {
      if (disposed) return;
      let newResult: unknown;
      let newDeps: string[];
      try {
        const tracked = this.track(fn);
        newResult = tracked.result;
        newDeps = tracked.deps;
      } catch (error) {
        log.error('computed fn threw — retaining prior value', {
          targetPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // Successful re-eval: swap subscriptions, write result.
      for (const u of unsubs) u();
      unsubs = [];
      for (const dep of newDeps) {
        unsubs.push(this.subscribe(dep, reEvaluate));
      }
      this.setState(targetPath, newResult, { source: 'computed' });
    };

    for (const dep of initial.deps) {
      unsubs.push(this.subscribe(dep, reEvaluate));
    }

    return () => {
      disposed = true;
      for (const u of unsubs) u();
      unsubs = [];
    };
  }

  #setStateImmediate(path: string, value: unknown, context: unknown): void {
    const oldValue = this.getState(path, undefined, false);
    let finalValue = value;
    for (const mw of this.#middlewares) {
      try {
        const result = mw({ path, oldValue, newValue: finalValue, context, state: this.#state });
        if (result !== undefined) finalValue = result;
      } catch (error) {
        log.error('middleware threw', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (deepEquals(oldValue, finalValue)) return;

    this.#writeAtPath(path, finalValue);

    this.#newSubs.add(path);
    try {
      this.#fanout(path, oldValue, finalValue);
    } finally {
      this.#newSubs.delete(path);
    }
  }

  #writeAtPath(path: string, value: unknown): void {
    const parts = getPathParts(path);
    let current: Record<string, unknown> = this.#state;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const existing = current[part];
      if (existing == null || typeof existing !== 'object') {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }

  /**
   * Three-direction subscriber fanout for a write at `writePath`.
   * Top-level dedup (skip if `oldValue` deep-equals `newValue`) already happened
   * in the caller. Per-subscriber dedup happens here for descendant subscribers.
   *
   * Snapshots the (path, subs) entries before iterating: a callback that
   * re-subscribes (e.g. a `computed` re-evaluation) deletes-and-re-adds its
   * path entry, which a live Map iterator would visit again — that path leads
   * to infinite recursion.
   */
  #fanout(writePath: string, oldValue: unknown, newValue: unknown): void {
    const entries: Array<[string, Set<Subscription>]> = [];
    for (const [subPath, subs] of this.#subscribers) {
      entries.push([subPath, new Set(subs)]);
    }
    for (const [subPath, subs] of entries) {
      for (const { cb, hierarchical } of subs) {
        // Each fire: figure out whether it applies and what values to pass.
        if (subPath === writePath) {
          this.#safeFire(cb, newValue, oldValue, writePath);
          continue;
        }
        if (!hierarchical) continue;

        if (subPath.startsWith(writePath + '.')) {
          // Subscriber is a descendant of the write. Drill old & new along the suffix.
          const suffix = getPathParts(subPath.slice(writePath.length + 1));
          const subOld = drill(oldValue, suffix);
          const subNew = drill(newValue, suffix);
          if (deepEquals(subOld, subNew)) continue;
          this.#safeFire(cb, subNew, subOld, writePath);
        } else if (writePath.startsWith(subPath + '.')) {
          // Subscriber is an ancestor of the write. Old value at subPath
          // would require pre-write snapshotting; pass `undefined`.
          const subNew = this.getState(subPath, undefined, false);
          this.#safeFire(cb, subNew, undefined, writePath);
        }
      }
    }
  }

  #safeFire(cb: SubscriberCallback, newValue: unknown, oldValue: unknown, changedPath: string): void {
    try {
      cb(newValue, oldValue, changedPath);
    } catch (error) {
      log.error('subscriber threw', {
        changedPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #beginBatch(): void {
    this.#isBatching = true;
    this.#batchQueue = [];
    this.#batchedPaths.clear();
  }

  #endBatch(): void {
    if (!this.#isBatching) return;
    this.#isBatching = false;
    if (this.#batchQueue.length === 0) return;
    this.#processBatchedUpdates();
  }

  #queueBatchedUpdate(path: string, value: unknown, context: unknown): void {
    // Last-write-wins per path within a batch.
    this.#batchQueue = this.#batchQueue.filter((u) => u.path !== path);
    this.#batchQueue.push({ path, value, context });
    this.#batchedPaths.add(path);
  }

  #processBatchedUpdates(): void {
    const updates = this.#batchQueue;
    this.#batchQueue = [];
    this.#batchedPaths.clear();
    for (const u of updates) {
      this.#setStateImmediate(u.path, u.value, u.context);
    }
  }
}
