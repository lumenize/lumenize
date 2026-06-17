# DevContainer — the 4th Lumenize node type (+ reusable mesh-node-core seam)

**Status**: Designing — **hard prerequisite** to the container-vite pivot (`tasks/nebula-studio.md` § *UI-build architecture*). Decided pre-demo 2026-06-17.
**Phase**: Studio container-vite pivot — foundation (build before the dev-loop reshape + the Q5 spike).
**App**: `packages/mesh` (the reusable node seam) + `apps/nebula` (`NebulaContainer`) — **Mesh framework + Nebula layer**. Commits **ADR-007**.

**Why this exists:** the pivot makes the dev preview a **`DevContainer` DO** that fronts a vite container (`nebula-studio.md` § *UI-build architecture*). DevContainer is a sibling of `DevStar`, not the Star — but it must still be a **full mesh node**: receive (and make) `lmz.call()`, run the `onBeforeCall` scope guard, sit behind the Gateway's JWT check like every other node. The agent→DevContainer command channel (Q5, `tasks/spike-container-agent-channel.md`) is itself `lmz.call`, so **DevContainer must be a node before Q5 can run against it**. `DevContainer extends @cloudflare/containers Container` (which extends `DurableObject`), so it **cannot inherit `LumenizeDO`** — the core must come in by composition. ADR-007 commits the invariant.

**Good news (mapped 2026-06-17):** the core is already composition-based, not inheritance-bound — `executeEnvelope()` ([lmz-api.ts:841](../packages/mesh/src/lmz-api.ts)) behind the minimal `EnvelopeExecutorNode` interface ([lmz-api.ts:812](../packages/mesh/src/lmz-api.ts)) = `{ lmz, onBeforeCall(), __executeChain() }`. `LumenizeDO`/`LumenizeWorker`/`LumenizeClient` each *call* it; none inherits it. JWT is verified at the Gateway ([lumenize-client-gateway.ts:206](../packages/mesh/src/lumenize-client-gateway.ts)), not per-node; the "JWT hook" is `onBeforeCall`, and `NebulaDO.onBeforeCall` ([nebula-do.ts:47](../apps/nebula/src/nebula-do.ts)) enforces scope isolation via `matchAccess(pattern, aud)`. So this is *formalize a seam that exists + drop in the 4th type*, not *untangle a mess*.

## What this owns
1. **Formalize the reusable mesh-node seam** so a class extending a third-party base composes it ergonomically.
2. **Audit the 3 existing node types + consolidate** any *unjustified* divergence (ADR-007).
3. **Build the 4th type**: `LumenizeContainer` (mesh) + `NebulaContainer` (nebula scope guard), mirroring `LumenizeDO`/`NebulaDO`.

Owned **elsewhere — pointers, not restatements:** the vite dev-loop / HMR / DO-proxy serving + the scope-injection relocation → the #1a reshape (container dev-loop). The agent command channel + its latency → `tasks/spike-container-agent-channel.md` (Q5). Source durability → `tasks/nebula-app-versioning.md` (Q6). This file is **the node, not the container's job.**

## Decisions pinned
- **Composition via `EnvelopeExecutorNode`** (the existing seam), not a common base class. Reuse mechanism decided in P1: a **`withLumenizeMesh(Base)` mixin** (reusable for any future third-party base) vs. a concrete **`LumenizeContainer extends Container`** base — lean mixin if typing is acceptable, else the concrete base.
- **`NebulaContainer extends <the container node base>`** carries the scope-isolation `onBeforeCall` — **reuse `buildAuthScopePattern` + `matchAccess`**, do not re-derive (mirror `NebulaDO`, `tasks/nebula-do-scope-isolation.md`).
- **JWT stays at the Gateway.** DevContainer is DO-side, so it uses the **ALS `callContext` path** like `LumenizeDO` — the Client's explicit-field divergence (justified, browser/Node compat) does **not** apply here.
- **No raw RPC.** Agent↔DevContainer and DevContainer↔anything is `lmz.call`/`ctn` (mesh.md, ADR-003).

## Phases (provisional)

### Phase 1 — Audit + extract the seam
- Read the 3 node types' `executeEnvelope` wiring; produce a **divergence inventory**, each item marked *justified* (documented, e.g. the `callContext` ALS-vs-field) or *defect → consolidate*.
- Decide + implement the reusable form (`withLumenizeMesh(Base)` mixin or `LumenizeContainer` base).
- **Success:** a documented seam (interface + "how to compose a node") + the audit inventory with every divergence justified-or-fixed; existing DO/Worker/Client tests stay green (no behavior change to them).

### Phase 2 — `LumenizeContainer` (mesh layer)
- `extends Container` (`@cloudflare/containers`) + implements `EnvelopeExecutorNode` + wires `executeEnvelope` + `lmz` via the shared factory; no-op `onBeforeCall` (secure-by-default opt-in, like the other bases).
- **Success (capable-of-failing):** a `LumenizeContainer` instance **receives an `lmz.call`** end-to-end (integration, full path) and its `onBeforeCall` fires (debug-sink marker, mutation-checked — testing.md); `Container` lifecycle (`ctx.storage`, ports) coexists with the mesh core (no base-class conflict).

### Phase 3 — `NebulaContainer` (nebula layer)
- `extends LumenizeContainer`; `onBeforeCall` enforces scope isolation reusing `buildAuthScopePattern`/`matchAccess` (mirror `NebulaDO`).
- Update the **B5 frozen non-admin allow-list** (`scope-isolation.test.ts`) if the new type adds reachable methods.
- **Success (mirroring `scope-isolation.test.ts`):** a **genuinely-minted** (not forged) cross-scope / non-admin caller is **rejected** and writes nothing; an in-scope caller passes; ADR-002 cross-boundary error test.

### Phase 4 — Coexistence smoke (node + container, together)
- A `NebulaContainer` that *also* fronts a real container (the minimal `containerFetch` proxy) — prove the **mesh node + the `Container` lifecycle run in one DO** with no conflict. The full vite/proxy/reload build is the #1a reshape; this is only the "do they coexist" gate.
- **Success:** one `NebulaContainer` instance both answers an `lmz.call` (guarded) **and** proxies an HTTP GET to its container.

## Out of scope
- The vite dev-loop, HMR, DO-proxy serving, scope-injection relocation → #1a reshape.
- The agent command channel + latency → Q5 spike (`tasks/spike-container-agent-channel.md`).
- Source durability (Galaxy dual-write/rehydrate) → #1b (`tasks/nebula-app-versioning.md`).
- Prod static-asset serving → the prod-serve task.

## References
`docs/adr/007-shared-node-security-core.md` (the invariant this builds); `packages/mesh/src/lmz-api.ts` (`executeEnvelope` / `EnvelopeExecutorNode`), `lumenize-do.ts` / `lumenize-worker.ts` / `lumenize-client.ts` (the 3 current types), `lumenize-client-gateway.ts` (Gateway JWT); `apps/nebula/src/nebula-do.ts` + `tasks/nebula-do-scope-isolation.md` (the scope-guard to mirror); `tasks/nebula-studio.md` § *UI-build architecture* (the pivot); `tasks/spike-container-agent-channel.md` (Q5, depends on this); `.claude/rules/mesh.md` (no raw RPC).
