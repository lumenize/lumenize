# Lumenize Nebula — Master Task File

**License**: BSL 1.1
**Primary App**: `apps/nebula/` in the Lumenize monorepo (not published to npm)
**Auth Package**: `@lumenize/nebula-auth` (separate package in `packages/`, `"private": true`)
**Built on**: `@lumenize/mesh` (MIT) — extends its classes (including `LumenizeClientGateway` via Phase 1.5 hooks)

---

## What Nebula Is — Walled Garden, Not a Toolkit

Lumenize Nebula is a SaaS vibe coding deployment product built on Lumenize Mesh.

Lumenize Mesh is a flexible open-source toolkit: developers extend LumenizeDO, wire up their own routing, swap in their own auth, choose their own UI framework. Nebula is the opposite — it's a **product, not a toolkit**. The vibe coder never touches the back end. They provide an ontology (data model) and Nebula does everything else: auth, routing, storage, real-time sync, access control. On the client side, they use NebulaClient and NebulaUI (derived from JurisJS) — no React, no Svelte, no choice. User-provided server-side logic (guards, migrations, validation) runs in sandboxed Cloudflare Dynamic Worker Loader (DWL) isolates or Cloudflare Containers sandbox. Data extraction integrations get clear REST endpoints but nothing more.

**This matters for design decisions.** When writing Nebula task files, don't offer escape hatches, configuration alternatives, or "the developer can do X instead." If there's one right way, that's the only way. Guard against footguns by removing the footgun, not by documenting it.

---

## Package Architecture

```
@lumenize/mesh (MIT)                apps/nebula/ (BSL 1.1)
┌──────────────────────┐            ┌──────────────────────────────┐
│ LumenizeDO           │───extends─▶│ NebulaDO (base class)        │
│ LumenizeClient       │───extends─▶│ NebulaClient                 │
│ LumenizeClientGateway│───extends─▶│ NebulaClientGateway          │
└──────────────────────┘            │ Universe, Galaxy, Star,      │
                                    │   ResourceHistory            │
                                    │ entrypoint.ts (Worker router)│
@lumenize/nebula-auth (BSL 1.1)     │ Access Control (DAG tree)    │
┌───────────────────────┐           │ Resources engine (DWL)       │
│ NebulaAuth DO         │─ import ─▶│ Schema evolution             │
│ NebulaAuthRegistry    │           │ ResourcesWorker (DWL base)   │
│ routeNebulaAuthRequest│           │ NebulaUI (JurisJS port)      │
│ Types & utilities     │           └──────────────────────────────┘
└───────────────────────┘
```

**Extends, not forks.** All Nebula classes extend their Lumenize Mesh counterparts: `NebulaDO extends LumenizeDO`, `NebulaClient extends LumenizeClient`, `NebulaClientGateway extends LumenizeClientGateway`. The Gateway extension is enabled by Phase 1.5's hooks (instance name validation, claims extraction, callContext enrichment, inbound envelope validation). No forking needed.

**Auth**: `@lumenize/nebula-auth` is a separate package (`"private": true`). It exports `routeNebulaAuthRequest` for the entrypoint to compose into its routing. Everything else new goes into `apps/nebula/`.

---

## Demo Roadmap (focus through investor demo)

Investor demo is the near-term focus. The phase table below marks held items as **On Hold — demo focus** with a path under `tasks/on-hold/`. Critical path through the demo:

1. Resources fundamentals (5.1 done; 5.2 in progress; 5.3 single-resource subscribe).
2. Dev-mode lazy / copy-on-read migrations (5.5 dev-mode subset).
3. Dev-mode branching — single Star, in-place.
4. NebulaClient subscribe wrappers (Phase 7 — single-resource only).
5. `@lumenize/ui` (Phase 8) — JurisJS-derived MIT package.
6. Studio (Phase 9, renamed from "Vibe Coding IDE").

See `tasks/nebula-task-files-refactor.md` for the full plan, the on-hold list, and the spikes (Studio cold-start, hosting choice, `@lumenize/ui` inventory, preview-URL auto-refresh).

