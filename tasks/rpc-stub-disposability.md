# Experiment: Workers RPC stub disposability + `using` semantics — across all three environments

**Status**: **✅ RESOLVED (2026-07-15)** — ran across all three environments (pool-workers, `wrangler dev`, deployed real-CF), **byte-for-byte identical** matrix. **H1 CONFIRMED / H2 REFUTED**: a DO stub, a service/WorkerEntrypoint binding stub, and a DO facet stub are local pointers with NO `Symbol.dispose` in any environment (`using` throws "Object is not disposable."); only a method-returned RpcTarget is disposable. The wall-clock-billing angle (question 3) was **descoped** before the run (Larry). Full record: `experiments/rpc-stub-disposability/FINDINGS.md` + the `using-on-do-stub-not-disposable` memory. Record corrected in `profile.ts`, `durable-objects.md` § Wall-clock billing, `raw-comm.md` § Raw Workers RPC; repo grep = zero offenders (every `using` is on a disposable client). Ready to archive. — Original plan below.

**Status (original)**: **NEW (2026-07-14)** — spike, to run in a **fresh context** (self-contained; results captured here + in `experiments/rpc-stub-disposability/FINDINGS.md`, code not kept runnable — workflow.md § Experiments). May run in an **isolated worktree** (experiments are the sanctioned exception to the no-parallel-worktree rule). Written during the profile-store build after `using registry = env.NEBULA_AUTH_REGISTRY.getByName(...)` threw **"Object is not disposable"** in vitest-pool-workers and I (Claude) concluded — **without verifying** — that it was a miniflare-only quirk and real Cloudflare DO stubs are disposable. Larry doubts that ("we've never seen something this low-level be true in prod but not in pool-workers/`wrangler dev`") and offers a more principled model. This experiment settles it.

## The question
1. **Is `using` on a DO stub supposed to work at all?** The Cloudflare docs show `using` for **RpcTarget / WorkerEntrypoint** stubs but **not** for **DO** stubs. Why the asymmetry?
2. **Environment-dependence:** does the "Object is not disposable" throw happen only in **vitest-pool-workers (miniflare)**, or also in **`wrangler dev` (local workerd)** and **deployed (real Cloudflare)**?
3. **Wall-clock billing:** `durable-objects.md` § Wall-clock billing claims *"holding Workers RPC stubs open"* bills wall-clock and prescribes `using` to dispose promptly. If DO stubs hold nothing open, that guidance may be wrong — **does holding an idle DO stub actually keep the DO active/billed?**
4. **DO facet stubs** (the newer facets feature): do they behave like DO stubs or like RpcTargets?

## Competing hypotheses (the experiment must confirm/refute)
- **H1 — Larry's model (local pointer vs session):** a DO stub (and a plain service/WorkerEntrypoint binding stub) is essentially a **local pointer** that does its connecting at *call* time and tears the connection down immediately after — so there is **nothing to dispose**, hence **no `Symbol.dispose` in ANY environment**, and `using` on it is meaningless (throws or no-ops). An **RpcTarget returned from a method** holds a **session** (server-side object kept alive across calls) → **is** disposable (`Symbol.dispose` present) so the caller can release the session. **Prediction:** a method-returned RpcTarget has `Symbol.dispose` **even in pool-workers**; DO/service stubs never do, in any env.
- **H2 — Claude's doubted guess (test-harness stripping):** `cloudflare:test` wraps the DO namespace in a proxy (to support `runInDurableObject` etc.) that **strips `Symbol.dispose`**, so **real workerd** (`wrangler dev` + deployed) DO stubs **are** disposable and only pool-workers throws. **Prediction:** the same DO-stub probe gains `Symbol.dispose` under `wrangler dev`/deployed.
- **H3 — facets:** DO facet stubs behave like {DO stubs | RpcTargets} — TBD.

