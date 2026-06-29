# Think→Nebula shim hardening (production-grade, for later)

**Status**: **Iceboxed — Think not adopted** (2026-06-22; was on-hold 2026-06-16). The in-DO WS shim existed to connect a foreign Cloudflare Think Agent DO to Nebula. Confirmed in code 2026-06-22: the Studio codegen loop (`apps/nebula/src/dev-studio.ts` → `DevStudio.chat`) calls the model through the **Workers AI binding** (`env.AI.run`) — no shim, no outbound WebSocket — so this work has no consumer. Parked indefinitely (`tasks/icebox/think-nebula-integration.md`); revive only if Think is ever reconsidered. Original framing preserved below.

## Pre-flight: bump Think + agents before building
Sunil shipped a DO-write-cost optimization (Discord, 2026-06-06) claiming **20–80% lower DO costs**, gated on latest versions. Bump before building on the harness:
- [ ] `@cloudflare/think` **0.8.3 → 0.8.4**
- [ ] `agents` **0.14.2 → 0.14.3**
- [ ] `@cloudflare/ai-chat` — **N/A** (we don't depend on it; Think uses `@cloudflare/codemode`).

Orthogonal to the bake-off's model-token cost numbers (it's a DO storage/write win) — doesn't change results, free savings once Studio runs on Think in production.

## Objective

Take the in-DO WS-client shim from "works in the bake-off" to "production-grade for Studio." The artifacts, the multi-tenant security framing, the confinement claim, and the keep-vs-delete-shim *decision* all live in `tasks/icebox/think-nebula-integration.md` — read it first; this file is the implementation checklist for whatever it decides.

## Artifacts (worktree `.claude/worktrees/think-vs-cma`)
- `think/src/fetch-ws.ts` — `FetchUpgradeWebSocket`.
- `think/src/in-do-executor.ts` — `createInDoExecutor(env, scope, accessToken?)` (real token = prod; omitted = TEST-ONLY mint).
- `cma/executor.ts` — `ExperimentClient` + `CmaNebulaExecutor` (the tool→Resources mapping).

## Tasks

### 1. Kill the minted-JWT path for production (highest priority)
Production can NEVER forge a JWT. The offline-mint fallback in `createInDoExecutor` (signs an admin JWT with `JWT_PRIVATE_KEY_BLUE`) is a god-mode impersonation hole — transport-probe convenience only.
- [ ] `accessToken` **required** on the production path; no offline-mint fallback reachable outside tests.
- [ ] The signing key is **not bound** to the agent DO's Worker project — it can't forge tokens even if the code tried.
- [ ] Any mint helper kept for tests lives behind a test-only boundary the prod build can't import.

### 2. Confinement tests (the integration file makes the claim; this proves it)
- [ ] Trace presents-token → `verifyNebulaAccessToken` → Gateway mints `originAuth` from the verified JWT → `onBeforeCall` scope-lock + `DagTree.requirePermission`. Confirm the agent caller is treated identically to a browser caller (caller-agnostic).
- [ ] Negative test: an in-DO client holding scope-A's token attempting a scope-B Star op is rejected by the existing guards (not by shim-side logic).

### 3. Token lifetime + refresh in the DO
- [ ] Documented decision: is "a DO holding the user's access token to act on their behalf" the accepted server-side-session pattern? (Larry to confirm.)
- [ ] Access-token expiry (~900s) handled for sessions longer than the TTL — refresh or re-auth, no silently-dead connection.
- [ ] Exposure surface noted (where the token lives; not logged; not persisted beyond need).

### 4. Result routing + connection soundness
- [ ] Fire-and-forget result routing works for the in-DO client (clientId from token `sub`); the Gateway's `onBeforeCallToClient` scope-check is sound for it.
- [ ] Token-in-wss-subprotocol-over-TLS is acceptable.
- [ ] The live WS connection's reconnect timers don't leak / don't cause wall-clock billing surprises in an idle authoring DO.

## Notes
- Internal hardening — recommend a **new session** with the key files (listed in `think-nebula-integration.md`) read fresh.
- Out of scope: re-running the bake-off; the UI-gen viability spike (`tasks/kimi-ui-gen-viability.md`).
