# Spike: plain-DO + raw `ctx.container` (no `extends Container`)

**For:** `tasks/archive/nebula-galaxy-collapse-and-chat.md` Open **Q7** — should the collapsed `Galaxy`
node `extends Container` (→ loses `svc`) or be a plain `NebulaDO` that drives the build container
via the **raw `ctx.container` API** (→ keeps `svc.broadcast`/`svc.alarms`, uniformity, and — maybe —
pool-workers testability)?

CF documents `ctx.container` as available on **any** DO with a container binding ("use it when you…
cannot use the `Container` class") — so the *API* is blessed. This spike answers the two empirical
unknowns that decide whether the plain path is actually better:

1. **Q1 — construction under vitest-pool-workers.** The `[[container-no-construct-pool-workers]]` limit
   is documented for `extends Container`. Does a DO that merely *has a container binding* (and touches
   `ctx.container` only in methods, never the constructor) **construct** under pool-workers? If yes, the
   plain path **restores unit-testability** that `extends Container` forfeits.
   → `npm test` (or run vitest against this dir).

2. **Q2 — driving the container under `wrangler dev` + Docker.** Can a plain DO `start()` the container,
   `getTcpPort(8080).fetch()` it, and get a response — with **no** `Container` helper class? Proves the
   "~50–100 lines of lifecycle" claim is real, not hopeful.
   → `npm run dev`, then `curl localhost:8787/drive` (needs Docker Desktop).

**Hypothesis:** `extends Container` fails construction because *its constructor* touches container APIs
inside `blockConcurrencyWhile`; a plain DO that defers all `ctx.container` use to methods constructs fine.

Findings land in `RESULTS.md`. This is a throwaway spike (workflow.md) — not maintained after it answers Q7.
