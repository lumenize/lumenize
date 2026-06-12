/**
 * Factory: createNebulaClient(config, client) → { store, client, use, dispose }
 *
 * The `store` is a path-aware Proxy that wraps a `@vue/reactivity` reactive
 * object. Three custom behaviors layered on Vue's normal reactivity:
 *
 *   1. **Middleware in `set` trap.** Every write — at any depth — flows through
 *      a middleware chain before forwarding to the underlying reactive. The
 *      built-in synced-state middleware sees writes under
 *      `resources.<rt>.<rid>.value.*` with context.source === 'local' and
 *      routes them to `client.transaction(...)`.
 *
 *   2. **Top-level deep-equal dedup.** If the write's `newValue` deep-equals
 *      the current value, the write is skipped entirely. Middleware never
 *      runs; no Vue trigger fires.
 *
 *   3. **effectScope-driven auto-subscribe.** When a read on
 *      `resources.<rt>.<rid>.*` happens inside an active effectScope, the
 *      factory refcounts the (rt, rid). 0→1 triggers `client.subscribe`;
 *      scope-dispose → grace → 1→0 triggers `client.unsubscribe`. Multiple
 *      reads in the same scope dedup to a single refcount entry.
 *
 * Sync-state writes from server fanout flow through `client.onResourceUpdate`
 * and use `context.source === 'remote'` so the middleware skips them.
 */

import {
  reactive,
  effectScope,
  getCurrentScope,
  onScopeDispose,
  toRaw,
  computed as vueComputed,
  type EffectScope,
} from '@vue/reactivity';
import { deepEquals } from './deep-equals';
import { createDebounceQueue } from './debounce-queue';
import type {
  ClientLike,
  FactoryResult,
  Middleware,
  WriteContext,
} from './types';

// Vue 3 component render effects DO NOT activate their owning effectScope at
// `run()` time — they only set `activeSub` (for dep tracking) and
// `shouldTrack`. That means `getCurrentScope()` returns null inside a
// component's render, so the factory's scope-based auto-subscribe never
// fires when reads happen via Vue templates.
//
// To bridge: read Vue's `getCurrentInstance()` from `@vue/runtime-core`; if
// it returns a component instance, use `instance.scope` as the lifecycle
// scope. The component's scope is disposed automatically when the component
// unmounts, so registered `onScopeDispose` callbacks fire at the right time.
import { getCurrentInstance } from '@vue/runtime-core';

function getActiveVueScope(): EffectScope | null {
  const instance = getCurrentInstance() as { scope?: EffectScope } | null;
  return instance?.scope ?? null;
}

export interface CreateNebulaClientOptions {
  /** Grace period before unsubscribing after refcount drops to zero. */
  unsubscribeGraceMs?: number;
  /** Initial state (deep-cloned into the reactive root). */
  initialState?: Record<string, any>;
  /**
   * Submission debounce defaults (see src/debounce-queue.ts). Production
   * defaults are quietMs 500 / maxWaitMs 2000; tests that pin per-write
   * submission timing pass `{ quietMs: 0 }` (eager microtask submit).
   */
  debounce?: { quietMs?: number; maxWaitMs?: number; timeoutMs?: number };
}

const DEFAULT_UNSUBSCRIBE_GRACE_MS = 2000;

