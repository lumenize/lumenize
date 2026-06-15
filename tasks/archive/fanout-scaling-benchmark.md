# Fanout Scaling Benchmark

**Status**: **COMPLETE — archived 2026-06-10.** Blog-publish flip carried to `tasks/backlog.md` § Website. Originally:

**Status (2026-06-06)**: Phases 1–5b complete. Framework primitive `svc.broadcast` v1 + v2 shipped in `@lumenize/mesh`, Star adopted, apples-to-apples deployed comparison numbers in [apps/nebula/test/browser/RESULTS-fanout-comparison-deployed.md](../../apps/nebula/test/browser/RESULTS-fanout-comparison-deployed.md). **Phase 6 — blog post 2e drafted** at [website/blog/2026-06-06-scaling-durable-object-broadcast/index.md](../../website/blog/2026-06-06-scaling-durable-object-broadcast/index.md) (`draft: true`). Exp 1 (alarm-defer) closed inconclusive — see post §"The residual to Agents" for why a sidecar-DO version is the cleaner experiment design. Remaining: flip draft → published when ready.

## Headline findings

**1. Cloudflare Agents naive broadcast is fast and flat.** ~150 ms median e2e across N=10 → N=1000 on real CF, zero errors. The Discord folklore "6-to-1000 fanout limit" doesn't manifest as a delivery wall at the naive `ws.send` primitive; it's a tail-latency story, not a hard cap.

**2. Lumenize's flat per-subscriber `lmz.call` loop degrades super-linearly above N≈250.** At N=1000 the pre-broadcast `Star.#fanout` had p50 1,746 ms, p99 4,739 ms, max 5,418 ms. Cause: every `lmz.call` initiates an outbound Workers RPC subrequest that holds a slot in a small per-host concurrency window; the tail subscribers wait through ~166 queue cycles.

**3. The fix is a recursive Worker tier, branching factor 6.** Workers RPC's per-isolate cap on concurrent outbound subrequests is ~6 per binding namespace. If each tier node fans out to ≤6 children, no node queues. At N=1000 the recursive tree delivers in p50 743 ms, p99 1,204 ms, max 1,262 ms. Workers cold-start is ~5 ms vs DO cold-start ~100-300 ms, so the tier nodes are Workers (not DOs) — that choice eliminated a wide tail-variance band we saw earlier with a DO-helper-based 2-tier variant.

**4. Architectural punchline — the Gateway pattern is what makes the tree feasible.** A state-holding DO that also owns the WebSockets can't delegate to tier-2 helpers because the helpers can't reach a client whose WS is bound to a different DO. The Discord audience's instinct "add fanout helpers" *architecturally requires the Gateway pattern* — splitting state from per-client-WebSocket DOs is exactly what gives the tier helpers something to call. Tree fanout isn't a fundamentally different architecture from Gateway 1:1; it's Gateway 1:1 with K-way batching at the dispatch tier. Naive same-DO can't do tree at all.

**5. Lumenize Resources transaction with `svc.broadcast` v2 at N=1000**: p50 790 ms / p99 2,677 ms / max 2,702 ms — about 2× slower than Agents on median but with three architectural properties Agents can't match: per-client Gateway DOs (per-client auth state), DAG-permission-checked subscriber lists, and now drop-on-failed-fanout cleanup via the v2 `onResult` handler.

## Phase progress

