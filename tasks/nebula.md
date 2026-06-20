# Lumenize Nebula — Master Task File

**License**: UNLICENSED (until external launch)
**Primary App**: `apps/nebula/` in the Lumenize monorepo (not published to npm)
**Auth Package**: `@lumenize/nebula-auth` (separate package in `packages/`, `"private": true`)
**Built on**: `@lumenize/mesh` (MIT) — extends its classes (including `LumenizeClientGateway` via Phase 1.5 hooks)

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

**Extends, not forks.** All Nebula classes extend their Lumenize Mesh counterparts: `NebulaDO extends LumenizeDO`, `NebulaClient extends LumenizeClient`, `NebulaClientGateway extends LumenizeClientGateway`. The Gateway extension is enabled by Phase 1.5's hooks (instance name validation, claims extraction, callContext enrichment, inbound envelope validation). No forking needed.

**Auth**: `@lumenize/nebula-auth` is a separate package (`"private": true`). It exports `routeNebulaAuthRequest` for the entrypoint to compose into its routing. Everything else new goes into `apps/nebula/`.

---

## Demo Roadmap (focus through investor demo)

Investor demo is the near-term focus.

**Shipped so far:** Resources core (storage engine, validation/ontology, the `transaction()` + `subscribe()` engine); the **Vue frontend** (`@lumenize/nebula/frontend` — subscribe wrappers, `client.resources.*`, the reactive store; merged to `main` 2026-06-15); founder root-admin seeding.

**Remaining critical path through the demo:**

1. **✅ Structural DO scope isolation — DONE 2026-06-16 (commit `7c83407`).** Replaced the TOFU `aud`-lock in `NebulaDO.onBeforeCall` with structural scope-from-instance-name for the **tier DOs** (Star/Galaxy/Universe). **Was the blocker for ≥2 Stars under one Galaxy:** under TOFU the shared Galaxy DO locked to the first caller's `aud` and rejected all others, so only the first Star under each Galaxy could fetch its ontology — the rest were non-functional, and the dev Star + any production Star share a Galaxy. Shipped Fix 1 only (the `<scope>:<local>` helper-naming grammar, Fix 2, had no real consumer and is deferred — `tasks/on-hold/nebula-scoped-helper-naming.md`); the `ResourceHistory` fixture was removed. `tasks/archive/nebula-do-scope-isolation.md`.
2. **✅ Dev Star — DONE 2026-06-16.** Studio's sandbox is a plain `Star` at the reserved `{u}.{g}.dev` instance — **no `DevStar` class** (`tasks/nebula-dev-flows.md` Decision 2; it reuses all Star machinery — 3-tuple routing, per-Star SQLite/permissions, root-admin bootstrap). On an ontology change, DevStudio prompts the user to wipe `.dev` data via the **Flow 1b** server→client mesh call (additive edits preserved, breaking ones reset; lazy migration deferred — `tasks/on-hold/nebula-lazy-schema-migrations.md`). URL-level branching is post-demo (`tasks/on-hold/nebula-branches.md`). Build: `tasks/nebula-studio.md`.
3. **Agentic development engine — Kimi 2.7 via Workers AI** (`@cf/moonshotai/kimi-k2.7-code`), a thin native-tool-calling loop **run by DevStudio** — no Think, no codemode (native tool-calling covers the loop; codemode's JSON bridge violates ADR-002). Claude = eval baseline. Viability **validated 2026-06-16**. Model + ontology-annotation conventions (`@title`/`@description`/`@inverse`) + eval strategy + the vibesdk reading task all live in `tasks/nebula-agentic-development-engine.md`.
4. **Studio** — the chat-first authoring experience. Cast: **DevStudio** (orchestrator + source-of-truth), **DevContainer** (disposable vite/HMR checkout), **Studio UI** (chat SPA from Workers Assets), **Preview app** (iframe, vite HMR). Architecture canonical in `tasks/nebula-dev-flows.md`; build plan `tasks/nebula-studio.md`.

**Parked / candidate work** lives in `tasks/on-hold/` (resource history on R2, schema-evolution polish, HTTP transport, docs & coverage, ORM + queries) and `tasks/icebox/` (the superseded capability-tickets premise). It's deliberately *not* enumerated as tracked phases here — pull a file into `tasks/` when a real need surfaces; until then its presence in the folder is the signal. Historical context for the demo-focus refactor is in `tasks/archive/nebula-task-files-refactor.md`.

## Phases

Detail lives in each task file; this table is the index. **Numbering convention:** completed phases keep their numbers — they're frozen history and are cross-referenced as "Phase 1.5", "Phase 3.1", "Phase 5.2.3" across the repo (and several are baked into archived filenames). **Active/forward work is named, not numbered** — so we never have to renumber as the plan shifts. Parked work is intentionally not listed here (see the Demo Roadmap's "Parked / candidate work").

