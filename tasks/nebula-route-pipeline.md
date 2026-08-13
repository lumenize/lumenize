# The route pipeline helpers

> 🚧 **STUB — a holding pen, not a designed task file.** It exists only so decisions made while editing `docs/vision/auth.md` and [nebula-registry-route-guards.md](nebula-registry-route-guards.md) have somewhere to live instead of evaporating. ⚠️ **It has had no `/write-task`, no design-intent pass and no review, and it MUST NOT be built from.** Phases and acceptance criteria are deliberately absent rather than pending.
>
> ⚠️ **This violates `tasks/README.md`'s one-child-at-a-time rule and the never-pre-create-stubs agreement — deliberately, authorised by Larry 2026-08-13.** The alternative was losing settled decisions or parking them in a sibling that does not own them. When this becomes real work it goes through `/write-task` from the top; nothing below is a substitute for that.

**What it will cover:** the hono-like helpers that run a route's ordered step list — the mechanism under [nebula-registry-route-guards.md](nebula-registry-route-guards.md)'s pipeline table, which pins the *shape* and leaves the machinery unbuilt. `docs/vision/auth.md` § *Coarse-grained access control* describes the behaviour those helpers must produce (R1–R7), mechanism-neutral, so this file chooses the mechanism and nothing else.

## Decisions already made

| Decision | Rejected alternative — why |
|---|---|
| **The threaded value is `routeState`** — `{ scope, claims }` | `ctx` / `context` — already two meanings in this repo (`this.ctx` is `DurableObjectState`, 103 uses; `callContext` is mesh's, 138), and a third repeats the ambiguity ADR-015 spent a rename ending. Also rejected: `verified`, which reads well at guard sites but names the bag for its *provenance*, so anything later steps add that nobody verified becomes a lie. `state` follows `callContext.state`, the repo's existing name for a value threading a long call chain. |
| **`env` is not in `routeState`** | Threading it — `routeState` holds what steps *establish*; `env` is ambient and identical on every request. It is importable from `cloudflare:workers` (`packages/debug/src/index.workerd.ts` already does). ⚠️ **Two things to verify before relying on the import**: `router.ts` today takes a widened `Env & { NEBULA_AUTH_RATE_LIMITER?: RateLimit }` (`:343`, `:374`) that the bare import does not give — see `packaging.md` § *Cross-platform `cloudflare:workers` detection*; and whether the import reflects vitest-pool-workers' `miniflare.bindings`, which is where test-mode flags live by rule. |
| **Step ordering is enforced by the TYPE, not by the name or at runtime** | hono's `c.set` / `c.get` bag — a string-keyed lookup can only ever promise `T \| undefined`, so "did `verifyJwtGuard` run first?" stays a runtime property. With `claims` non-optional on the guard-facing shape and only the verify step able to produce it, **a guard placed before verify does not compile.** ⚠️ The runtime failure this avoids is not cosmetic: `isAtOrBelow(access.authScope, node)` throws at `.endsWith` on an absent `access`, and `router.ts`'s blanket catch turns that into a **500 where a 403 belongs**. |

## Open questions

- **Array literal vs builder chain.** The array is what makes a route auditable — you read the row and see every check — but threading types through a heterogeneous array needs tuple / recursive conditional types. A builder chain (`.use().use()`, hono's actual shape) threads types naturally and stops looking like a table. A middle path worth trying first: keep the array and let the ordering guarantee fall out of **constructibility** — guards take the shape with `claims` non-optional, and only the verify step produces one, so a mis-placed guard has no valid argument.
- **Adopt hono, or write the helpers?** [backlog.md](backlog.md) § *Nebula Auth* carries the row: `raw-comm.md`'s threshold (a dozen routes and/or significant middleware needs) is **met**, and the route list transfers directly because the pipeline is already hono-shaped. Deferred for sequencing, not merit. ⚠️ Whichever wins, **measure the startup cost first** — `nebula-auth` fronts the Registry singleton and a DO pays for its Worker's whole import graph (`workflow.md` § *Startup cost is the criterion*).
- **The `*Guard` suffix is applied inconsistently today.** `coding-style.md` § *Guard naming* requires it of any step that returns a `Response` to refuse. `auth.md`'s worked example spells `rateLimitGuard` / `verifyJwtGuard`; the sibling's pipeline table spells bare `verifyJwt` / `rateLimit`. One of the two moves, and the rule says which.
- **Does the helper live in Nebula, or become a package?** Not examined. Nothing depends on the answer yet.

## Relationships

- **Mechanism for** [nebula-registry-route-guards.md](nebula-registry-route-guards.md) — that file pins the pipeline table, the guards and their operands; this one is how a step list actually runs. It can build without these helpers (its table is expressible by hand), so this is not a blocker.
- **Conforms to** [`docs/vision/auth.md`](../docs/vision/auth.md) § *Coarse-grained access control* R1–R7, which is `accepted` and mechanism-neutral by design.
