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

## Sub-Tasks

Each phase produces testable, working code that only depends on prior phases. Placeholder/dummy methods in earlier phases get replaced by real implementations in later phases — typically with higher-level integration or e2e tests.

| Phase | Name | Status | Task File |
|-------|------|--------|-----------|
| 0 | Nebula Auth | **Complete** | `tasks/archive/nebula-auth.md` |
| 1 | Refactor Nebula Auth | **Complete** | `tasks/archive/nebula-refactor-auth.md` |
| 1.5 | Mesh Extensibility | **Complete** | `tasks/mesh-extensibility.md` |
| 1.7 | Mesh Gateway Fix | **Complete** | `tasks/archive/nebula-mesh-gateway-fix.md` |
| 1.8 | JWT Active Scope in `aud` | **Complete** | `tasks/archive/nebula-jwt-active-scope.md` |
| 1.9 | Auth Security Hardening | **Complete** | `tasks/archive/nebula-auth-security-hardening.md` |
| 1.95 | Enforce Synchronous Guards (in `@lumenize/mesh`) | **Complete** | `tasks/archive/nebula-sync-guards-in-lumenize-mesh.md` |
| 1.96 | `verifyNebulaAccessToken` | **Complete** | `tasks/archive/nebula-verify-access-token.md` |
| 2 | Baseline Access Control | **Complete** | `tasks/archive/nebula-baseline-access-control.md` |
| 2.1 | Test Structure Refactor | **Complete** | `tasks/archive/nebula-test-refactor.md` |
| 3 | DAG Tree Access Control | Pending | `tasks/nebula-dag-tree.md` |
| 4 | User-provided Code Isolation Research | Pending | `tasks/nebula-isolation-research.md` |
| 5 | Resources — Basic Functionality | Pending | `tasks/nebula-resources.md` |
| 5.5 | Resource Capability Tickets | Pending | `tasks/nebula-resource-capability-tickets.md` |
| 6 | Resources — Schema Migration | Pending | `tasks/nebula-schema-migration.md` |
| 7 | Nebula Client | Pending | `tasks/nebula-client.md` |
| 8 | Nebula UI | Pending | TBD |
| 9 | Nebula Vibe Coding IDE | Pending | `tasks/nebula-vibe-coding-ide.md` |

### Phase 0: Nebula Auth — COMPLETE

Multi-tenant auth with `universe.galaxy.star` hierarchy. Two DO classes (NebulaAuth + NebulaAuthRegistry), magic link login, JWT access tokens, admin roles, delegation, self-signup, email-based discovery. 242 tests (after Phase 1.8 additions), 80.59% branch coverage.

**Deliverables**: `@lumenize/nebula-auth` package with NebulaAuth DO, NebulaAuthRegistry DO, NebulaEmailSender, Worker router, and comprehensive test suite.

### Phase 1: Refactor Nebula Auth

Make nebula-auth a clean library for importing into the main Nebula Worker. Trim exports, rename `handleRequest` → `routeNebulaAuthRequest`, push `wrangler.jsonc` down into `test/` so the package doesn't look deployable at first glance.

### Phase 1.5: Mesh Extensibility — COMPLETE

Added extension points to `@lumenize/mesh` (MIT) so Nebula can subclass rather than fork. Two features shipped as a single Mesh release: (1) LumenizeClientGateway hooks — overridable methods for instance name validation, claims extraction, callContext enrichment, inbound envelope validation (`onBeforeCallToClient` receives `connectionInfo`), and binding name; (2) LumenizeDO `onRequest()` lifecycle hook for HTTP request handling. Documentation across gateway.mdx, lumenize-do.mdx, mesh-api.mdx, and security.mdx. 917 tests passing.

### Phase 1.7: Mesh Gateway Fix — COMPLETE

Unified `WebSocketAttachment` into `GatewayConnectionInfo` (single type for attachment and hooks), added required `bindingName` (from routing header) and `instanceName`, auto-included all JWT claims, simplified default `onBeforeAccept` to validation-only, changed `routeNebulaAuthRequest` to fallthrough pattern (`undefined` for non-matching paths). 634 mesh tests, 231 nebula-auth tests passing.

### Phase 1.8: JWT Active Scope in `aud` Claim — COMPLETE

Put the active scope (universeGalaxyStarId) into the JWT `aud` claim. The refresh endpoint requires an `activeScope` field in the JSON request body; the server validates the requested scope is covered by the user's `access` pattern via `matchAccess`, then mints the access token with `aud` set to that scope. Removed the static `NEBULA_AUTH_AUDIENCE` constant. Renamed `access.id` → `access.authScopePattern` and `buildAccessId` → `buildAuthScopePattern`. Delegated token endpoint requires the same `activeScope` body field. 242 nebula-auth tests passing.

