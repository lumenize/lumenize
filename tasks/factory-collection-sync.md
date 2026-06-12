# Factory collection-sync — Map/Set mutations through the store (v3 isolation detour)

**Status**: spec'd 2026-06-11; **implemented + tested in spike 2026-06-12**. Pre-v3 isolation detour for `tasks/nebula-frontend.md` Phase 5.3.7-v3, resolving deep-review **M10**. Lives in `apps/nebula/spike/vue-factory/`: the mutator interception in `src/create-nebula-client.ts` (the `MAP_MUTATORS`/`SET_MUTATORS` block in the `get` trap), tests at `test/collection-sync.test.ts` (15 tests, sharing the [debounce-serial-queue.md](debounce-serial-queue.md) harness — MockClient capture + the debounce queue at `quietMs: 0` so rapid mutations coalesce on a microtask). **Capable-of-failing verified**: reintroducing the M10 gap (interception disabled) fails 11/15 — the 4 survivors are the read-only/array/no-echo tests that don't depend on interception.

**Pinned during D0** (and synced to api-reference § Middleware):
- Mutator-driven middleware args: `path` = the owning collection's path, `oldValue` = pre-mutation snapshot, `newValue` = post-mutation value (the spec's suggested shape, confirmed).
- **Middleware ordering changed for parity**: user middlewares run first, the built-in synced-state middleware runs LAST — a user abort (throw) now aborts the submission too (previously synced-state ran first and a queued submission could leak past a later abort), and synced-state sees the final substituted value. Applies to property writes and mutator calls identically.
- Adjacent fixes the tests forced: (a) the path-Proxy now wraps only plain objects/arrays/Maps/Sets (mirroring Vue's targetTypeMap) — it used to wrap `Date` etc., breaking internal-slot methods ("this is not a Date object"); (b) `deepEquals` got a cycle/alias pair-memo guard (two structurally-equal cyclic values used to recurse to stack overflow — ADR-002 requires cycles to work).
- **Known gap deferred to v3 wiring**: property writes on objects retrieved FROM collection entries (`map.get('k').name = 'x'`) don't path-route through the wrapper — Vue's instrumentation hands back its own reactive, not our path proxy. Mutating the collection itself syncs; mutating an entry's interior does not. Decide treatment during the v3 port (recurse the wrapping through instrumented `get`, or document as assign-the-entry).

## The gap

The factory captures writes via the outer Proxy `set` trap → synced-state middleware → debounced `put`. That fires on **property assignment**. It does NOT fire on `Map`/`Set` **method** mutations (`map.set/delete/clear`, `set.add/delete/clear`) — those are `get`-of-method + `apply`, never a `set` trap. So a collection edit paints locally (Vue's `reactive()` instruments collections, so reactivity + re-render already work) but **never submits a transaction** → silent local-only divergence until the next fanout clobbers it.

- **Arrays already sync** — `arr.push/splice` assign `arr[i]` and `arr.length`, both of which hit the `set` trap. No work needed; cover with a regression test.
- The gap is **specifically `Map`/`Set` method mutations**. (`WeakMap`/`WeakSet` aren't structured-clone-serializable, so resources never hold them — out of scope.)

The docs **promise** full structured-clone support with transparent sync (Resources § "fully supporting everything the structured-clone algorithm supports: Map, Date, cycles…"), so leaving this as a documented "use explicit assignment" footgun is a leaky abstraction. v3 must make the promise true.

## Approach (decided 2026-06-11): Option A — intercept the collection mutators

In the factory's `get` trap, when handing out a `Map`/`Set` mutator (`set`/`add`/`delete`/`clear`), return a wrapper that **computes the post-mutation value, runs the middleware chain BEFORE applying** (abort ⇒ no local mutation; substitute ⇒ the substituted value is what gets applied), then applies the mutation and triggers the **same** debounced submission the `set` trap triggers for the owning resource path. Collection edits become **indistinguishable from property writes** — same middleware chain, same submission, same ability for user middleware to transform/abort. (Mutate-first-then-submit would re-create Option B's flaw through the front door: abort could stop only the submission, not the local mutation. Option B — per-resource deep `watch` — was rejected for exactly that reason: it fires *after* the mutation, so collection edits couldn't run the abort-capable middleware that property writes get. Original finding: M10 in tasks/nebula-frontend-deep-review-findings-2026-06-10.json.) **Pin during D0**: the middleware args for a mutator-driven invocation (suggested: `path` = the owning collection's path, `oldValue` = pre-mutation snapshot, `newValue` = post-mutation value) — then sync api-reference § Middleware.

**Implementation notes:**
- **Receiver-binding gotcha**: a `Map`/`Set` method called on a Proxy throws *"Method Map.prototype.set called on incompatible receiver"*. Bind mutators (and non-mutating reads — `get`/`has`/`forEach`/iterators/`size`) to the raw collection, exactly as Vue's `mutableCollectionHandlers` does — that's the reference implementation to copy.
- **Exhaustive nesting**: the wrapping must reach collections wherever they nest in a resource value (`value.tags`, `value.meta.labels`, a `Map` inside an array, …), so the factory's path-aware wrapping recurses into collections, not just plain objects. This is what makes the "all structured-clone types" promise hold for deep nesting (the reason A was chosen over a shallow fix).
- **One submission model**: the wrapped mutator funnels into the existing microtask-defer → read full `value` → submit `put` path, so it inherits debounce, serial-per-`(rt,rid)` queue, and remote/rollback `context.source` discrimination for free. Do NOT add a second submission trigger.
- **No double-submit**: a single mutator call submits once; a remote fanout that writes a collection through `{ source: 'remote' }` must NOT re-submit (same skip as the `set` trap).

## Tests (property-style, against the captured-transaction harness) — ALL GREEN

- [x] `Map.set` / `Map.delete` / `Map.clear` on a resource value each produce exactly one submitted transaction carrying the full post-mutation `value`; round-trips through the mock and writes back (committed eTag lands in `meta.eTag`).
- [x] `Set.add` / `Set.delete` / `Set.clear` — same.
- [x] **Receiver-binding**: non-mutating reads (`map.get`, `map.has`, `set.has`, `forEach`, `for…of`, `.size`, `keys()`) work through the factory Proxy without throwing. (Vue's instrumentation resolves `this.__v_raw` through the wrapper's `__v_` pass-through — no explicit binding needed; mutators are wrapped anyway.)
- [x] **Deep nesting**: a `Map` at `value.meta.labels` and a `Set` inside an array element both sync (proves the wrapping recurses).
- [x] **Parity with property writes**: a middleware abort (throw) prevents the local mutation AND the submission for both mutators and property writes; a transform substitutes the applied and submitted collection.
- [x] **Debounce coalescing**: 10 rapid mutations → 1 transaction (shares the debounce path).
- [x] **No echo**: a remote fanout writing a collection value does not trigger a resubmit.
- [x] **Array regression**: `arr.push`/`splice` still sync via the `set` trap.
- [x] **Mutation during iteration**: `for (const k of map.keys()) map.delete(k)` coalesces to one submitted transaction; collection empty locally and on the mock.
- [x] **No-op mutators**: all four shapes produce **zero** submissions AND never run the middleware chain (asserted directly).
- [x] Round-trip rich-type invariant: `Map` + `Set` + `Date` + cycle survive mutate → submit → fanout → re-read, cycle identity intact (`sent.self === sent`), no echo.

## Port

Once green in isolation, fold into the factory during v3 (`packages/nebula-frontend/src/create-nebula-client.ts`) alongside the debounce port — they share the submission path. Delete this detour after the port (standard experiment lifecycle).
