# Broadcast Tree-Path Result-Routing Fix (Option A)

**Status**: **ON HOLD** — sequenced after [nebula-do-scope-isolation.md](../archive/nebula-do-scope-isolation.md) (do that first)
**Origin**: Design review of `packages/mesh/src/broadcast.ts` + `lumenize-worker.ts` tier (session 2026-06-08). Filename retained from the superseded "Option B (origin transparency)" framing — see *Superseded approach* below.

## Objective

Fix the one real bug: in `svc.broadcast`'s **tree path**, the drop-on-failed-fanout result handler is misrouted. Fix it **surgically** by carrying the broadcasting DO's identity as **data** into `__forwardBroadcastResult` and forwarding there — instead of inferring it from `callChain[0]`. Keep inheritance. **No `newChain`, no settable `originAuth`, no framework change, no Gateway change, no override removal.**

## The bug (unchanged)

`LumenizeWorker.__forwardBroadcastResult` ([lumenize-worker.ts:312-324](../../packages/mesh/src/lumenize-worker.ts#L312)) forwards the per-target result to `this.lmz.callContext.callChain[0]`, with a comment claiming that is "the originating DO." It isn't. `svc.broadcast` inherits the chain, so `callChain[0]` is the **origin of the whole chain** — for the production mutation path, the **mutating client**, not Star (see `Star.transaction`/`subscribe` reading `callChain[0].instanceName` as the clientId, [star.ts:217](../../apps/nebula/src/star.ts#L217)). So a tree-path `ClientDisconnectedError` is forwarded to the *client*, where Star's `onBroadcastResult` doesn't exist → **drop-on-failed-fanout silently never runs**. The **direct path is correct** — its `onResult` runs locally on Star and never routes by `callChain[0]`. Untested: the only cleanup test (`nebula-client-disconnect-cleanup.test.ts`, 2 clients) exercises the direct path only.

## Approach (Option A)

Carry the origin DO's identity as data, exactly as `remote`/`onResultChain` already are:
- **`broadcast.ts` (tree path):** pass `{ bindingName: doInstance.lmz.bindingName, instanceName: doInstance.lmz.instanceName }` as an argument into `__broadcastTier`.
- **`lumenize-worker.ts`:** thread that origin identity through `__broadcastTier`'s recursion into the leaf's `__forwardBroadcastResult` continuation; `__forwardBroadcastResult` forwards to **that identity**, not `callChain[0]`.
- **Direct path:** unchanged.

Why this is sufficient — and why nothing else is needed:
- **Push auth keeps working on both paths via inheritance.** Per the D7 finding (`aud` is structurally the star), the *mutator's* inherited `aud` already equals *every subscriber's* `aud`, so `NebulaClientGateway.onBeforeCallToClient`'s `aud === aud` check passes on both direct and tree paths with no stamping.
- **The forwarded `onBroadcastResult` lands on Star.** The tier worker's forward inherits the chain (`originAuth.aud = mutator's = star`), so Star's `NebulaDO.onBeforeCall` accepts it.

## Superseded approach — Option B, and why we dropped it

Option B made Star the chain origin (`newChain: true`) and stamped a scope-only `originAuth`, to also deliver "transparency," a security tightening (delete `NebulaClient.onBeforeCall`), and mutator-hiding. The 2026-06-08 review (workflow `wol29sgsv`) killed it:
- **Forgery primitive (blocker).** A settable `originAuth` on `CallOptions` lets *any* DO mint a forged `{ access: { admin }, aud }` that downstream authorizers (`requireAdmin`, `DagTree.requirePermission`, `NebulaDO.onBeforeCall`, `onBeforeCallToClient`) trust verbatim — `executeEnvelope` installs `callContext` with zero re-verification. It breaks the mesh invariant "**`originAuth` is minted only at verified ingress (the Gateway)**." `newChain` itself is fine (it produces `originAuth: undefined`, truthful + fail-closed); *settable `originAuth`* was the hole.
- **push-on-clear regression (blocker).** Removing `NebulaClient.onBeforeCall` breaks the deploy-time stale-ontology push ([star.ts:176-182](../../apps/nebula/src/star.ts#L176)), which dispatches via a dynamic `subscriberBinding` to a *non-originating* subscriber while the chain carries the installing client at `callChain[0]` — the restored base peer guard would reject it.
- **D7 refutes B's premise.** Since `aud` is structurally the star, the mutator's inherited `aud` already matches every subscriber — so B's scope-stamping solved a problem that can't occur. Option A is strictly simpler and carries none of the security baggage.

(The other documented alternative — revert the tier, hard-cap fanout at ~N via the direct loop — remains available if the tier is ever deemed not worth its complexity. Not this task.)

**Retained from B:** the middle `LUMENIZE_BROADCAST_TIER` hops stay in `callChain` (harmless; useful for "works direct, fails through tiers" debugging). Everything else B-specific (newChain, scope stamping, `OriginAuth.sub?`, `CallOptions.originAuth`, Gateway change, override removal) is **dropped**.

## Implementation phases

### Phase 0 — Test-first: prove the bug (RED on current main)
- [ ] **A1** written and **confirmed RED on `main`**. Prereq (per review finding): the baseline test app must host a real `LumenizeWorker` tier — its default export is a plain handler object, not a `LumenizeWorker` subclass, and `instrumentDOProject` drops class methods, so "bind the tier to itself" won't expose `__broadcastTier`. Add a named `LumenizeWorker` subclass (mirror `apps/nebula/test/browser/worker/bench-fanout-tier.ts`), export it by name, and register it under `LUMENIZE_BROADCAST_TIER`. Force the tree path with `STAR_BROADCAST_DIRECT_THRESHOLD=0` ([star.ts:523](../../apps/nebula/src/star.ts#L523)).
- [ ] **A2** written (tree-path success delivery) — passes now, must keep passing.

### Phase 1 — Carry origin identity through the tier
**Goal**: `__broadcastTier`/`__forwardBroadcastResult` take the origin DO identity as data; the forward targets it, not `callChain[0]`.

### Phase 2 — Tests green
**Goal**: A1 GREEN, A2 GREEN, plus A3/A4 below.

### Phase 3 — Verify
**Goal**: full suites green; `type-check` clean; rewrite the `__forwardBroadcastResult` JSDoc ("forward to the data-carried origin identity, not `callChain[0]`"); fix the `nebula-client-disconnect-cleanup.test.ts` header (already done in the 2026-06-08 session).

## Test matrix (capable-of-failing)
- **A1 — Tree-path cleanup lands on Star** (RED→GREEN). `directThreshold:0`, 2–3 subscribers, one disconnected past grace; mutate; assert the disconnected `Subscribers` row is dropped. Fails on `main` (forwarded to `callChain[0]` = client).
- **A2 — Tree-path success delivery.** Connected subscriber receives `handleResourceUpdate` through the tier; its row is not dropped.
- **A3 — Recursion depth ≥2 levels** (review finding #5). Force multiple tier hops (`branch:2` + 5–7 subscribers, or default `branch` + ≥7): assert (a) cleanup still lands on Star after middle hops, and (b) inherited `originAuth.aud` survives to the leaf. This is what actually proves the middle hops are harmless at depth.
- **A4 — Reconnect-during-grace over-cleanup race** (review finding #8). Subscriber disconnects, then reconnects (same clientId) within grace; mutate; assert the row is NOT dropped and the update is delivered. Guards the "no spurious cleanup" claim against the reactive race.

(The B/C/D/G scope-and-security tests from the prior draft are dropped — Option A changes no scope/auth behavior.)

## Related
- [nebula-do-scope-isolation.md](../archive/nebula-do-scope-isolation.md) — **do FIRST.** Same trust/scope model, surfaced in the same review. Not hard-coupled to this fix, but higher priority; this task is on hold behind it.