| Phase | Name | Status | Task File |
| --- | --- | --- | --- |
| 0 | Nebula Auth | **Complete** | `tasks/archive/nebula-auth.md` |
| 1 | Refactor Nebula Auth | **Complete** | `tasks/archive/nebula-refactor-auth.md` |
| 1.5 | Mesh Extensibility | **Complete** | `tasks/archive/mesh-extensibility.md` |
| 1.7 | Mesh Gateway Fix | **Complete** | `tasks/archive/nebula-mesh-gateway-fix.md` |
| 1.8 | JWT Active Scope in `aud` | **Complete** | `tasks/archive/nebula-jwt-active-scope.md` |
| 1.9 | Auth Security Hardening | **Complete** | `tasks/archive/nebula-auth-security-hardening.md` |
| 1.95 | Enforce Synchronous Guards | **Complete** | `tasks/archive/nebula-sync-guards-in-lumenize-mesh.md` |
| 1.96 | `verifyNebulaAccessToken` | **Complete** | `tasks/archive/nebula-verify-access-token.md` |
| 2 | Baseline Access Control | **Complete** | `tasks/archive/nebula-baseline-access-control.md` |
| 2.1 | Test Structure Refactor | **Complete** | `tasks/archive/nebula-test-refactor.md` |
| 3 | DAG Tree Access Control | **Complete** (3.1 + 3.2; `getNodeByPath` carry-over tracked in the resources design doc) | `tasks/archive/nebula-dag-tree.md` |
| 4.0 | Isolation Technologies Blog Post | **Complete** | `tasks/archive/nebula-isolation-blog.md` |
| 4.1 | TypeScript as Schema Research | **Complete** | `tasks/archive/nebula-ts-as-schema-research.md` |
| 5 | Resources (architecture umbrella) | **Core shipped** — storage + validation/ontology + `transaction()`/`subscribe()` engine live; design reference | `docs/nebula-resources-design.md` |
| 5.1 | Storage Engine | **Complete** | `tasks/archive/nebula-5.1-storage-engine.md` |
| 5.2 | TypeScript Validation & Ontology | **Complete** | `tasks/archive/nebula-5.2-tsc-validation.md` (overview) |
| — | Nebula Frontend (Vue) — subscribe wrappers, `client.resources.*`, reactive store (formerly Phases 5.3 + 7 + 8) | **Complete** — v1–v5 merged to `main` 2026-06-15; §5.3.8 for-docs probes + deferred flash/debounce remain | `tasks/archive/nebula-frontend.md` |
| — | Structural DO scope isolation (replaced TOFU `aud`-lock; was blocker for multi-Star-per-Galaxy) | **Complete** — built 2026-06-16 (`7c83407`) | `tasks/archive/nebula-do-scope-isolation.md` |
| — | Dev Star (reserved `dev` slug; a plain `Star`, no `DevStar` class) | **Complete** — built + verified 2026-06-16 (`fa9d4fb`) | `tasks/archive/dev-star.md` |
| — | Studio dev/publish flows (canonical architecture + sequence diagrams) | Active — design locked 2026-06-20 | `tasks/nebula-dev-flows.md` |
| — | Agentic development engine (codegen + eval) | Active — demo critical path | `tasks/nebula-agentic-development-engine.md` |
| — | Nebula Studio (build) | Active — demo end-of-line goal | `tasks/nebula-studio.md` |

5.2 sub-phases are tracked in the archived overview at `tasks/archive/nebula-5.2-tsc-validation.md`. Parked/candidate work (resource history on R2, schema-evolution polish, HTTP transport, docs & coverage, ORM + queries, capability tickets) lives in `tasks/on-hold/` and `tasks/icebox/`.

### Phase 3: DAG Tree Access Control

DAG tree inside each Star for organizing resources and controlling access. Phases 3.1 (implementation) and 3.2 (cleanup) complete; archived at `tasks/archive/nebula-dag-tree.md`. The remaining `getNodeByPath(slugPath)` carry-over is tracked in `docs/nebula-resources-design.md` ("DAG Tree Prerequisites" section). Phase 3.0 (SQL performance experiment) archived at `tasks/archive/nebula-dag-tree-experiment.md`.

### Phase 5: Resources

Temporal storage (Snodgrass-style) with subscriptions, fanout, guards, validation, schema evolution, and migrations. Inverted DWL architecture — DO calls out to DWL for guard decisions, resource config, and validation. Key APIs: `transaction()`, `subscribe()`, `read()`/`reads()`. Full design in `docs/nebula-resources-design.md`.

