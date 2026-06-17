# ADR-007: Lumenize Node Types Share One Mesh Comms + Guards Core (Composed, Not Reimplemented)

**Date**: 2026-06-17
**Status**: Proposed
**Deciders**: Larry
**Status note (2026-06-17)**: **Proposed**, not yet Accepted — held until the container-vite pivot survives its Q5 viability spike (`tasks/spike-container-agent-channel.md`) and the 4th node type lands (`tasks/nebula-devcontainer-node-type.md`). Also **scoped down** on the day it was drafted: the invariant is the narrow **comms + guards** core, not a broad "mesh + security core" (storage/alarms/onStart/fetch are per-node-type capabilities, below).
**Evidence / history**: `packages/mesh/src/lmz-api.ts` (`executeEnvelope` + the `EnvelopeExecutorNode` seam; `lmz.call` receive, `lmz.ctn` outgoing), `packages/mesh/src/lumenize-do.ts` / `lumenize-worker.ts` (both realize the receive path via `executeEnvelope` + `onBeforeCall`), `packages/mesh/src/lumenize-client.ts` (`#handleIncomingCall` — a **separate, hand-rolled** receive path, no `executeEnvelope`, browser/Node compat), `packages/mesh/src/lumenize-client-gateway.ts` (JWT verified at the Gateway), `apps/nebula/src/nebula-do.ts` (`onBeforeCall` scope guard), `tasks/nebula-devcontainer-node-type.md` (the 4th type), `tasks/nebula-studio.md` § *UI-build architecture* (the pivot that surfaced this).

## Context

Lumenize is a mesh of **nodes** that talk over `lmz.call()`. The functionality every node must share is **narrow**: receive mesh calls (`lmz.call`), make outgoing continuations (`lmz.ctn`), and enforce the guards (`onBeforeCall` + the `@mesh()` decorator), behind a JWT the Gateway has already verified. **Everything else is a per-node-type capability that varies by base class** — storage (`lmz.sql`, DO-based nodes only), alarms, `onStart`, request/`fetch` handling — and is explicitly *not* part of the shared core. (`LumenizeWorker` takes neither alarms nor `onStart`; a node takes only what it needs.)

The core is **composed, not inherited**: `LumenizeDO` (extends `DurableObject`) and `LumenizeWorker` (extends `WorkerEntrypoint`) both realize the receive path by calling the shared `executeEnvelope` behind the minimal `EnvelopeExecutorNode` seam. `LumenizeClient` provides the **same capability via a separate hand-rolled path** (no `executeEnvelope`, explicit `callContext` field instead of workerd ALS — browser/Node compat); that divergence is the one Phase 1 of the 4th-type task must classify as justified-or-consolidate.

The container-vite pivot adds a **fourth** node type, `LumenizeContainer`/`NebulaContainer`, whose **reason for existing is using containers**. It extends `@cloudflare/containers`'s `Container` (which extends `DurableObject`) — **incidental** DO ancestry, **not** a `LumenizeDO`. A fresh contributor adding any node-shaped surface will otherwise hand-roll the guards or skip them — a security hole or silent drift.

## Decision

**Every Lumenize node type provides the comms + guards core — `lmz.call()` (receive), `lmz.ctn()` (outgoing continuations), `onBeforeCall`, and `@mesh()` — by composing the shared implementation, never reimplementing it. New node types compose this core regardless of which base class they must extend.**

- **The core is deliberately narrow.** Storage (`lmz.sql`), alarms, `onStart`, and request/`fetch` handling are **per-node-type capabilities**, not part of this invariant — a node takes only what it needs (e.g. `LumenizeWorker` and the container node take neither alarms nor `onStart`; the container node uses its `Container` base's own `fetch()`, not a DO `onRequest()`).
- **The guards cover the mesh receive path only.** `onBeforeCall` runs inside the mesh dispatch (`executeEnvelope`); a node type's own request/`fetch()` surface is **outside** the shared guard and must be secured by that node type's design (public-by-design, or its own check) — never *assumed* gated. (E.g. the container node's `fetch()` is the intentionally-public vite proxy; its sensitive operations go over the mesh.)
- **Composition over inheritance.** The seam is `EnvelopeExecutorNode` + `executeEnvelope` (DO/Worker today), so a node extending a third-party base (`Container`) composes the core without inheriting a Lumenize base.
- **JWT verification stays at the Gateway trust boundary**; nodes enforce *authorization* (scope/permission) in their `onBeforeCall` override + `@mesh(requireAdmin)`.
- **Per-type divergence in the core requires a documented, defensible reason.** The `LumenizeClient`'s separate receive path (browser/Node compat) is the current one — to keep documented or consolidate, not a license to reimplement freely. Unjustified divergence is a defect.
- The mechanism is `executeEnvelope`/`EnvelopeExecutorNode` today; **the commitment is the principle** (cf. ADR-001).

## Alternatives considered

| Approach | Why rejected |
|---|---|
| Each node type reimplements the receive + guard logic | Drift and security holes by construction; every new surface forgets a check; relitigation-by-default. |
| Share the core via a common base class (inheritance only) | Breaks the instant a node must extend a third-party base (`Container`); single inheritance forbids it. The `EnvelopeExecutorNode` seam already composes across bases. |
| Make the shared core broad ("mesh + security": storage + alarms + onStart too) | Forces every node to carry DO-lifecycle capabilities it doesn't need — the container node (like Worker) needs neither alarms nor `onStart`; bundling them manufactures the alarm/onStart collisions with `Container`'s own that the narrow scope avoids entirely. |

## Consequences

### Positive
- **Uniform secure-by-default comms** — one guard path, one place to audit.
- A new node type composes a **narrow four-element core**, then adds only the per-type capabilities it needs (the container node: `lmz.sql` from its DO base + its `Container` `fetch()`; no alarms, no `onStart`).
- Keeping the core narrow **sidesteps the `Container` lifecycle collisions** (its own `alarm()`/`onStart()`/`fetch()`) that a broad core would have forced us to reconcile.

### Negative / open
- **The `LumenizeClient`'s separate receive path is a divergence to classify** (justified by browser/Node compat, or consolidate) — Phase 1 of `nebula-devcontainer-node-type.md`. Until then the "shared by composition" claim is realized by 2 of 3 existing types via `executeEnvelope`, with the Client a documented parallel path.
- **Proposed, not Accepted**, until the pivot survives Q5 and the container node lands.
