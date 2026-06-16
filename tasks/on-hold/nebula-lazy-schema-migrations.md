# Nebula Lazy Schema Migrations (Star-Local)

**Status**: **On-hold (deferred 2026-06-15)** — cut from the demo critical path; see the deferral note below for the interim dev-Star-reset behavior (`tasks/dev-star.md` § *In-dev data lifecycle*).

**Owner**: `tasks/nebula-studio.md` (when it resumes, this makes Studio's iteration loop preserve data across *breaking* ontology edits)

**Depends on**: 5.2.4.2 (parse-validate via DO facet, per-version Galaxy registry, `_index` mirrored to Star)

**Companion**: `tasks/dev-star.md` (the dev Star these migrations would run inside for the demo; a single independent Star instance). Post-demo, the same runner applies per-branch under `tasks/on-hold/nebula-branches.md`.

**Production polish**: `tasks/on-hold/nebula-5.5-schema-evolution.md` (the broader schema-evolution surface; also on-hold)

> De-numbered from "Phase 5.5 (branch-local subset): In-Place Lazy Migrations" 2026-06-15 and re-homed under Studio. Phase 5's core shipped; this was the last Phase-5-lineage piece carried as demo-critical.
>
> **Deferred 2026-06-15.** The demo does not ship the lazy-migration runner. Studio's loop is "build from scratch," so we accept the cruder bargain: **additive** ontology edits (new optional field + `@default`) stay readable via the parser's existing `__fillDefaults` on read — no machinery here — while a **breaking** edit (rename / type change / required-field add) in the dev Star resets it to empty rather than migrating. The in-dev reset behavior lives in `tasks/dev-star.md`; this file holds the in-place-migration runner that replaces that reset post-demo. Un-defer when "your data evolves in place" becomes part of the product story.

## Scope

Just enough schema-evolution machinery to make Studio's iteration loop feel sane: when the user-developer changes their ontology mid-session, existing data on **the active Star** migrates lazily on read. **Per Star, in-place, copy-on-read.** No cross-Star data migration. No production-grade error handling, no version-skew protection, no cross-resource migration callbacks. Those are all in the on-hold companion file and unfreeze post-funding.

The migration runner is **Star-local**: it acts on whatever Star instance the request is routed to — the dev Star for the demo (`tasks/dev-star.md`), or any branch if true branching lands (`tasks/on-hold/nebula-branches.md`). It has no special "dev mode" path; a dev Star is an ordinary Star.

## What this phase ships

### 1. `migrationBundle` field on `OntologyVersionRow`

Add a compiled-JS-module field alongside the existing `validatorBundle`. Compiled at `appendOntologyVersion()` time inside `compileOntologyVersion()`. v1 has no migrations (no predecessor); v2+ carries migrations FROM v(N-1) TO vN.

User authors migrations as TS source — strings in the version config. Compiled into a sandboxable bundle for the DO facet.

### 2. Migration-bundle generator

Mirrors the shape of `generateParseModule()`. Likely lives alongside it in `@lumenize/ts-runtime-parser-validator` (same package, same `extractTypeMetadata` reuse, same typia/tsc-bundling pattern). Don't extract to a separate package — different release cadence isn't enough reason.

The bundle exposes one method: `migrate(value, fromVersion, toVersion): unknown`. Walks the chain, applies each step in order. **No `query` proxy** in this phase — cross-resource migrations are deferred.

### 3. Star migration runner on read (lazy / copy-on-read, per Star)

When the active Star reads a snapshot at version `vN` and current is `vM` (where `N < M`):

1. Slice `Galaxy.ontology:_index` from `vN` to `vM` to get the chain (Star already has `_index` cached locally from 5.2.4.2).
2. Fetch any historical rows needed via `Galaxy.getOntologyVersion(v)`. Star doesn't cache historical rows — fetch on demand.
3. Load a single combined migration facet for current version `vM` (one bundle holds all migrations from any older version → current). Single facet load, simpler runner.
4. Apply migrations in order through the facet.
5. **Eager write-back**: create a new snapshot at `vM` with the migrated value. Once-per-old-snapshot cost; simpler invariant than deferred. Re-evaluate only if write traffic becomes a hot spot.

The migration runner doesn't know or care which Star it's running on — it operates against the Star's own SQLite. Isolation is provided by the fact that each Star (dev or production, or a branch post-demo) is an independent DO instance.

### 4. Default-fill is parser's job, NOT migration's

Parser-validator's in-place `__fillDefaults` already handles new optional fields with `@default` tags on read. **For new optional fields with a default value, no migration entry is needed.** Migrations are only for transformations the parser can't infer — renames, type changes, required-field additions, computed fields.

This boundary holds for any Star.

## Out of scope (lives in on-hold/nebula-5.5-schema-evolution.md)

- **Cross-resource migration callback** (`query` proxy injection through the facet boundary) — non-trivial design, defer until post-demo
- **Migration error handling UX** — for demo, throw with whatever the facet produces; don't design a typed error path
- **Version-skew handling** during interleaved appends — accept the extra lazy-migration hop on next read
- **Eager vs deferred write-back as a configurable knob** — eager is the only option here
- **Cross-Star data migration** — copying data from one Star to another (the dev-Star fork-to-test case in `tasks/dev-star.md`, or the `origin !== null` branch-creation case in `tasks/on-hold/nebula-branches.md`)

## Success Criteria

- [ ] `OntologyVersionRow` gains a `migrationBundle: string` field for v2+
- [ ] First version has empty/no `migrationBundle`; types not listed in any version's migrate pass through unchanged
- [ ] `compileOntologyVersion()` compiles migrations alongside the validator; failures reject the append at submit time with a clear error
- [ ] Star walks `_index` to drive the migration chain; fetches historical rows from Galaxy via `getOntologyVersion(v)` only as needed
- [ ] Migration runs in a DO facet (same isolation + bundleId-scoping pattern as 5.2.4.2's validator facet)
- [ ] Lazy migration: resource at vN is migrated to vM on first read; written back as a new snapshot at vM (eager write-back)
- [ ] `@default`-fillable changes (new optional fields) work without any migration entry — parser handles them on read
- [ ] Migration throws → bubble up to the caller as-is; no typed error path required for demo
- [ ] Verified to work identically on the dev Star and any production Star (and any branch, post-demo) — the runner has no Star-identity awareness

## Notes

- This file was extracted from `nebula-5.5-schema-evolution.md` during the demo-focus refactor (historical context in `tasks/archive/nebula-task-files-refactor.md`). The full file is in `tasks/on-hold/` as the production-polish reference.
- The Star these migrations run inside is, for the demo, the dev Star (`tasks/dev-star.md`); post-demo the same runner applies per-branch (`tasks/on-hold/nebula-branches.md`).
- Renamed 2026-05-07 from `nebula-5.5-dev-mode-migrations.md` after the dev-mode-as-branch refactor. Migration logic is identical; only the framing changed.
- Renamed again 2026-06-15 from `branch-migrations.md` → `nebula-lazy-schema-migrations.md`. The old name read like "migrating data *between* branches" — exactly the cross-Star copy this file lists as out of scope. This runner is Star-*agnostic*: it operates on a single Star's SQLite; it's lazy *schema* migration that happens to run per-Star.
- Re-framed 2026-06-15 from "branch-local" to "Star-local" when the dev-sandbox need was decoupled from branching: Studio's sandbox became a reserved-slug dev Star (`tasks/dev-star.md`), and first-class branching was deferred (`tasks/on-hold/nebula-branches.md`). The runner is unchanged — it never cared about branch identity.
