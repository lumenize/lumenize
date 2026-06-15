/**
 * Factory: createNebulaStore(client, options) → { store, use, flush, dispose }
 *
 * The `store` is a path-aware Proxy that wraps a `@vue/reactivity` reactive
 * object. Custom behaviors layered on Vue's normal reactivity:
 *
 *   1. **Middleware in `set` trap.** Every write — at any depth — flows through
 *      a middleware chain before forwarding to the underlying reactive. The
 *      built-in synced-state middleware sees writes under
 *      `resources.<rt>.<rid>.value.*` with context.source === 'local' and
 *      enqueues a debounced transaction via `client.resources.write(...)`.
 *
 *   2. **Top-level deep-equal dedup.** If the write's `newValue` deep-equals
 *      the current value, the write is skipped entirely. Middleware never
 *      runs; no Vue trigger fires.
 *
 *   3. **effectScope-driven auto-subscribe.** When a read on
 *      `resources.<rt>.<rid>.*` happens inside an active effectScope, the
 *      factory refcounts the (rt, rid). 0→1 triggers `client.resources.subscribe`;
 *      scope-dispose → grace → 1→0 triggers `client.resources.unsubscribe`.
 *
 *   4. **Connection-state surfacing.** The factory mirrors the client's
 *      connection state into `store.lmz.connection.*` (and replays the current
 *      state once at creation, so factory/connect ordering is irrelevant).
 *
 * Unlike the spike, the conflict-outcome engine + debounce queue NO LONGER live
 * here — NebulaClient owns them. The factory builds the Vue-reactive store and
 * injects a {@link NebulaStoreAdapter} into the client via `client.bindStore`;
 * the engine drives that adapter for all optimistic-state effects (commit,
 * rollback, use-server, fanout write-through). The factory's only submission
 * role is the synced-state middleware → `client.resources.write(...)`.
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
import { getCurrentInstance } from '@vue/runtime-core';
import { debug } from '@lumenize/debug';
import { deepEquals } from './deep-equals';
import type { Middleware, StoreClient, WriteContext } from './types';
import { NebulaClient } from '../nebula-client';
import type { NebulaStoreAdapter, ResourceSubscription, OntologyStaleInfo, NebulaClientConfig } from '../nebula-client';
import type { Snapshot } from '../resources';

const log = debug('lumenize.nebula-frontend');

// Vue 3 component render effects DO NOT activate their owning effectScope at
// `run()` time — they only set `activeSub` (for dep tracking) and
// `shouldTrack`. That means `getCurrentScope()` returns null inside a
// component's render, so the factory's scope-based auto-subscribe never fires
// when reads happen via Vue templates.
//
// To bridge: read Vue's `getCurrentInstance()` from `@vue/runtime-core`; if it
// returns a component instance, use `instance.scope` as the lifecycle scope.
// The component's scope is disposed automatically when the component unmounts,
// so registered `onScopeDispose` callbacks fire at the right time.
function getActiveVueScope(): EffectScope | null {
  const instance = getCurrentInstance() as { scope?: EffectScope } | null;
  return instance?.scope ?? null;
}

export interface CreateNebulaStoreOptions {
  /** Grace period before unsubscribing after refcount drops to zero. Default 2000ms. */
  unsubscribeGraceMs?: number;
  /** Initial state (merged into the reactive root alongside the reserved subtrees). */
  initialState?: Record<string, any>;
}

/** Factory output (the store half — the public `createNebulaClient` wraps this
 *  and adds `client` + `ready` in Phase 7). */
export interface NebulaStoreResult {
  /** The Vue-reactive, path-aware Proxy. Consumers read/write properties on it. */
  store: Record<string, any>;
  /** Register an additional middleware. User middlewares run in registration
   *  order; the built-in synced-state middleware always runs after them (an
   *  abort therefore also aborts the submission). Returns an unregister fn. */
  use(middleware: Middleware): () => void;
  /** External flush trigger (unmount / blur / explicit). No args flushes
   *  everything. Delegates to the client's debounce queue. */
  flush(resourceType?: string, resourceId?: string): void;
  /** Flush pending writes + settle open submissions + tear down auto-subscribe
   *  timers. Nothing submits after this resolves. */
  dispose(): Promise<void>;
}

