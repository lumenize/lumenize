# Phase 5.2.4.2: Galaxy Validator Integration

**Status**: Phases 2 and 3 complete (landed 2026-04-27). Phases 4 and 5 pending.
**Depends on**: 5.2.4.1 (parse-validate package)
**Package**: `apps/nebula/` (Galaxy + Star) consuming `@lumenize/ts-runtime-parser-validator`
**See also**: [parse-validate-blog-and-measurement.md](./parse-validate-blog-and-measurement.md) — pulled-out integrated measurement + the two release blog posts. Can run in parallel with Phases 4 and 5 here.

## Objective

Wire `@lumenize/ts-runtime-parser-validator`'s `generateParseModule()` and the generated module's `parse()` into Nebula's Galaxy/Star architecture. Galaxy compiles validators at ontology registration time. Stars run the pre-compiled validator as a **DO facet** loaded into the Star DO — no network hop on the hot path. `parse()` fills `@default` values and validates in one call on the transaction hot path.

This phase also updates `Resources.transaction()` to use `parse()` instead of the old `validate()` from `@lumenize/ts-runtime-validator`, completing the migration from tsc-based validation to the new parse-validate pipeline.

## Architecture: DO Facet on Star (decided)

The pre-compiled validator lives as a **DO facet** ([announced 2026-04-13](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/)) inside each Star DO. Facets are Dynamic Workers that share their parent DO's isolate and thread, so the Star → validator call is a same-isolate RPC — near-zero latency, no network hop. This is the decided hosting model for this task; the alternative plain-DW approach (one shared DW per ontology version accessed via Service Binding) is a possible future enhancement if we eventually need cross-Star bundle sharing, but is out of scope here.

