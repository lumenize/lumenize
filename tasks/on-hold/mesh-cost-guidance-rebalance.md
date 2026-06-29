# Mesh cost guidance + `callRaw` docs rebalance

**Status**: on-hold, drafted 2026-06-19. Not demo-critical. Pick up during a docs pass (or when `website/docs/mesh/` is next touched).
**Why on-hold**: the `.claude/rules/mesh.md` rule file is already mostly balanced; the user-facing `website/docs/mesh/*.mdx` rewrite is the can-of-worms part and isn't urgent.

## Why this exists
`website/docs/mesh/` over-emphasizes **wall-clock billing** as a primary cost driver. Real Cloudflare bills show **DO SQLite storage writes ($1/M rows) dominate; wall-clock is negligible for fast calls** (a single write ≈ keeping a DO alive for ~seconds). The wall-clock bias predates that learning and shaped the original `call()`-vs-two-one-way framing.

Established this session (2026-06-19) by reading `packages/mesh/src/lmz-api.ts`:
- **`call()` is fire-and-forget, always.** `callShared` is a non-async `void` function ([lmz-api.ts:394](../../packages/mesh/src/lmz-api.ts)) — it never awaits `callRaw`. 3-arg = true fire-and-forget; 4-arg = fire-and-forget + an **async local result handler** (`setupFireAndForgetHandler`, [:192](../../packages/mesh/src/lmz-api.ts)). The caller never blocks on a return value. This was a deliberate change to "two one-way" semantics that (per Larry) shipped **without** the planned latency-vs-wall-clock benchmark.
- **`callRaw()` is the awaited request/response form** ([:325](../../packages/mesh/src/lmz-api.ts) awaits `__executeOperation`, returns `$result`) and is a **full mesh call** — callContext/identity propagate, errors pre/post-processed. "raw" = it accepts a raw operation chain, NOT raw Workers RPC. It also accepts a continuation (added later for convenience).

## What to change (when picked up)
1. **De-emphasize wall-clock** across `website/docs/mesh/*.mdx`. Storage writes dominate bills; for fast calls, awaiting (or a 4-arg handler keeping the DO alive) costs less than a single write. Reserve "two one-way / direct-delivery / alarm to shed wall-clock" for **genuinely long (multi-second) calls** or **true multi-hop direct-delivery**.
2. **Bless `callRaw` (continuation form) for single-hop result locality** — `await` the result and process it in the same method, which aligns with how LLMs are trained (don't fight `await` with docs). State plainly that `callRaw` is mesh, not raw RPC.
3. **Discourage the raw-operation-chain form of `callRaw`** unless genuinely rewriting the chain (e.g. `LumenizeClientGateway` DMZ proxying).
4. **Preserve the ADR-003 boundary**: single-hop `callRaw` await = transport (fine); awaiting `callRaw` hop-after-hop across a chain = the request/response-across-hops anti-pattern → continuations / direct-delivery.
5. **`.claude/rules/mesh.md`** (agent rule file — already balanced on wall-clock) just needs a short *call vs callRaw* note adding items 2–4. Cheap; can land ahead of the website rewrite.

## Investigations (double-taps)
- **Verify the workerd keep-alive behavior.** The comment ([:182-184](../../packages/mesh/src/lmz-api.ts)) says a 4-arg **success** handler "appears to keep the originating invocation alive until it settles" — empirical, mechanism unpinned. Hypothesis (Larry): keeping it alive avoids **persisting the pending continuation** across hibernation (a storage write); cheaper than a write for sub-second responses, more expensive only for multi-second waits. Confirm the behavior + the crossover; it's the basis of the `onErrorOnly` mitigation. **Data point (2026-06-19):** Cloudflare's [DO lifecycle diagram](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) lists the non-hibernatable (wall-clock-billed) triggers as `setTimeout`/`setInterval`, standard WebSockets, or **waiting on a `fetch()`** — *not* a bare open promise (so an open promise alone appears NOT to bill). Likely-reconciliation of "I thought Workers RPC bills": RPC rides the subrequest path, so it's probably already covered by "waiting on a `fetch()`." Treat the diagram as a possibly-curated subset; an experiment is the only way to be sure of the full set.
- **The never-run benchmark.** `call()`-as-two-one-way shipped without the planned latency-vs-wall-clock benchmark. Now low priority (writes dominate). If revisited, measure **multi-hop direct-delivery** latency (skip-the-backtrack), not single-hop result-back (the keep-alive comment already settles that in `callRaw`'s favor).

## References
`packages/mesh/src/lmz-api.ts` (`callShared`, `callRawImpl`, `setupFireAndForgetHandler`); [`.claude/rules/mesh.md`](../../.claude/rules/mesh.md); [ADR-003](../../docs/adr/); `experiments/interim-dev-loop` (uses `callRaw` for single-hop result locality — the proven pattern).