- ✅ **Phase 1** — single-subscriber baseline. Local: ~1.3 ms commit, ~1.3 ms e2e. Deployed: ~60 ms commit, ~60 ms e2e.
- ✅ **Phase 2** — fanout-arrival instrumentation via `HarnessNebulaClient.handleResourceUpdate` override + `waitForFanoutArrival(eTag)`. No `InstrumentedStar` needed — client-side override + originator-pre-generated `newETag` correlator was sufficient.
- ✅ **Phase 3a** — `BenchAgent` deployed alongside Nebula DOs in the bench worker, routed via `routeAgentRequest`. Compat flag changed `nodejs_compat_v2` → `nodejs_compat` to satisfy a transitive `node:os` import from agents/mimetext. `AgentsHarnessClient` wraps `AgentClient` from `agents/client`; passes `protocol: 'wss'` explicitly because PartySocket forces `ws://` for any `127.0.0.1:` host but wrangler dev runs HTTPS.
- ✅ **Phase 3** — both patterns measured across N=10/50/100/250/500/1000 deployed.
- ✅ **Phase 4** — diagnosis: Lumenize without broadcast has wide variance at high N whose worst-case is unusable; queueing is the mechanism.
- ✅ **Phase 5b (three variants)**:
  - DO 2-tree with K helpers and per-N K tuning — works but cold-start tail at N=1000 with K=64 hit p50 5,374 ms (each helper invocation paid DO cold-start).
  - Recursive Worker tier with branch=6 — eliminated the DO cold-start tail; p50 743 ms at N=1000.
  - Sweep of BRANCH ∈ {6, 7, 8} × `reverseAtOddDepth` ∈ {false, true}. BRANCH=6 was the most reliable; reverseAtOddDepth helped some N values, hurt others; not net positive across the ramp. Shipped as BRANCH=6 fixed, no rotation.
- ✅ **Phase 5b framework lift — `svc.broadcast` v1** (fire-and-forget):
  - New `packages/mesh/src/broadcast.ts` — registers `this.svc.broadcast(targets, remote, opts?)` via the NADIS service registry.
  - New `@mesh() __broadcastTier` on `LumenizeWorker` base — recursive tier with branch=6, accessed via convention service binding `LUMENIZE_BROADCAST_TIER`.
  - New public `continuationFromChain<T>(chain)` helper in OCAN — wraps a serialized chain back into a proxy that `lmz.call` accepts. (The tier receives chains over the wire; this lets it re-dispatch them.)
  - `Star.#fanout` renamed to `Star.#broadcast`, now calls `this.svc.broadcast(...)`.
- ✅ **Phase 5b framework lift — `svc.broadcast` v2** (per-target onResult):
  - `BroadcastOptions.onResult: Continuation` — partial continuation that the framework completes with the per-target result via the standard last-argument convention (no new placeholder mechanism, no chain manipulation by user code).
  - New `@mesh() __forwardBroadcastResult` on `LumenizeWorker` base — uses `replaceNestedOperationMarkers` to inject the result, then forwards to `callChain[0]` via a fresh `lmz.call`.
  - **Optimization**: `__forwardBroadcastResult` only forwards when `result instanceof Error`. Otherwise the success-path callbacks pile up on the originating DO's input gate at high N. Direct branch (≤ `directThreshold`) is unchanged — it fires `onResult` for both success and error via local 4-arg `lmz.call`.
  - `Star.onFanoutDelivered` renamed to `Star.onBroadcastResult(resourceId, result)`. clientId comes from `ClientDisconnectedError.clientInstanceName`, not a separate handler arg.
  - Mesh routing rule documented in `CLAUDE.md` (instanceName undefined ⇒ Worker, string ⇒ DO).
  - Documentation page at [website/docs/mesh/broadcast.mdx](../../website/docs/mesh/broadcast.mdx).
- ⏸️ **Phase 5a (bare-naive DIY broadcast)** — not done. Was conditional on Phase 4 motivating it; Agents was already the canonical naive example and a parallel DIY version would have added noise without adding new signal.
- ⏸️ **Phase 6 — blog post 2e** — pending. All data + a real shippable framework primitive in hand; the post can now link to `svc.broadcast` source as the artifact rather than describing a bench-only experiment.

## Final deployed comparison (3 commits per N, 2 warmups)

