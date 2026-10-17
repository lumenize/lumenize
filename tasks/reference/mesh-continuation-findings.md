# Mesh continuation-only calls — Phase 1 findings (the exploratory record)

Captured 2026-07-03 during `/build-task` on [`mesh-continuation-only-calls.md`](../mesh-continuation-only-calls.md). This is the criterion-12 findings note: the mechanics that worked, the discoveries, and what is (and isn't) confirmed by which harness.

## The load-bearing premise — CONFIRMED (pool-workers)

D15's premise (if false, the "no per-node-type `waitUntil` branch" breaks and must feed back before Phase 2):

- **A DO early-acks, does a REAL 2s post-ack gap, and the fire-back STILL lands.** `DurableObjectState.waitUntil(postAck)` keeps the DO alive across the detached post-ack chain + fire-back. (`continuation-only-feasibility.test.ts` → "DO-liveness (criterion 10)", 2033ms.)
- **Early-ack is real, not late-ack.** `__executeOperation` returns `{$ack:true}` BEFORE the chain finishes — a `slowEcho`'s completion marker is still absent right after the ack.
- **ALS/`callContext` survives the detached post-ack task.** `executeEnvelope` re-binds via `runWithCallContext(envelope.callContext, async () => …)` around the chain+fire-back (a fresh scope, not a captured closure). The handler at the sink observes the propagated response-leg callChain (length ≥ 2).
- **Interleaved early-ack calls stay isolated.** 5 concurrent calls, each handler receives its own result. Works because Workers RPC serializes each envelope **synchronously** at the `stub.__executeOperation(envelope)` call site inside the caller's loop, so a shared-reference `callContext.state` snapshots per iteration.

**Caveat:** pool-workers does NOT hibernate/evict a DO mid-invocation, so this confirms the *mechanism* (a 2s detached `waitUntil` tail fires back) but not survival across a *real* eviction. True-eviction timing is a production observation; if a DO were evicted mid-post-ack the fire-back would be lost — that is exactly the deferred guaranteed tier's (`callDurable`) domain, not best-effort. The browser e2e + container run (below) are the real-`workerd` confidence for the wire/bundle/seam paths.

## Discoveries (non-obvious things that shaped the build)

1. **A caller must `ctx.waitUntil` its OWN dispatch.** A fire-and-forget `call()` fired from an invocation that then *returns* gets its outbound RPC **cancelled** — the ack (and thus the callee's whole run) never happens. In production a `call` always runs inside a mesh invocation already kept alive by the callee's post-ack `waitUntil`; the gap is only direct-stub test initiators and multi-hop callbacks (a callee firing an onward call from its own post-ack tail). Fix: `callShared` `waitUntil`s the dispatch promise for **all** node types (matches the memory's "unify `waitUntil` in the substrate" refinement). Found via the two-one-way callback test going silently dead.

2. **A caller's `bindingName` must be a REAL, resolvable binding.** The callee fires back to `env[returnAddr.bindingName].getByName(returnAddr.instanceName)`. The old local-handler model tolerated a fabricated caller binding (e.g. tests using `CALLER_DO`); the traveling model does not. Holds automatically in production (identity comes from real routing) — but it's a migration/doc note (Phase 3), and it broke ~6 existing `call()` tests that used fake identities.

3. **@mesh-block and method-throws are now POST-ack, not on the ack.** The @mesh allowlist + guard + the method body all run in `executeOperationChain` *after* the early ack. So a non-@mesh call or a thrown Error no longer returns `{$error}` from `__executeOperation` — it rides the **fire-back** (4-arg) or is **logged** ("post-ack chain threw", 3-arg / no-response). Admission failures (version/callContext/identity/`onBeforeCall`/`requirePassage`) still return `{$error}` on the ack. This split changed how the container-seam + scope tests observe rejects (debug-sink for post-ack, `{$error}` for admission).

4. **`{$ack:true}` is the admission-success shape.** No `{$result}` ever comes back from a mesh node's `__executeOperation`/`__handleResponse` — results are delivered by fire-back (DO/Worker), re-resolved RESULT (client), or discarded (3-arg). Every hand-built-envelope test asserts `{$ack:true}` on admit.

5. **Self-inflicted lesson:** an Edit that dropped the `const dispatchPromise = …` line made it *look* like DO-caller `ctx.waitUntil` was broken (everything went red). When a change makes *everything* red, suspect the mechanical edit before the hypothesis.

## Confirmed by harness

| Harness | What it confirms | Result |
|---|---|---|
| pool-workers (`main` + for-docs) | the whole DO/Worker/Container/client/Gateway mechanism | 398/398 green |
| pool-workers (`container`) | LumenizeContainer composition (seam mirrors the new recipe) | 14 pass / 1 skip |
| pool-workers (`baseline`, nebula) | `requirePassage` gates the RESPONSE door (D5, mutation-validated) | 7/7 green |
| real chromium + wrangler-dev (`browser`) | client leg over a real WS: subscribe → save → broadcast → direct-delivery | 4/4 green |

### Browser e2e (real client leg) — CONFIRMED

The `getting-started` e2e (`ws-roundtrip-browser.test.ts`) drives the documented `EditorClient` through a real `wrangler dev` from real chromium: magic-link login → subscribe (initial content) → `saveContent` → the DocumentDO broadcasts back AND the SpellCheckWorker direct-delivers findings straight to the client. All of that is the D16/D17 client leg (the client makes calls + receives pushes over one re-resolvable WS). **4/4 green.** (First run failed at the magic-link *email* round-trip — `auth-bootstrap.ts` "No email received", a cold-start of the external Cloudflare Email Sending/Routing path, BEFORE any client-leg code; passed on immediate re-run in 5s. Per `testing.md`, first-run-after-idle on an external service is a cold start, not a bug.)

### Not covered here (deferred, per task scope)

- **Container-callee long-4-arg** (`awaitPreviewReady`, DevStudio→Container): can't run under pool-workers; the fire-back is the *same* shared `executeEnvelope` mechanic the DO/Worker proof + container seam already cover. Deferred to the Phase-2 container sites (`wrangler dev` + Docker).
- **`packages/fetch`**: still calls `callRaw` → breaks at runtime; its best-effort adapt is Phase 2.
- **onBroadcastResult subscriber-drop (full nebula path)**: the mesh side (a 4-arg call to a disconnected client delivers `ClientDisconnectedError` to the handler) is covered; `Star.onBroadcastResult`'s row-drop logic is unchanged by this refactor and rides the same D6 tier-2 routing — full re-verification is Phase-2 nebula.