const DEFAULT_UNSUBSCRIBE_GRACE_MS = 2000;

/**
 * Build a Vue-reactive store around an existing NebulaClient (or a structural
 * stand-in). Internal — the public {@link createNebulaClient} (Phase 7)
 * constructs the client and calls this.
 */
export function createNebulaStore(
  client: StoreClient,
  options: CreateNebulaStoreOptions = {},
): NebulaStoreResult {
  const unsubscribeGraceMs = options.unsubscribeGraceMs ?? DEFAULT_UNSUBSCRIBE_GRACE_MS;

  // ─── Reactive root + middleware chain ────────────────────────────────────
  // Bootstrap framework-managed subtrees so descendant access works even before
  // any data lands. `resources.*` is path-tracking territory for auto-subscribe;
  // `lmz.connection.*` is where the factory writes connection state (seeded so
  // first-paint reads aren't `undefined`). `ui`/`app` are app-owned conveniences
  // (not reserved) — pre-seeded so `store.ui.*` / `store.app.*` access works with
  // no init (api-reference § Reserved state paths).
  const seed: Record<string, any> = {
    resources: {},
    lmz: { connection: { state: 'disconnected', connected: false }, orgTree: {} },
    ui: {},
    app: {},
  };
  const userInitial = options.initialState ?? {};
  for (const k of Object.keys(userInitial)) {
    seed[k] = userInitial[k];
  }
  const root = reactive(seed);
  // User middlewares only. The built-in synced-state middleware runs LAST, after
  // the user chain (see notifySyncedState call sites): a user abort (throw) must
  // stop the submission too, and synced-state should see the final
  // post-substitution value.
  const middlewares: Middleware[] = [];

  // Module-scope sidecar: currentContext threads write context through the Proxy
  // `set` trap so middleware can discriminate user vs remote writes. Synchronous
  // reads from middleware mean no async-context worries.
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

  // Re-entrancy guard: a user middleware that writes back to a path already
  // being applied would re-enter the `set` trap and (for a sloppy same-path
  // write-back) infinite-loop. Paths currently mid-apply skip the middleware
  // chain (forward direct to Vue). Keyed by full path — a cross-path write-back
  // has a different key, so ITS middleware still runs exactly once.
  const applyingPaths = new Set<string>();

  // ─── Refcount + auto-subscribe registry ──────────────────────────────────
  const refcount = new Map<string, number>();
  const scopeReads = new WeakMap<EffectScope, Set<string>>();
  const pendingUnsubscribes = new Map<string, ReturnType<typeof setTimeout>>();
  // One held subscription handle per component-bound (rt, rid). The factory's
  // component-scope refcount collapses N reads to this single handle; disposing
  // it (after grace) releases the factory's contribution to the client's
  // per-handle refcount (explicit `using` handles contribute independently).
  const componentHandles = new Map<string, ResourceSubscription>();

  function resourceKey(rt: string, rid: string): string {
    return `${rt}:${rid}`;
  }

  function trackResourceRead(rt: string, rid: string): void {
    // Try the standard `@vue/reactivity` scope first (synthetic test scopes via
    // `effectScope().run(...)`). If absent, fall back to Vue's component
    // instance — render effects don't activate their owning scope, but
    // `getCurrentInstance().scope` exposes it.
    const scope = getCurrentScope() ?? getActiveVueScope();
    if (!scope) return; // read outside any tracked context — no auto-subscribe
    const key = resourceKey(rt, rid);
    let seenInScope = scopeReads.get(scope);
    if (!seenInScope) {
      seenInScope = new Set();
      scopeReads.set(scope, seenInScope);
      // Register decrement on scope dispose. `onScopeDispose` requires the scope
      // to be active; component scopes aren't active during render, so we
      // briefly activate via `scope.run(...)`. Test scopes via
      // `effectScope().run(...)` are already active, so the extra `run` is a
      // no-op nesting.
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
      // Grace-cancel: a new binding showed up before unsubscribe fired. The
      // server-side subscription is still live — refcount-bump only, no
      // re-subscribe RTT.
      clearTimeout(pending);
      pendingUnsubscribes.delete(key);
      refcount.set(key, (refcount.get(key) ?? 0) + 1);
      return;
    }
    const prev = refcount.get(key) ?? 0;
    refcount.set(key, prev + 1);
    if (prev === 0) {
      // 0 → 1: issue subscribe and HOLD the handle. Fanout writes arrive via the
      // engine's `applyFanout` (the bound adapter). A failed subscribe (bad rid
      // / no read permission) leaves the path `undefined`; surface it to the
      // developer via `.snapshot.catch` instead of swallowing silently.
      const handle = client.resources.subscribe(rt, rid);
      handle.snapshot.catch((err: unknown) => {
        log.warn('auto-subscribe failed', {
          rt,
          rid,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      componentHandles.set(key, handle);
    }
  }

  function decrementRefcount(key: string): void {
    const prev = refcount.get(key) ?? 0;
    if (prev <= 1) {
      refcount.delete(key);
      // Schedule the held handle's dispose after grace (cancelled by a re-bind
      // during the window — the handle stays alive, no re-subscribe RTT).
      const timer = setTimeout(() => {
        pendingUnsubscribes.delete(key);
        componentHandles.get(key)?.[Symbol.dispose]();
        componentHandles.delete(key);
      }, unsubscribeGraceMs);
      pendingUnsubscribes.set(key, timer);
    } else {
      refcount.set(key, prev - 1);
    }
  }

  // ─── Middleware chain runner ─────────────────────────────────────────────
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
  // applied), then apply via Vue's instrumented method (reactivity fires) — the
  // synced-state middleware funnels into the same debounced submission.
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
  // Wraps `target` (a Vue reactive) with a custom Proxy that knows its path.
  // Each level wraps lazily on read; nested objects are wrapped on first access.
  // Vue's own Proxy still handles dep-tracking and triggering beneath ours.
  const wrapperCache = new WeakMap<object, Map<string, any>>();

  // Mirror Vue's targetTypeMap: only plain objects, arrays, Maps, and Sets get a
  // path wrapper. Dates, RegExps, errors, class instances pass through raw — a
  // Proxy around them breaks internal-slot methods ("this is not a Date object"),
  // and Vue leaves them unreactive for the same reason.
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
    // identity-stable wrappers. Important for Vue's dep-tracking which keys by
    // identity.
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
      // interprets a different receiver as "write the property on the receiver,
      // not the target," which bypasses Vue's dep tracking. Forwarding to Vue's
      // Proxy directly keeps Vue's trap firing normally.
      get(t, key) {
        if (typeof key !== 'string') return Reflect.get(t, key);

        // Pass through Vue internal-marker reads (`__v_isRef`, `__v_isReactive`,
        // `__v_raw`, etc.) without wrapping or path extension. Vue 3.5 in-DOM
        // mode probes `__v_isRef` on the outer store during render; the
        // underlying Vue reactive answers correctly via this pass-through.
        if (key.startsWith('__v_')) return Reflect.get(t, key);

        // Map/Set mutator interception (M10): the collection's own path is this
        // wrap level's path. Non-mutating reads (get/has/forEach/iterators/size)
        // flow through untouched — Vue's instrumentation resolves
        // `this.__v_raw` through the `__v_` pass-through above.
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
        // fire) even when no data has been pushed yet. Uses context: 'computed'
        // so middleware skips, and reads from the raw store to skip our own
        // wrapping. Vue's normal triggers still fire for the vivification write.
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

        // Re-entrancy guard: a middleware writing back to THIS path skips the
        // chain (direct to Vue) so a sloppy same-path write-back can't loop.
        if (applyingPaths.has(fullPath)) {
          return Reflect.set(t, key, newValue);
        }

        applyingPaths.add(fullPath);
        let finalValue: unknown;
        try {
          finalValue = runUserMiddlewares(fullPath, oldValue, newValue);
        } finally {
          applyingPaths.delete(fullPath);
        }
        // Lazy post-middleware dedup: only re-run deep-equals when a middleware
        // actually substituted (finalValue !== newValue by reference). When
        // nothing substituted, the top-of-trap check already proved inequality.
        if (finalValue !== newValue && deepEquals(oldValue, finalValue)) return true;

        notifySyncedState(fullPath, oldValue, finalValue);
        return Reflect.set(t, key, finalValue);
      },
    });
    levelCache.set(pathKey, proxy);
    return proxy;
  }

  const store = wrap(root, []);

  // Internal write that walks via the outer Proxy so context flows through
  // middleware checks (middleware reads context.source and skips
  // remote/rollback/computed). When intermediate levels are missing, build the
  // whole nested object bottom-up and assign in a single write so Vue fires
  // triggers ONCE, not once per level.
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

  // ─── Built-in synced-state middleware ────────────────────────────────────
  // flush-on-blur (pinned debounce trigger (d), §5.3.7): maps a focused editable
  // element → the resource its v-model writes target, so a `focusout` can flush
  // THAT resource's pending debounced write immediately (without waiting for the
  // quiet window). Populated in the synced-state middleware from
  // `document.activeElement` at write time — the input driving a v-model write IS
  // the active element. WeakMap: entries clear when the element is GC'd.
  const boundEditTargets = new WeakMap<EventTarget, { rt: string; rid: string }>();

  // Routes writes under resources.<rt>.<rid>.value.* with context.source ===
  // 'local' to the client's debounce queue. Optimistic apply: the write lands
  // immediately (the `set` trap's Reflect.set fires AFTER this); debounce gates
  // only the submission; rollback on terminal failure restores the baseline.
  const syncedStateMiddleware: Middleware = ({ path, context }) => {
    if (context.source !== 'local') return undefined;
    const match = /^resources\.([^.]+)\.([^.]+)\.value(?:\.|$)/.exec(path);
    if (!match) return undefined;
    const rt = match[1];
    const rid = match[2];
    const eTag = (root as any)?.resources?.[rt]?.[rid]?.meta?.eTag as string | undefined;
    if (!eTag) {
      // User editing a never-subscribed resource: no baseline eTag to submit
      // against, so no transaction. The `v-if` guard pattern is supposed to
      // prevent this; an unguarded `v-model` would otherwise be invisibly
      // broken in production, so surface it to the developer.
      log.warn('synced-state write dropped: no meta.eTag (resource not subscribed)', { rt, rid, path });
      return undefined;
    }
    // Remember which input is driving this edit so its blur can flush precisely.
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active) boundEditTargets.set(active, { rt, rid });
    // First-divergence base capture (B4 site a): the queue uses this only when
    // the resource has no baseline yet — the value the store held BEFORE this
    // optimistic write lands (the `set` trap's Reflect.set runs after us).
    const liveValue = (root as any)?.resources?.[rt]?.[rid]?.value;
    const preWriteFullValue =
      liveValue === undefined ? undefined : structuredClone(toRaw(liveValue));
    client.resources.write(rt, rid, { preWriteValue: preWriteFullValue });
    return undefined;
  };

  // ─── Store adapter: the engine writes optimistic-state effects through this ─
  // NebulaClient instantiates the conflict-outcome engine; we inject this
  // Vue-reactive adapter so commits/rollbacks/use-server/fanout land in the
  // store. All writes use a non-'local' context so the synced-state middleware
  // skips them (no resubmission loop). `readResource` returns toRaw'd values so
  // the engine's default `structuredClone` clone works on the Proxy-free raw
  // tree (NebulaClient stays vue-free and passes no custom clone).
  const adapter: NebulaStoreAdapter = {
    readResource(rt, rid) {
      const entry = (root as any)?.resources?.[rt]?.[rid];
      const value = entry?.value;
      return {
        value: value !== null && typeof value === 'object' ? toRaw(value) : value,
        eTag: entry?.meta?.eTag as string | undefined,
      };
    },
    applyServer(rt, rid, snapshot: Snapshot) {
      withContext({ source: 'remote' }, () => {
        internalDeepWrite(['resources', rt, rid, 'value'], snapshot.value);
        internalDeepWrite(['resources', rt, rid, 'meta'], snapshot.meta);
      });
    },
    applyFanout(rt, rid, snapshot: Snapshot) {
      withContext({ source: 'remote' }, () => {
        internalDeepWrite(['resources', rt, rid, 'value'], snapshot.value);
        internalDeepWrite(['resources', rt, rid, 'meta'], snapshot.meta);
      });
    },
    applyCommit(rt, rid, eTag) {
      withContext({ source: 'remote' }, () => {
        internalDeepWrite(['resources', rt, rid, 'meta', 'eTag'], eTag);
      });
    },
    rollbackTo(rt, rid, value) {
      withContext({ source: 'rollback' }, () => {
        internalDeepWrite(['resources', rt, rid, 'value'], value);
      });
    },
    applyResolvedValue(rt, rid, value) {
      // `use-this`: a fresh optimistic paint of the merged verdict value. Marked
      // 'remote' so it doesn't re-enqueue — the engine drives its re-submission.
      withContext({ source: 'remote' }, () => {
        internalDeepWrite(['resources', rt, rid, 'value'], value);
      });
    },
    applyOptimistic(rt, rid, value, eTag) {
      // Explicit transactionOps create/put paint (value + baseline eTag).
      withContext({ source: 'remote' }, () => {
        internalDeepWrite(['resources', rt, rid, 'value'], value);
        internalDeepWrite(['resources', rt, rid, 'meta', 'eTag'], eTag);
      });
    },
    flash() {
      // DOM flash deferred to v4 (api-reference § Default flash classes).
    },
  };
  client.bindStore(adapter);

  // ─── Connection-state surfacing ──────────────────────────────────────────
  // Mirror the client's connection state into store.lmz.connection.* (the
  // engine's connection gate is wired inside NebulaClient — NOT here).
  function writeConnectionState(state: string): void {
    withContext({ source: 'remote' }, () => {
      internalDeepWrite(['lmz', 'connection', 'state'], state);
      internalDeepWrite(['lmz', 'connection', 'connected'], state === 'connected');
      if (state === 'connected') {
        internalDeepWrite(['lmz', 'connection', 'lastConnectedAt'], Date.now());
      }
    });
  }
  // Replay current state at creation, then observe transitions — so factory /
  // connect ordering is irrelevant.
  writeConnectionState(client.connectionState);
  client.onConnectionStateChange(writeConnectionState);

  // ─── OrgTree surfacing ────────────────────────────────────────────────────
  // Mirror the org/permission tree into store.lmz.orgTree.value. Registering
  // this listener also opts the client into auto-subscribing the tree on connect
  // (NebulaClient gates the subscribe on a registered listener). The synced-state
  // middleware's `^resources\.` matcher structurally never sees lmz.*, so this is
  // never mistaken for a transaction.
  client.onOrgTreeUpdate((state) => {
    withContext({ source: 'remote' }, () => {
      internalDeepWrite(['lmz', 'orgTree', 'value'], state);
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

  function flush(rt?: string, rid?: string): void {
    client.flush(rt, rid);
  }

  // flush-on-blur: a delegated `focusout` listener flushes the pending debounced
  // write of whichever resource the blurred input was editing (mapping from the
  // synced-state middleware). `focusout` bubbles, so one document-level listener
  // covers every bound input; the per-factory WeakMap means concurrent factories
  // only flush their own resources. Guarded for headless/no-DOM (Node tests).
  const onFocusOut = (e: Event): void => {
    const target = e.target as EventTarget | null;
    if (!target) return;
    const bound = boundEditTargets.get(target);
    if (bound) flush(bound.rt, bound.rid);
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('focusout', onFocusOut);
  }

  async function dispose(): Promise<void> {
    if (typeof document !== 'undefined') {
      document.removeEventListener('focusout', onFocusOut);
    }
    for (const t of pendingUnsubscribes.values()) clearTimeout(t);
    pendingUnsubscribes.clear();
    refcount.clear();
    componentHandles.clear(); // server subscriptions release via client.dispose's WS disconnect
    // Flush pending writes; resolves once open submissions settle, then the WS
    // disconnects (client.dispose). Nothing submits after this resolves.
    await client.dispose();
  }

  return { store, use, flush, dispose };
}

// Re-export for tests that drive synthetic scopes / computeds.
export { effectScope, vueComputed as computed };

/**
 * Configuration for {@link createNebulaClient}. Only `appVersion` is required;
 * `baseUrl` / `activeScope` / `onShouldRefreshUI` auto-detect, and all the
 * inherited `NebulaClient` fields (`fetch`, `sessionStorage`, `onLoginRequired`,
 * `onConnectionStateChange`, …) stay available as escape hatches for
 * admin/scripting/tests. api-reference § createNebulaClient is the contract.
 *
 * **`authScope` is currently required-in-practice** — its URL auto-detect is
 * deferred (coupled to the open Studio-hosting/deployment-URL decision; see
 * tasks/backlog.md). Omitting it throws a clear error at call time.
 */
export interface CreateNebulaClientConfig
  extends Omit<NebulaClientConfig, 'authScope' | 'activeScope' | 'onShouldRefreshUI'> {
  /** Cookie-path auth scope. Auto-detect deferred — pass explicitly for now. */
  authScope?: string;
  /** JWT `aud` active scope. Defaults to `authScope`. */
  activeScope?: string;
  /** Called on `ontology-stale`. `undefined`/`null` → default once-guarded
   *  `window.location.reload()`; pass an explicit `() => {}` to opt out. */
  onShouldRefreshUI?: ((info: OntologyStaleInfo) => void) | null;
  /** Grace before auto-unsubscribe after the binding refcount hits zero (default 2000ms). */
  unsubscribeGraceMs?: number;
}

/**
 * What {@link createNebulaClient} returns. `store` is the Vue-reactive,
 * path-aware Proxy; `client` exposes the NebulaClient surface; `ready` resolves
 * after the first successful connection (claims populated) and rejects with a
 * `LoginRequiredError` on terminal auth failure (api-reference § createNebulaClient).
 */
export interface FactoryResult {
  client: NebulaClient;
  store: Record<string, any>;
  ready: Promise<void>;
  use(middleware: Middleware): () => void;
  flush(resourceType?: string, resourceId?: string): void;
  dispose(): Promise<void>;
}

const RELOAD_STORM_SENTINEL = 'lmz.ontology-stale-reloaded';

/**
 * Default `onShouldRefreshUI`: fetch the new bundle via a full reload, guarded
 * by a `sessionStorage` sentinel so an immediate re-stale right after the reload
 * doesn't loop. (Set-once per session: a much-later staleness across the same
 * long-lived tab won't auto-reload — accepted; the app can pass a custom
 * handler. See tasks/nebula-frontend.md.)
 */
function defaultOnShouldRefreshUI(_info: OntologyStaleInfo): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (sessionStorage.getItem(RELOAD_STORM_SENTINEL)) return; // already reloaded once for staleness
      sessionStorage.setItem(RELOAD_STORM_SENTINEL, '1');
    }
    if (typeof window !== 'undefined') window.location.reload();
  } catch {
    // non-browser / storage blocked — nothing to reload.
  }
}

/**
 * Pure config resolution (auto-detect + defaults), split out so it's unit-testable
 * without opening a connection. Throws on a missing `appVersion` or `authScope`
 * (the latter's URL auto-detect is deferred — see {@link CreateNebulaClientConfig}).
 */
export function resolveNebulaClientConfig(config: CreateNebulaClientConfig): {
  baseUrl?: string;
  authScope: string;
  activeScope: string;
  appVersion: string;
  onShouldRefreshUI: (info: OntologyStaleInfo) => void;
} {
  if (!config.appVersion) {
    throw new Error('createNebulaClient: `appVersion` is required.');
  }
  if (config.authScope === undefined) {
    throw new Error(
      'createNebulaClient: `authScope` auto-detect from the deployment URL is not yet implemented ' +
        '(coupled to the open Studio-hosting / deployment-URL decision — see tasks/backlog.md). ' +
        'Pass `authScope` explicitly for now.',
    );
  }
  const baseUrl = config.baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
  const authScope = config.authScope;
  const activeScope = config.activeScope ?? authScope;
  // `?? ` coalesces both `undefined` and `null` to the default reload (by design —
  // there is no "disable" sentinel; opt out with an explicit `() => {}`).
  const onShouldRefreshUI = config.onShouldRefreshUI ?? defaultOnShouldRefreshUI;
  return { baseUrl, authScope, activeScope, appVersion: config.appVersion, onShouldRefreshUI };
}

/**
 * Integration entry point — constructs a {@link NebulaClient} and wraps it in a
 * Vue-reactive store (via {@link createNebulaStore}) with optimistic writes,
 * debounced transactions, conflict resolution, and effect-scope-tied
 * auto-subscribe. Returns `{ client, store, ready, use, flush, dispose }`.
 *
 * `ready` resolves on the first `'connected'` transition (token refresh complete
 * → `client.claims` populated) and **rejects** with a `LoginRequiredError` on a
 * terminal `onLoginRequired` before that — the bootstrap top-level-awaits it.
 * (The *first-connect* terminal-reject becomes fully exercisable once P9 makes
 * mesh classify first-connect auth failures; mid-session terminal works today.)
 *
 * @see https://lumenize.com/docs/nebula/api-reference#createnebulaclient
 */
export function createNebulaClient(config: CreateNebulaClientConfig): FactoryResult {
  const resolved = resolveNebulaClientConfig(config);

  // Pull the user's own connection/auth observers (if any) so we can chain ours
  // in front of them rather than shadowing them.
  const { onConnectionStateChange: userOnConnectionStateChange, onLoginRequired: userOnLoginRequired } = config;

  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let readySettled = false;

  const client = new NebulaClient({
    ...config,
    baseUrl: resolved.baseUrl,
    authScope: resolved.authScope,
    activeScope: resolved.activeScope,
    appVersion: resolved.appVersion,
    onShouldRefreshUI: resolved.onShouldRefreshUI,
    onConnectionStateChange: (state) => {
      if (state === 'connected' && !readySettled) {
        readySettled = true;
        resolveReady();
      }
      userOnConnectionStateChange?.(state);
    },
    onLoginRequired: (err) => {
      // Terminal auth failure. Before `ready` resolves (a logged-out visitor on
      // first connect), reject it so the bootstrap can redirect rather than hang.
      if (!readySettled) {
        readySettled = true;
        rejectReady(err);
      }
      userOnLoginRequired?.(err);
    },
  });

  const storeResult = createNebulaStore(client, { unsubscribeGraceMs: config.unsubscribeGraceMs });

  return {
    client,
    store: storeResult.store,
    ready,
    use: storeResult.use,
    flush: storeResult.flush,
    dispose: storeResult.dispose,
  };
}