**The clean discriminator between H1 and H2:** run the *identical* DO-stub probe in `wrangler dev` and deployed. Gains `Symbol.dispose` there → **H2**. Still absent → **H1** (universal; pool-workers is faithful). The method-returned-RpcTarget probe in pool-workers is the second discriminator (RpcTarget disposable while DO isn't → strongly H1).

## What we ALREADY know (pool-workers, collected 2026-07-14 — don't redo)
Probed via a throwaway vitest test in `packages/nebula-auth` (`env` from `cloudflare:test`, top-level in the `it`, i.e. Worker context — NOT inside `runInDurableObject`):
| stub | `Symbol.dispose` | `Symbol.asyncDispose` | `constructor.name` | `using` throws? |
|---|---|---|---|---|
| `env.NS.get(idFromName)` | `undefined` | `undefined` | `DurableObject` | **yes** — "Object is not disposable." |
| `env.NS.getByName(name)` | `undefined` | `undefined` | `DurableObject` | **yes** — same |
| `env.SERVICE` (WorkerEntrypoint binding) | `undefined` | `undefined` | `Fetcher` | not tested, but no dispose |
| **method-returned RpcTarget** | — | — | — | **NOT TESTED — the key gap** |
| **DO facet stub** | — | — | — | **NOT TESTED** |

So in pool-workers, binding-level stubs (DO + service) have no `Symbol.dispose`. Consistent with **both** H1 and H2 so far; the untested rows + the other two environments decide it.

## Stub types to probe (each, in EACH environment)
1. DO stub via `env.NS.get(env.NS.idFromName(name))`.
2. DO stub via `env.NS.getByName(name)`.
3. **RpcTarget returned from a DO method** — e.g. a DO `@mesh`-free method `getCap() { return new MyCap(); }` where `class MyCap extends RpcTarget {}`; the caller holds the returned stub (our object-capability pattern, mesh.md § Object-capability). This is the "session" case.
4. **RpcTarget returned from a WorkerEntrypoint method** (same, via a service binding).
5. `env.SERVICE` (WorkerEntrypoint binding stub itself).
6. **DO facet stub** — confirm the current facets API first (likely `ctx.facets.get(...)` / a `facet()`-style call; verify against CF docs at run time), then probe the returned stub.

## Per-stub measurements
- `typeof stub[Symbol.dispose]`, `typeof stub[Symbol.asyncDispose]`, `stub?.constructor?.name`.
- `using x = stub` — does it throw? capture the message. (And `await using x = stub`.)
- **Behavior (the pointer-vs-session tell):** after a method call, let the stub go out of scope with NO `using`; then obtain a FRESH stub and confirm prior server state persists (DO) or the session is gone (RpcTarget). Distinguishes "local pointer, nothing to release" from "held session."
- **Wall-clock (stretch — question 3):** hold an idle stub across a measured delay and determine, via an **external observer** (NOT `Date.now()` inside the invocation — see the cf-clock-traps memory), whether the DO stays active/billed. Deployed-only if it needs real billing signal; a Tail Worker / AE or the DO's own alarm-liveness may approximate it. Mark clearly if inconclusive.

## Methodology / harness
Build `experiments/rpc-stub-disposability/` — one small Worker exposing a **`GET /probe`** route that runs every check above and returns a **JSON matrix** `{ stubType: { symbolDispose, symbolAsyncDispose, ctor, usingThrew, usingMessage } }`. Same probe code drives all three environments:
- **pool-workers**: a vitest test that hits `SELF.fetch('/probe')` (or imports the probe fn) and dumps the JSON. (Fills the two untested rows + re-confirms the known rows.)
- **`wrangler dev`**: `wrangler dev` the experiment Worker locally (real workerd), `curl localhost:<port>/probe`. Boots without extra flags; `pkill -9 -f workerd` between runs (workerd-zombie-hang memory).
- **deployed**: `wrangler deploy` a throwaway Worker (unique name), `curl` the `workers.dev` URL, then delete it. (wrangler-delete-leaves-do-data: dashboard-delete if DO storage must be wiped — here it's throwaway, fine.)

Register `experiments/rpc-stub-disposability` as an **individual** entry in the root `package.json` `workspaces`, `npm install`, run, capture, then prune the workspace entry + `git rm -r` when results are captured (workflow.md § Experiments).

## Deliverables
1. `experiments/rpc-stub-disposability/FINDINGS.md` — the full 6-stub × 3-environment matrix, the **resolved hypothesis** (H1 / H2 / mixed), the facet answer, and the wall-clock finding (or an explicit "inconclusive, because …").
2. **Correct the record everywhere the wrong inference leaked:**
   - the `reference_using_on_do_stub_not_disposable.md` memory (currently hedged to "open question — this experiment"; finalize it with the answer),
   - the `packages/nebula-auth/src/profile.ts` `lookupProfileScopes` comment,
   - `durable-objects.md` § Wall-clock billing — reconcile the `using stub` prescription with reality: is `using` on a DO stub correct? necessary? actively wrong (throws)? Update the example + the guidance accordingly, and note the RpcTarget-vs-DO distinction.
   - `raw-comm.md` § Raw Workers RPC — add the disposability note if warranted.
3. If the answer is H1 (DO stubs never disposable): a clear repo-wide rule that **`using` is for RpcTarget/WorkerEntrypoint session stubs, never DO stubs** — grep the repo for any `using` on a `.get(`/`.getByName(` DO stub and fix.

## Constraints / gotchas to heed (memories)
- **cf-clock-traps** — READ before any timing/billing measurement; `Date.now()` is pinned within an invocation; use an external observer.
- **workerd-zombie-hang** — `pkill -9 -f workerd` before pool-workers / wrangler-dev runs.
- **wrangler-delete-leaves-do-data** — `wrangler delete` keeps DO data; use a throwaway Worker + dashboard-delete if a true wipe is needed (not needed for a throwaway).
- Experiment hygiene — workflow.md § Experiments (tracked, individual workspaces entry, prune when done).

## Not in scope
- Fixing the profile-store code — it already dropped `using` for a plain `const` + `await`, which is correct under **every** hypothesis (works in all environments). This experiment only resolves the *explanation* + the general rule, and whether the wall-clock-billing guidance needs a rewrite.
