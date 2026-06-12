# Factory collection-sync — Map/Set mutations through the store (v3 isolation detour)

**Status**: spec'd 2026-06-11, not started. Pre-v3 isolation detour for `tasks/nebula-frontend.md` Phase 5.3.7-v3, resolving deep-review **M10**. Build + property-test in isolation **before** the bulk of v3 wiring, reusing the [debounce-serial-queue.md](debounce-serial-queue.md) D0 harness (the mock `client.transaction` that captures every submitted `{ rt, rid, eTag, newETag, value }`).

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

## Tests (property-style, against the captured-transaction harness)

- [ ] `Map.set` / `Map.delete` / `Map.clear` on a resource value each produce exactly one submitted transaction carrying the full post-mutation `value`; round-trips through the mock and writes back.
- [ ] `Set.add` / `Set.delete` / `Set.clear` — same.
- [ ] **Receiver-binding**: non-mutating reads (`map.get`, `map.has`, `set.has`, `forEach`, `for…of`, `.size`) work through the factory Proxy without throwing.
- [ ] **Deep nesting**: a `Map` at `value.meta.labels` and a `Set` inside an array element both sync (proves the wrapping recurses).
- [ ] **Parity with property writes**: a user middleware that aborts/transforms sees collection mutations the same as property writes (the abort-ability A buys over B).
- [ ] **Debounce coalescing**: N rapid collection mutations on one resource coalesce to ~1 transaction (shares the debounce path).
- [ ] **No echo**: a remote fanout writing a collection value does not trigger a resubmit.
- [ ] **Array regression**: `arr.push`/`splice` still sync via the `set` trap (no regression from the collection work).
- [ ] **Mutation during iteration**: `for (const k of map.keys()) map.delete(k)` (raw-bound iterator + wrapped mutator) coalesces to one submitted transaction and leaves the collection empty locally and on the mock — no iterator invalidation through the Proxy, no N mid-iteration submissions.
- [ ] **No-op mutators**: `set.add(existingElement)`, `map.set(k, sameValue)`, `delete(absentKey)`, `clear()` on an empty collection produce **zero** submissions (parity with the set-trap deep-equals skip in "One submission model").
- [ ] Round-trip rich-type invariant: a resource whose value contains `Map`, `Set`, `Date`, and a cycle survives mutate → submit → fanout → re-render (the Phase 5 testing invariant, now exercised through the factory).

## Port

Once green in isolation, fold into the factory during v3 (`packages/nebula-frontend/src/create-nebula-client.ts`) alongside the debounce port — they share the submission path. Delete this detour after the port (standard experiment lifecycle).
