# Nebula — App versioning, save APIs & dev/prod distribution

**Status**: Design — captures decisions from the 2026-06-16 design conversation that followed `/review-task` on `tasks/nebula-studio-compile-pipeline.md`. Several items are **pinned**; a few need pinning before build (flagged § *Open*). **Not yet `/review-task`'d as a standalone file.**
**Phase**: Studio build-seq #1b (the Galaxy-side distribution/durability half; #1a = `nebula-studio-compile-pipeline.md`, the DevStar/Star mechanics).
**App**: `apps/nebula/` — **Mesh platform layer**: never raw primitives; solve raw needs via a mesh hook.
**Relationship**:
- **Prerequisite for** the *end-to-end* Studio dev loop (`tasks/nebula-studio.md`) and the end-to-end wiring atop `tasks/nebula-studio-compile-pipeline.md` (which builds compile + `onRequest` serve + reload-broadcast independently; this file feeds bundles into Star storage and keeps source durable).
- **Touches built code**: the Galaxy ontology registry (`galaxy.ts` `appendOntologyVersion`/`getLatestOntologyVersion`/`OntologyVersionRow`) is **broadened** here — a breaking change to a built surface (favor it over tech debt; bump semver, flag the release).
- **Coordinates with** `tasks/dev-star.md` (reset precondition + re-hydrate seam) and `tasks/nebula-studio.md` § *Durable draft ownership*.

## Why this exists (the reframe)

The ontology version registry was built when we were focused on **Resources**, which only need the ontology — not source files or the compiled UI bundle. We've since decided **the ontology, the UI source, and the compiled bundle always version in lock-step**. So a registry keyed on "ontology version" is too narrow: CRUD on the ontology should broaden to CRUD on the **whole app version**.

## Decisions pinned (2026-06-16)

### 1. Ontology API → **App** API
The Galaxy registry becomes an **app-version record**, not an ontology-only row. One immutable version `N` bundles everything that ships together: ontology types + compiled validator, the compiled UI bundle, and static assets. Broaden `appendOntologyVersion`/`getLatestOntologyVersion`/`OntologyVersionRow` into app-version CRUD (`appendAppVersion`/`getLatestAppVersion`/`AppVersionRow`, names TBD).
- **Subsumes** the earlier `uiBundle`-field pin from the compile-pipeline review: this is the *combined app-version record* the Stage-1 review flagged as the open choice — picked combined, not a field bolted onto the ontology row.
- The Star's inherited cache-miss apply path (`#installState`/`applyFetchedState`) installs the **app** version (validator **and** bundle), not just the validator.

### 2. Two save shapes — dev (repo-like) vs prod (artifact)
- **Prod publish** = the **deployable artifact only**: compiled UI bundle + static assets + compiled validator. End-users never need source. This is what a prod Star lazy-pulls and serves.
- **Dev save** = **repo-like superset**: *everything*, including source (`.vue` + ontology `.d.ts`) and the bundle — like a source-code repo.
- The relationship: **prod-publish is a projection of dev-save** (compile + strip source). Likely **one underlying store with two read/write surfaces**, not two unrelated APIs.

### 3. Dev distribution **reuses the Star's lazy-pull** (keep DevStar ↔ Galaxy)
We considered making Studio the sole hub with **DevStar never talking to Galaxy**, and rejected it: it would diverge dev from prod's pull path, discard the built `deployToDev`, and fight the fact that `DevStar extends Star` and **inherits Star's lazy cache-miss → Galaxy calls** anyway. DevStar ↔ Galaxy is already proven safe (dev-star P4 coexistence), so there's no security forcing function.
- **The dev update mechanism:** Studio publishes the new app version to Galaxy, then **forces a browser refresh of the preview**; the refresh drives the Star to **lazy-pull the new version from Galaxy** — the *same* path prod uses, just eagerly triggered.
- **"Can't be truly lazy anymore"**: the refresh is the eager trigger (we don't wait for a natural cache-miss), but the underlying pull is the existing lazy mechanism (`deployToDev`'s eager-apply is the in-place analog; either may serve as the trigger — pin during build).
- **Latency**: a per-cycle Galaxy round-trip is a concern, but **deferred as premature optimization**. Start with lazy-pull reuse and measure.