## Phases

Each phase produces testable, working code that only depends on prior phases. Detail lives in each task file; this table is the index. Completed phases have summaries in their archived task files.

| Phase | Name | Status | Task File |
| --- | --- | --- | --- |
| 0 | Nebula Auth | **Complete** | `tasks/archive/nebula-auth.md` |
| 1 | Refactor Nebula Auth | **Complete** | `tasks/archive/nebula-refactor-auth.md` |
| 1.5 | Mesh Extensibility | **Complete** | `tasks/mesh-extensibility.md` |
| 1.7 | Mesh Gateway Fix | **Complete** | `tasks/archive/nebula-mesh-gateway-fix.md` |
| 1.8 | JWT Active Scope in `aud` | **Complete** | `tasks/archive/nebula-jwt-active-scope.md` |
| 1.9 | Auth Security Hardening | **Complete** | `tasks/archive/nebula-auth-security-hardening.md` |
| 1.95 | Enforce Synchronous Guards | **Complete** | `tasks/archive/nebula-sync-guards-in-lumenize-mesh.md` |
| 1.96 | `verifyNebulaAccessToken` | **Complete** | `tasks/archive/nebula-verify-access-token.md` |
| 2 | Baseline Access Control | **Complete** | `tasks/archive/nebula-baseline-access-control.md` |
| 2.1 | Test Structure Refactor | **Complete** | `tasks/archive/nebula-test-refactor.md` |
| 3 | DAG Tree Access Control | **Complete** (3.1 + 3.2; `getNodeByPath` carry-over tracked in Phase 5 file) | `tasks/archive/nebula-dag-tree.md` |
| 4.0 | Isolation Technologies Blog Post | **Complete** | `tasks/archive/nebula-isolation-blog.md` |
| 4.1 | TypeScript as Schema Research | **Complete** | `tasks/archive/nebula-ts-as-schema-research.md` |
| 5 | Resources | In Progress | `tasks/nebula-5-resources.md` (design) |
| 5.1 | Storage Engine | **Complete** | `tasks/archive/nebula-5.1-storage-engine.md` |
| 5.2 | TypeScript Validation & Ontology | In Progress | `tasks/nebula-5.2-tsc-validation.md` (overview) |
| 5.3 | Subscriptions & Fanout | Active — demo critical path (single-resource only) | `tasks/nebula-5.3-subscriptions.md` |
| 5.4 | Capability Tickets | **On Hold — demo focus** | `tasks/on-hold/nebula-5.4-capability-tickets.md` |
| 5.5 (dev-mode) | In-Place Lazy Migrations | Active — demo critical path | `tasks/nebula-5.5-dev-mode-migrations.md` |
| 5.5 (production polish) | Schema Evolution | **On Hold — demo focus** | `tasks/on-hold/nebula-5.5-schema-evolution.md` |
| 5.6 | HTTP Transport | **On Hold — demo focus** | `tasks/on-hold/nebula-5.6-http-transport.md` |
| 5.7 | Documentation & Coverage | **On Hold — demo focus** | `tasks/on-hold/nebula-5.7-docs-coverage.md` |
| 7 | Nebula Client | Active — demo critical path | `tasks/nebula-7-client.md` |
| 8 | Nebula UI (`@lumenize/ui`) | Active — demo critical path | `tasks/lumenize-ui.md` |
| 9 | Nebula Studio | Active — demo end-of-line goal | `tasks/nebula-studio.md` |
| — | Dev-Mode Branching (single Star, in-place) | Active — demo critical path | `tasks/dev-mode-branching.md` |

5.2 sub-phases are tracked in `tasks/nebula-5.2-tsc-validation.md`.

### Phase 3: DAG Tree Access Control

DAG tree inside each Star for organizing resources and controlling access. Phases 3.1 (implementation) and 3.2 (cleanup) complete; archived at `tasks/archive/nebula-dag-tree.md`. The remaining `getNodeByPath(slugPath)` carry-over is tracked in `tasks/nebula-5-resources.md` ("DAG Tree Prerequisites" section). Phase 3.0 (SQL performance experiment) archived at `tasks/archive/nebula-dag-tree-experiment.md`.