| N | Agents | Lumenize without broadcast | Lumenize with svc.broadcast v2 |
|--:|--:|--:|--:|
| 10 | 182 / 214 / 214 | 61 / 77 / 77 | **47 / 58 / 58** |
| 100 | 137 / 176 / 229 | **142 / 243 / 293** | 151 / 254 / 336 |
| 250 | **158 / 181 / 182** | 296 / 522 / 581 | 317 / 590 / 640 |
| 500 | **144 / 154 / 274** | 652 / 1161 / 1230 | 614 / 2811 / 2843 |
| 1000 | **148 / 291 / 429** | 1746 / 4739 / 5418 | **790 / 2677 / 2702** |

Format: `p50 / p99 / max` end-to-end ms. Bold = winner of the Lumenize-side pair (B vs C); Agents shown for orientation since it's a different architecture.

## Open questions / follow-ups

- **Star's `onFanoutDelivered` no-op shim** is still in place for in-flight calls from before the deploy. Safe to remove after a grace window.
- **Optional `fireOn: 'always' | 'error'` flag on `BroadcastOptions`** — if a real user shows up needing success callbacks at the tree branch, the design accommodates it. Defer until there's a use case.
- **Bench file inventory** in `apps/nebula/test/browser/` includes `fanout.benchmark.ts`, `fanout-agents.benchmark.ts`, `fanout-tree.benchmark.ts` plus the harness clients. The `fanout-tree.benchmark.ts` (BenchBroadcaster / BenchFanoutTier) is now superseded by Star directly using `svc.broadcast`; it remains useful as a primitive-isolated measurement.

## Blog post 2e — outline (for Phase 6)

Working frame: *"How big can a Durable Object's WebSocket fanout get?"* Open with the Discord folklore (6-to-1000), walk through the head-to-head measurement, land the tree-fanout-requires-Gateway-pattern point, close with the `svc.broadcast` primitive as the productized artifact.

Suggested order:

1. **Discord folklore + setup.** "I keep seeing folks ask, with answers ranging 6 to 1000. Let's measure."
2. **Naive Agents broadcast scales fine.** Numbers from column A; partyserver's loop is in the post linked.
3. **Lumenize's prior 1:1 dispatch hits a tail-latency wall at high N.** Numbers from column B; explain Workers RPC subrequest queueing.
4. **What "tree fanout" actually means architecturally.** Tier helpers need targets they can reach; same-DO WebSocket holders can't delegate. So tree fanout architecturally IS the Gateway pattern with batching. Punchline.
5. **Shipping it as a framework primitive.** `this.svc.broadcast(targets, remote, opts?)` — link to docs and source. Mention the threshold so the post is honest about when the tree pays off.
6. **Closing comparison table.** All three columns with the v2 numbers. Acknowledge Agents still wins on raw median; Lumenize's win is in architectural properties (per-client auth, DAG perms, drop-on-failed-fanout) that Agents doesn't model.

Per [feedback_cf_community_framing](/Users/larry/.claude/projects/-Users-larry-Projects-mcp-lumenize/memory/feedback_cf_community_framing.md): if any Agents-side surprise reads as criticism, attribute naivety to me/the LLM, not to the partyserver/Agents authors. (None of the current findings are critical of Agents — naive broadcast IS the right primitive for its target audience.)

Cross-link from `website/docs/mesh/broadcast.mdx`, `website/docs/mesh/gateway.mdx` (subscriptions/fanout section), and from post 2d.

## Related

- [Star.#broadcast](../../apps/nebula/src/star.ts) — the production-path adopter.
- [packages/mesh/src/broadcast.ts](../../packages/mesh/src/broadcast.ts) — service factory.
- [packages/mesh/src/lumenize-worker.ts](../../packages/mesh/src/lumenize-worker.ts) — `__broadcastTier` + `__forwardBroadcastResult`.
- [website/docs/mesh/broadcast.mdx](../../website/docs/mesh/broadcast.mdx) — user-facing docs.
- [Piercing the temporal haze (2d)](../../website/blog/2026-05-09-benchmarking-cloudflare-durable-objects-from-outside/) — methodology post; this is post 2e in the same arc.
