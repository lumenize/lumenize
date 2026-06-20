# Think ↔ Nebula Integration (multi-tenant fit)

**Status**: **On-hold — Think was evaluated and NOT adopted for Studio** (2026-06-16). Studio runs Kimi 2.7 via Workers AI + a thin native-tool-calling loop, no Think (`tasks/kimi-ui-gen-viability.md` § Decided stack), so this file's multi-tenant-containment analysis is shelved. Its kernel — containing per-tenant agent DOs/facets within Nebula's scope isolation — may resurface, **reframed away from Think**, for the post-Studio in-app AI chat context. Original analysis preserved below; production hardening was in `tasks/on-hold/shim-hardening.md` (also shelved).

**Decision context**: `tasks/archive/think-vs-cma-bakeoff.md` + `experiments/think-vs-cma/results/RESULTS.md` (decision = Think/Kimi+codemode). Model/eval strategy + vibesdk pattern input: `tasks/nebula-agentic-development-engine.md` (the codegen + eval engine, incl. the vibesdk reading task).

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

1. **Confinement & verifiability** (the security crux). Confirm the in-DO client confers **no more authority than the user's real token**, confined to their scope by the *same* guards a browser client hits: `verifyNebulaAccessToken` → Gateway mints `originAuth` from the verified JWT → `onBeforeCall` scope-lock + DagTree `requirePermission`. Negative case: a scope-A token can't reach a scope-B Star. The verifiability claim (refined in the findings below): identity is derived from a token whose signature was verified **at connect**, minted into `originAuth` the client can't spoof, expiry-checked per call.
2. **Think DO footprint & tenant containment.** Empirically enumerate every DO Think instantiates in a realistic Studio session (Agent DO, codemode isolates, any sub-agent/schedule/Workflow DOs — most were "dead weight for Studio" in the bakeoff, but verify). For each: is it fine as-is (single-user, no cross-tenant data), does it need the parked `<scope>:<local>` scoped-helper-naming grammar revived (`tasks/on-hold/nebula-scoped-helper-naming.md` — this work is its most likely trigger), or should it be replaced by a Nebula-owned DO?
3. **Long-stream / turn durability.** DOs evict ~1–2×/day (+ deploys) — any severs an in-flight stream. Instrument turn durations in a real generation loop, force a mid-turn eviction, and verify Think's resumable-stream/fiber recovery (`chatRecovery = true`) holds for multi-minute turns. Most Studio turns are short, so likely dodged — but verify.
4. **Memory plug: Star/Galaxy as the session store.** The Studio plan says "Galaxy hosts chat session state" (`tasks/nebula-studio.md` § Architecture), but Think defaults to owning session memory in its Agent DO's SQLite. Probe how pluggable `agents`/`@cloudflare/think` persistence is. Decide **plug vs. accept**: redirect Think's store into Nebula, or let Think keep *chat-history-only* in its DO with Resources canonical (the likely answer — but verify the seam, especially survival across a dev-Star reset and where Studio chat history truly belongs). Does plugging cut against the grain?
5. **Architectural decision: keep the WS-shim, or delete it** via a Nebula-side result-returning-transaction RPC for trusted in-deployment callers? Verifiability is the tiebreaker — the WS-shim derives identity from a signed token (signature verified at connect; see findings), keeping the trust boundary at the Gateway (arguably *more* verifiable); a direct RPC shifts trust into the caller (the DO asserts identity itself). **First-pass finding: keep the shim.** Confirm and write the rationale; the implementation lands in `shim-hardening.md`.

## Token lifetime in the DO (decision needed, implemented in hardening)

A long authoring session exceeds the ~900s access-token TTL. Is "a DO holding the user's token to act on their behalf" the accepted server-side-session pattern (Larry to confirm)? Refresh strategy + exposure surface are implemented in `shim-hardening.md` task 3.

## Key files to read fresh (main repo)

`packages/mesh/src/{lumenize-client-gateway.ts,lmz-api.ts}` (where `originAuth` is minted from the verified JWT); `apps/nebula/src/nebula-do.ts` (`onBeforeCall` scope-lock, `requireAdmin`); `apps/nebula/src/dag-tree.ts` (`requirePermission` + admin-bypass); `apps/nebula/src/entrypoint.ts` (`verifyNebulaAccessToken`); `packages/nebula-auth/` (JWT mint/verify, two-scope model). Plus the shim files in the worktree.

## First-pass findings (2026-06-16 — against `@cloudflare/think` 0.8.3 / `agents` 0.14.2, pre-bump; re-confirm after the 0.8.4/0.14.3 bump)

