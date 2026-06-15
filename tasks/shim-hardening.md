# Think→Nebula shim hardening

**Status**: Not started — kickoff for a new session.

**Background / analysis**: [`tasks/think-nebula-shim-security-review.md`](think-nebula-shim-security-review.md) (read first — it frames the design + multi-tenant-security questions). Decision context: [`tasks/archive/think-vs-cma-bakeoff.md`](archive/think-vs-cma-bakeoff.md) + `experiments/think-vs-cma/results/RESULTS.md`.

## Pre-flight: bump Think + agents before implementing
Sunil shipped a DO-write-cost optimization (Discord, 2026-06-06) claiming **20–80% lower DO costs** — gated on latest versions. We're one patch behind on both; bump before building on the harness:
- [ ] `@cloudflare/think` **0.8.3 → 0.8.4**
- [ ] `agents` **0.14.2 → 0.14.3**
- [ ] `@cloudflare/ai-chat` 0.8.3 — **N/A** (we don't depend on it; Think uses `@cloudflare/codemode`).

Note: this is a **DO storage/write** cost win, orthogonal to the bake-off's **model-token** cost numbers — it does NOT change the experiment results, but it's free savings once Studio runs on Think in production.

## Objective

Take the in-DO WS-client shim from "works in the bake-off" to "production-grade for Studio." The shim is the engineering artifact that survives the Think/Kimi+codemode decision; this task hardens it and answers Larry's two questions: **is it clean, and does it honor the Lumenize Mesh + multi-tenant security architecture in a cleanly verifiable way?**

## The artifacts under review (worktree `.claude/worktrees/think-vs-cma`)
- `experiments/think-vs-cma/think/src/fetch-ws.ts` — `FetchUpgradeWebSocket` (fetch-upgrade → `WebSocket` adapter; workerd has no outbound `new WebSocket()`; token in `Sec-WebSocket-Protocol`).
- `experiments/think-vs-cma/think/src/in-do-executor.ts` — `createInDoExecutor(env, scope, accessToken?)`: real token = prod path; **omitted = mints an admin JWT offline (TEST-ONLY)**.
- `experiments/think-vs-cma/cma/executor.ts` — `ExperimentClient` + `CmaNebulaExecutor` (tool→Resources mapping; shared by both arms).

Mesh/security files to read fresh (main repo): `packages/mesh/src/lumenize-client-gateway.ts` + `lmz-api.ts`, `apps/nebula/src/nebula-do.ts` (`onBeforeCall` aud-lock, `requireAdmin`), `apps/nebula/src/dag-tree.ts` (`requirePermission`), `apps/nebula/src/entrypoint.ts` (`verifyNebulaAccessToken`), `packages/nebula-auth/`.

## Tasks

### 1. Kill the minted-JWT path for production (highest priority)
**Goal**: production can NEVER forge a JWT. The offline-mint fallback in `createInDoExecutor` (signs an admin JWT with `JWT_PRIVATE_KEY_BLUE`) is a god-mode impersonation hole — it was a transport-probe convenience only.

**Success criteria**:
- [ ] `accessToken` is **required** on the production code path; no offline-mint fallback reachable outside tests.
- [ ] The signing key (`JWT_PRIVATE_KEY_BLUE` / any private key) is **not bound** to the agent DO's Worker project — it cannot forge tokens even if the code tried.
- [ ] If a mint helper is kept for tests, it lives behind a test-only boundary (separate module / test fixture) that the prod build cannot import.

### 2. Verify confinement: the Think DO confers no more authority than the user's token
**Goal**: prove the in-DO client acts **exactly as the user, confined to their scope** — same guards a browser client hits.

**Success criteria**:
- [ ] Trace presents-token → `verifyNebulaAccessToken` → Gateway mints `originAuth` from the *verified* JWT → `NebulaDO.onBeforeCall` aud-lock + `DagTree.requirePermission` (sub + admin-bypass). Confirm the agent caller is treated identically to a browser caller (caller-agnostic).
- [ ] Confirm **no cross-tenant path**: a token for scope A cannot reach scope B's Star (aud-lock holds end-to-end).
- [ ] A negative test: an in-DO client holding scope-A's token, attempting a scope-B Star operation, is rejected by the existing guards (not by shim-side logic).

### 3. Token lifetime + refresh in the DO
**Goal**: decide and implement how a DO holds the user's token across a long authoring session.

**Success criteria**:
- [ ] Documented decision: is "a DO holding the user's access token to act on their behalf" the accepted server-side-session pattern? (Larry to confirm.)
- [ ] Access-token expiry (~900s) handled for sessions longer than the TTL — refresh strategy or re-auth, no silently-dead connection.
- [ ] Exposure surface noted (where the token lives in the DO; not logged; not persisted beyond need).

### 4. Result routing + connection soundness
**Success criteria**:
- [ ] Confirm fire-and-forget result routing works for the in-DO client (clientId from token `sub`) and the Gateway's `onBeforeCallToClient` aud-check is sound for it.
- [ ] Confirm token-in-wss-subprotocol-over-TLS is acceptable.
- [ ] Confirm the live WS connection's reconnect timers don't leak / don't cause wall-clock billing surprises in an idle authoring DO.

### 5. Architectural decision: keep the WS-shim, or delete it?
**Goal**: explicitly compare the WS-shim against a **Nebula-side result-returning-transaction RPC** for trusted in-deployment callers (which would let the Think DO call the Star directly via a forged `originAuth` envelope, no WS client).

**Decision criteria** (verifiability is the tiebreaker):
- WS-shim: the Gateway verifies a **real signed token** every call → arguably *more* verifiable.
- Nebula-side RPC: the DO *asserts* the user identity itself (no per-call signature check) → simpler transport, but shifts trust into the caller.
- [ ] Pick one, write the rationale, and (if RPC) scope the Nebula-side change as a follow-up phase.

## Notes
- This is internal hardening + a security/architecture decision — recommend a **new session** with the key files read fresh (the bake-off history is durably captured in RESULTS.md + the bake-off task; don't re-derive it here).
- Suggested opening prompt is at the bottom of [`think-nebula-shim-security-review.md`](think-nebula-shim-security-review.md).
- Out of scope: re-running the bake-off; the UI-gen half (parked for 5.3.7).
