# Phase 5.5 (dev-mode subset): In-Place Lazy Migrations

**Status**: Active — critical path for the demo
**Depends on**: 5.2.4.2 (parse-validate via DO facet, per-version Galaxy registry, `_index` mirrored to Star)
**Companion**: `tasks/dev-mode-branching.md` (single dev-mode Star, in-place)
**Production polish**: `tasks/on-hold/nebula-5.5-schema-evolution.md` (held until post-demo)

## Scope

Just enough schema-evolution machinery to make Studio's iteration loop feel sane: when the vibe coder changes their ontology mid-session, existing data on the dev-mode Star migrates lazily on read. **One Star, in-place, copy-on-read.** No cross-Star branching. No production-grade error handling, no version-skew protection, no cross-resource migration callbacks. Those are all in the on-hold companion file and unfreeze post-funding.

## What this phase ships

### 1. `migrationBundle` field on `OntologyVersionRow`

Add a compiled-JS-module field alongside the existing `validatorBundle`. Compiled at `appendOntologyVersion()` time inside `compileOntologyVersion()`. v1 has no migrations (no predecessor); v2+ carries migrations FROM v(N-1) TO vN.

User authors migrations as TS source — strings in the version config. Compiled into a sandboxable bundle for the DO facet.

### 2. Migration-bundle generator

Mirrors the shape of `generateParseModule()`. Likely lives alongside it in `@lumenize/ts-runtime-parser-validator` (same package, same `extractTypeMetadata` reuse, same typia/tsc-bundling pattern). Don't extract to a separate package — different release cadence isn't enough reason.

The bundle exposes one method: `migrate(value, fromVersion, toVersion): unknown`. Walks the chain, applies each step in order. **No `query` proxy** in this phase — cross-resource migrations are deferred.

### 3. Star migration runner on read (lazy / copy-on-read)

When Star reads a snapshot at version `vN` and current is `vM` (where `N < M`):

1. Slice `Galaxy.ontology:_index` from `vN` to `vM` to get the chain (Star already has `_index` cached locally from 5.2.4.2).
2. Fetch any historical rows needed via `Galaxy.getOntologyVersion(v)`. Star doesn't cache historical rows — fetch on demand.
3. Load a single combined migration facet for current version `vM` (one bundle holds all migrations from any older version → current). Single facet load, simpler runner.
4. Apply migrations in order through the facet.
5. **Eager write-back**: create a new snapshot at `vM` with the migrated value. Once-per-old-snapshot cost; simpler invariant than deferred. Re-evaluate only if write traffic becomes a hot spot.

### 4. Default-fill is parser's job, NOT migration's

Parser-validator's in-place `__fillDefaults` already handles new optional fields with `@default` tags on read. **For new optional fields with a default value, no migration entry is needed.** Migrations are only for transformations the parser can't infer — renames, type changes, required-field additions, computed fields.

This boundary holds in dev-mode just as it does in production.

## Out of scope (lives in on-hold/nebula-5.5-schema-evolution.md)

- **Cross-resource migration callback** (`query` proxy injection through the facet boundary) — non-trivial design, defer until post-demo
- **Migration error handling UX** — for demo, throw with whatever the facet produces; don't design a typed error path
- **Version-skew handling** during interleaved appends — accept the extra lazy-migration hop on next read
- **Eager vs deferred write-back as a configurable knob** — eager is the only option here
- **Production cross-Star data migration** — the ability to migrate production data into a fresh branch Star

## Success Criteria

- [ ] `OntologyVersionRow` gains a `migrationBundle: string` field for v2+
- [ ] First version has empty/no `migrationBundle`; types not listed in any version's migrate pass through unchanged
- [ ] `compileOntologyVersion()` compiles migrations alongside the validator; failures reject the append at submit time with a clear error
- [ ] Star walks `_index` to drive the migration chain; fetches historical rows from Galaxy via `getOntologyVersion(v)` only as needed
- [ ] Migration runs in a DO facet (same isolation + bundleId-scoping pattern as 5.2.4.2's validator facet)
- [ ] Lazy migration: resource at vN is migrated to vM on first read; written back as a new snapshot at vM (eager write-back)
- [ ] `@default`-fillable changes (new optional fields) work without any migration entry — parser handles them on read
- [ ] Migration throws → bubble up to the caller as-is; no typed error path required for demo

## Notes

- This file was extracted from `nebula-5.5-schema-evolution.md` during the demo-focus refactor (see `tasks/nebula-task-files-refactor.md`). The full file is in `tasks/on-hold/` as the production-polish reference.
- The companion `tasks/dev-mode-branching.md` describes the single-Star dev-mode model these migrations run inside.
