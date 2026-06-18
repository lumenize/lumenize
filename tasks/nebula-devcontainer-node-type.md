# LumenizeContainer / NebulaContainer — the 4th Lumenize node type

**Status**: Design complete (reviewed: framing + conformance, 2026-06-17) — **gate CLEARED: the agent-channel spike RAN + GOed 2026-06-17** (`tasks/spike-container-agent-channel.md`; Q1 mechanism + Q2 deployed-latency both ✅, ~30 ms warm channel edge-local; memory [[agent-channel-container-exec]]). **Now build-ready** (next in build order). Carry forward the spike's sizing caveat (size the dev instance so `vite build` doesn't starve the command channel).
**Phase**: Studio container-vite pivot — foundation (`tasks/nebula-studio.md` § *UI-build architecture*).
**App**: `packages/mesh` (`LumenizeContainer` — **`@cloudflare/containers` approved as a mesh dep 2026-06-17**; mesh is already CF-coupled, this sits beside `LumenizeDO`/`LumenizeWorker`; optionally exposed via a `@lumenize/mesh/container` subpath so container-free consumers can skip the install — decide in build) + `apps/nebula` (`NebulaContainer`). Realizes **ADR-007 (Proposed)**.

**Why this exists:** the pivot's dev preview fronts a vite container; its **reason for existing is using containers**. But to talk to the rest of Nebula it must be a **mesh node** — provide the comms+guards core: `lmz.call()` (receive), `lmz.ctn()` (outgoing), `onBeforeCall` + `@mesh()`. It extends `@cloudflare/containers` `Container` (which extends `DurableObject`), so it **cannot** inherit `LumenizeDO` — and shouldn't: it's **its own node type**, not a `LumenizeDO`. The DO ancestry (via `Container`) is **incidental**. (The Studio-specific `DevContainer` — vite + the preview proxy — is a `NebulaContainer` consumer built later in the #1a dev-loop reshape; this file builds only the node type.)

