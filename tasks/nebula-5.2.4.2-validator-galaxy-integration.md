# Phase 5.2.4.2: Galaxy Validator Integration

**Status**: Not started — design pinned 2026-04-25
**Depends on**: 5.2.4.1 (parse-validate package)
**Package**: `apps/nebula/` (Galaxy + Star) consuming `@lumenize/ts-runtime-parser-validator`

## Objective

Wire `@lumenize/ts-runtime-parser-validator`'s `generateParseModule()` and the generated module's `parse()` into Nebula's Galaxy/Star architecture. Galaxy compiles validators at ontology registration time. Stars run the pre-compiled validator as a **DO facet** loaded into the Star DO — no network hop on the hot path. `parse()` fills `@default` values and validates in one call on the transaction hot path.

This phase also updates `Resources.transaction()` to use `parse()` instead of the old `validate()` from `@lumenize/ts-runtime-validator`, completing the migration from tsc-based validation to the new parse-validate pipeline.

## Architecture: DO Facet on Star (decided)

The pre-compiled validator lives as a **DO facet** ([announced 2026-04-13](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/)) inside each Star DO. Facets are Dynamic Workers that share their parent DO's isolate and thread, so the Star → validator call is a same-isolate RPC — near-zero latency, no network hop. This is the decided hosting model for this task; the alternative plain-DW approach (one shared DW per ontology version accessed via Service Binding) is a possible future enhancement if we eventually need cross-Star bundle sharing, but is out of scope here.

**Characteristics**:
- Each Star hosts its own facet, loaded lazily from Galaxy on first use of a version
- Galaxy is a versioned ontology registry storing one compiled `OntologyVersionRow` per version (types + bundle + relationships); no DW provisioning at promotion time
- Per-Star cache — one `OntologyVersionRow` in Star KV at a time (~120 KB for a 30-type ontology, per 5.2.4.1 Phase 6 measurements)
- Sandboxing is preserved (facets = DW-based, same isolation guarantees)
- Facets are currently Beta (April 2026); track GA timing

No `parse()`-hosting spike is needed in this task — `generateParseModule()`'s output shape and facet-loading mechanics are resolved in 5.2.4.1 Phase 1. Phase 1 below focuses on measuring integration overhead on top of the bare-bench numbers from 5.2.4.1 Phase 6.

## Design Decisions

1. **Galaxy owns the registry, acts as composer.** On `appendOntologyVersion()`, Galaxy validates the version label, calls `extractTypeMetadata(types)` to get the relationship graph, then calls `generateParseModule(md.writeShapeTypeDefinitions)` to produce the `validatorBundle` (per 5.2.4.1 Phase 6.5). Compilation failure rejects the update at submit time, not at first request. The package itself does no type-graph rewriting; named-interface fields being validated as string IDs is Nebula policy, not a package behavior. The facet's `parse()` expects IDs on relationship fields — the transaction payload Star sees has already-resolved references.

2. **Per-version KV rows, ordered index.** Galaxy stores each version as a separate row keyed `ontology:<version>` containing `{ version, types, validatorBundle, relationships }`. A separate `ontology:_index` row holds the ordered version labels (`string[]`), serving both as the "what's the latest" pointer (last entry) and as the migration ordering source for 5.5. No separate `_latest` pointer — the index is the single source of truth for ordering and naming. KV is the right primitive here: KV writes are ~1000× more expensive than reads, so a layout that's write-rare (append-only, one row per promotion) and read-cheap (one or two `kv.get`s per cache miss) is the cost-aligned shape. `kv.list({ prefix: 'ontology:' })` also provides debugging visibility without a dedicated index column.

3. **Version label grammar.** Version labels must match `/^[A-Za-z0-9-]+$/` (alphanumerics and dashes only). Validated in `appendOntologyVersion()` before any storage operation. Rejection error: `Invalid ontology version label '<input>': must match /^[A-Za-z0-9-]+$/ (alphanumerics and dashes only).` The `_` prefix used by `ontology:_index` is reserved by exclusion from the regex — no user version can collide.