### Phase 5: Resources

Temporal storage (Snodgrass-style) with subscriptions, fanout, guards, validation, schema evolution, and migrations. Inverted DWL architecture — DO calls out to DWL for guard decisions, resource config, and validation. Key APIs: `transaction()`, `subscribe()`, `read()`/`reads()`. Full design in `tasks/nebula-5-resources.md`.

### Phases 5.3, 5.5 (dev-mode subset) — demo critical path

5.3 single-resource subscriptions and 5.5's dev-mode in-place lazy migration runner are active. Production polish on 5.4, 5.5 (full), 5.6, 5.7 is on hold (see Demo Roadmap).

### Phase 7: Nebula Client

Discovery-first login, proactive token refresh, WebSocket keepalive, subscription management, scope switching. Builds on Phase 2 foundation. Design in `tasks/nebula-7-client.md`.

### Phase 8: Nebula UI (`@lumenize/ui`)

JurisJS-derived MIT package. Local state management mirrors remote — synced and local state look the same in component code. Design in `tasks/lumenize-ui.md`.

### Phase 9: Nebula Studio

Conversational interface where vibe coders describe their product and the AI generates ontology + UI. Studio is the demo's end-of-line goal. Design in `tasks/nebula-studio.md`. See `tasks/nebula-scratchpad.md` for follow-on ideas.

---

## Key Technical Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| **App structure** | `apps/nebula/` for the deployable app, `packages/nebula-auth/` (`private: true`) for auth library | Apps aren't published; auth is a library consumed by the app |
| **NebulaDO** | Base class extends `LumenizeDO`; `Universe`, `Galaxy`, `Star`, and `ResourceHistory` extend `NebulaDO` | `onBeforeCall` reserved for base class (universeGalaxyStarId binding); subclasses use `@mesh(guard)` |
| **NebulaClientGateway** | Extends `LumenizeClientGateway` (via Phase 1.5 hooks) | Overrides `onBeforeCallToClient` for active-scope verification; reads active scope from JWT `aud` claim (Phase 1.8) |
| **NebulaClient** | Extends `LumenizeClient` | Gets WebSocket management, token refresh, tab detection, Browser injection for testing |
| **Access control** | Four layers: entrypoint `verifyNebulaAccessToken` → Gateway `onBeforeCallToClient` active-scope check → `onBeforeCall` universeGalaxyStarId binding → `@mesh(guard)` | Entrypoint rejects early; Gateway verifies mesh→client scope match; base class locks DO to active scope; guards handle method-level auth |
| **DAG permissions** | Grant if any ancestor path grants | Simple model: admin > write > read. Roll-down through tree. |
| **DWL architecture** | Inverted — DO calls OUT to DWL | DWL is callback provider. DO owns storage, subscriptions, fanout. |
| **`transaction()`**** API** | Mixed upserts/deletes, single-phase pessimistic eTag check inside `transactionSync` | Minimizes DWL round-trips (billing), ensures atomicity despite input gate opening |
| **Schema** | TypeScript types, not DSL | No Zod, TypeBox, or JSON Schema. `.d.ts` is the source of truth. |
| **Testing** | E2e strongly favored, Browser.fetch/WebSocket injection | Dogfood `@lumenize/testing`; integration tests are primary |

---

## Research Notes

See Phase 4.0 (`tasks/archive/nebula-isolation-blog.md`) for detailed notes on DWL, codemode, Containers, and Sandbox SDK. See Phase 4.1 (`tasks/archive/nebula-ts-as-schema-research.md`) for the TypeScript-as-schema research. Clean decision: `docs/adr/001-typescript-as-schema.md`.

---

## Deferred Items & Scratchpad

See `tasks/nebula-scratchpad.md` for deferred items, early-stage ideas (database branching, vibe coder testing workflow), and notes captured during planning.