## Scope of the node core (narrow — per ADR-007)
- **IN (the shared core, composed):** `lmz.call()` receive, `lmz.ctn()` outgoing continuations, `onBeforeCall`, `@mesh()`. This is exactly what **`LumenizeWorker`** composes — verified: `LumenizeWorker` has `onBeforeCall` + `executeEnvelope` and **no** `onStart`/`onRequest`/`alarm` (`lumenize-worker.ts`).
- **AVAILABLE, not part of the invariant:** `lmz.sql` (the node is DO-based via `Container`'s `ctx.storage`) for the node's own storage needs — but `ctx.storage` is **shared with `Container`'s own lifecycle state** (see *Storage namespace* below).
- **OUT — `Container` exclusively owns these; the mesh core takes none:** `Container`'s constructor `blockConcurrencyWhile`s `scheduleNextAlarm()` + `CREATE TABLE container_schedules` and its `alarm()`/`onStart()` are load-bearing for container lifecycle. So **`alarm`/`onStart` are not "available later" — they are owned.** A future Lumenize alarm need on this node type is **blocked**: route it through `Container.schedule()` or a sibling Worker, **never** `svc.alarms`. The node uses `Container`'s own `fetch()` (not a DO `onRequest()`).

## Scope-isolation boundary (M1 — state it explicitly, don't let #1a inherit an unstated assumption)
`onBeforeCall` (the tenant scope guard) runs **only on the mesh path** (inside `executeEnvelope`). It does **not** cover `Container.fetch()`/`containerFetch`. That is **by design, not a hole:**
- **`fetch()` is the public vite-proxy surface** — it serves only the **public preview shell** (frontend code + ontology types every client gets anyway), exactly like DevStar's intentionally-open `onRequest` (#1a). No tenant data flows through it.
- **Everything sensitive — data, and the agent command channel — goes over the mesh** (`lmz.call`, `onBeforeCall`-gated). The agent talks to DevContainer over the mesh; the container's command-server port is reachable **only** by DevContainer's internal `containerFetch`, **never forwarded from the public `fetch()`** (the Q5 trust boundary).
- **Test (capable-of-failing):** with `fetch()` open, a cross-scope **mesh** data call is still rejected by `onBeforeCall`; and the command-server port is not reachable via the public proxy.

## The composable seam (corrected — M1 framing-stage finding)
Composed, not inherited: `LumenizeDO` + `LumenizeWorker` realize the receive path via `executeEnvelope` behind the `EnvelopeExecutorNode` seam. **`LumenizeClient` does NOT use `executeEnvelope`** — it hand-rolls the receive path (`#handleIncomingCall`). So the seam is shared by **2 of 3** today; the Client is a documented parallel path. `LumenizeContainer` composes the **DO-flavored** seam.

**The full receive contract a non-`LumenizeDO` base must implement** (m1 — not just "lmz/onBeforeCall/__executeChain"): public **`__executeOperation(envelope)`** (calls `executeEnvelope(…, { includeInstanceName: true })` — the surface `lmz.call` dispatches to), `lmz` with a working **`__init`**, `onBeforeCall`, `__executeChain`, and `__localChainExecutor` (result-handler path). Composition point: **`createLmzApiForDO(this.ctx, this.env, this)`** (n2); identity persistence relies on `Container`'s `ctx.storage` being SQLite-backed → register the class with **`new_sqlite_classes`** (durable-objects.md).

## Decisions pinned
- **`class LumenizeContainer extends Container`** in `packages/mesh` — a **concrete base** composing the comms+guards core (default; one consumer, YAGNI). A generic `withLumenizeMesh(Base)` mixin is **deferred** unless a 2nd third-party base appears.
- **`NebulaContainer extends LumenizeContainer`** — `onBeforeCall` reuses `buildAuthScopePattern` + `matchAccess` (mirror `NebulaDO`'s guard; a **sibling**, not a subclass, of `NebulaDO`).
- **Addressing contract (M3):** a DevContainer is **always** addressed by its `parseId`-valid tenant-scoped name **`{u}.{g}.dev`**, never a 64-hex `idFromString` — so `buildAuthScopePattern(name)` yields exactly the scope the caller must already hold (the name==routing-key soundness that makes the tier-DO guard work; `nebula-do-scope-isolation.md` M4). Enforced by a fail-closed test, not assumed.
- **Storage namespace (m2):** `createLmzApiForDO` persists identity (`__lmz_do_*`) into the same `ctx.storage` `Container` uses for `container_schedules` + `OUTBOUND_CONFIGURATION_KEY`. The Lumenize kv/SQL namespace **must not collide** with those reserved Container keys/tables.
- JWT stays at the Gateway; DO-side ALS `callContext` path. No raw RPC for the node's own mesh calls (mesh.md, ADR-003).

## Build order
**0. The agent-channel spike runs FIRST** (`tasks/spike-container-agent-channel.md`) — proves the mechanism against a **stubbed/minimal surface** (raw RPC fine in throwaway experiment code). This task follows its GO; don't build production mesh code or accept ADR-007 before it clears.

### Phase 1 — Divergence inventory + the composable seam (no consolidation)
- Produce the **inventory** (build-now): `grep` every type calling `executeEnvelope` (`packages/mesh/src`) **plus** the Client's `#handleIncomingCall`. **Artifact-shaped criterion (m6):** for each `EnvelopeExecutorNode`/receive requirement, state per existing type whether it's satisfied via `executeEnvelope` or hand-rolled, and which `LumenizeContainer` reuses verbatim vs. supplies. Pin the **four Client divergences** as required rows: no `__init`, no `runWithCallContext`/ALS, no `{$error}` wrap, response-via-WS-message.
- Enumerate `Container`-owned keys/tables (`container_schedules`, `OUTBOUND_CONFIGURATION_KEY`, the alarm slot) as **reserved**; document "how to compose the comms+guards core onto a base" + the no-collide namespace rule.
- **Do NOT consolidate the Client's path** — deferred unless it blocks composition.
- **Success:** the inventory artifact above exists + names what `LumenizeContainer` supplies; existing DO/Worker/Client tests stay green.

### Phase 2 — `LumenizeContainer` (mesh layer)
- `extends Container` + composes the receive contract (above); `lmz.sql` available; raw `fetch()`, no `onRequest`.
- **Success — mesh seam (testable in-process; M4):** via a named harness (`createTestingClient` isolated DO, or full Client→Gateway→DO), an inbound `lmz.call` **lands via `__executeOperation`** and returns; an outgoing `lmz.ctn` fires; `onBeforeCall` fires — **mutation-check by commenting out `node.onBeforeCall()` in `executeEnvelope` (lmz-api.ts:902), confirm the marker-count test goes RED, restore** (m8; drop the `T-local-skip` mirror — its negative half needs `svc.alarms`, which this node lacks).
- **Success — error round-trip (m9, ADR-002):** a `@mesh` method that throws a custom `Error` surfaces to the `lmz.call` caller with `name` + custom own-properties intact (assert by `err.name` + property presence, **not** `instanceof` — mesh.md) — exercises the `{$error}` wrap unique to `executeEnvelope`.
- **Success — narrow-core / no-collision (m7):** assert `!Object.hasOwn(LumenizeContainer.prototype, 'alarm')` **and** `!Object.hasOwn(…, 'onStart')`, with a **positive control** (a member the core DOES define — `onBeforeCall`/`__executeOperation` — IS an own-prop, so the negatives aren't vacuously true); pin `@cloudflare/containers` **v0.3.7** as the baseline so upstream drift breaks it. Plus: identity `__init` coexists with `Container`'s constructor `blockConcurrencyWhile` startup (instanceName persisted, lifecycle unbroken) (m2).
- Real `containerFetch`/port behavior is **not** exercisable in vitest-pool-workers (no OS container) — defer to a deployed e2e or the agent-channel spike via `it.skip` + named blocker (M4); do **not** assert it against a stub.

### Phase 3 — `NebulaContainer` (nebula layer)
- `extends LumenizeContainer`; `onBeforeCall` scope-isolation via `buildAuthScopePattern`/`matchAccess` (mirror `NebulaDO`).
- **Success (mirroring `scope-isolation.test.ts`):**
  - A **genuinely-minted** (not forged) cross-scope / non-admin caller is **rejected** (`Error`, B1) — give `NebulaContainer` **one trivial guarded `@mesh` write** (e.g. an `lmz.sql` INSERT) so "writes nothing" is capable-of-failing (mutation-check: comment out the `matchAccess` reject → the write lands) (m5). An in-scope caller passes.
  - **Fail-closed addressing (M3):** a `NebulaContainer` addressed with a foreign-scope or unparseable/hex name is rejected (mirror `T-malformed`).
  - **B5 (m5):** extend the frozen non-admin-`@mesh` allow-list with a walk/`it` over `NebulaContainer`'s prototype (the dynamic partition by `getMeshGuard(m) !== requireAdmin`), so a new non-admin method fails the test.

## Out of scope
- Vite dev-loop / HMR / DO-proxy serving / scope-injection relocation → #1a reshape (builds `DevContainer` on `NebulaContainer`).
- The agent exec channel + latency → `tasks/spike-container-agent-channel.md` (runs first). **Hardening + re-validating that exec is unreachable except by the in-scope Nebula agent DO is owned by the #1a dev-loop task** (m4 — name it so the "receiver re-validates" requirement isn't orphaned between the spike, which names but doesn't harden, and this task).
- Source durability → `tasks/nebula-app-versioning.md` (Q6). Prod static-asset serving → the prod-serve task.
- Consolidating the Client's hand-rolled receive path — deferred follow-up unless it blocks composition.
- Mesh alarms / `onStart` on the container node — **blocked** by `Container`'s ownership (above); route via `Container.schedule()` if ever needed.

## References
**ADR-007 (Proposed)** owns the comms+guards invariant (this file points to it). `lmz-api.ts` (`executeEnvelope`/`EnvelopeExecutorNode`, `__executeOperation`@305, `onBeforeCall` call site @902, `lmz.call`/`ctn`/`sql`/`__init`); `lumenize-worker.ts` (minimal-core sibling); `lumenize-client.ts` `#handleIncomingCall` (the parallel path Phase 1 classifies); `nebula-do.ts` + `tasks/nebula-do-scope-isolation.md` (the guard to mirror, incl. `T-malformed`/B5); `node_modules/@cloudflare/containers` v0.3.7 (`container.d.ts` — `alarm`/`onStart`/`fetch`/`container_schedules`); `tasks/spike-container-agent-channel.md` (runs first); `tasks/nebula-studio.md` § *UI-build architecture*; `.claude/rules/{mesh,durable-objects,testing,security}.md`.
