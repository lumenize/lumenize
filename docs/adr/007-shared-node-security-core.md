# ADR-007: All Lumenize Node Types Share One Mesh + Security Core (Composed, Not Reimplemented)

**Date**: 2026-06-17
**Status**: Accepted
**Deciders**: Larry
**Evidence / history**: `packages/mesh/src/lmz-api.ts` (`executeEnvelope` @ 841, the `EnvelopeExecutorNode` interface @ 812 — the seam), `packages/mesh/src/lumenize-do.ts` / `lumenize-worker.ts` / `lumenize-client.ts` (each *calls* `executeEnvelope`, none inherits it), `apps/nebula/src/nebula-do.ts:47` (`onBeforeCall` scope-isolation guard), `packages/mesh/src/lumenize-client-gateway.ts:206–254` (JWT verified at the Gateway trust boundary, injected as `originAuth`), `tasks/nebula-devcontainer-node-type.md` (the 4th type + the seam-extraction work), `tasks/nebula-studio.md` § *UI-build architecture* (the container-vite pivot that surfaced this). Surfaced 2026-06-17 planning the pivot: a `@cloudflare/containers` `Container`-based `DevContainer` must be a first-class mesh node yet **cannot** inherit `LumenizeDO` (single inheritance — it already extends `Container`).

## Context

Lumenize is a mesh of **nodes** that talk over `lmz.call()`. Security is by-default and **uniform**: every node must (a) speak the mesh envelope protocol (receive and make calls, thread `callContext`), and (b) enforce the same guards — the `onBeforeCall` hook (scope isolation in Nebula), behind a JWT the Gateway has already verified.

Today there are **three node types**, and crucially they do **not** share the core by inheriting a common ancestor. Each (`LumenizeDO extends DurableObject`, `LumenizeWorker extends WorkerEntrypoint`, `LumenizeClient` standalone) **calls a shared function** `executeEnvelope()` behind a minimal interface, `EnvelopeExecutorNode` = `{ lmz, onBeforeCall(), __executeChain() }`. The core is already **composed, not inherited** — a deliberate isolation so it could be reused across bases that share no ancestor.

The container-vite pivot adds a **fourth** node type. `DevContainer` must `extends Container` (from `@cloudflare/containers`), so it can't also `extends LumenizeDO` — yet it must be an equal mesh citizen with the full guard core. More generally: a fresh contributor — or a fresh LLM session — adding *any* new node-shaped surface (a container, a queue consumer, a new entrypoint) will reach for "just handle the request directly," hand-roll the guards, or skip them. That is a security hole or silent drift, created exactly when no one is reviewing the guard path.

## Decision

**Every Lumenize node type enforces the mesh protocol and security guards through the one shared core, reused by composition — implement `EnvelopeExecutorNode` and delegate to `executeEnvelope`, obtain `lmz` from the shared factory — and never reimplements the envelope/guard logic. New node types compose the core regardless of which base class they must extend; they do not hand-roll it.**

- **Composition over inheritance for the core.** The sharing seam is the `EnvelopeExecutorNode` interface + `executeEnvelope` (and, where ergonomic, a `withLumenizeMesh(Base)` mixin / a `LumenizeContainer` base) — not a common ancestor class. This is what lets a `Container`-based node be a full node.
- **JWT verification stays at the Gateway trust boundary**, not duplicated per node; nodes receive a pre-verified `originAuth` and enforce *authorization* (scope/permission) in their `onBeforeCall` override.
- **Per-type divergence requires a documented, defensible reason.** The one current divergence — the browser/Node `LumenizeClient` threads `callContext` via an explicit field because workerd `AsyncLocalStorage` isn't available there — is justified and recorded. **Unjustified divergence is a defect to be consolidated**, not a precedent.
- The mechanism today is `executeEnvelope` / `EnvelopeExecutorNode`; **the commitment is the principle**, not the function names (cf. ADR-001: the principle outlived its mechanism).

## Alternatives considered

| Approach | Why rejected |
|---|---|
| Each node type reimplements the envelope + guard logic | Drift and security holes by construction; every new surface is a fresh chance to forget a check; relitigation-by-default. |
| Share the core via a common base class (inheritance only) | Breaks the instant a node must extend a third-party base (`Container` now; some future framework class later) — single inheritance forbids it. The composition seam already sidesteps this and is proven across the three existing types. |
| Convention only (no committed invariant) | A fresh session adds a "quick" direct-`fetch` handler with no guard and it ships silently; nothing keeps the fourth+ type from going its own way. |

## Consequences

### Positive
- **Uniform secure-by-default** across every node — one guard path, one place to audit and fix.
- A **new node type drops in by implementing a three-method interface** (the 4th, `DevContainer` → `NebulaContainer`, mirrors `LumenizeDO`/`NebulaDO`), instead of re-deriving mesh + auth.
- Composition is **already validated** across DO / Worker / Client, so the fourth type is an extension of a working pattern, not a new bet.

### Negative / open
- **Justified divergence persists and must be documented, not erased** — `callContext` via ALS (DO/Worker, incl. the container) vs. an explicit field (Client) is load-bearing for browser/Node compat.
- **Seam-extraction is real work** — formalizing the reusable form (`withLumenizeMesh` mixin or `LumenizeContainer` base) and **auditing the existing three types to confirm no *unjustified* drift** before the fourth composes in. Tracked in `tasks/nebula-devcontainer-node-type.md`.
