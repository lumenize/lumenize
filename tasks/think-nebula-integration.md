# Think ↔ Nebula Integration (multi-tenant fit)

**Status**: Active — a prerequisite to planning Studio. Consolidates what was three threads (the shim security-review, the "what DOs does Think spawn / how do we contain them" question, and the "can Star/Galaxy be Think's memory store" question) into one. Production-grade hardening is split out to `tasks/shim-hardening.md` (for later, after the decisions here land).

**Decision context**: `tasks/archive/think-vs-cma-bakeoff.md` + `experiments/think-vs-cma/results/RESULTS.md` (decision = Think/Kimi+codemode). Model/eval strategy: `tasks/nebula-studio-llm-strategy.md`. Pattern input: `tasks/vibesdk-llm-patterns.md` (feeds prompt/agent-loop/tool/streaming shapes for whatever we build here).

**Pre-flight**: bump `@cloudflare/think` 0.8.3→0.8.4 and `agents` 0.14.2→0.14.3 before building on the harness (a DO write-cost win; rationale in `shim-hardening.md` § Pre-flight).

## The core tension

Lumenize/Nebula runs DOs in a **strict multi-tenant mode** (structural scope-from-instance-name in `NebulaDO.onBeforeCall` + DagTree `requirePermission` — `tasks/nebula-do-scope-isolation.md`). **Think creates DOs of its own** (an `Agent` DO per session, codemode isolates, possibly more) that don't carry those protections out of the box. This file is about learning, before we plan Studio, how Think's DO/memory footprint coexists with that guarantee.

> **Scoping reframe**: the "Think spawns DOs at will without our protections" risk bites hardest in the **in-app AI context** (apps user-developers ship → many *end-users* triggering AI). For **Studio** itself the footprint is small — roughly one Agent DO per (single) developer-user session — so the Studio-side problem is mostly *in-DO-client confinement*. Keep the in-app case in view here but don't let it block Studio.

## What's already settled (don't re-litigate)

- **The transport works.** A `@cloudflare/think` Agent DO extends CF's `Agent`, not `LumenizeDO` — no `this.lmz`, can't natively make authenticated mesh calls; and `Star.transaction`/`read` are fire-and-forget to a *connected Gateway client* (a forged direct-RPC caller never gets results). The bakeoff's fix — make the Think DO a real Gateway-connected `NebulaClient` from inside workerd via a fetch-upgrade WS shim + injected token — was **proven** (TransportProbe: minted JWT → in-DO client → register + transaction + read-back, all green).
- **Think session memory = chat history**, orthogonal to Resources, and cleanly resettable. The "two app-state stores fighting in one Star" fear largely dissolved.
- **The minted-JWT offline-forge path is TEST-ONLY** and must never reach production (it's god-mode impersonation for any scope). Hardening enforces this; treat it as a fixed constraint here.

## The shim, briefly

The artifact that survives the decision (worktree `.claude/worktrees/think-vs-cma`):
- `think/src/fetch-ws.ts` — `FetchUpgradeWebSocket` (workerd has no outbound `new WebSocket()`; token in `Sec-WebSocket-Protocol`).
- `think/src/in-do-executor.ts` — `createInDoExecutor(env, scope, accessToken?)` → in-DO `NebulaClient` + `ToolExecutor` (real token = prod path; omitted = TEST-ONLY mint).
- `cma/executor.ts` — `ExperimentClient` + the tool→Resources mapping.

## Open questions / learning goals

1. **Confinement & verifiability** (the security crux). Confirm the in-DO client confers **no more authority than the user's real token**, confined to their scope by the *same* guards a browser client hits: `verifyNebulaAccessToken` → Gateway mints `originAuth` from the verified JWT → `onBeforeCall` scope-lock + DagTree `requirePermission`. Negative case: a scope-A token can't reach a scope-B Star. The verifiability claim is that the Gateway verifies a *real signed token* every call.
2. **Think DO footprint & tenant containment.** Empirically enumerate every DO Think instantiates in a realistic Studio session (Agent DO, codemode isolates, any sub-agent/schedule/Workflow DOs — most were "dead weight for Studio" in the bakeoff, but verify). For each: is it fine as-is (single-user, no cross-tenant data), does it need the parked `<scope>:<local>` scoped-helper-naming grammar revived (`tasks/on-hold/nebula-scoped-helper-naming.md` — this work is its most likely trigger), or should it be replaced by a Nebula-owned DO?
3. **Long-stream / turn durability.** DOs evict ~1–2×/day (+ deploys) — any severs an in-flight stream. Instrument turn durations in a real generation loop, force a mid-turn eviction, and verify Think's resumable-stream/fiber recovery (`chatRecovery = true`) holds for multi-minute turns. Most Studio turns are short, so likely dodged — but verify.
4. **Memory plug: Star/Galaxy as the session store.** The Studio plan says "Galaxy hosts chat session state" (`tasks/nebula-studio.md` § Architecture), but Think defaults to owning session memory in its Agent DO's SQLite. Probe how pluggable `agents`/`@cloudflare/think` persistence is. Decide **plug vs. accept**: redirect Think's store into Nebula, or let Think keep *chat-history-only* in its DO with Resources canonical (the likely answer — but verify the seam, especially survival across a dev-Star reset and where Studio chat history truly belongs). Does plugging cut against the grain?
5. **Architectural decision: keep the WS-shim, or delete it** via a Nebula-side result-returning-transaction RPC for trusted in-deployment callers? Verifiability is the tiebreaker — the WS-shim makes the Gateway verify a real signed token every call (arguably *more* verifiable); a direct RPC shifts trust into the caller (the DO asserts identity itself). Pick one and write the rationale; the implementation lands in `shim-hardening.md`.

## Token lifetime in the DO (decision needed, implemented in hardening)

A long authoring session exceeds the ~900s access-token TTL. Is "a DO holding the user's token to act on their behalf" the accepted server-side-session pattern (Larry to confirm)? Refresh strategy + exposure surface are implemented in `shim-hardening.md` task 3.

## Key files to read fresh (main repo)

`packages/mesh/src/{lumenize-client-gateway.ts,lmz-api.ts}` (where `originAuth` is minted from the verified JWT); `apps/nebula/src/nebula-do.ts` (`onBeforeCall` scope-lock, `requireAdmin`); `apps/nebula/src/dag-tree.ts` (`requirePermission` + admin-bypass); `apps/nebula/src/entrypoint.ts` (`verifyNebulaAccessToken`); `packages/nebula-auth/` (JWT mint/verify, two-scope model). Plus the shim files in the worktree.