4. **One JS module per ontology version.** `generateParseModule()` emits a single JS module containing assert/parse functions for all resource types in the ontology plus an exported `parse(value, typeName): { valid: true, data } | { valid: false, errors }` that dispatches by name. Stars fetch this one string per version, not N strings per type. Shared runtime helpers and the `@default` table are baked into the bundle. Call site after loading into the facet: `await`` facet.parse(value, typeName)` (the helper returns a Promise — same-isolate RPC). Relationship metadata is **not** baked into the module (per 5.2.4.1 Phase 6.5) — Galaxy stores it in the same row alongside `validatorBundle`, and Star reads it from that row.

5. **Lazy bundle fetch — no push notification.** Stars discover new ontology versions via the UI tagging every resource request with its known version. On Handler 1's cache check (existing code), an unknown-or-newer tag triggers a single RPC to Galaxy (`getLatestOntologyVersion()`) which returns the row including the `validatorBundle`. Star caches the row in its own KV (`ontology:<version>` and `ontology:_index` mirroring Galaxy's keys), loads the facet, and proceeds. *Push notification was considered and dropped: a ****\*******`{ version }`****\*-only push doesn't save the next-transaction fetch (that's where the cache miss happens), and a ****\*******`{ version, row }`****\* push fans \~150 KB to every Star regardless of whether they'll transact again. The one-time post-promotion \~300 ms latency on the first transaction per Star is acceptable as a UI blip. If telemetry shows this becomes a real problem, push is a small additive change to retrofit.*

6. **UI is the version source of truth on the client.** The browser fetches a UI bundle from Galaxy (mechanism out of scope here — see `tasks/lumenize-ui.md`) which embeds the current ontology version. The UI tags every resource request with that version. A user-initiated refresh is the recovery path if the embedded version ever falls behind — no polling, no TTL, no push acks needed.

7. **Eager version switch, JS references handle in-flight transactions.** When Star fetches a new version, it eagerly replaces its cached row + facet. In-flight transactions that already captured the old facet into a local variable continue to use it via JS closure semantics; when they return, the local reference drops and the old facet is GC'd. Concurrency safety comes from `Resources.transaction()`'s existing double-eTag-check protocol (optimistic pre-check → parse/guards → pessimistic recheck → `transactionSync` write). Writing data validated under version N is safe even if current becomes N+1 mid-transaction — 5.5's lazy migration handles version skew at read time. No refcount bookkeeping, no TTL. Star's KV holds exactly one current `ontology:<version>` row at a time.

   *Note for Phase 5.5*: Migrations running in facets may want an additional version check at write time (not just data eTag) to avoid writing migrated data against a stale target schema. Design this when 5.5 picks up.

8. **Stale-tagged transactions are rejected (already implemented).** [`star.ts:149`](apps/nebula/src/star.ts:149) already rejects transactions tagged for a version that doesn't match Star's current version with a clear "Refresh your schema" error including the actual current version. Behavior carries over under the new layout — only the comparison source shifts (cached `_index` last entry instead of `Ontology.latestVersion`).

9. **`parse()`**** replaces \****`validate()`**\*\* in the transaction pipeline.** `Resources.transaction()` calls `parse()` (fill defaults + validate) instead of the old tsc-based `validate()`. `@default` filling happens automatically inside `parse()` — no separate fill step in the pipeline. Callers discriminate on `result.valid` to narrow to `data` (success) or `errors` (failure). The resulting `data` replaces `op.value` for downstream Step 7+ usage because defaults are now filled.