### 4. Parallel source durability
Every save writes source to **DevStar** (the fast eyeball-local working copy, for compile/preview) **and** **Galaxy** (the durable copy) **in parallel** — so a breaking-edit reset (`resetDevData()` wipes the DevStar's `file` resources) never costs the user work.
- **The ontology is "just another file"** in this save — uniform with `.vue` files. It needs durability here specifically because the version registry only captures ontology source at *publish points*, while the user edits it *between* publishes; those in-progress edits otherwise have no durable home.
- This is **not** a per-cycle lazy load — DevStar stays the working copy; Galaxy is the survival copy. Lazy load back from Galaxy happens only on re-hydrate after a wipe.

### 5. Studio coordinates the seam — but **don't trust browser storage**
Studio talks to Galaxy and to DevStar; it **orchestrates** the save → confirm-durable → wipe → re-hydrate sequence, but **never holds the only copy**. Galaxy is authoritative. Invariants this imposes:
- **Parallel-save-to-Galaxy happens *before* any wipe** → a Studio (browser) crash mid-turn loses nothing; worst case the DevStar is stale and Studio re-hydrates it from Galaxy on reconnect.
- **The confirm-durable-before-wipe gate is answerable from Galaxy's *server* state** (Galaxy confirms the save / returns the version), **never** a browser flag.
- **Re-hydrate** (pull source from Galaxy into the wiped DevStar) is **orchestrated by Studio** — the re-hydrate seam `dev-star.md` P3 deliberately left open. The reset **trigger** (breaking-change detection vs. manual) stays Studio's per `nebula-studio.md`.

## Phases (provisional — refine after the § *Open* items are pinned)

### Phase 1 — Broaden the Galaxy registry to app versions
- `OntologyVersionRow` → `AppVersionRow` (ontology types + validator + UI bundle + static assets); `appendAppVersion`/`getLatestAppVersion` (app/ontology/bundle lock-step, atomic write). Migrate the built ontology callers.
- Extend `Star.#installState` to install the bundle alongside the validator.
- **Success criteria:** publishing version N stores ontology + bundle + assets atomically under N; `getLatest` returns all; the Star installs both on apply.

### Phase 2 — Dev save API + parallel durability
- A backend-agnostic **dev-save** surface the Galaxy owns (demo backend = Galaxy SQLite), storing the repo-like source set (`.vue` + ontology + bundle).
- The dev cycle writes source to DevStar **and** Galaxy in parallel on each save.
- **Success criteria:** after a save, the source is durable on Galaxy (server-confirmable) before any wipe could fire; a `resetDevData()` followed by re-hydrate restores the working copy from Galaxy.

### Phase 3 — Wire the end-to-end dev loop (`deploy_to_dev`) via lazy-pull
- Studio publishes the app version to Galaxy → forces a preview browser refresh → the Star lazy-pulls + serves (via `onRequest`, built in the compile-pipeline task). Reconcile step ordering: the UI is **compiled before** the app version is published (lock-step requires both present at publish).
- **Success criteria:** edit `.vue` → compile → publish → refresh → preview shows the new version, end to end, within the ~3 s target; source is durable throughout.

### Phase 4 — Prod publish + lazy-pull/serve to end-users
- Prod-publish surface (artifact-only projection of dev-save); prod Star lazy-pulls + serves the deployed app to end-users via the same `Star.onRequest()`.
- **Success criteria:** a published app version is lazily pulled and served by a fresh prod Star; end-users get the runtime-only bundle under a strict CSP.

## Open — pin before building the dependent phase
- **App-version record shape** + exactly how dev-save (repo-like) and prod-publish (artifact) relate to it ("one store, two surfaces" — confirm).
- **Who publishes to Galaxy** — Studio, or DevStar — within the kept DevStar ↔ Galaxy topology.
- **Lazy-pull trigger** for dev — does the browser refresh's resource-op cache-miss suffice, or does Studio call `deployToDev` (eager-apply) explicitly? (Measure latency here too.)
- **Re-hydrate orchestration** details + the reset **trigger** — coordinate with `nebula-studio.md` § Durable draft ownership + `dev-star.md` reset precondition.
- **Static assets** handling (where they live in the record; how `onRequest` serves them).

## References
`tasks/nebula-studio-compile-pipeline.md` (the DevStar/Star mechanics half); `tasks/nebula-studio.md` (§ Architecture, § Durable draft ownership, § Dev-mode Star); `tasks/dev-star.md` (reset precondition + re-hydrate seam); `apps/nebula/src/galaxy.ts` (the registry being broadened); `apps/nebula/src/star.ts` (`#installState`/`applyFetchedState` apply path); `packages/nebula-auth/README.md` (singleton Registry + per-instance NebulaAuth; auth survives a DevStar wipe).