**Resource history storage — decided: R2, not per-resource DOs (2026-06-08).** The unbounded-over-time growth axis (old snapshot blobs) moves off Star SQLite onto **R2**, keyed `<resourceId>/<validFrom>`, with Star keeping the small metadata rows as the eTag source of truth. This **abandons** the earlier "one `ResourceHistory` DO per resourceId" plan (capacity ceiling, map/reduce fan-out across instances, and DO write cost all argued against it). Design: `tasks/on-hold/nebula-resource-history-r2.md`. The `ResourceHistory` class (`apps/nebula/src/resource-history.ts`) was a tenant-scoped-helper *test fixture* only; it was **removed** by `tasks/archive/nebula-do-scope-isolation.md` (commit `7c83407`), which dropped its Fix 2 (helper-naming) scope — see `tasks/on-hold/nebula-scoped-helper-naming.md`.

### Nebula Frontend (Vue) — shipped

Single-resource subscriptions, NebulaClient subscribe wiring + the `client.resources.*` namespace, and the reactive store all shipped as the **`@lumenize/nebula/frontend`** Vue factory (merged to `main` 2026-06-15; formerly tracked as Phases 5.3 + 7 + 8). NebulaClient's base (two-scope model, refresh path, NebulaClientGateway active-scope verification) came from earlier auth work; the factory builds its reactive store on **Vue 3 reactivity** (`@vue/reactivity` + `effectScope`) behind a path-aware Proxy. There is **no `@lumenize/state` / `@lumenize/ui` / `@lumenize/router`** — that JurisJS-derived three-package plan was dropped in the 2026-05-15 Vue/SFC pivot (`@lumenize/state` was published, then deleted with zero importers). Remaining work + the full design live in `tasks/archive/nebula-frontend.md`; the user-facing contract is `website/docs/nebula/coding-your-ui.md` + `api-reference.md`. Discovery-first login, proactive token refresh, WebSocket keepalive, and scope-switching UX are deferred post-demo.

### Schema evolution in dev (deferred)

The in-place lazy / copy-on-read migration runner is **deferred for the demo (2026-06-15)** — `tasks/on-hold/nebula-lazy-schema-migrations.md`. Instead, on an ontology change, additive edits stay readable via the parser's `__fillDefaults`, and DevStudio prompts the user to wipe `.dev` data via the **Flow 1b** server→client mesh call (the `.dev`-guarded `resetDevData`) — see `tasks/nebula-dev-flows.md` Decision 11 + `tasks/nebula-studio.md` (`resetDevData`). Production-polish schema evolution, capability tickets, and R2 history are also parked (see the Demo Roadmap's parked-work note).

### Nebula Studio

The chat-first authoring experience (cast: **DevStudio** + **DevContainer** + **Studio UI** + **Preview app**) where user-developers describe their product and the agentic development engine generates ontology + UI. The demo's end-of-line goal. Architecture canonical in `tasks/nebula-dev-flows.md`; build plan `tasks/nebula-studio.md`; codegen + eval `tasks/nebula-agentic-development-engine.md`. Follow-on ideas: `tasks/nebula-scratchpad.md`.

---

## Key Technical Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| **App structure** | `apps/nebula/` for the deployable app, `packages/nebula-auth/` (`private: true`) for auth library | Apps aren't published; auth is a library consumed by the app |
| **NebulaDO** | Base class extends `LumenizeDO`; `Universe`, `Galaxy`, `Star` extend `NebulaDO` | `onBeforeCall` reserved for base class (universeGalaxyStarId binding); subclasses use `@mesh(guard)` |
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

See `tasks/nebula-scratchpad.md` for deferred items, early-stage ideas (database branching, user-developer testing workflow), and notes captured during planning.

**Known follow-up — browser benchmark auth broken by scope-isolation Fix 1 (2026-06-17).** The structural `onBeforeCall` (`nebula-do-scope-isolation.md`, commit `7c83407`) requires a caller's `aud` to equal the Star it calls (a galaxy-level `aud` is rejected — scope-isolation **T6**). That work's validation ran `baseline`/`unit`/`mesh`/`fetch` but **never the `browser` vitest project**, so the `test/browser/` harness (which minted a galaxy `activeScope` then hit Stars) was left red and uncaught.
- **Fixed (2026-06-17):** the two in-gate browser tests (`flush-spike`, `multi-client`) + `fanout.benchmark`'s `setupMultiClient` call now operate at a **star-level `activeScope`** (the harness `setupMultiClient` takes a required `activeScope`).
- **Still broken (browser-bench / deployed-only — NOT in `npm test`):** `transactions` / `throughput` / `throughput-multi` / `cross-region` benchmarks hit **multiple (incl. random cold) Stars with one minted `aud`**, which the structural guard now forbids. Needs a **benchmark-auth rework** — re-mint `activeScope` per Star, or scope each bench to a single Star. Low priority (perf tooling, not demo-critical).
