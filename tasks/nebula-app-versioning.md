# Nebula — App versioning & parallel source durability

**Status**: **Reviewed (framing ×2 + conformance) 2026-06-17 — build-ready.** Companion to the BUILT #1a (`tasks/nebula-studio-compile-pipeline.md`). Forks resolved (DevStar = sole compiler; per-file storage; self-hosted-assets/CSP split to `tasks/nebula-self-hosted-assets.md`). Conformance fixes applied (Galaxy save-API `@mesh(requireAdmin)` + B5 allow-list; `AppBundle` PK = schema migration; broadened rename/test surface; capable-of-failing DO markers; dual-write failure tests). ⚠️ **Phase 2's end-to-end durability is gated on the still-unbuilt `nebula-studio.md` § Durable draft ownership orchestration; Phase 3 (prod) is post-demo** (the one remaining § Open item).
**Phase**: Studio build-seq #1b (the Galaxy-side half; #1a = the DevStar/Star compile/serve/reload mechanics).
**App**: `apps/nebula/` — Mesh platform layer: never raw primitives; solve raw needs via a mesh hook.

**What this file owns:**
1. **The app-version record + the compiler relocation** — broaden the Galaxy registry to a versioned **app-version** record (ontology + validator + UI bundle + assets, lock-step), and move **all** compilation to DevStar so **Galaxy is a pure versioned store**.
2. **Parallel source durability** — every save writes source to DevStar **and** Galaxy.