This eliminates the `~`-delimited Gateway instanceName design from Phase 2 — NebulaClient uses standard `${sub}.${tabId}` format, and the Gateway reads the active scope from JWT claims (`aud`) instead of parsing the instanceName.

### Phase 1.9: Auth Security Hardening — COMPLETE

Hardened `@lumenize/nebula-auth` against vulnerabilities from security review. Seven fixes: (1) invite token replay — delete after use like magic links, (2) `discover` endpoint added to Turnstile gating, (3) registry no longer uses `parseJwtUnsafe` — router passes verified access claim in request body, (4) public key cache removed — keys imported fresh each request, (5) DO-level `adminApproved` check in `#verifyRefreshTokenIdentity` as defense-in-depth for RPC bypass, (6) email format validation on registry claim paths (`claimUniverse`, `claimStar`), (7) instance name format validation in router via `parseId()`. 254 tests (12 new), all passing.

### Phase 1.95: Enforce Synchronous Guards (in `@lumenize/mesh`) — COMPLETE

Enforced synchronous `MeshGuard` and `onBeforeCall` across all three base classes. `MeshGuard<T>` type drops `Promise<void>`, guard invocation drops `await`, `LumenizeClient.onBeforeCall` drops `Promise<void>` and its invocation drops `await`. DO and Worker confirmed already sync. Test guard methods renamed from `guardedAsyncMethod` → `guardedMethod` etc. Doc updated (`mesh-api.mdx`). 758 mesh tests passing. Breaking change to `@lumenize/mesh` (deferred to Nebula release).

### Phase 1.96: `verifyNebulaAccessToken` — COMPLETE

New export from `@lumenize/nebula-auth` that consolidates JWT verification logic previously spread across three sites (`verifyAndGateJwt`, `checkJwtForRegistry`, `#verifyBearerToken`). Encapsulates key loading (blue/green rotation), signature verification, standard claims validation (`aud`, `iss`, `sub`, `access.authScopePattern`), and `matchAccess(authScopePattern, aud)` internal-consistency check. Returns `NebulaJwtPayload | null`. All three existing verification sites refactored to call it as their foundation, layering site-specific checks (admin gate, target matchAccess, local subject lookup) on top. Closes a gap where `#verifyBearerToken` skipped `aud`/`iss`/`authScopePattern` validation and `checkJwtForRegistry` lacked `authScopePattern` presence + internal-consistency checks. 272 nebula-auth tests passing (18 new).

### Phase 2: Baseline Access Control

Create `apps/nebula/` with five DO classes (`NebulaDO` base, `Universe`, `Galaxy`, `Star`, `ResourceHistory`), `NebulaClientGateway` (extends `LumenizeClientGateway` via Phase 1.5 hooks), `NebulaClient`, and the Worker entrypoint. Four-layer security model: entrypoint JWT verification via `verifyNebulaAccessToken` (Phase 1.96), Gateway active-scope verification (`onBeforeCallToClient`), NebulaDO's `onBeforeCall` universeGalaxyStarId binding (permanently locks each DO instance to the active scope that first accessed it), and `@mesh(guard)` per-method authorization. NebulaClient uses standard `${sub}.${tabId}` instanceName format and the two-scope model (auth scope for refresh cookies, active scope via JWT `aud`). Dummy methods validate the security scenarios with abuse case testing via e2e tests, including cross-active-scope rejection and admin scope switching at all three levels (universe, galaxy, star).

### Phase 2.1: Test Structure Refactor

Refactor the Phase 2 test suite from a flat `test/` directory into a split structure matching `@lumenize/mesh`'s pattern: root `test/` for unit-style tests (import directly from `src/`), `test/test-apps/baseline/` for the e2e integration test-app (Browser, WebSocket, full DO mesh). Adopts the simplified `instrumentDOProject(sourceModule)` API (auto-detects DOs via prototype chain walking). Removes `.js` extensions from all imports. Sets up the pattern for phases 3–9 to add test-apps incrementally.

### Phase 3: DAG Tree Access Control

Add a DAG tree inside each Star DO. The nebula-auth hierarchy (`universe.galaxy.star`) goes up from Star; the DAG tree goes down to organize resources. Prior art ported from `transformation-dev/blueprint` (cycle detection, tree operations) with new permission model on top. Every resource attaches to one node (but may be accessible via multiple DAG paths). Permissions (admin, write, read) roll down — if any ancestor branch grants access, the node is accessible. Greatly refactors the Phase 2 test suite. Resource paths: `universe.galaxy.star/resources/level-1-slug/.../level-n-slug`. Phase 3.0 (SQL performance experiment) archived at `tasks/archive/nebula-dag-tree-experiment.md`. Remaining sub-phases: 3.1 (implementation), 3.x (follow-on).