export function createNebulaClient(
  client: ClientLike,
  options: CreateNebulaClientOptions = {},
): FactoryResult {
  const unsubscribeGraceMs = options.unsubscribeGraceMs ?? DEFAULT_UNSUBSCRIBE_GRACE_MS;

  // ─── Reactive root + middleware chain ────────────────────────────────────
  // Bootstrap framework-managed subtrees so descendant access works even
  // before any data lands. `resources.*` is path-tracking territory for
  // auto-subscribe; `lmz.connection.*` is where the factory writes connection
  // state. Users can extend either without owning their creation.
  const seed: Record<string, any> = { resources: {}, lmz: { connection: {} } };
  const userInitial = options.initialState ?? {};
  for (const k of Object.keys(userInitial)) {
    seed[k] = userInitial[k];
  }
  const root = reactive(seed);
  // User middlewares only. The built-in synced-state middleware runs LAST,
  // after the user chain (see runMiddlewareChain): a user abort (throw) must
  // stop the submission too, and synced-state should see the final
  // post-substitution value.
  const middlewares: Middleware[] = [];

  // Module-scope sidecar: currentContext threads write context through the
  // Proxy `set` trap so middleware can discriminate user vs remote writes.
  // Synchronous reads from middleware mean no async-context worries.
  let currentContext: WriteContext = { source: 'local' };

  function withContext<T>(ctx: WriteContext, fn: () => T): T {
    const saved = currentContext;
    currentContext = ctx;
    try {
      return fn();
    } finally {
      currentContext = saved;
    }
  }

  // ─── Refcount + auto-subscribe registry ──────────────────────────────────
  // (rt, rid) → number of distinct effectScopes currently reading it.
  // Scopes are deduped per (rt, rid) so multiple reads in the same scope
  // count once.
  const refcount = new Map<string, number>();
  // Per scope: which (rt, rid)s has it already counted? Avoids double-count.
  const scopeReads = new WeakMap<EffectScope, Set<string>>();
  // Per (rt, rid): pending unsubscribe timer (grace period).
  const pendingUnsubscribes = new Map<string, ReturnType<typeof setTimeout>>();

  function resourceKey(rt: string, rid: string): string {
    return `${rt}:${rid}`;
  }

  function trackResourceRead(rt: string, rid: string): void {
    // Try the standard `@vue/reactivity` scope first (synthetic test scopes
    // created via `effectScope().run(...)` and similar). If absent, fall
    // back to Vue's component instance — render effects don't activate
    // their owning scope, but `getCurrentInstance().scope` exposes it.
    const scope = getCurrentScope() ?? getActiveVueScope();
    if (!scope) return; // read outside any tracked context — no auto-subscribe
    const key = resourceKey(rt, rid);
    let seenInScope = scopeReads.get(scope);
    if (!seenInScope) {
      seenInScope = new Set();
      scopeReads.set(scope, seenInScope);
      // Register decrement on scope dispose. `onScopeDispose` requires the
      // scope to be active; component scopes aren't active during render,
      // so we briefly activate via `scope.run(...)`. Test scopes via
      // `effectScope().run(...)` are already active, so the extra `run`
      // is a no-op nesting.
      scope.run(() => {
        onScopeDispose(() => {
          const reads = scopeReads.get(scope);
          if (!reads) return;
          scopeReads.delete(scope);
          for (const k of reads) {
            decrementRefcount(k);
          }
        });
      });
    }
    if (seenInScope.has(key)) return; // already counted in this scope
    seenInScope.add(key);
    incrementRefcount(key, rt, rid);
  }

  function incrementRefcount(key: string, rt: string, rid: string): void {
    const pending = pendingUnsubscribes.get(key);
    if (pending) {
      // Grace-cancel: a new binding showed up before unsubscribe fired.
      // Server-side subscription is still live — refcount-bump only, no
      // re-subscribe RTT.
      clearTimeout(pending);
      pendingUnsubscribes.delete(key);
      refcount.set(key, (refcount.get(key) ?? 0) + 1);
      return;
    }
    const prev = refcount.get(key) ?? 0;
    refcount.set(key, prev + 1);
    if (prev === 0) {
      // 0 → 1: issue subscribe. Fire-and-forget; fanout writes will arrive
      // via onResourceUpdate.
      client.subscribe(rt, rid).catch(() => {
        // swallow; production would surface via log/debug
      });
    }
  }

  function decrementRefcount(key: string): void {
    const prev = refcount.get(key) ?? 0;
    if (prev <= 1) {
      refcount.delete(key);
      // Schedule unsubscribe after grace.
      const [rt, rid] = key.split(':');
      const timer = setTimeout(() => {
        pendingUnsubscribes.delete(key);
        client.unsubscribe(rt, rid);
      }, unsubscribeGraceMs);
      pendingUnsubscribes.set(key, timer);
    } else {
      refcount.set(key, prev - 1);
    }
  }

  // ─── Middleware chain runner ─────────────────────────────────────────────
  // User middlewares in registration order. The built-in synced-state
  // middleware runs AFTER this chain (and after the post-substitution dedup),
  // invoked explicitly at each write site: a user abort (throw) aborts the
  // submission too, and synced-state sees the final substituted value.
  function runUserMiddlewares(path: string, oldValue: unknown, newValue: unknown): unknown {
    let finalValue = newValue;
    for (const mw of middlewares) {
      const result = mw({ path, oldValue, newValue: finalValue, context: currentContext });
      if (result !== undefined) finalValue = result;
    }
    return finalValue;
  }

  function notifySyncedState(path: string, oldValue: unknown, newValue: unknown): void {
    syncedStateMiddleware({ path, oldValue, newValue, context: currentContext });
  }

  // ─── Map/Set mutator interception (M10, Option A) ────────────────────────
  // Collection METHOD mutations never hit the `set` trap, so the `get` trap
  // hands out wrappers that make them indistinguishable from property writes:
  // compute the post-mutation value, run the middleware chain BEFORE applying
  // (abort ⇒ no local mutation; substitute ⇒ the substituted collection is
  // applied), then apply via Vue's instrumented method (reactivity fires) —
  // the synced-state middleware funnels into the same debounced submission.
  const MAP_MUTATORS = new Set(['set', 'delete', 'clear']);
  const SET_MUTATORS = new Set(['add', 'delete', 'clear']);

  function isNoOpMutation(raw: Map<unknown, unknown> | Set<unknown>, method: string, args: unknown[]): boolean {
    const k0 = args[0];
    const rawK0 = k0 !== null && typeof k0 === 'object' ? toRaw(k0) : k0;
    if (raw instanceof Map) {
      if (method === 'set') {
        const key = raw.has(k0 as never) ? k0 : rawK0;
        if (!raw.has(key as never)) return false;
        const existing = raw.get(key as never);
        return existing === args[1] || deepEquals(existing, toRawDeepArg(args[1]));
      }
      if (method === 'delete') return !raw.has(k0 as never) && !raw.has(rawK0 as never);
      return raw.size === 0; // clear
    }
    if (method === 'add') return raw.has(k0) || raw.has(rawK0);
    if (method === 'delete') return !raw.has(k0) && !raw.has(rawK0);
    return raw.size === 0; // clear
  }

  function toRawDeepArg(v: unknown): unknown {
    return v !== null && typeof v === 'object' ? toRaw(v) : v;
  }

  function applyMutationToClone(
    cloned: Map<unknown, unknown> | Set<unknown>,
    method: string,
    args: unknown[],
  ): Map<unknown, unknown> | Set<unknown> {
    const cleanArgs = args.map((a) => {
      const raw = toRawDeepArg(a);
      return raw !== null && typeof raw === 'object' ? structuredClone(raw) : raw;
    });
    (cloned as never as Record<string, (...a: unknown[]) => unknown>)[method](...cleanArgs);
    return cloned;
  }

  /** Replace a live collection's contents with `next` through Vue's instrumented methods. */
  function applyCollectionValue(vueColl: any, next: unknown): void {
    vueColl.clear();
    if (next instanceof Map) {
      for (const [k, v] of next.entries()) vueColl.set(k, v);
    } else if (next instanceof Set) {
      for (const v of next.values()) vueColl.add(v);
    }
  }

  // ─── Recursive path-aware Proxy ──────────────────────────────────────────
  // Wraps `target` (which is a Vue reactive) with a custom Proxy that knows
  // its path. Each level wraps lazily on read; nested objects are wrapped on
  // first access. Vue's own Proxy still handles dep-tracking and triggering
  // beneath ours.
  const wrapperCache = new WeakMap<object, Map<string, any>>();

  // Mirror Vue's targetTypeMap: only plain objects, arrays, Maps, and Sets
  // get a path wrapper. Dates, RegExps, errors, class instances pass through
  // raw — a Proxy around them breaks internal-slot methods ("this is not a
  // Date object"), and Vue leaves them unreactive for the same reason.
  function isWrappable(v: object): boolean {
    const raw = toRaw(v);
    if (Array.isArray(raw) || raw instanceof Map || raw instanceof Set) return true;
    const proto = Object.getPrototypeOf(raw);
    return proto === Object.prototype || proto === null;
  }

  function wrap(target: any, path: string[]): any {
    if (target === null || typeof target !== 'object') return target;
    if (!isWrappable(target)) return target;
    // Cache wrappers by (parent target, path-suffix) so re-reads return
    // identity-stable wrappers. Important for Vue's dep-tracking which keys
    // by identity.
    const pathKey = path.join('.');
    let levelCache = wrapperCache.get(target);
    if (!levelCache) {
      levelCache = new Map();
      wrapperCache.set(target, levelCache);
    }
    const cached = levelCache.get(pathKey);
    if (cached) return cached;

    const proxy = new Proxy(target, {
      // Don't pass `receiver` to Reflect.get/Set — Vue's reactive Proxy
      // interprets a different receiver as "write the property on the
      // receiver, not the target," which bypasses Vue's dep tracking.
      // Forwarding to Vue's Proxy directly keeps Vue's trap firing normally.
      get(t, key) {
        if (typeof key !== 'string') return Reflect.get(t, key);

        // Pass through Vue internal-marker reads (`__v_isRef`,
        // `__v_isReactive`, `__v_raw`, etc.) without wrapping or path
        // extension. Vue 3.5 in-DOM mode probes `__v_isRef` on the outer
        // store during render; the underlying Vue reactive answers
        // correctly via this pass-through.
        //
        // (Q2a sub-probe confirmed `__v_skip` is never queried — that
        // returning-true was Alpine 3.x specific.)
        if (key.startsWith('__v_')) return Reflect.get(t, key);

        console.log(`[proxy get] path=${JSON.stringify(path)} key=${key}`);

        // Map/Set mutator interception (M10): the collection's own path is
        // this wrap level's path. Non-mutating reads (get/has/forEach/
        // iterators/size) flow through untouched — Vue's instrumentation
        // resolves `this.__v_raw` through our `__v_` pass-through above.
        const rawTarget = toRaw(t);
        if (
          (rawTarget instanceof Map && MAP_MUTATORS.has(key)) ||
          (rawTarget instanceof Set && SET_MUTATORS.has(key))
        ) {
          const collection = rawTarget as Map<unknown, unknown> | Set<unknown>;
          return (...args: unknown[]) => {
            const chainable = key === 'set' || key === 'add';
            if (isNoOpMutation(collection, key, args)) {
              // Parity with the set trap's deep-equal dedup: middleware never
              // runs, no submission.
              return chainable ? proxy : key === 'delete' ? false : undefined;
            }
            const oldValue = structuredClone(collection);
            const newValue = applyMutationToClone(structuredClone(collection), key, args);
            const finalValue = runUserMiddlewares(path.join('.'), oldValue, newValue);
            notifySyncedState(path.join('.'), oldValue, finalValue);
            if (finalValue === newValue) {
              // No substitution: apply the original mutation through Vue's
              // instrumented method so reactivity triggers normally.
              const fn = Reflect.get(t, key) as (...a: unknown[]) => unknown;
              const result = fn.apply(t, args);
              return chainable ? proxy : result;
            }
            // Substituted: the substituted collection is what gets applied.
            applyCollectionValue(t, finalValue);
            return chainable ? proxy : key === 'delete' ? true : undefined;
          };
        }

        // Vivification: under `resources.*`, ensure intermediate containers
        // exist so descendant access works (and auto-subscribe tracking can
        // fire) even when no data has been pushed yet. Uses
        // context: 'computed' so middleware skips, and reads from the raw
        // store to skip our own wrapping. Vue's normal triggers still fire
        // for the vivification write — effects may re-run, but only those
        // depending on the vivified path; they'll see the same empty value.
        const isResourcesPath = path.length === 1 && path[0] === 'resources';
        const isResourceTypePath = path.length === 2 && path[0] === 'resources';
        if ((isResourcesPath || isResourceTypePath) && Reflect.get(t, key) === undefined) {
          withContext({ source: 'computed' }, () => {
            Reflect.set(t, key, {});
          });
        }

        const value = Reflect.get(t, key);

        // Resource-read tracking fires when we cross the
        // `resources.<rt>.<rid>` boundary. path === ['resources', rt] and
        // key === rid.
        if (isResourceTypePath) {
          trackResourceRead(path[1], key);
        }

        if (value !== null && typeof value === 'object') {
          return wrap(value, [...path, key]);
        }
        return value;
      },
      set(t, key, newValue) {
        if (typeof key !== 'string') return Reflect.set(t, key, newValue);
        const fullPath = [...path, key].join('.');
        const oldValue = Reflect.get(t, key);

        // Top-level deep-equal dedup: skip the write entirely if equal.
        if (deepEquals(oldValue, newValue)) return true;

        // User middlewares first; a middleware may substitute.
        const finalValue = runUserMiddlewares(fullPath, oldValue, newValue);
        // Re-dedup after middleware substitution.
        if (deepEquals(oldValue, finalValue)) return true;

        notifySyncedState(fullPath, oldValue, finalValue);
        return Reflect.set(t, key, finalValue);
      },
    });
    levelCache.set(pathKey, proxy);
    return proxy;
  }

  const store = wrap(root, []);

  // ─── Submission queue (debounce + serial-per-resource) ───────────────────
  // The synced-state middleware no longer submits directly: it notifies the
  // queue, which owns WHEN a transaction goes out and WHAT eTag/newETag/base
  // it carries (quiet/maxWait windows, serial per resource with buffering,
  // connection gating, B4 base re-anchoring). See src/debounce-queue.ts.
  const queue = createDebounceQueue({
    quietMs: options.debounce?.quietMs,
    maxWaitMs: options.debounce?.maxWaitMs,
    timeoutMs: options.debounce?.timeoutMs,
    // `structuredClone` refuses Vue Proxies (DataCloneError); `toRaw()`
    // strips the outer Proxy and the raw tree beneath is Proxy-free (Vue
    // toRaw's values on write), so it clones cleanly — preserving Dates,
    // Maps, Sets, cycles.
    clone: (v) => (v === undefined ? undefined : structuredClone(toRaw(v as object))),
    submit: async ([s]) => {
      const outcome = await client.transaction({
        rt: s!.rt,
        rid: s!.rid,
        eTag: s!.eTag,
        value: s!.value,
        newETag: s!.newETag,
      });
      return [outcome];
    },
    readResource: (rt, rid) => {
      const entry = (root as any)?.resources?.[rt]?.[rid];
      return { value: entry?.value, eTag: entry?.meta?.eTag as string | undefined };
    },
    onCommitted: (s, eTag) => {
      // Write meta.eTag through with 'remote' context (skips middleware).
      withContext({ source: 'remote' }, () => {
        internalDeepWrite(['resources', s.rt, s.rid, 'meta', 'eTag'], eTag);
      });
    },
    onNonCommit: (outcome, s, api) => {
      const parts = ['resources', s.rt, s.rid];
      const o = outcome as import('./types').TransactionOutcome;
      if (o.resolution === 'use-server') {
        withContext({ source: 'remote' }, () => {
          internalDeepWrite([...parts, 'value'], o.snapshot.value);
          internalDeepWrite([...parts, 'meta'], o.snapshot.meta);
        });
        api.accept(o.snapshot);
        return;
      }
      // validation-failed / timeout: roll back to the merge base — the value
      // at the asserted baseline (the same capture B4 re-anchors; for a
      // single write this is the pre-write value).
      withContext({ source: 'rollback' }, () => {
        internalDeepWrite([...parts, 'value'], s.base);
      });
      api.fail();
    },
  });

  // ─── Built-in synced-state middleware ────────────────────────────────────
  // Routes writes under resources.<rt>.<rid>.value.* with context.source ===
  // 'local' to the submission queue. Optimistic apply: the write lands
  // immediately (debounce gates only the submission); rollback on terminal
  // failure restores the baseline value.
  const syncedStateMiddleware: Middleware = ({ path, context }) => {
    if (context.source !== 'local') return undefined;
    const match = /^resources\.([^.]+)\.([^.]+)\.value(?:\.|$)/.exec(path);
    if (!match) return undefined;
    const rt = match[1];
    const rid = match[2];
    const eTag = (root as any)?.resources?.[rt]?.[rid]?.meta?.eTag as string | undefined;
    if (!eTag) {
      // "User editing never-subscribed resource"; no transaction.
      // Production would log/warn here. Spike: silent.
      return undefined;
    }
    // First-divergence base capture (B4 site a): the queue uses this only
    // when the resource has no baseline yet — i.e. the value at the eTag the
    // next submission asserts.
    const liveValue = (root as any)?.resources?.[rt]?.[rid]?.value;
    const preWriteFullValue =
      liveValue === undefined ? undefined : structuredClone(toRaw(liveValue));
    queue.write(rt, rid, { preWriteValue: preWriteFullValue });
    return undefined;
  };

  // Internal write that walks via the outer Proxy so context flows through
  // middleware checks (middleware reads context.source and skips
  // remote/rollback/computed). When intermediate levels are missing, build
  // the whole nested object bottom-up and assign in a single write so Vue
  // fires triggers ONCE, not once per level.
  function internalDeepWrite(path: string[], value: unknown): void {
    if (path.length === 0) return;
    let cursor: any = store;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      const next = cursor[key];
      if (next === null || typeof next !== 'object') {
        // Build the missing subtree all at once: { rest.0: { rest.1: ... { last: value } } }
        let nested: any = value;
        for (let j = path.length - 1; j > i; j--) {
          nested = { [path[j]]: nested };
        }
        cursor[key] = nested;
        return;
      }
      cursor = next;
    }
    cursor[path[path.length - 1]] = value;
  }

  // ─── Wire client → store: fanout, connection state ───────────────────────
  client.onResourceUpdate((rt, rid, snapshot) => {
    withContext({ source: 'remote' }, () => {
      const basePath = ['resources', rt, rid];
      if (snapshot === null) {
        internalDeepWrite([...basePath, 'value'], undefined);
        internalDeepWrite([...basePath, 'meta'], undefined);
      } else {
        internalDeepWrite([...basePath, 'value'], snapshot.value);
        internalDeepWrite([...basePath, 'meta'], snapshot.meta);
      }
    });
    // An idle resource adopts the fanout snapshot as its new baseline.
    queue.noteRemoteSnapshot(rt, rid);
  });

  client.onConnectionStateChange((state) => {
    withContext({ source: 'remote' }, () => {
      internalDeepWrite(['lmz', 'connection', 'state'], state);
      internalDeepWrite(['lmz', 'connection', 'connected'], state === 'connected');
      if (state === 'connected') {
        internalDeepWrite(['lmz', 'connection', 'lastConnectedAt'], Date.now());
      }
    });
    // Connection gate: not-'connected' suspends flush + all queue timers.
    queue.setConnectionState(state);
  });

  // ─── Public API ──────────────────────────────────────────────────────────
  function use(mw: Middleware): () => void {
    middlewares.push(mw);
    return () => {
      const i = middlewares.indexOf(mw);
      if (i >= 0) middlewares.splice(i, 1);
    };
  }

  async function dispose(): Promise<void> {
    for (const t of pendingUnsubscribes.values()) clearTimeout(t);
    pendingUnsubscribes.clear();
    refcount.clear();
    // Flush pending writes; resolves once open submissions settle. Nothing
    // submits after this resolves.
    await queue.dispose();
  }

  return {
    store,
    client,
    use,
    dispose,
    flush: queue.flush,
    transactionDebounce: queue.transactionDebounce,
  };
}

// Re-export for tests
export { effectScope, vueComputed as computed };
