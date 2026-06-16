# Phase 5.5: Schema Evolution (production polish — ON HOLD)

> **Status note (demo focus)**: The branch-local lazy-migration subset was extracted to [`nebula-lazy-schema-migrations.md`](./nebula-lazy-schema-migrations.md) (formerly `branch-migrations.md`, before that `nebula-5.5-branch-migrations.md`, originally `nebula-5.5-dev-mode-migrations.md`). That subset was **also deferred for the demo (2026-06-15)** and now sits alongside this file in `on-hold/`. This file holds the broader production-polish surface (cross-resource migration callback, version-skew handling, write-back tuning, error-handling UX) and is on hold until post-funding. Both unfreeze together when in-place schema evolution becomes part of the product story; demo handling is parser default-fill + dev-Star reset (see `tasks/dev-star.md`).

**Status**: ON HOLD — see note above

**Depends on**: 5.2.4.2 (parse-validate via DO facet, per-version row storage, Galaxy `_index` mirrored to Star)

**Parent**: `tasks/nebula.md`

## Scope

Lazy read-time migration of resources stored at older ontology versions. Galaxy compiles migrations alongside validators at `appendOntologyVersion()` time; Star runs the migration chain in a DO facet on read; migrated data is written back as a new snapshot. Sandboxing matches 5.2.4.2's validator path (same DO-facet hosting model, same DWL isolation).

## What 5.2.4.2 already gave us

The ground laid by 5.2.4.2 is most of the lazy-migration foundation:

