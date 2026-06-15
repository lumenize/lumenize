# Think→Nebula shim — design & multi-tenant-security review

**Status (2026-06-06)**: Drafted as a handoff for a focused **next-session** design discussion. The Think-vs-CMA bake-off is concluded (→ Think/Kimi+codemode; see `tasks/think-vs-cma-bakeoff.md` + `experiments/think-vs-cma/results/RESULTS.md`). **The shim is the engineering artifact that survives that decision** — Larry: "other than the decision to go Think all the way, that's what will survive." This doc frames the review so the new session can start focused (read the real code, not the bake-off history).

## What the shim is

A `@cloudflare/think` agent DO is **not a Lumenize mesh participant** (it extends Cloudflare's `Agent`, not `LumenizeDO`), so it has no `this.lmz` and can't natively make authenticated mesh calls to the Star. And `Star.transaction`/`read` are fire-and-forget to a *connected Gateway client* — a forged direct-RPC caller never gets results. So the shim makes the Think DO a **real Gateway-connected NebulaClient from inside workerd**:
- `think/src/fetch-ws.ts` — `FetchUpgradeWebSocket`: adapts workerd's fetch-upgrade (`response.webSocket`) to the `WebSocket` interface `LumenizeClient` expects (workerd has no outbound `new WebSocket()`). Token rides in the `Sec-WebSocket-Protocol` subprotocol.
- `think/src/in-do-executor.ts` — `createInDoExecutor(env, scope, accessToken?)`: builds an in-DO `NebulaClient` (the shim + injected access token), waits for connect, returns a `ToolExecutor` over it. **`accessToken` provided = real e2e login token (production path); omitted = mints an admin JWT offline (TEST-ONLY fallback).**
- `cma/executor.ts` — `ExperimentClient` (NebulaClient subclass) + `CmaNebulaExecutor` (the tool→Resources mapping). Shared by both arms.

All in the worktree `.claude/worktrees/think-vs-cma` (branch `feat/think-vs-cma-bakeoff`).

## The questions to answer (Larry)
1. **How clean is the shim?**
2. **Does it honor the Lumenize Mesh design + multi-tenant security architecture in a cleanly *verifiable* way?**

## Preliminary read (to pressure-test in the discussion)

**The shim does NOT bypass any security — it rides on Nebula's existing mesh auth, IF it uses a real user token.** Path: the in-DO client presents the JWT → the Worker entrypoint `verifyNebulaAccessToken` checks sig/iss/aud/exp/authScopePattern → the Gateway sets `originAuth` from the *verified* JWT → downstream Star/Galaxy `@mesh` guards enforce (`requireAdmin` reads `claims.access.admin`; `DagTree.requirePermission` reads `sub` + admin-bypass; `NebulaDO.onBeforeCall` **locks the DO to the JWT's `aud`**). So a Think DO holding user U's token for scope S acts **exactly as U, confined to S** — same guards a browser client hits, caller-agnostic. That's the verifiability claim: *the Think DO has no more authority than the user whose token it holds, confined to that user's scope by the same guards.*

**The load-bearing risks to scrutinize:**
- ⚠️ **The minted-JWT fallback must NEVER reach production.** `createInDoExecutor` with no `accessToken` forges an admin JWT offline with `JWT_PRIVATE_KEY_BLUE`. In prod that's a god-mode impersonation hole (forge admin for *any* scope). It was a transport-probe convenience only. Prod must use **real user tokens only**, and the signing key must not be usable by the agent DO for forging. (Quarantine or delete the mint path for prod.)
- **Token handling in the DO**: the user's access token held in a DO (per session/scope) — lifetime (~900s), refresh strategy for long authoring sessions, exposure surface. Is "a DO holding the user's token to act on their behalf" acceptable (server-side-session pattern)?
- **Tenant confinement**: confirm the `aud`-lock (`NebulaDO.onBeforeCall`) + DagTree fully confine a Think DO to its tenant's scope with **no** cross-tenant path (a token for scope A can't reach scope B's Star).
- **Result routing**: the in-DO client is a real Gateway-connected client (clientId from token `sub`); confirm fire-and-forget result routing + the Gateway's `onBeforeCallToClient` aud-check are sound for it.
- **Connection**: token in the wss subprotocol over TLS — confirm fine.

**Alternative to weigh: delete the shim via a Nebula-side change.** A result-returning transaction RPC for trusted in-deployment callers would let the Think DO call the Star directly (forged-envelope with `originAuth`), no WS client. BUT that shifts trust: the DO *asserts* the user identity itself (no Gateway verification of a signed token), which may be *less* verifiable than the WS-shim (where the Gateway verifies a real signed token). So the shim may be the *more* secure option — worth comparing explicitly.

## Key files for the review (mesh + security architecture, in the main repo)
- `packages/mesh/src/` — the `@mesh` guard + `CallContext`/`OriginAuth` + `lumenize-client-gateway.ts` (where `originAuth` is minted from the verified JWT) + `lmz-api.ts` (CallEnvelope/`__executeOperation`).
- `apps/nebula/src/nebula-do.ts` — `onBeforeCall` (aud-lock) + `requireAdmin`.
- `apps/nebula/src/dag-tree.ts` — `requirePermission` + admin-bypass.
- `apps/nebula/src/entrypoint.ts` — `verifyNebulaAccessToken` (the signature/claims check).
- `packages/nebula-auth/` — JWT mint/verify + the two-scope auth model.
- The shim itself (worktree): `think/src/{fetch-ws,in-do-executor}.ts`, `cma/executor.ts`.

## Suggested next-session opening
"Review the Think→Nebula shim for multi-tenant security: verify the in-DO client confers no more authority than the user's real token, confined to their scope by the existing mesh guards; confirm the minted-JWT path is prod-quarantined; and compare the WS-shim vs a Nebula-side result-returning-transaction RPC on verifiability." (Read the key files above fresh.)