### Phase 4: Cloudflare Isolation Research

Research and benchmark Cloudflare's four isolation technologies: DWL (raw), `@cloudflare/codemode` SDK (DWL wrapper), Containers (raw), and Sandbox SDK (Containers wrapper). Cold start times, DX comparison (direct vs wrapper), use case distinctions, cost analysis (could be just a hand wave). Deliverable is a blog post. Must complete before Phase 5 (Resources needs DWL) and Phase 6 (schema validation needs Containers). Can start in parallel with earlier phases.

### Phase 5: Resources — Basic Functionality

The heart of Nebula. Temporal storage (Snodgrass-style) with subscriptions, fanout, guards, and validation. User-provided code runs in DWL isolates (informed by Phase 4 research). Integrates the DAG access control model. Includes abuse case testing for the combined Resources + DAG access control. Extensive existing design in `tasks/nebula-resources.md`. **Primary prior art**: Blueprint repo's `temporal-entity.js` — the exact Snodgrass temporal storage implementation for Cloudflare DOs (saved at `tasks/reference/blueprint/temporal-entity.js`). Resources = Temporal Entities.

### Phase 5.5: Resource Capability Tickets

Per-resource, per-user HMAC capability tickets so clients can talk directly to ResourceHistory DOs without routing every access through the Star singleton. Star mints short-lived tickets (after checking the DAG) using the existing JWT private key (BLUE/GREEN rotation) — no new secrets. ResourceHistory independently verifies by recomputing the HMAC with the same key from `env`. Stateless on both sides: Star mints and forgets, ResourceHistory just verifies. Tickets are per-user and per-resource (unforgeable, unshareable). Short TTL means revocation takes effect naturally when the client asks Star for a fresh ticket.

### Phase 6: Resources — Schema Migration

Schema evolution and migration layer on top of the basic Resources engine. User-provided migration functions in DWL, versioned alongside resource config. TypeScript types are the schema — no DSL. Runtime type validation via `tsc`/`tsgo` in Containers (informed by Phase 4 research). Lazy read-time migration with write-back.

### Phase 7: Nebula Client

Builds on the NebulaClient foundation from Phase 2 (two-scope model, basic token management). Adds discovery-first login flow, proactive token refresh, WebSocket keepalive, subscription management, and full scope switching UX. Consumes and tests the subscription capability from Resources. Must keep Phase 8 (UI) in mind.

### Phase 8: Nebula UI

Copy/paste port of JurisJS modified to work with the subscription model of Resources through NebulaClient. Local state management mirrors remote state management with minimal config difference. Task file TBD.

### Phase 9: Nebula Vibe Coding IDE

The authoring experience where Nebula users (vibe coders) define their data model and iterate on their application via natural language. Language model generates `ResourcesWorker` subclasses and Nebula UI components. Code deploys to DWL isolates; schema validation via `tsc`/`tsgo` in Containers. Wizard-style flow: ontology first → migration validation gate → UI. See `tasks/nebula-scratchpad.md` for follow-on ideas (LLM training, database branching, testing workflow).

---

## Core Capabilities

### Auth (`universe.galaxy.star`)

Multi-tenant auth with a three-tier hierarchy: Universe (development org) > Galaxy (application) > Star (tenant). Person → EmailAddress → Organization mapping. JWT claims carry access entries with wildcard support. Path-scoped refresh cookies enable multi-tab sessions (Coach scenario). Self-signup, admin invite, delegation, and email-based discovery flows.

**Built in**: Phase 0 (complete). Refactored in Phase 1.
**Key files**: `packages/nebula-auth/src/`

### Access Control (DAG Tree)

Every resource attaches to exactly one node in a directed acyclic graph (DAG) tree. Permissions (admin, write, read) are granted per-node and roll down to descendants. A node is accessible if **any** ancestor path grants the required permission. Admin can grant permissions. Write can write. Read can read.

The access control model bridges nebula-auth's three-tier identity (who you are) with the DAG tree (what you can access). Guards are standalone functions reusable across the codebase.

**Built in**: Phase 2 (baseline with JWT guards), Phase 3 (full DAG model).

### Resources (DWL Architecture)

Temporal storage (Snodgrass-style) with subscriptions, fanout, guards, validation, schema evolution, and migrations. The DWL isolate is a callback provider — the NebulaDO calls *into* it for guard decisions, resource config, and validation. The DWL code never calls out to storage or Mesh directly.

