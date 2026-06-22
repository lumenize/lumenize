# Lumenize Nebula — Master Map

**License**: UNLICENSED (until external launch)
**Primary App**: `apps/nebula/` in the Lumenize monorepo (not published to npm)
**Auth Package**: `@lumenize/nebula-auth` (separate package in `packages/`, `"private": true`)
**Built on**: `@lumenize/mesh` (MIT) — extends its classes (including `LumenizeClientGateway` via the mesh-extensibility hooks)

> **What this file is:** the whole-product map — what Nebula is, how it's wired, what's decided, what's live, and what's next. It is **not** a phase ledger. Forward work is **named, not numbered**; the old `5.x`-style phase numbering is retired and survives only as frozen identifiers baked into archived filenames (see *Shipped*). Architecture detail lives in `tasks/nebula-dev-flows.md`; the active build/roadmap docs are linked under *Active work*.

---

## What Nebula Is — Walled Garden, Not a Toolkit

Lumenize Nebula is a SaaS vibe coding deployment product built on Lumenize Mesh.

Lumenize Mesh is a flexible open-source toolkit: developers extend LumenizeDO, wire up their own routing, swap in their own auth, choose their own UI framework. Nebula is the opposite — it's a **product, not a toolkit**. The user-developer never touches the back end. They provide an ontology (data model) and Nebula does everything else: auth, routing, storage, real-time sync, access control. On the client side, they use NebulaClient plus the Vue-based `@lumenize/nebula/frontend` factory (Vue 3 under the hood) — no React, no Svelte, no choice. User-provided server-side logic (guards, migrations, validation) runs in sandboxed Cloudflare Dynamic Worker Loader (DWL) isolates or Cloudflare Containers sandbox. Data extraction integrations get clear REST endpoints but nothing more.

**This matters for design decisions.** When writing Nebula task files, don't offer escape hatches, configuration alternatives, or "the developer can do X instead." If there's one right way, that's the only way. Guard against footguns by removing the footgun, not by documenting it.

---

## Package Architecture

```
@lumenize/mesh (MIT)                apps/nebula/ (UNLICENSED)
┌──────────────────────┐            ┌──────────────────────────────┐
│ LumenizeDO           │───extends─▶│ NebulaDO (base class)        │
│ LumenizeClient       │───extends─▶│ NebulaClient                 │
│ LumenizeClientGateway│───extends─▶│ NebulaClientGateway          │
└──────────────────────┘            │ Universe, Galaxy, Star       │
                                    │                              │
                                    │ entrypoint.ts (Worker router)│
@lumenize/nebula-auth (UNLICENSED)  │ Access Control (DAG tree)    │
┌───────────────────────┐           │ Resources engine (DWL)       │
│ NebulaAuth DO         │─ import ─▶│ Schema evolution             │
│ NebulaAuthRegistry    │           │ ResourcesWorker (DWL base)   │
│ routeNebulaAuthRequest│           │ Vue frontend factory         │
│ Types & utilities     │           └──────────────────────────────┘
└───────────────────────┘
```

**Extends, not forks.** All Nebula classes extend their Lumenize Mesh counterparts: `NebulaDO extends LumenizeDO`, `NebulaClient extends LumenizeClient`, `NebulaClientGateway extends LumenizeClientGateway`. The Gateway extension is enabled by the mesh-extensibility hooks (instance name validation, claims extraction, callContext enrichment, inbound envelope validation). No forking needed.

**Auth**: `@lumenize/nebula-auth` is a separate package (`"private": true`). It exports `routeNebulaAuthRequest` for the entrypoint to compose into its routing. Everything else new goes into `apps/nebula/`.

---

## Active work (the live center)

Investor demo is the near-term focus. The dev-loop **infrastructure is built** and the live Studio loop works end-to-end on real infra — the remaining critical path is codegen *quality*, not plumbing.