- **Galaxy as per-version registry**: each `OntologyVersionRow` is keyed by version label and stored immutably in Galaxy's KV. `getOntologyVersion(v)` retrieves any historical row.
- **Ordered version index**: `Galaxy.ontology:_index` is the ordered version history (oldest → newest). It IS the migration ordering source — slice between `vN` (a stored snapshot's version) and `vM` (current) and you have the chain.
- **History mirrored to Star**: `getLatestOntologyVersion()` returns `{ row, history }` atomically. Star caches `history` in its own `ontology:_index`. Migration chain order is therefore available locally on Star without a follow-up Galaxy round-trip.
- **`relationships` co-located with the row**: 5.2.4.2 keeps `TypeMetadata['relationships']` on each `OntologyVersionRow` specifically so 5.5 doesn't need to re-extract from the `types` source on every cold migration.
- **DO-facet hosting pattern**: validated end-to-end by 5.2.4.2. Same isolate, near-zero same-isolate RPC latency, DWL sandbox semantics. The migration facet should follow the same pattern as the validator facet (per-`bundleId` cache, scoped by `<universe>.<galaxy>/<version>`).
- **`@default` filling already happens via parser**: optional fields with `@default` JSDoc tags are filled by `parseBatch()` on every read-after-write. **For new optional fields with a default value, no migration is needed** — the parser handles them. Migrations are only for changes the parser can't infer (renames, type changes, required-field additions, computed fields).

## What 5.5 still has to build

### `migrationBundle` field on `OntologyVersionRow`

Add a compiled-JS-module field alongside `validatorBundle`. The first version has no migrations (no predecessor); v2 onward has migrations FROM v(N-1) TO vN. Compiled at `appendOntologyVersion()` time inside `compileOntologyVersion()`, same eager-failure model as the validator bundle.

User authors migrations as TS source — strings in the version config, not real functions (user-developer code → must be compiled into a sandboxable bundle). Real-function input should still work for standalone package use and unit tests, but Nebula's path is string-only.

### Migration-bundle generator

Likely a new package (`@lumenize/ts-runtime-migration` or similar) or an extension to `ts-runtime-parser-validator`. Compiles a per-type migrate map into a single JS module that runs inside the facet. Mirrors `generateParseModule()`'s shape.

The bundle exposes one method: `migrate(value, fromVersion, toVersion, query?): unknown`. Internally walks the chain and applies each step in order. Cross-resource migrations get the `query` proxy injected — see "Cross-resource migration callback" below.

### Star migration runner on read

When Star reads a snapshot at version `vN` and current is `vM` (where `N < M`):
1. Slice `_index` from `vN` to `vM` to get the chain.
2. Fetch any historical rows needed via `Galaxy.getOntologyVersion(v)` — Star doesn't cache historical rows by default; fetch on demand. (Future optimization: cache the recent N rows in Star KV with eviction.)
3. Load a migration facet per intermediate version (or one combined facet that has all the chain steps baked in — design choice).
4. Apply migrations in order through the facet.
5. Write back: create a new snapshot at `vM` with the migrated value.

The "which facet runs which step" choice has trade-offs:
- **One facet per version step**: smaller bundles, more cache misses, more facet spawns.
- **One combined migration facet per current version**: one bundle holds all migrations from any older version → current. Larger bundle, single facet load, simpler runner. Probably the right default.

### Cross-resource migration callback

Migrations can call `query.count('Todo', { assignedTo: data.id })` etc. The migration facet doesn't have direct access to Star's storage — same isolation as the validator facet. Need a callback mechanism: facet asks Star (via mesh continuation) for query results, Star executes against its data, returns to facet.

This is the same shape as fire-and-forget mesh callbacks already used for transaction results, but synchronous from the migration's POV (the migration facet `await`s the query). Non-trivial to design; revisit when 5.5 starts.

### Default-fill vs. migration boundary

Parser-validator's in-place `__fillDefaults` already handles new optional fields with `@default` tags on read. So if a v2 schema adds an optional `priority?: string /** @default "medium" */`, an old v1 record reads as `{...v1Data, priority: 'medium'}` automatically — no migration needed.

**Migration IS needed when**:
- Renaming a field
- Changing a field's type (string → number)
- Splitting / merging fields (`name` → `firstName + lastName`)
- Adding a required field that can't have a sensible default
- Computed fields that depend on other fields
- Cross-resource computed values (denormalized counts/aggregates)

This boundary is sharper now than it was in the old design, where `defaults` (storage-level field) and `migrate` overlapped. With `@default` JSDoc handling defaults at the parser level, migrations are about *transformations*, not *fillings*.

## Open Questions

### Write-back timing

Migrated data: should we write the new snapshot back immediately on read (eager), or only on the next regular write to the resource (deferred)?
- **Eager**: every old-version read produces a write. Read latency includes a snapshot insert. SQLite write traffic scales with read traffic.
- **Deferred**: read returns the migrated value but no write happens. The resource stays at `vN` in storage until something else mutates it. Each subsequent read re-runs the migration chain.
- **Hybrid**: write-back if the chain is long (>1 step) or if we detect repeated reads.

Recommend eager as the default — once-per-old-snapshot cost, simpler invariant. Re-evaluate if write traffic becomes a hot spot.

### Migration facet version skew (carried from 5.2.4.2)

A migration that transforms data from vN → vM and writes the result at vM has an implicit target-schema assumption. If Galaxy's current became `vM+1` mid-migration (interleaved during the facet `await`), the write is "one migration behind" again — not wrong, but wasteful. 5.2.4.2's validator case was safe because writing under vN is fine if current is vN+1 (5.5's lazy migration handles it). Migrations are different — they ARE the lazy-migration step.

Decide:
- (a) Add a target-version check at write time. If it shifted, restart the migration against the new target (re-run the missing step).
- (b) Accept the extra lazy-migration hop on next read.

(b) is simpler and probably fine — the "wasted" migration just becomes a second hop next time. Pick (a) only if measurement shows it matters.

### Migration error handling

If a migration throws (user-developer-supplied code can be wrong), what does the read return?
- The original (un-migrated) data with a typed error indication?
- An error to the client, with the resource frozen at the old version until the migration is fixed?
- A partial migration — apply what worked, leave the rest?

Probably "error to the client with which version + which type + what failed" — same shape as the parse-validate error path. User-developers need enough info to fix the migrate function. The resource staying at the old version is a feature: the bad migration doesn't corrupt storage.

### Standalone package extraction

Should the migration generator (`generateMigrationModule()`?) live in `@lumenize/ts-runtime-parser-validator` alongside `generateParseModule()`, or be its own package?

Lean toward same-package — they share `extractTypeMetadata`, the typia/tsc-bundling pattern, and the facet hosting model. Two packages would duplicate that infrastructure. Different release cadence isn't a strong enough reason to split.

## Success Criteria

- [ ] `OntologyVersionRow` gains a `migrationBundle: string` field (compiled JS module) for v2+
- [ ] First version (no predecessor) has empty/no `migrationBundle`; types not listed in any version's migrate pass through unchanged
- [ ] `compileOntologyVersion()` compiles migrations alongside the validator; failures reject the append at submit time with a clear typia/tsc error
- [ ] Star walks `_index` to drive the migration chain; fetches historical rows from Galaxy via `getOntologyVersion(v)` only as needed
- [ ] Migration runs in a DO facet (same isolation + bundleId-scoping pattern as 5.2.4.2's validator)
- [ ] Lazy migration: resource at vN is migrated to vM on first read; written back as a new snapshot at vM (eager write-back)
- [ ] Cross-resource migrations via `query` parameter work through the facet boundary (callback mechanism designed)
- [ ] Migration errors surface with clear messages (which version, which type, what failed); resource stays at old version until the migration is fixed
- [ ] `@default`-fillable changes (new optional fields with `@default` JSDoc) work without any migration entry — parser handles them on read

## Notes

- The previous version of this task file was written against an `Ontology` class that held all versions in an array and exposed `getMigration(version, typeName)`. That class is gone (deleted in 5.2.4.2 Phase 3). The migration runner now reads the row directly via Galaxy's per-version API.
- `defaults` as a field on the version config is also gone — `@default` JSDoc on optional properties is the user-facing API. Previous open questions about "defaults vs migration overlap" no longer apply in their original form; the new boundary is "`@default`-fillable on the parser side vs. transformations on the migration side."
