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
import type {
  ClientLike,
  FactoryResult,
  Middleware,
  TransactionOutcome,
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

  // ─── Recursive path-aware Proxy ──────────────────────────────────────────
  // Wraps `target` (which is a Vue reactive) with a custom Proxy that knows
  // its path. Each level wraps lazily on read; nested objects are wrapped on
  // first access. Vue's own Proxy still handles dep-tracking and triggering
  // beneath ours.
  const wrapperCache = new WeakMap<object, Map<string, any>>();

  function wrap(target: any, path: string[]): any {
    if (target === null || typeof target !== 'object') return target;
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

        // Run middleware chain. A middleware may substitute by returning a value.
        let finalValue = newValue;
        for (const mw of middlewares) {
          const result = mw({
            path: fullPath,
            oldValue,
            newValue: finalValue,
            context: currentContext,
          });
          if (result !== undefined) finalValue = result;
        }
        // Re-dedup after middleware substitution.
        if (deepEquals(oldValue, finalValue)) return true;

        return Reflect.set(t, key, finalValue);
      },
    });
    levelCache.set(pathKey, proxy);
    return proxy;
  }

  const store = wrap(root, []);

  // ─── Built-in synced-state middleware ────────────────────────────────────
  // Routes writes under resources.<rt>.<rid>.value.* with context.source ===
  // 'local' to client.transaction(). Optimistic apply: write lands; rollback
  // on terminal failure restores pre-write value.
  const syncedStateMiddleware: Middleware = ({ path, context, newValue }) => {
    if (context.source !== 'local') return undefined;
    const match = /^resources\.([^.]+)\.([^.]+)\.value(?:\.|$)/.exec(path);
    if (!match) return undefined;
    const rt = match[1];
    const rid = match[2];
    const basePath = `resources.${rt}.${rid}`;
    // Read current meta.eTag from the underlying root (read-only access; we
    // skip our Proxy's auto-subscribe by reading directly).
    const eTag = (root as any)?.resources?.[rt]?.[rid]?.meta?.eTag as string | undefined;
    if (!eTag) {
      // Treat as "user editing never-subscribed resource"; no transaction.
      // Production would log/warn here. Spike: silent.
      return undefined;
    }
    // Deep-clone the pre-write value: Vue mutates the underlying object
    // in place on nested writes, so capturing a reference here would yield
    // the post-write value by the time rollback runs. `structuredClone`
    // refuses Vue Proxies directly (DataCloneError), but `toRaw()` strips
    // the Proxy and returns the underlying POJO which clones cleanly.
    // Preserves Dates / RegExps / typed arrays correctly — handy if any
    // resource type stores those.
    const liveValue = (root as any)?.resources?.[rt]?.[rid]?.value;
    const preWriteFullValue = liveValue === undefined
      ? undefined
      : structuredClone(toRaw(liveValue));

    // Schedule the transaction after the optimistic write has landed.
    // Microtask defer is the standard pattern; the user's write has already
    // returned by the time the txn submits.
    queueMicrotask(async () => {
      // Re-read full value after the optimistic write applied.
      const submitValue = (root as any)?.resources?.[rt]?.[rid]?.value;
      const outcome = await client.transaction({
        rt,
        rid,
        eTag,
        value: submitValue,
        newETag: cryptoRandomUUID(),
      });
      handleTransactionOutcome(outcome, basePath, preWriteFullValue);
    });

    // Don't substitute; the optimistic write proceeds.
    void newValue;
    return undefined;
  };

  function handleTransactionOutcome(
    outcome: TransactionOutcome,
    basePath: string,
    preWriteFullValue: unknown,
  ): void {
    const parts = basePath.split('.');
    switch (outcome.resolution) {
      case 'committed': {
        // Write meta.eTag through with 'remote' context (skips middleware).
        withContext({ source: 'remote' }, () => {
          internalDeepWrite([...parts, 'meta', 'eTag'], outcome.eTag);
        });
        return;
      }
      case 'use-server': {
        withContext({ source: 'remote' }, () => {
          internalDeepWrite([...parts, 'value'], outcome.snapshot.value);
          internalDeepWrite([...parts, 'meta'], outcome.snapshot.meta);
        });
        return;
      }
      case 'validation-failed':
      case 'timeout': {
        // Rollback optimistic write.
        withContext({ source: 'rollback' }, () => {
          internalDeepWrite([...parts, 'value'], preWriteFullValue);
        });
        return;
      }
    }
  }

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

  middlewares.push(syncedStateMiddleware);

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
  });

  client.onConnectionStateChange((state) => {
    withContext({ source: 'remote' }, () => {
      internalDeepWrite(['lmz', 'connection', 'state'], state);
      internalDeepWrite(['lmz', 'connection', 'connected'], state === 'connected');
      if (state === 'connected') {
        internalDeepWrite(['lmz', 'connection', 'lastConnectedAt'], Date.now());
      }
    });
  });

  // ─── Public API ──────────────────────────────────────────────────────────
  function use(mw: Middleware): () => void {
    middlewares.push(mw);
    return () => {
      const i = middlewares.indexOf(mw);
      if (i >= 0) middlewares.splice(i, 1);
    };
  }

  function dispose(): void {
    for (const t of pendingUnsubscribes.values()) clearTimeout(t);
    pendingUnsubscribes.clear();
    refcount.clear();
  }

  return { store, client, use, dispose };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function cryptoRandomUUID(): string {
  // Node 20+ exposes globalThis.crypto.randomUUID; tolerate older runtimes.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback: time-based, not collision-proof; spike-only.
  return `spike-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Re-export for tests
export { effectScope, vueComputed as computed };