10. ** \****`Ontology`**\*\* class abstraction.** [ontology.ts](./apps/nebula/src/ontology.ts) is deleted. Galaxy holds raw rows in KV; Star holds `#row``````: OntologyVersionRow | null` and `#facet``````: ParserValidator | null` as separate fields, populated together on cache miss. The named types for this layer — `OntologyVersionConfig` (input) and `OntologyVersionRow` (stored) — both live in `galaxy.ts` (Galaxy is the producer). A `compileOntologyVersion(versionConfig): OntologyVersionRow` pure helper lives alongside them. *Considered and rejected: keep ****\*******`Ontology`****\* (didn't fit the per-row storage), introduce ****\*******`OntologyVersion`****\* class (singular name awkward; methods were 1-line passthroughs that earned no encapsulation).*

11. **Security framing.** DO facet sandboxing (DW-based) is the security boundary; compiling at schema-registration time (not per-request) is a bonus, not the primary defense.

## Phase 1: Facet Integration Validation

**Goal**: Validate the facet-hosted validator end-to-end with Nebula's mesh routing in the loop, and measure the integration cost (if any) on top of the facet path. Hosting approach (facet) and bundle shape are already decided in 5.2.4.1 Phase 1; raw cold/warm latency for facets was measured in 5.2.4.1 Phase 6 (cold ~1.7 s, warm ~1.4 ms deployed). This phase's question is the *additional* cost of putting Galaxy + Star + mesh routing on top of that path.

**Work**:
- Extend the existing baseline test-app at `apps/nebula/test/test-apps/baseline/` to exercise the full path: client → Gateway → Star Handler 1 (cache miss) → Galaxy `getLatestOntologyVersion()` → Star Handler 2 (load facet from row, run `parse()`, write transaction) → response
- Measure end-to-end: cold path (Star wake + Galaxy fetch + facet load + first parse) and warm path (subsequent transactions)
- Compare vs the bare GalaxyDO+StarDO bench from `experiments/ts-runtime-parser-validator-spike/`. Identify any meaningful overhead from mesh routing
- Check facet beta status: any production blockers? API stability signals from Cloudflare?

**Decision gate**: Continue unless production blockers surface. If facets prove to have API instability, correctness issues, or severe perf regressions in the integrated path, pause and reopen the plain-DW path as a fallback before continuing.

**Success Criteria**:
- [ ] Integrated Galaxy + Star + facet path validates a real transaction end-to-end
- [ ] End-to-end latency numbers (cold / warm p50 / warm p99) recorded in this file; integration overhead vs bare bench documented
- [ ] Facet beta-status risks documented

## Phase 2: Galaxy as Per-Version Registry

**Goal**: Replace Galaxy's whole-ontology storage with a per-version row layout, compile the `validatorBundle` at submit time, and expose the per-version API Star needs.

### What's already in place

- `appendOntologyVersion(versionConfig)` admin-gated `@mesh()` method ([`galaxy.ts:24-38`](apps/nebula/src/galaxy.ts:24))
- Duplicate-version-label rejection (currently scans the array; will read the index)
- Eager validation at submit time (currently via `new Ontology(updated)` to throw on parse errors; moves to `compileOntologyVersion()` doing `extractTypeMetadata` + `generateParseModule`)
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
@mesh()              getLatestOntologyVersion(): OntologyVersionRow
@mesh()              getOntologyVersion(version: string): OntologyVersionRow | null
@mesh()              listOntologyVersions(): string[]
@mesh(requireAdmin)  appendOntologyVersion(versionConfig: OntologyVersionConfig)
```

`getOntology()` (returns whole array) is removed. `getLatestOntologyVersion()` reads `ontology:_index`, takes the last entry, returns `kv.get('ontology:<latest>')`.

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
- `#ontology````: Ontology | null` → `#row``````: OntologyVersionRow | null` + `#facet``````: ParserValidator | null`
- Both fields populated together on cache miss; both replaced together on version switch

**Star storage**:
- Replace the current `kv.put('ontology', [...wholeArray])` with a per-version layout mirroring Galaxy's keys: `ontology:<version>` + `ontology:_index`. In practice Star only ever has the single current version cached, but the parallel key shape sets up future migration-aware caching (5.5)
- The cache-check helper [`#hasOntologyVersion`](apps/nebula/src/star.ts:49) shifts from "version exists in stored array" to "tag matches the *single* cached version label" (Star holds at most one row per Decision #7). On any mismatch — older or newer — Handler 1 fetches from Galaxy; the cache check decides whether to fetch, not whether the tag is current
-  `#currentOntology` getter ([`star.ts:54`](apps/nebula/src/star.ts:54)) goes away — replaced by direct `#row` and `#facet` access

**Cache-miss fetch**:
- Replace `Galaxy.getOntology()` with `Galaxy.getLatestOntologyVersion()`
- Star receives a single `OntologyVersionRow` rather than the whole array
- If the returned `version` doesn't match what the client tagged, reject with the existing stale-version error (now including the actual current version from the fetched row)
- On accept, replace the cache atomically inside `ctx.storage.transactionSync(() => { ... })`:
  - Delete any pre-existing `ontology:<v>` rows (at most one, found via the current `_index`)
  - `kv.put('ontology:<row.version>', row)`
  - `kv.put('ontology:_index', [row.version])`

  Then load the facet via `getParserValidatorFacet()` from `@lumenize/ts-runtime-parser-validator` and populate `#row` and `#facet`. Star's invariant: at any time, exactly one `ontology:<version>` row exists in KV and `_index` is a one-element array containing that same version label.

**Validation in \****`Resources.transaction`**:
- Replace `ontology.validate(op.value, typeName)` with `facet.parse(op.value, typeName)` (passed in by Star — exact signature shape bikeshed at implementation time; probably an inline `{ version, parse }` or two args)
- Replace the manual defaults-spread block ([`resources.ts:286-289`](apps/nebula/src/resources.ts:286): `const defaults = ontology.getDefaults(typeName); if (defaults) op.value = { ...defaults, ...op.value };`) with using `data` from a successful `parse()` result — `parse()` fills defaults in one call. Write `result.data` back onto `op.value` so downstream steps see the filled object.
- Update `ValidationError` import in `apps/nebula/src/resources.ts` from `@lumenize/ts-runtime-validator` to `@lumenize/ts-runtime-parser-validator`
- Convert the `valid: true | { valid: false, errors }` discriminant consumers to the new `{ valid: true, data } | { valid: false, errors }` shape

### What gets deleted

- [ontology.ts](./apps/nebula/src/ontology.ts) (the `Ontology` class)
- `Ontology` export from [index.ts](./apps/nebula/src/index.ts) (the `OntologyVersionConfig` re-export stays, now sourced from `galaxy.ts`)
- `OntologyVersionConfig.defaults` field — defaults now come from `@default` JSDoc tags in the types source (5.2.4.1 Phase 4)
- `OntologyVersionConfig.migrate` field — unused placeholder; 5.5 will define the migration signature
- `Ontology.getDefaults()`, `Ontology.validate()`, `Ontology.getRelationship()` methods
- `Ontology` `#latestDefaults` and `#metadata` instance fields
- The manual defaults-spread block in `Resources.transaction()` Step 5

### Test migration

- Tests using `OntologyVersionConfig.defaults` ([`star-ontology.test.ts:189`](apps/nebula/test/test-apps/baseline/star-ontology.test.ts:189) and `:265`) move defaults into `@default` JSDoc tags inside the `types` string.
- The `callGalaxyGetOntology()` helper at [`test-apps/baseline/index.ts:302-304`](apps/nebula/test/test-apps/baseline/index.ts:302) (which calls `Galaxy.getOntology()`) is replaced with helpers that wrap the new mesh API: `callGalaxyGetLatestOntologyVersion()` and/or `callGalaxyListOntologyVersions()`.
- The `appendOntologyVersion + getOntology round-trip` and ordering tests at [`star-ontology.test.ts:63-94`](apps/nebula/test/test-apps/baseline/star-ontology.test.ts:63) are reshaped to assert against the new per-version API rather than the whole-`OntologyVersionConfig[]` shape.

**Wrangler config** (Nebula app + every test-app under `apps/nebula/test/test-apps/`):
### Success Criteria

- [ ] `apps/nebula/wrangler.jsonc` and every test-app wrangler under `apps/nebula/test/test-apps/` have a `LOADER` Worker Loader binding and `compatibility_date >= 2026-04-01`
- [ ] Star validates via the facet, not in-process tsc
- [ ] `#row` and `#facet` populated lazily on cache miss; both null until first transaction
- [ ] Cache survives hibernation: Star reads `ontology:<version>` from its own KV on wake without re-fetching from Galaxy
- [ ] `@default` filling works through the parse pipeline; `Resources.transaction()` uses `data` from the parse result
- [ ] All `ontology.validate()` call sites in `apps/nebula/src/` migrated to `facet.parse()` / equivalent
- [ ] `Ontology` class deleted; `Ontology` export removed from `apps/nebula/src/index.ts`; `OntologyVersionConfig` moved to `galaxy.ts`; `defaults` and `migrate` fields removed; manual defaults-spread removed; tests migrated to `@default` JSDoc
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
- Test that an in-flight `Resources.transaction` started before a version switch completes correctly against the captured facet (targeted race test)
- Soak test: append N versions in a row through Star; after each, verify only one `ontology:<v>` row plus the index exists in Star's KV

### Success Criteria

- [ ] Star's KV holds exactly one `ontology:<version>` row at all times
- [ ] In-flight transactions across a version switch complete correctly against the captured facet
- [ ] Stale-tagged transactions after a switch are rejected with a clear error
- [ ] Soak test: after N version switches, no stale rows accumulate in Star's KV

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

## Phase 6: Blog posts — release announcement + facet-performance deep-dive

**Goal**: Two paired posts covering the parse-validate pipeline end-to-end. One is the user-facing release announcement; the other is the technical performance deep-dive that Cloudflare-community readers will want as a companion. Ship them together so they cross-link cleanly.

Moved here from 5.2.4.1 Phase 7 (release post) and 5.2.4.1 Phase 8 (facet-performance deep-dive, archived with that task). Rationale for the pairing: the release post is "here's the thing, use it"; the performance post is "here are the numbers, decide if it's right for you." Both benefit from existing alongside the deployed Galaxy + Star + facets stack rather than just the validator slice.

### 6a: Release announcement

The conceptual frame is already in place via two existing posts that launched `@lumenize/ts-runtime-validator`:
- [index.md](./../website/blog/2026-03-24-typescript-is-the-schema/index.md) — why TS interfaces beat parallel Zod / JSON Schema definitions
- [index.md](./../website/blog/2026-03-25-write-your-types-once/index.md) — the "you write types four times" pain pitch

The new announcement is a shorter follow-up that inherits the frame and announces what's new, not a fresh ground-up essay.

**Content** (target: ~half the scope of the conceptual posts above):
- What changed under the hood: typia engine replaces tsc, parse-not-just-validate semantics, `@default` filling, DO facet hosting
- One paragraph on the facets-vs-plain-DW rationale: facets share the parent DO's isolate → same-isolate RPC, no network hop. (The package's `index.md` links to Cloudflare's facets announcement for "what are facets"; the release blog is the place for "why *we* picked them for this.")
- Deprecation of `@lumenize/ts-runtime-validator` with pointer to the new package
- Cross-post per the content-distribution memory (Lumenize site + Substack + Medium)

**Rationale for the timing**: writing the announcement after Nebula integration lets us describe the full working system (parse-validate + Galaxy/Star wiring + `@default` lifted into JSDoc + DO facet hosting) in one post, and avoids announcing something that might still hit integration snags. If 5.2.4.1 ships and 5.2.4.2 stalls, we hold the post until 5.2.4.2 lands.

### 6b: Facet performance in practice (technical deep-dive)

**Why it's worth writing**: facets are new (announced 2026-04-13) and community guidance is thin. Our 5.2.4.1 Phase 6 benchmarks produced facet-specific numbers that answer questions other developers will have. Distinguishes Lumenize as having done the homework; pairs naturally with the release announcement.

**Headline framing**: real numbers distinguishing "DO facets are essentially free" (true for infrastructure/billing, Cloudflare's framing) from the per-call latency reality: **DO facets add \~262 ms cold-spawn and \~1 ms per-call RPC overhead** on top of whatever your DO setup already costs. (The post deliberately stays out of the DO cold-wake baseline — that's a separate cost everyone in DOs pays regardless, not something facets add.)

**Numbers to include** (from 5.2.4.1 Phase 6):

| Metric | Number |
| --- | --- |
| Facet cold-spawn (added on top of DO wake) | ~262 ms |
| Warm parse iteration | ~1.4 ms |
| Per-call RPC overhead (structured-clone + scheduler hop) | ~1 ms |
| Bundle size, 30-type ontology | 119 KB |

The "added on top of DO wake" framing keeps the focus on facet-specific cost without dragging readers through the DO infrastructure baseline.

**Content checklist**:
- Lead with the facet-specific number (262 ms cold-spawn) and the warm number (1.4 ms parse). Make those the headline.
- Include the 30-type benchmark fixture (`packages/ts-runtime-parser-validator/test/fixtures/benchmark-ontology-30.ts`) so readers can reproduce.
- Specific guidance on when facets are right (dynamic code hot-swap, per-tenant sandboxed code, ontology-driven schemas) vs wrong (sub-ms per-call latency requirements with no hot-swap need).
- Apply the framing rules from `feedback_cf_community_framing.md` — Cloudflare's "essentially free" is true at the layer they meant (billing/infra); we're adding the per-call latency view, not contradicting.
- Run the open 5.2.4.1 Phase 6 follow-up first: tsc baseline comparison via a parallel spike Worker wrapping the old `@lumenize/ts-runtime-validator`, so the post can cite the new-vs-old numbers side by side.
- CTA links back to the release post and to the `@lumenize/ts-runtime-parser-validator` package docs.

### Success Criteria (combined)

- [ ] tsc-baseline comparison spike run; numbers added to `experiments/ts-runtime-parser-validator-spike/RESULTS.md` (or equivalent).
- [ ] Release-announcement post drafted at `website/blog/YYYY-MM-DD-parse-validate.md`; references the two existing conceptual posts rather than re-deriving the frame.
- [ ] Facet-performance post drafted at `website/blog/YYYY-MM-DD-facet-performance-in-practice.md`; leads with facet-specific cost (cold-spawn + warm parse), avoids the DO cold-wake baseline framing.
- [ ] Reproducer link points at the committed benchmark fixture and the bench script in `experiments/ts-runtime-parser-validator-spike/`.
- [ ] Both posts cross-link.
- [ ] Cross-post per `reference_content_distribution.md` (Lumenize site + Substack + Medium).

## Open Questions

- Integration overhead of mesh routing on top of the facet path (Phase 1 answers this — bare facet numbers already known from 5.2.4.1 Phase 6)
- DO facets are beta — any API stability or GA timing signals from Cloudflare that affect the rollout schedule?
- How does 5.2.6 (validation in plain Worker) relate? It was designed for the tsc engine. With this work, the facet IS the validator — 5.2.6 may be superseded or simplified.
- Plain-DW deployment without a facet parent is a future enhancement — revisit if we need cross-Star bundle sharing
- Dev mode deferred to `tasks/dev-mode-branching.md` — no facet provisioning in dev

## Notes

- **Dev-mode concerns** deferred to `tasks/dev-mode-branching.md`.