- **Agentic development engine** (codegen + eval) — **the active forward-planning doc**: `tasks/nebula-agentic-development-engine.md` (Part 1 design, Part 2 ordered roadmap). Kimi 2.7 via Workers AI, a thin native-tool-calling loop run by DevStudio; no Think, no codemode (ADR-002). Viability validated 2026-06-16. Cheapest next rung: the **turn recorder**.
- **Nebula Studio** (chat-first authoring; cast: **DevStudio** + **DevContainer** + **Studio UI** + **Preview app**) — dev-loop infra **built 2026-06-21**; build file `tasks/nebula-studio.md` (publish tail is post-demo). Architecture canonical in `tasks/nebula-dev-flows.md`.

Post-demo work is a **live candidate pool**, not a backlog graveyard — see *Deferred & candidate index*.

---

## Key Technical Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| **App structure** | `apps/nebula/` for the deployable app, `packages/nebula-auth/` (`private: true`) for auth library | Apps aren't published; auth is a library consumed by the app |
| **NebulaDO** | Base class extends `LumenizeDO`; `Universe`, `Galaxy`, `Star` extend `NebulaDO` | `onBeforeCall` reserved for base class (universeGalaxyStarId binding); subclasses use `@mesh(guard)` |
| **NebulaClientGateway** | Extends `LumenizeClientGateway` (via the mesh-extensibility hooks) | Overrides `onBeforeCallToClient` for active-scope verification; reads active scope from JWT `aud` claim |
| **NebulaClient** | Extends `LumenizeClient` | Gets WebSocket management, token refresh, tab detection, Browser injection for testing |
| **Access control** | Four layers: entrypoint `verifyNebulaAccessToken` → Gateway `onBeforeCallToClient` active-scope check → `onBeforeCall` universeGalaxyStarId binding → `@mesh(guard)` | Entrypoint rejects early; Gateway verifies mesh→client scope match; base class locks DO to active scope; guards handle method-level auth |
| **DAG permissions** | Grant if any ancestor path grants | Simple model: admin > write > read. Roll-down through tree. |
| **DWL architecture** | Inverted — DO calls OUT to DWL | DWL is callback provider. DO owns storage, subscriptions, fanout. |
| **`transaction()` API** | Mixed upserts/deletes, single-phase pessimistic eTag check inside `transactionSync` | Minimizes DWL round-trips (billing), ensures atomicity despite input gate opening |
| **Schema** | TypeScript types, not DSL | No Zod, TypeBox, or JSON Schema. `.d.ts` is the source of truth (ADR-001). |
| **Resource history** | R2 (`<resourceId>/<validFrom>`), not per-resource DOs | Unbounded growth moves off Star SQLite; Star keeps eTag metadata (ADR-004; mechanics `tasks/on-hold/nebula-resource-history-r2.md`) |
| **Testing** | E2e strongly favored, Browser.fetch/WebSocket injection | Dogfood `@lumenize/testing`; integration tests are primary |

---

## Shipped (history index)

The foundation is built and frozen in `tasks/archive/`. Those task files keep old phase numbers in their **filenames** (e.g. `nebula-5.2-tsc-validation.md`) — **frozen historical identifiers only**, not a live taxonomy. Pillars:

- **Auth + identity** — Nebula Auth, the two-scope model (`authScope` cookie path + `activeScope` JWT `aud`), security hardening, `verifyNebulaAccessToken` → `tasks/archive/nebula-auth.md` + siblings.
- **Access control** — baseline + DAG-tree permissions → `tasks/archive/nebula-baseline-access-control.md`, `tasks/archive/nebula-dag-tree.md`. (`getNodeByPath(slugPath)` carry-over tracked in `docs/archive-and-outdated/nebula-resources-design.md`.)
- **Resources core** — storage engine, TS validation/ontology, the `transaction()`/`subscribe()`/`read()` engine → `tasks/archive/nebula-5.1-storage-engine.md`, `tasks/archive/nebula-5.2-tsc-validation.md`; full design `docs/archive-and-outdated/nebula-resources-design.md`.
- **Vue frontend** — the `@lumenize/nebula/frontend` factory (Vue 3 reactivity behind a path-aware Proxy), merged to `main` 2026-06-15 → `tasks/archive/nebula-frontend.md`; user docs `website/docs/nebula/coding-your-ui.md` + `api-reference.md`.
- **Structural DO scope isolation** + **dev Star** (reserved `.dev` slug instance) → `tasks/archive/nebula-do-scope-isolation.md`, `tasks/archive/dev-star.md`.
- **Studio dev-loop infrastructure** — DevStudio/DevContainer, the DevStar→Star collapse, the live version contract (built 2026-06-21; build file `tasks/nebula-studio.md`).
- **Mesh/platform foundations** — mesh-extensibility hooks, gateway fix, synchronous guards, JWT active-scope-in-`aud` → `tasks/archive/` (mesh-extensibility, nebula-mesh-gateway-fix, nebula-sync-guards-in-lumenize-mesh, nebula-jwt-active-scope).