**Characteristics**:
- Each Star hosts its own facet, loaded lazily from Galaxy on first use of a version
- Galaxy is a versioned ontology registry storing one compiled `OntologyVersionRow` per version (types + bundle + relationships); no DW provisioning at promotion time
- Per-Star cache — one `OntologyVersionRow` in Star KV at a time (~150 KB for a 30-type ontology: 119 KB `validatorBundle` from 5.2.4.1 Phase 6, plus ~30 KB raw `types` source and `relationships` metadata stored alongside per Decision #1)
- Sandboxing is preserved (facets = DW-based, same isolation guarantees)
- Facets are currently Beta (April 2026); track GA timing

No `parse()`-hosting spike is needed in this task — `generateParseModule()`'s output shape and facet-loading mechanics are resolved in 5.2.4.1 Phase 1. Phase 1 below is a post-implementation measurement step (see "Phase ordering"); it focuses on integration overhead on top of the bare-bench numbers from 5.2.4.1 Phase 6.

## Design Decisions

1. **Galaxy owns the registry, acts as composer.** On `appendOntologyVersion()`, Galaxy validates the version label, calls `extractTypeMetadata(types)` to get the relationship graph, then calls `generateParseModule(md.writeShapeTypeDefinitions)` to produce the `validatorBundle` (per 5.2.4.1 Phase 6.5). Compilation failure rejects the update at submit time, not at first request. The package itself does no type-graph rewriting; named-interface fields being validated as string IDs is Nebula policy, not a package behavior. The facet's `parse()` expects IDs on relationship fields — the transaction payload Star sees has already-resolved references. *Implementation note*: `generateParseModule()` calls `extractTypeMetadata()` again internally on whatever it's handed, so this path runs the extractor twice per promotion. Once-per-promotion is fine; not worth optimizing. Galaxy imports `TypeMetadata` from `@lumenize/ts-runtime-parser-validator` to type the stored `relationships` field. *Why we store `relationships` even though no Phase 1–6 code reads it*: 5.5's lazy migration path will need the relationship graph at read time to walk references when migrating data forward across schema versions. Keeping it on the row co-located with `validatorBundle` and `types` means the migrator gets a single `getOntologyVersion(v)` round-trip rather than re-extracting from `types` source. ~30 KB on top of the bundle is the right trade vs deferred re-extraction cost on every cold migration.

2. **Per-version KV rows, ordered index.** Galaxy stores each version as a separate row keyed `ontology:<version>` containing `{ version, types, validatorBundle, relationships }`. A separate `ontology:_index` row holds the ordered version labels (`string[]`), serving both as the "what's the latest" pointer (last entry) and as the migration ordering source for 5.5. No separate `_latest` pointer — the index is the single source of truth for ordering and naming. KV is the right primitive here: KV writes are ~1000× more expensive than reads, so a layout that's write-rare (append-only, one row per promotion) and read-cheap (one or two `kv.get`s per cache miss) is the cost-aligned shape. `kv.list({ prefix: 'ontology:' })` also provides debugging visibility without a dedicated index column.

   *Star caches the same shape*: a single `ontology:<currentVersion>` row + an `ontology:_index` mirroring Galaxy's full ordered history at the moment of last fetch. That means 5.5's lazy migration has the chain order locally — no follow-up Galaxy round-trip just to learn what comes between `vN` (a stored snapshot's version) and `vM` (current). The history is fetched atomically with the latest row via a single `getLatestOntologyVersion()` call returning `{ row, history }` (see "API surface" below) — no risk of an interleaved append racing between two RPCs.

3. **Version label grammar.** Version labels must match `/^[A-Za-z0-9-]+$/` (alphanumerics and dashes only). Validated in `appendOntologyVersion()` before any storage operation. Rejection error: `Invalid ontology version label '<input>': must match /^[A-Za-z0-9-]+$/ (alphanumerics and dashes only).` The `_` prefix used by `ontology:_index` is reserved by exclusion from the regex — no user version can collide.

4. **One JS module per ontology version.** `generateParseModule()` emits a single JS module containing assert/parse functions for all resource types in the ontology plus exported `parse(value, typeName)` and `parseBatch(items)` methods on the `ParserValidator` class. Stars fetch this one string per version, not N strings per type. Shared runtime helpers and the `@default` table are baked into the bundle. The transaction hot-path call site is `await facet.parseBatch(items)` once per transaction over a `Map<resourceId, { value, typeName }>`; `await facet.parse(value, typeName)` is the single-item form for one-off validation outside the transaction loop. Both return Promises — same-isolate RPC. Relationship metadata is **not** baked into the module (per 5.2.4.1 Phase 6.5) — Galaxy stores it in the same row alongside `validatorBundle`, and Star caches the whole row (so the field travels with the bundle), but no code in this task's Phases 1–6 consumes `relationships`. The consumer is 5.5's lazy-migration path (see Decision #1's "Why we store `relationships`").

5. **Lazy bundle fetch — no push notification.** Stars discover new ontology versions via the UI tagging every resource request with its known version. On Handler 1's cache check (existing code), an unknown-or-newer tag triggers a single RPC to Galaxy (`getLatestOntologyVersion()`) which returns `{ row, history }` — the latest row's `validatorBundle` AND the full ordered version history, in one atomic call. Star caches both in its own KV (`ontology:<version>` for the row + `ontology:_index` for the history), loads the facet, and proceeds. *Push notification was considered and dropped: a `{ version }`-only push doesn't save the next-transaction fetch (that's where the cache miss happens), and a `{ version, row }` push fans ~150 KB to every Star regardless of whether they'll transact again. The one-time post-promotion ~300 ms latency on the first transaction per Star is acceptable as a UI blip. If telemetry shows this becomes a real problem, push is a small additive change to retrofit.*

6. **UI is the version source of truth on the client.** The browser fetches a UI bundle from Galaxy (mechanism out of scope here — see `tasks/lumenize-ui.md`) which embeds the current ontology version. The UI tags every resource request with that version. A user-initiated refresh is the recovery path if the embedded version ever falls behind — no polling, no TTL, no push acks needed. *Scope note*: this task's Phases 1–5 don't depend on the UI work — the test client (`NebulaClientTest.callStarTransaction(star, version, ops)`) lets tests pass any version label directly, so the full Galaxy + Star + facet path is exercisable end-to-end without `tasks/lumenize-ui.md` landing first. The UI bundle becomes load-bearing only at production rollout.

7. **Eager version switch, JS references handle in-flight transactions.** When Star fetches a new version, it eagerly replaces its cached row + facet. In-flight transactions that already captured the old facet into a local variable continue to use it via JS closure semantics; when they return, the local reference drops and the old facet is GC'd. Concurrency safety comes from `Resources.transaction()`'s existing double-eTag-check protocol (optimistic pre-check → parse/guards → pessimistic recheck → `transactionSync` write). Writing data validated under version N is safe even if current becomes N+1 mid-transaction — 5.5's lazy migration handles version skew at read time. No refcount bookkeeping, no TTL. Star's KV holds exactly one `ontology:<currentVersion>` row at a time, plus the full ordered `ontology:_index` (mirrored from Galaxy at last fetch) so 5.5 can walk the migration chain without an extra round-trip.

   *Facet `bundleId`*: `${galaxyId}/${version}` where `galaxyId` is `<universe>.<galaxy>` (the first two dot-segments of Star's instanceName, e.g. `'acme.app/v1'`). The Worker Loader caches by `bundleId` *per-Worker*, not per-DO, so all Stars in the same Worker share the loader cache; using just `version` as `bundleId` would let two Galaxies (or two tests) with overlapping version labels collide on the loader cache and silently see each other's validator. Scoping by `galaxyId` namespaces them — and including the universe segment matters: the same galaxy slug ('app') can legitimately be reused across universes, and the loader cache wouldn't see them as distinct otherwise. A version switch within the same galaxy passes a different `bundleId`, which produces a fresh facet via Worker Loader's per-`bundleId` cache; the old facet's stub is no longer referenced by `#facet` and is eligible for collection. Version labels are guaranteed unique within a galaxy by Decision #2's append-only `_index`, and the `<universe>.<galaxy>` prefix disambiguates across galaxies and across universes.

   *Note for Phase 5.5*: Migrations running in facets may want an additional version check at write time (not just data eTag) to avoid writing migrated data against a stale target schema. Design this when 5.5 picks up.

8. **Stale-tagged transactions are rejected (already implemented).** [`star.ts:149`](apps/nebula/src/star.ts:149) already rejects transactions tagged for a version that doesn't match Star's current version with a clear "Refresh your schema" error including the actual current version. Behavior carries over under the new layout — only the comparison source shifts (cached `_index` last entry instead of `Ontology.latestVersion`).

9. **`parseBatch()` is the transaction hot-path call (`parse()` is the single-item form).** `Resources.transaction()` calls `parseBatch()` once per transaction over a `Map<resourceId, { value, typeName }>` built from the entries that need parsing. The previous tsc-based method is removed entirely. `@default` filling happens inside the parser; callers discriminate on `result.valid` to narrow to `data` (success) or `errors` (failure). The resulting `data` overwrites `op.value` so downstream Step 7+ sees the filled object. Input-gate openings collapse from N to 1 per transaction; correctness across input-gate windows is still guaranteed by the existing eTag double-check.

10. **No `Ontology` class abstraction.** [ontology.ts](./apps/nebula/src/ontology.ts) is deleted. Galaxy holds raw rows in KV; Star holds `#row: OntologyVersionRow | null` and `#facet: ParserValidator | null` as separate fields, populated together on cache miss. The named types for this layer — `OntologyVersionConfig` (input) and `OntologyVersionRow` (stored) — both live in `galaxy.ts` (Galaxy is the producer). A `compileOntologyVersion(versionConfig): OntologyVersionRow` pure helper lives alongside them. *Considered and rejected: keep `Ontology` (didn't fit the per-row storage); introduce `OntologyVersion` class (singular name awkward; methods were 1-line passthroughs that earned no encapsulation).*

11. **Security framing.** DO facet sandboxing (DW-based) is the security boundary; compiling at schema-registration time (not per-request) is a bonus, not the primary defense.

## Phase ordering

Implementation order is **2 → 3 → 4 → 5**. Phases 2 and 3 are tightly coupled (removing `getOntology()` in 2 breaks Star until 3 lands) and ship as one unit; Phase 4 is verification of the lifecycle behavior; Phase 5 removes the old package and deprecates it.

Integrated measurement and the public-facing blog posts have moved to a separate task: see [parse-validate-blog-and-measurement.md](./parse-validate-blog-and-measurement.md). That task owns the pre-implementation Cloudflare facet beta-status check, the integrated cold/warm latency benchmarks, the tsc-baseline comparison spike, and the two paired blog posts (release announcement + facet-performance deep-dive). Splitting it out kept this task focused on bounded code changes; it can run in parallel with Phases 4 and 5 here once Phases 2/3 have landed.

## Phase 2: Galaxy as Per-Version Registry

**Goal**: Replace Galaxy's whole-ontology storage with a per-version row layout, compile the `validatorBundle` at submit time, and expose the per-version API Star needs.

### What's already in place

- `appendOntologyVersion(versionConfig)` admin-gated `@mesh()` method ([`galaxy.ts:24-38`](apps/nebula/src/galaxy.ts:24))
- Duplicate-version-label rejection (current implementation scans the array)
- Eager validation at submit time (current implementation calls `new Ontology(updated)` to surface parse errors)
- The `requireAdmin` gate carries over unchanged

### What changes

- Storage shape: `kv.put('ontology', [...wholeArray])` → per-version rows + `_index`
- Read API: `getOntology(): OntologyVersionConfig[]` → three new mesh methods (`getLatestOntologyVersion`, `getOntologyVersion`, `listOntologyVersions`)
- Append internals: rewritten around `compileOntologyVersion()` + atomic two-key write
- New: version-label regex validation before any storage op

### Storage layout

`OntologyVersionRow` (defined in `apps/nebula/src/galaxy.ts`, alongside `OntologyVersionConfig` which moves here from `ontology.ts`):
```
ontology:<version>  →  OntologyVersionRow   // immutable after write
ontology:_index     →  string[]             // ordered version labels
```


```typescript
interface OntologyVersionRow {
  version: string;
  types: string;                              // original TS source — stored "just in case" for debug / future migration tooling; not used at runtime
  validatorBundle: string;                    // generateParseModule() output — this is what runs in the facet
  relationships: TypeMetadata['relationships'];
}
```

### API surface

```typescript
@mesh()              getLatestOntologyVersion(): OntologyState | null   // { row, history }
@mesh()              getOntologyVersion(version: string): OntologyVersionRow | null
@mesh()              listOntologyVersions(): string[]
@mesh(requireAdmin)  appendOntologyVersion(versionConfig: OntologyVersionConfig)
```

`getOntology()` (returns whole array) is removed. `getLatestOntologyVersion()` reads `ontology:_index`, returns `{ row: kv.get('ontology:<latest>'), history: index }` so Star captures the latest row AND the full ordered history in one call — no two-RPC race window where an `appendOntologyVersion()` could land between them. Returns `null` when no versions have been appended yet — Star treats this the same as a missing-version mismatch. `getOntologyVersion(v)` (used by 5.5 to fetch a specific historical row) and `listOntologyVersions()` (used for admin/debugging) stay as standalone methods.

### Append flow

1. Validate `versionConfig.version` against `/^[A-Za-z0-9-]+$/` — reject with the named error per Decision #3.
2. Read `ontology:_index`; reject if label already exists.
3. Compile via `compileOntologyVersion(versionConfig)`: `extractTypeMetadata(types)` + `generateParseModule(md.writeShapeTypeDefinitions)`. Both fail loud at submit time, surfacing typia's error to the caller.
4. Atomic write inside `ctx.storage.transactionSync(() => { ... })`:
  - `kv.put('ontology:<version>', row)`
  - `kv.put('ontology:_index', [...index, version])`

### What goes away

- The current `Ontology` class is no longer used in `appendOntologyVersion()` (used only to throw on parse errors). Replaced by direct `extractTypeMetadata` + `generateParseModule` calls inside `compileOntologyVersion()`, which throw clear errors on invalid types.
- `OntologyVersionConfig.defaults` field — defaults now come from `@default` JSDoc tags in the `types` source (per 5.2.4.1 Phase 4).
- `OntologyVersionConfig.migrate` field — currently an unused placeholder; 5.5 will define the migration signature when it picks up.
- `OntologyVersionConfig` interface itself moves from `ontology.ts` (deleted in Phase 3) to `galaxy.ts`, next to `OntologyVersionRow`.
- The whole-array `kv.put('ontology', [...])` storage.

### Success Criteria

- [ ] Galaxy stores per-version rows under `ontology:<version>` keys
- [ ] Galaxy stores ordered index under `ontology:_index`
- [ ] `appendOntologyVersion()` validates label, compiles bundle, writes atomically
- [ ] Compilation failure rejects the append at submit time with a clear typia error referencing the failing type
- [ ] Invalid version labels rejected before any storage op with the named error
- [ ] All four mesh methods (`getLatestOntologyVersion`, `getOntologyVersion`, `listOntologyVersions`, `appendOntologyVersion`) functional and tested
- [ ] `getOntology()` and the whole-array storage removed

## Phase 3: Star Parse Pipeline

**Goal**: Stars validate via the facet using the per-version row from Galaxy, replacing in-process tsc validation. Most of the surrounding plumbing (Handler 1 / Handler 2 cache pattern, version-mismatch rejection, lazy fetch on cache miss) already exists in [star.ts](./apps/nebula/src/star.ts) — this phase upgrades *what* Star fetches and *how* it validates, not the dispatch logic.

### What's already in place (no changes needed)

- `transaction(ontologyVersion, ops)` Handler 1 + `doTransaction()` Handler 2 split
- Cache-miss → fetch from Galaxy → store → re-execute pattern via the mesh continuation handler
- Stale-version rejection ("Refresh your schema") with the actual current version in the error
- Symmetric two-handler pattern for `read()` / `doRead()`

### What changes

- Add a Worker Loader binding to each `wrangler.jsonc`:
```jsonc
  "worker_loaders": [{ "binding": "LOADER" }]
```
- Bump `compatibility_date` to ≥ `2026-04-01` so `ctx.facets` is available (the `@lumenize/ts-runtime-parser-validator` package's helper assumes this date for the spawned DW)
- Run `npm run types` to refresh the generated `Env` interface so `this.env.LOADER` type-checks

**Star state**:
- `#ontology: Ontology | null` → `#row: OntologyVersionRow | null` + `#facet: ParserValidator | null`
- Both fields populated together on cache miss; both replaced together on version switch
- `Resources.transaction()`, `Star.doTransaction()`, and `Star.doRead()` become `async` because `parseBatch()` returns a Promise across the facet RPC boundary. Per CLAUDE.md's "Keep Methods Synchronous" rule this is unusual — facet RPC at ~1 ms warm IS long enough to open an input gate and allow interleaving (unlike `crypto.subtle.*`, which the rule's exception list scopes to microsecond-scale APIs). What makes the gate-opening safe here is the eTag double-check inside `transactionSync` (Decision #9): any concurrent transaction that interleaves during the parse will be caught by the pessimistic recheck and re-issued. The async hop is a deliberate trade — N input-gate openings collapse to 1 per transaction (Decision #9), and correctness is preserved by the existing optimistic-concurrency protocol, not by avoiding the gate.

**Star storage**:
- Replace the current `kv.put('ontology', [...wholeArray])` with a per-version layout mirroring Galaxy's keys: `ontology:<currentVersion>` (one row at a time) + `ontology:_index` (full ordered history mirrored from Galaxy at last fetch, per Decision #2). The history mirror is what 5.5 walks for lazy migration ordering
- The cache-check helper [`#hasOntologyVersion`](apps/nebula/src/star.ts:49) is renamed `#isCachedVersion(version)` to reflect the new semantic — it now answers "does this tag match the latest entry in my cached `_index`?" The `_index` mirrors Galaxy's full ordered history (per Decision #2), and the cached row is always the *latest* (last entry). Older entries are part of the migration chain (5.5) but no row is cached for them. On any mismatch — older or newer — Handler 1 fetches from Galaxy; the cache check decides whether to fetch, not whether the tag is current
-  `#currentOntology` getter ([`star.ts:54`](apps/nebula/src/star.ts:54)) goes away — replaced by direct `#row` and `#facet` access

**Cache-miss fetch**:
- Replace `Galaxy.getOntology()` with `Galaxy.getLatestOntologyVersion()`
- Star receives an `OntologyState` = `{ row, history }` — the latest row plus the full ordered version list, captured atomically on Galaxy's side
- If `state.row.version` doesn't match what the client tagged, reject with the existing stale-version error (including the actual current version from the fetched state)
- On accept, replace the cache atomically inside `ctx.storage.transactionSync(() => { ... })`:
  - Delete the previous `ontology:<v>` row, if one exists (cold-start path has none — read the previous `_index` to find the previous latest)
  - `kv.put('ontology:<row.version>', row)`
  - `kv.put('ontology:_index', history)` — full ordered history, NOT just `[row.version]`

  Then load the facet via `getParserValidatorFacet()` from `@lumenize/ts-runtime-parser-validator` and populate `#row` and `#facet`. Star's invariant: at any time, exactly one `ontology:<version>` row exists in KV (the latest), `_index` is the full ordered history (oldest → newest), and the cached row's version matches `_index[_index.length - 1]`.

**Validation in `Resources.transaction`**:
- Replace the per-op `ontology.validate()` loop ([`resources.ts:282-305`](apps/nebula/src/resources.ts:282)) with a single batch call. Build `requests: Map<string, ParseRequest>` from the entries that actually need parsing, using `resourceId` as the key. Skip the same cases the existing loop continues on: `delete`/`move` ops, `create`/`put` with `op.value == null`, and `put` with no current snapshot. If `requests.size === 0`, skip the call entirely. Otherwise call `await facet.parseBatch(requests)` once and walk the returned Map — each entry shares the input key so the caller maps back via direct `results.get(resourceId)`.
- For each successful per-item result, write `result.data` back onto the corresponding `op.value` so downstream Step 7+ sees the `@default`-filled value. The manual defaults-spread block ([`resources.ts:286-289`](apps/nebula/src/resources.ts:286): `const defaults = ontology.getDefaults(typeName); if (defaults) op.value = { ...defaults, ...op.value };`) goes away — `parseBatch()` fills defaults inside the parser.
- For each failed per-item result, populate `validationErrors[resourceId]` with the same `{ type: 'validation', errors }` shape the current loop produces.
- Update `ValidationError` import in `apps/nebula/src/resources.ts` from `@lumenize/ts-runtime-validator` to `@lumenize/ts-runtime-parser-validator`.
- Convert the `valid: true | { valid: false, errors }` discriminant consumers to the new `{ valid: true, data } | { valid: false, errors }` shape.

### What gets deleted

- [ontology.ts](./apps/nebula/src/ontology.ts) (the `Ontology` class, including its `getDefaults()` / `validate()` / `getRelationship()` methods and the `#latestDefaults` / `#metadata` instance fields)
- `Ontology` export from [index.ts](./apps/nebula/src/index.ts) (the `OntologyVersionConfig` re-export stays, now sourced from `galaxy.ts`)
- The manual defaults-spread block in `Resources.transaction()` Step 5

(`OntologyVersionConfig.defaults` and `.migrate` field removals are listed under Phase 2's "What goes away" since they belong to Galaxy's input shape.)

### Test migration

- Tests using `OntologyVersionConfig.defaults` ([`star-ontology.test.ts:189`](apps/nebula/test/test-apps/baseline/star-ontology.test.ts:189) and `:265`) move defaults into `@default` JSDoc tags inside the `types` string.
- The `callGalaxyGetOntology()` helper at [`test-apps/baseline/index.ts:302-304`](apps/nebula/test/test-apps/baseline/index.ts:302) (which calls `Galaxy.getOntology()`) is replaced with helpers that wrap the new mesh API: `callGalaxyGetLatestOntologyVersion()` and/or `callGalaxyListOntologyVersions()`.
- The `appendOntologyVersion + getOntology round-trip` and ordering tests at [`star-ontology.test.ts:63-94`](apps/nebula/test/test-apps/baseline/star-ontology.test.ts:63) are reshaped to assert against the new per-version API rather than the whole-`OntologyVersionConfig[]` shape.

### Success Criteria

- [ ] `apps/nebula/wrangler.jsonc`, `apps/nebula/test/wrangler.jsonc`, and every `apps/nebula/test/test-apps/<name>/test/wrangler.jsonc` have a `LOADER` Worker Loader binding and `compatibility_date >= 2026-04-01`
- [ ] Star validates via the facet, not in-process tsc
- [ ] `#row` and `#facet` populated lazily on cache miss; both null until first transaction
- [ ] Cache survives hibernation: Star reads `ontology:<version>` from its own KV on wake without re-fetching from Galaxy
- [ ] `@default` filling works through the parse pipeline; `Resources.transaction()` uses `data` from the parse result
- [ ] All `ontology.validate()` call sites in `apps/nebula/src/` migrated to `facet.parse()` / equivalent
- [ ] `Ontology` class and `apps/nebula/src/ontology.ts` deleted; `Ontology` export removed from `apps/nebula/src/index.ts`; `OntologyVersionConfig` (without `defaults`/`migrate`) lives in `galaxy.ts`; manual defaults-spread removed; tests migrated to `@default` JSDoc
- [ ] Disconnected Star recovers on first resource request tagged with a newer version (existing lazy fetch path, validated under the new layout)
- [ ] Stale-tagged transactions rejected with a clear error including the actual current version

## Phase 4: Lifecycle and Eviction

**Goal**: Confirm the runtime behavior of cached rows + facet instances over time. With push dropped (Decision #5), most of the original phase scope is gone — there are no concurrent version-promotion races to coordinate, no fan-out to drain.

### What's true by design

- Star's KV holds at most one current version row (under `ontology:<currentVersion>`) plus the index. On lazy version switch, the new row is written and the old is deleted in the same `transactionSync`.
- In-flight transactions that already captured the old facet into a local variable continue to use it via JS closure semantics. When they return, the local reference drops and the old facet is GC'd. No explicit refcount, no drain bookkeeping.
- Stale-tagged transactions arriving after a switch are rejected with the existing stale-version error (Decision #8).
- DO hibernation handles facet warm/cold transparently: when Star hibernates, the facet hibernates with it; when Star wakes, the facet is reconstructed from the cached bundle string. No explicit warm-keeping logic.
- No TTL anywhere — UI-tagged version + lazy fetch + eager cache replacement + JS closures for in-flight safety replace any polling model.

### Work (verification, not new mechanism)

- Test that Star's KV cleanup (delete old version row when caching new) happens atomically with the new write
- Soak test: append N versions in a row through Star; after each, verify only one `ontology:<v>` row plus the index exists in Star's KV
- Verify stale-tagged transactions after a switch reject cleanly without disturbing KV state
- Verify rapid back-to-back transactions on the new version succeed (cache-hit path immediately after a switch)

*An explicit "in-flight transaction across a version switch" test was considered and dropped*: the property is JS closure semantics — `Star.doTransaction` captures `facet` into a local at the top of the function, and any subsequent `#installState()` only reassigns `#facet`, not the local. There's no orchestration this layer can do to make that wrong, and our test infrastructure doesn't expose hooks to pause execution mid-`await` to drive a "during" window. The visible properties that follow (post-switch state correct, no KV drift, stale rejection clean) are tested directly.

### Success Criteria

- [x] Star's KV holds exactly one `ontology:<version>` row at all times (the latest); `_index` mirrors Galaxy's full ordered history for 5.5 chain-walking — `single-row invariant` test
- [x] Soak test: after N version switches, no stale rows accumulate in Star's KV; `_index` grows in lockstep with Galaxy's history — `soak` test
- [x] Stale-tagged transactions after a switch are rejected with a clear error and don't disturb KV state — `post-switch: stale-tagged` test
- [x] Cache-hit path works immediately after a switch (the new facet is installed atomically with the new row) — `rapid back-to-back` test
- [Skipped] In-flight transaction race test — see "Work" section above for rationale

## Phase 5: Old Package Removal and Deprecation

**Goal**: Remove `@lumenize/ts-runtime-validator` dependency from Nebula and deprecate the package on npm.

**Work**:
- Verify all call sites in `apps/nebula/` use new package
- Remove old package from `apps/nebula/package.json`
- Update any remaining imports
- `npm deprecate @lumenize/ts-runtime-validator "Use @lumenize/ts-runtime-parser-validator instead"` (moved here from 5.2.4.1 Phase 7 — pairing deprecation with Nebula's removal lets us postpone the deprecate if integration uncovers problems, without needing to un-deprecate. No migration guide per 5.2.4.1 Phase 7 — the new package is framed as a fresh package, not a successor.)

**Success Criteria**:
- [ ] Zero imports of `@lumenize/ts-runtime-validator` in `apps/nebula/`
- [ ] All tests pass with new package only
- [ ] `@lumenize/ts-runtime-validator` deprecated on npm with pointer to new package

## Open Questions

- How does 5.2.6 (validation in plain Worker) relate? It was designed for the tsc engine. With this work, the facet IS the validator — 5.2.6 may be superseded or simplified.
- Plain-DW deployment without a facet parent is a future enhancement — revisit if we need cross-Star bundle sharing.
- Dev mode deferred to `tasks/dev-mode-branching.md` — no facet provisioning in dev.
- Integrated latency measurement, tsc-baseline comparison, facet beta-status check, and the two release blog posts live in [parse-validate-blog-and-measurement.md](./parse-validate-blog-and-measurement.md).

## Notes

- **Dev-mode concerns** deferred to `tasks/dev-mode-branching.md`.