Owned **elsewhere — pointers, not restatements**: save **orchestration** (when to save, the confirm-durable-before-wipe gate, re-hydrate trigger) + the don't-trust-browser invariant → `nebula-studio.md` § Durable draft ownership. Reset mechanism + precondition + re-hydrate seam → `dev-star.md`. The compile/serve/reload mechanics + the built `AppBundle` storage shape → **#1a**. **Self-hosting the platform libraries (Vue + DaisyUI + Lucide) same-origin + strict `script-src` + the compile-time specifier-rewrite** → **`tasks/nebula-self-hosted-assets.md`** (the platform-fixed asset story, distinct from this file's per-version compiled bundle). Only the *Studio-LLM granular-icon docs* and the *real `@lumenize/nebula/frontend` factory bundle* defer (to Studio generation / #1a's T3 preview).

**Touches built code** — broadens the Galaxy ontology registry **and** relocates the validator compile from Galaxy to DevStar (reworks `appendOntologyVersion` → store-only, `deployToDev`'s pull → local compile). Breaking change; favor it over tech debt, bump semver, flag the release.

## Why this exists (two coupled reframes)

1. **Lock-step versioning** — the ontology, UI source, and compiled bundle ship together, so the registry broadens from an ontology row to a whole **app-version** record.
2. **DevStar is the sole compiler** — it already compiles `.vue` (#1a); it must **also** compile the ontology **validator** locally, because the dev preview needs the validator *resident* to test data the moment the user tries the app — a Galaxy-compile-then-pull would put the very first-try latency we removed back in. So Galaxy stops compiling and becomes a **pure versioned store**; prod Stars pull (validator + bundle) and serve, never compiling.

## Decisions pinned

### 1. Galaxy registry → app-version record (Galaxy stores, never compiles)
The immutable per-version row becomes a single combined **app-version record**: ontology types + **DevStar-compiled** validatorBundle + UI bundle + static assets + carried-forward `relationships`. `append` becomes **store-only** — it takes the pre-compiled artifacts DevStar pushes and no longer calls `compileOntologyVersion`.
- **Record shape (pinned — was § Open):** the version registry stays a KV row `AppVersionRow { version, types, validatorBundle, relationships }` (ontology + validator); the **UI bundle reuses #1a's `AppBundle` SQLite table, gaining a `version` column** (PK `(version, path)`, `WITHOUT ROWID`). An **app-version N = the KV row at N + the `AppBundle` rows where `version = N`** — that's the physical registry↔bundle relation. `getLatestAppVersion` returns the KV row; `onRequest`/`#installState` read the bundle rows by `(version, path)`.
- `Star.#installState` installs validator + bundle — **contract unchanged**; only the *source* of the validatorBundle changes (DevStar-local in dev, Galaxy-pulled in prod).
- Carry `relationships` forward unchanged ([galaxy.ts:37](../apps/nebula/src/galaxy.ts) — the deferred-5.5 lazy-migration breadcrumb).
- **Supersedes** `nebula-studio.md` § Open questions' "built-artifact storage/versioning is deferrable" (already two-sided: nebula-studio.md:170 points back here).

### 2. Storage — per-file, filesystem-shaped API
Source + compiled assets are stored **per file (path → bytes)**, each its own row. The reason is **write-cost granularity**, not a value-size cap: #1a's `AppBundle` table is SQLite `content TEXT` ([app-bundle.ts:113](../apps/nebula/src/app-bundle.ts)), so a per-save compile is **one `INSERT OR REPLACE` per changed asset** rather than rewriting a whole-bundle blob (`durable-objects.md` § SQLite write-cost). (The 128 KiB cap is a `ctx.storage.kv` *value* limit — it only bites a future KV-backed path, not the SQLite TEXT store.) The **top-level API is filesystem-shaped** (read/write by path) so the demo's per-file SQLite backend can later swap to `@cloudflare/shell`'s `Workspace` (`tasks/on-hold/nebula-file-storage-backend.md`) without changing callers.
- **Two stores, two lifecycles:** an *immutable* app-version registry (published versions) and a *mutable* dev-draft store (in-progress source). Publish bridges them (compile + snapshot). This file owns these **storage shapes**; the save *orchestration* is nebula-studio.md's.
- **Dev save = source only** (`.vue` + ontology `.d.ts`); the bundle is regenerable (recompiled on re-hydrate), lives in the version record at publish, not in dev-save.

### 3. Parallel source durability
**Studio dual-writes source** to **DevStar** (fast eyeball-local working copy) **and** the **Galaxy draft store** (durable) in parallel on each save — independent of DevStar liveness, so a breaking-edit wipe never costs the user work. Ontology is *just another file*. Not a per-cycle lazy load; Galaxy is read back only on re-hydrate.

### 4. Distribution — dev is fully local; lazy-pull is prod-only
With DevStar as sole compiler, **dev needs no Galaxy pull**: an ontology edit → DevStar compiles the validator locally + installs it; a `.vue` edit → DevStar compiles the bundle locally + serves it. No round-trip, no per-cycle latency — `deployToDev`'s former Galaxy-pull is **superseded by local compile**.
- **Publish** (less frequent): DevStar pushes the compiled app-version (validator + bundle) to Galaxy.
- **Prod**: a prod Star lazy-pulls the published version (validator + bundle) from Galaxy via the existing cache-miss path and serves it — **the only place the pull is used**.
- **Who writes Galaxy:** *source* → **Studio** (the parallel dual-write of Decision 3, through the Galaxy-owned save API); *compiled version* → **DevStar** (server-side push, so the bundle never round-trips the browser). Studio orchestrates the triggers (orchestration owned by nebula-studio.md).

## Phases (provisional — refine after § Open is pinned)

### Phase 1 — App-version record + relocate compilation to DevStar
- `AppVersionRow` (the pinned shape, Decision 1) + `appendAppVersion`/`getLatestAppVersion` = **store-only** + **`@mesh(requireAdmin)`** (B1, mirroring `appendOntologyVersion`); lock-step atomic write inside one `transactionSync`.
- **The `AppBundle` PK change `path` → `(version, path)` is a SCHEMA MIGRATION, not a column add** — `CREATE TABLE IF NOT EXISTS` no-ops against the built `path`-PK table ([app-bundle.ts:111-114](../apps/nebula/src/app-bundle.ts)) and SQLite can't ALTER a PK in place, so it needs an explicit in-DO **rebuild (create-new/copy/drop/rename) under a schema-version latch** (durable-objects.md), and **every `AppBundle` caller threads `version`** (`getAsset`/`putAsset`/`ensureTable`/`stageScaffold`/`Star.onRequest`). (Dev resets via `deleteAll`, so dev is moot; prod/test fixtures under the `path`-only schema need the rebuild.)
- **Move the *ontology-validator* compile to DevStar** — a **new** DevStar method (the validator compile = `extractTypeMetadata` + `generateParseModule`, **distinct from `.vue`-only `compileSFC`**), reusing the validator bundle `apps/nebula` already imports. DevStar **synthesizes the `OntologyState`** itself (`row` from the local compile, `history` from its own index — `applyFetchedState`'s "failed-Galaxy-continuation" JSDoc must be reconciled, or a distinct local-apply seam added) + installs via `#installState`. Rework `deployToDev` (Galaxy-pull → local-compile-and-install).
- **Migrate the full built surface** — the grep is the authoritative inventory, broadened to the **renamed method + its config type + the public barrels**: `grep -rn 'OntologyVersionRow\|OntologyState\|OntologyVersionConfig\|getLatestOntologyVersion\|compileOntologyVersion\|appendOntologyVersion' apps/nebula/src` (zero residual), **plus** the public re-exports (`index.ts`, `client-index.ts`) and the **test surface** (~25 `.test.ts` files + `callGalaxyAppendOntologyVersion`; `dev-star-eager-apply.test`'s append→pull→assert round-trip). ⚠️ **Carve-out: the prod cache-miss pull STAYS** — `star.ts` `doTransaction`/`doRead`/`doSubscribe` keep `getLatestOntologyVersion`; don't rip it out with the dev path.
- **Migrate the tests, don't shim them** — move `dev-star-eager-apply.test` + ontology-lifecycle setups to the compile-locally / store-only shape (not aliased via back-compat shims), retaining capable-of-failing markers; name the harness change (`callGalaxyAppendOntologyVersion` now needs a precompiled artifact or a new DevStar-local compile initiator).
- **Success criteria (capable-of-failing, via debug-sink DO markers — testing.md):**
  - **No Galaxy call in dev** — a **local-compile marker fires exactly once** AND **no Galaxy-fetch marker** fires on the dev apply (mutation check: comment out the local compile → red). NOT "deployToDev succeeded" — vacuous, since `applyFetchedState`'s `applied` marker fires for a Galaxy pull too.
  - **Prod carve-out** — pinned to a **non-`.dev` STAR** (`callStarTransaction`, uncached version): the **Galaxy-fetch marker fired** (mirror-image of the dev assertion — together they prove the split, not a shared no-op).
  - **Publish atomicity** — a publish that throws partway leaves **no partial version N** (neither the KV `AppVersionRow` nor stray `AppBundle` rows): inject a throw between the KV put and the bundle writes, assert `getLatestAppVersion` ≠ N.
  - The grep + barrels + test surface show **zero residual**; `relationships` present; a prod Star pulls + installs both.

### Phase 2 — Parallel source durability (the dual-write half)
This file builds the **Galaxy draft store + the source dual-write**. The save *orchestration* it rides — per-turn autosave, the confirm-durable-before-wipe gate, re-hydrate-on-reset, the reset trigger — is **owned by `nebula-studio.md` § Durable draft ownership and is design-only / not built and owned by no build task yet** (a hard cross-file prerequisite — sequence its build, likely with Studio proper).
- Studio dual-writes source (`.vue` + ontology) to DevStar **and** the Galaxy draft store on each save, **via the Galaxy-owned save API**.
- **The save API is `@mesh(requireAdmin)` (B1)** — `Galaxy.onBeforeCall` proves tenant *scope* only, and the `<id>.*` widening admits descendant non-admins, so without the gate any in-scope non-admin could overwrite another developer's draft source (mirror the already-gated `appendOntologyVersion`/`setGalaxyConfig`). It **re-validates every browser-supplied field server-side** (M2): `path` sanitized like `getAsset` (no traversal); the version/label re-checked against `VERSION_LABEL_RE`; writes **confined to the mutable draft store** (a draft write can never land in the immutable published registry).
- **Update the B5 frozen non-admin allow-list** (`scope-isolation.test.ts` — the four read-only methods): swap the renamed read in, keep every new write admin-gated (and therefore absent) — else the `.*`-widening-is-safe invariant silently breaks.
- **Success criteria:**
  - The save API + `appendAppVersion` carry `@mesh(requireAdmin)`; a **genuinely-minted** (not forged) non-admin caller with a valid in-scope aud is **rejected** ("Admin access required") and **writes nothing** (both accept + reject cases, mirroring `scope-isolation.test.ts`); the B5 allow-list stays green. *(If the gate lives in the not-yet-built orchestration, `it.skip` the rejection test with the blocker named — deferring ≠ deleting.)* A save targeting a published-version key or a traversal `path` is rejected.
  - **Dual-write durability under failure** (the point of Decision 3): (a) force the **DevStar leg to fail** → the Galaxy draft is still present + current (proves the writes don't secretly serialize through DevStar); (c) **rapid re-saves** of the same path → the draft store holds the latest. (b) Galaxy-write-fails-partial → assert Studio does **not** treat the draft as durable — `it.skip` if it depends on the design-only orchestration.
  - After a normal save, the source is present + readable in the Galaxy draft store (server-confirmable). The end-to-end "durable **before** wipe / `resetDevData()` + re-hydrate restores" is gated on the orchestration prerequisite above and is **not** asserted by this phase.

### Phase 3 — Prod publish + serve to end-users **(Exploratory — post-demo)**
Prod-publish (the artifact projection) + a prod Star lazy-pulls and serves to end-users via `Star.onRequest`. **Inherited open seam:** sync `onRequest` can't complete an async lazy-pull on a cold miss — lean: a fixed **loading-shell** (always resident) whose JS triggers an async ensure-version pull + reloads. Plus clean-URL / custom-domain routing. Deliverable = the pinned mechanism + a findings note, not green prod-serve criteria.

## Open — pin before the dependent phase
- **Prod cold-cache-miss serving** (the Phase 3 seam above) — exploratory/post-demo.

## Deferred (captured, not lost)
- **App-specific binary assets** (logos, images) — **every app will want at least a logo.** Mechanism: `file` resources (`ArrayBuffer`) + a record reference. Deferred from the demo (generated apps are code-only); revive when the first real upload need lands.
- **Prod Worker size / cold-start** — prod Stars serve but never compile (Decision 4), yet carry #1a's compile machinery (the 3.4 MB tsc bundle + validator bundle) unused; isolate behind a **Worker Loader facet** if cold-start bites — backlog, not a demo blocker. Standing-fact details: #1a.

## References
`tasks/nebula-studio-compile-pipeline.md` (#1a, BUILT — the `AppBundle` shape + `onRequest`); `tasks/nebula-self-hosted-assets.md` (the platform-fixed asset/CSP detour); `tasks/nebula-studio.md` (§ Durable draft ownership — owns the save API + orchestration + gate); `tasks/dev-star.md` (§ In-dev data lifecycle — reset + re-hydrate seam); `apps/nebula/src/galaxy.ts` (registry broadened; compile relocating out); `apps/nebula/src/star.ts` (`#installState` apply path; prod pull stays); `tasks/on-hold/nebula-file-storage-backend.md` (`@cloudflare/shell` `Workspace` — the filesystem backend to swap in later).