**Research records:** `tasks/archive/nebula-isolation-blog.md` (DWL/codemode/Containers), `tasks/archive/nebula-ts-as-schema-research.md` (clean decision `docs/adr/001-typescript-as-schema.md`).

---

## Deferred & candidate index (gates re-checked 2026-06-22)

The container-loop pivot is done, so nothing in `on-hold/` is dead — it's a **live candidate pool**, not a graveyard. The immediate "next" is the **Studio engine roadmap** (`tasks/nebula-agentic-development-engine.md` Part 2), *not* this pile. Drift-audited 2026-06-22: all specs are clean on the post-pivot model (no DevStar-class / Galaxy-ontology-registry / branches-as-dev / pull-not-push assumptions); only `tasks/nebula-scratchpad.md` carried stale notes (now annotated). Grouped by what each is actually waiting on:

- **Rides the Studio roadmap** (resume *with* the engine work): `tasks/on-hold/nebula-skills.md`, `tasks/on-hold/nebula-studio-eval-suite.md`, `tasks/nebula-tenant-ai-billing.md`; further out, `tasks/on-hold/distributed-cpg-security-analysis.md` (gated on `tasks/on-hold/mesh-call-tracing-and-ids.md` V0 + Studio LLM infra).
- **Available now, low-risk quick wins** (gate fully passed, demo-independent): `tasks/nebula-nightly-loop.md` (Phase 0 = `/consolidate-memory`), `tasks/on-hold/dag-client-supplied-nodeid.md`, `tasks/on-hold/broadcast-origin-transparency.md` (prereq scope-isolation landed), `tasks/on-hold/mesh-active-callcontext-guard.md`.
- **Post-demo backlog** (live, correctly deferred until after the demo): `tasks/on-hold/mesh-overload-backpressure-handling.md`, `tasks/on-hold/mesh-resilience-testing.md`, `tasks/on-hold/mesh-cost-guidance-rebalance.md` (docs pass), `tasks/on-hold/mesh-call-tracing-and-ids.md`, `tasks/on-hold/nebula-orm-and-queries.md`, `tasks/on-hold/nebula-resource-history-r2.md`, `tasks/on-hold/wire-merge-patch-sync.md`, `tasks/on-hold/nebula-release-process.md` + `tasks/on-hold/release-process-improvements.md`, `tasks/on-hold/nebula-observability-tail-worker-r2-ae.md` (also gated on prod volume).
- **Gated on `tasks/mesh-origin-request.md`**: `tasks/nebula-request-access.md`, `tasks/nebula-star-root-admin.md` Part 1b (Part 2 is ready now).

Scratchpad / early-stage ideas → `tasks/nebula-scratchpad.md`.

**Known follow-up — browser benchmark auth broken by scope-isolation (2026-06-17).** The structural `onBeforeCall` (`tasks/archive/nebula-do-scope-isolation.md`, commit `7c83407`) requires a caller's `aud` to equal the Star it calls; the `test/browser/` benchmark harness minted a galaxy-level `aud` and hit multiple Stars. The two in-gate browser tests were fixed (2026-06-17, star-level `activeScope`); the deployed-only benchmarks (`transactions`/`throughput`/`throughput-multi`/`cross-region`, **not** in `npm test`) still need a benchmark-auth rework (re-mint `activeScope` per Star). Low priority — perf tooling, not demo-critical.