**Q1 — Confinement holds, caller-agnostic.** Trace: token in `Sec-WebSocket-Protocol` (`fetch-ws.ts:39-41`, same as a browser) → signature verified **once at WS upgrade** (`entrypoint.ts:45` `verifyNebulaAccessToken`: sig + `iss` + `aud`/`sub` + `access.authScopePattern` + `matchAccess(pattern,aud)`) → Gateway mints `originAuth` from the **verified attachment**, replacing anything the client sent (`lumenize-client-gateway.ts:534-546`) → `onBeforeCall` structural scope-lock (`nebula-do.ts:47-81`; hard cross-tenant boundary at **`:78`** `matchAccess(pattern, aud)`) → DagTree `requirePermission` (`dag-tree.ts:152-163`). Nothing distinguishes a Think DO from a browser → an in-DO client holding U's scope-S token confers no more authority than U in S.
- ⚠️ **Wording refinement** (applied above in Q1/Q5): per-call the Gateway **decodes the attachment + checks `exp` only**, no fresh signature check (`lumenize-client-gateway.ts:213`). Precise claim = "identity from a token whose signature was verified at connect and hasn't expired" — still materially stronger than direct-RPC self-assertion.

**Q2 — DO footprint: one `DurableObject` base** (Think→Agent→Server→DurableObject). `StudioThinkAgent` is a single DO namespace, **not** `LumenizeDO`, **no Nebula scope isolation**. Components: sub-agents = **facets of the same namespace** (no extra binding, no isolation); scheduling = the Agent's **own DO alarm** (in-DO); codemode = a **Worker-Loader isolate, not a DO** (sandboxed, `globalOutbound:null` in the bake-off); Workflows/MCP = separate bindings **only if wired** (no isolation if used). **Studio (single dev-user): small** — ~one Agent DO/session, no cross-tenant data → "fine as-is"; the Studio problem reduces to in-DO confinement (Q1). **In-app AI (many end-users): where it bites** — Agent DOs sit outside Nebula's scope model; revive the parked `<scope>:<local>` grammar (`tasks/on-hold/nebula-scoped-helper-naming.md`) or make them Nebula-owned DOs. Not a Studio blocker.

**Q3 — Durability: resumable stream chunks + chat-recovery fiber**, both persisted to the **Agent's own DO SQLite**, resumed on the next alarm (`chatRecovery=true` default). Budgeted (MAX_ATTEMPTS=10, 24h); on exhaustion → a terminal "could not recover" banner (typed error, not a silent hang). **Gap:** an in-flight server-tool `execute()` at eviction is **not re-run** — it's flipped to an errored tool result so the model proceeds. Studio's short turns likely dodge it; still worth forcing a mid-turn eviction to characterize the in-flight-tool edge.

**Q4 — Memory IS pluggable.** First-class `SessionProvider` interface (getMessage/getHistory/appendMessage/…); a shipped `PostgresSessionProvider` proves a non-DO backend works. Override seam: `Think.configureSession` (or pass a custom `SessionProvider` to `Session.create`). **Caveat that decides plug-vs-accept:** only the **message-history** layer is behind `SessionProvider`; the **durability machinery** (fibers/runs/schedules/resumable-stream chunks — Q3) is hardwired to the Agent's own DO SQLite, no provider seam. So we *can* relocate chat history to Galaxy, but the recovery/stream tables stay in the Agent DO regardless. → **Leaning: accept** (chat-history in the Agent DO, Resources canonical in Nebula) is lower-friction; plugging is feasible but cuts against the grain, and a dev-Star reset never touches the Agent DO's recovery state anyway.

**Q5 — Keep the WS shim.** It keeps the trust boundary at the Gateway (identity from a signed token, reusing `onBeforeCall`/`requirePermission` with zero new bypass surface); a direct result-returning RPC would move identity assertion into a DO that carries none of Nebula's scope machinery (Q2). More verifiable → keep.

**Cross-cutting (homed in `shim-hardening.md`):** `in-do-executor.ts:38-57` + `transport-probe.ts:32-50` hold the real `JWT_PRIVATE_KEY_BLUE` *signing* key in-DO and forge admin tokens offline; the mint branch fires on any falsy token → must be quarantined out of prod builds.

**Open / undeterminable from code:** the real-deployment **origin of the user's token inside the Agent** (the bake-off drove it via direct DO RPC, the token passed by an external driver) — so the token-lifetime/refresh question is unanswerable from current code; re-confirm everything after the 0.8.4/0.14.3 bump; `studio-think-agent.ts`'s header comment ("NOT codemode") is stale — the live wiring IS codemode.
