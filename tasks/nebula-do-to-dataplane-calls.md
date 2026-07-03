# Nebula — DO→DO (and the foundation for AI-memory DOs) calls into a Data Plane

**Status**: **📋 DRAFT — validation test for a capability the [`mesh-client-callasync`](mesh-client-callasync.md) refactor ENABLED.** Not a blocker for that task (which is complete). Build when the AI-memory-DO work starts, or sooner if we want the coverage locked in.

**Why now (the trigger)**: the `callAsync` refactor changed the resource `read`/`transaction` path from **Pattern-R** (server explicitly pushes `handleReadResponse`/`handleTransactionResult` back to a *client* `@mesh` handler via the Gateway — **client-only** by construction) to **Pattern-C** (the `@mesh` method **returns the value** and the framework fires it back to *whoever* called — client via `callAsync`, or a **DO/Worker via the 4-arg traveling handler**). So the refactor **enabled DO→DO / Worker→DO calls into a Data Plane** — it did not restrict them. This task adds the integration test that locks that in.

**Use case (Larry, 2026-07-03)**: DOs that serve as **memory for the AI** (perhaps a Universe, perhaps external to it) will live outside a single DevStudio instance but be **retrieved from a DevStudio instance** — i.e. a DO reads (and likely writes) resources on another DO's Data Plane. Worker→DO has no known use case (skip — see Decisions).

---

## What is already proven (so this is a small, well-understood addition)

- **The DO→DO fire-back mechanism** — a DO 4-arg-calls a callee whose `@mesh` method **returns a value**, and the framework fires it back to the caller DO's handler: **tested** at the mesh level, `packages/mesh/test/lumenize-do.test.ts:442` (`Result delivery (4-arg → fire-back)`, `remoteEcho` returns `echo: hello`).
- **`Star`/`DevStudio` `read`/`transaction` are now valid 4-arg targets** — they return the value (D12-compliant: local sync/async production, no further cross-node call; the transaction's fan-out broadcasts are fire-and-forget side effects). Confirmed by the `callAsync` build.
- **DevStudio Data-Plane auth** (`requireAdmin` + the `{u}.{g}.dev` scope guard) — **tested** for the client path, `apps/nebula/test/test-apps/baseline/devstudio-resources-e2e.test.ts` (incl. permission-denied).

The **composition** — a DO 4-arg-calling `DevStudio.read`/`transaction` with real auth — is what this task's integration test adds.

---

## Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | **Host** | **DevStudio** (fixed Session/Message ontology → `void appVersion`, no version-gate to thread through a DO caller). Directly models "AI-memory DO retrieved from a DevStudio instance." Star (version-gated) is a later add if wanted. | **[PINNED 2026-07-03 Larry]** |
| D2 | **Worker→DO** | **Skip — no test, no code change.** The only conceivable Worker-origin scenario is a multi-hop, which has **unexamined security implications** (a Worker has no `instanceName`, so it can't be the broadcast-exclusion identity, and its authority to drive a write is unclear). **YAGNI** now. | **[PINNED 2026-07-03 Larry]** |
| D3 | **The `!clientId` guard** | **Do NOT relax it.** `Star`/`DevStudio.transaction` derive `clientId = callChain[0]?.instanceName` (for broadcast originator-exclusion) and **throw if absent**. A **DO** origin has an `instanceName` → works (excludes itself, a harmless no-op — it isn't a subscriber). A **Worker** origin has none → throws — and per D2 that stays a loud, secure default, not a code mod. | **[PINNED 2026-07-03 Larry]** |

---

## Test plan (DO→DevStudio, real auth)

A **caller DO** in the `.dev` scope 4-arg-calls `DEV_STUDIO.read`/`transaction` over the full `client → callerDO → DevStudio` flow, so the `.dev`-admin **origin propagates** (DevStudio's `enforceScopeReach` gates the *origin*, not the immediate caller — D5/N4). Assert the fire-back delivers the result to the caller DO's handler.

**Infra to build:**
- A minimal **caller DO** (test-app; a `LumenizeDO`/`NebulaDO` test fixture) with: `readViaHost(binding, instance, resourceId)` + `transactViaHost(...)` that fire **4-arg `call`s** with a `@mesh` result handler; the handler stores the delivered `Snapshot`/`TransactionResult` in DO storage; a `getStoredResult()` reader. Its instance lives at the `.dev` scope so the `.dev`-admin client can reach it.
- A **binding** (`MEMORY_DO` or similar) + `new_sqlite_classes` in `test/test-apps/baseline/test/wrangler.jsonc`.
- A `NebulaClientTest` initiator to drive the caller DO.

**Scenarios (capable-of-failing each):**
- DO→DevStudio **read** returns the `Snapshot` to the caller DO's handler (create a resource on DevStudio first via the client, then read it through the DO).
- DO→DevStudio **transaction** (create/put) returns the `TransactionResult`; the committed mutation is visible on a subsequent read.
- DO origin is correctly **excluded from the broadcast** (it isn't a subscriber → no echo) — the `clientId`-from-a-DO path (D3).
- (Optional, later) Star host: the **ontology-stale → Error fired back to a DO caller** path (Star throws `OntologyStaleError` → the framework delivers it as the handler's `$result` Error), and the version-plumbing a DO caller needs.

**Success Criteria:**
- [ ] Caller DO + binding + migration + client initiator added to the baseline test-app.
- [ ] DO→DevStudio read + transaction integration tests green, each capable-of-failing.
- [ ] Broadcast originator-exclusion verified for a DO origin (D3).
- [ ] `.claude/rules/mesh.md` note: `read`/`transaction` (Pattern-C, D5(a)) are caller-agnostic 4-arg targets — a DO can call them; a Worker origin is a deliberate `!clientId` throw (D2/D3).

---

## Notes
- This is **not** a `callAsync` consumer — a DO can't `callAsync` (client-only). A DO uses the ordinary **4-arg `call` + traveling handler**; the Data-Plane method returning a value (Pattern-C) is what makes it a valid target.
- If the AI-memory DO ends up being its **own** Data-Plane host (its own `ResourceDataPlane`), the *same* Pattern-C return-value shape applies — this test also de-risks that direction.