Key APIs: `transaction()` for atomic mixed upserts/deletes, `subscribe()` for real-time updates, `read()`/`reads()` for queries. Double eTag check protocol (optimistic pre-check → DWL guards → pessimistic recheck → `transactionSync` write).

**Built in**: Phase 5.
**Detailed design**: `tasks/nebula-resources.md`

### Schema Evolution

User-provided migration functions in DWL, versioned alongside resource config. TypeScript types are the schema — no DSL. Lazy read-time migration with write-back.

**Built in**: Phase 6.

### Client (Real-Time Sync)

NebulaClient extends LumenizeClient. Two-scope model (auth scope vs active scope) and basic token management in Phase 2. Discovery-first login flow, proactive refresh, 25-second WebSocket keepalive, subscription management, and full scope switching UX in Phase 7. Per-tab access tokens, path-scoped refresh cookies.

**Built in**: Phase 2 (foundation), Phase 7 (full experience).
**Design**: `tasks/nebula-client.md`
**Sequence diagrams**: `website/docs/nebula/auth-flows.mdx`

### UI Framework

Tightly coupled to the resources implementation. Local state management mirrors remote state management with minimal config difference. Client-side LLM-generated code only. Port of JurisJS.

**Built in**: Phase 8.

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **App structure** | `apps/nebula/` for the deployable app, `packages/nebula-auth/` (`private: true`) for auth library | Apps aren't published; auth is a library consumed by the app |
| **NebulaDO** | Base class extends `LumenizeDO`; `Universe`, `Galaxy`, `Star`, and `ResourceHistory` extend `NebulaDO` | `onBeforeCall` reserved for base class (universeGalaxyStarId binding); subclasses use `@mesh(guard)` |
| **NebulaClientGateway** | Extends `LumenizeClientGateway` (via Phase 1.5 hooks) | Overrides `onBeforeCallToClient` for active-scope verification; reads active scope from JWT `aud` claim (Phase 1.8) |
| **NebulaClient** | Extends `LumenizeClient` | Gets WebSocket management, token refresh, tab detection, Browser injection for testing |
| **Access control** | Four layers: entrypoint `verifyNebulaAccessToken` → Gateway `onBeforeCallToClient` active-scope check → `onBeforeCall` universeGalaxyStarId binding → `@mesh(guard)` | Entrypoint rejects early; Gateway verifies mesh→client scope match; base class locks DO to active scope; guards handle method-level auth |
| **DAG permissions** | Grant if any ancestor path grants | Simple model: admin > write > read. Roll-down through tree. |
| **DWL architecture** | Inverted — DO calls OUT to DWL | DWL is callback provider. DO owns storage, subscriptions, fanout. |
| **`transaction()` API** | Mixed upserts/deletes, double eTag check, `transactionSync` write | Minimizes DWL round-trips (billing), ensures atomicity despite input gate opening |
| **Schema** | TypeScript types, not DSL | No Zod, TypeBox, or JSON Schema. `.d.ts` is the source of truth. |
| **Testing** | E2e strongly favored, Browser.fetch/WebSocket injection | Dogfood `@lumenize/testing`; integration tests are primary |

---

## Research Notes

### Cloudflare Sandbox SDK (To Be Evaluated)

Cloudflare announced a [Sandbox SDK](https://developers.cloudflare.com/sandbox/) for running untrusted code in isolated environments. May be relevant as an alternative or complement to DWL for executing user-provided guards, migrations, and validation logic. Key questions: Does it offer better isolation guarantees? Is it simpler to manage than DWL stubs? Does it support the inverted architecture? What are the latency and billing characteristics?

### `@cloudflare/codemode` v0.1.0 SDK Rewrite (2026-02-20)

Cloudflare released a complete rewrite of `@cloudflare/codemode` as a modular, runtime-agnostic SDK built on DWL infrastructure:

- **`DynamicWorkerExecutor`** — pre-built executor with network isolation, console capture, and configurable timeout. Production-hardened version of our DWL sandboxing pattern.
- **`Executor` interface** — minimal contract (`execute(code, fns)`) for custom sandbox implementations. Worth studying for our DWL executor structure.
- Validates DWL as a production-ready pattern — Cloudflare is building official tooling around it.

### Runtime Type Validation (Experiment)

Run `tsgo` (or Rust-based TS compiler) in a Cloudflare Container. `@lumenize/structured-clone` gains `toLiteralString()` mode. TypeScript itself validates values against type definitions — no schema DSL duplication. Spike planned in `experiments/tsgo-validation-spike/`.

---

## Deferred Items & Scratchpad

See `tasks/nebula-scratchpad.md` for deferred items, early-stage ideas (database branching, vibe coder testing workflow), and notes captured during planning.
