# Phase 5.2.4.2: Galaxy Validator Integration

**Status**: Not started
**Depends on**: 5.2.4.1 (parse-validate package)
**Package**: `apps/nebula/` (Galaxy + Star) consuming `@lumenize/ts-runtime-parser-validator`

## Objective

Wire `@lumenize/ts-runtime-parser-validator`'s `compileTypesToParseModule()` and the generated module's `parse()` into Nebula's Galaxy/Star architecture. Galaxy compiles validators at ontology registration time. Stars run the pre-compiled validator as a **DO facet** loaded into the Star DO — no network hop on the hot path. `parse()` fills `@default` values and validates in one call on the transaction hot path.

This phase also updates `Resources.transaction()` to use `parse()` instead of the old `validate()` from `@lumenize/ts-runtime-validator`, completing the migration from tsc-based validation to the new parse-validate pipeline.

## Architecture: DO Facet on Star (decided)

The pre-compiled validator lives as a **DO facet** ([announced 2026-04-13](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/)) inside each Star DO. Facets are Dynamic Workers that share their parent DO's isolate and thread, so the Star → validator call is a same-isolate RPC — near-zero latency, no network hop. This is the decided hosting model for this task; the alternative plain-DW approach (one shared DW per ontology version accessed via Service Binding) is a possible future enhancement if we eventually need cross-Star bundle sharing, but is out of scope here.

**Characteristics**:
- Each Star hosts its own facet, loaded lazily from Galaxy on first use of a version
- Galaxy is a metadata registry (stores `validatorBundle` strings); no DW provisioning at promotion time
- Per-Star cache (~5-50KB per ontology version) — one `validatorBundle` row in Star SQLite at a time
- Sandboxing is preserved (facets = DW-based, same isolation guarantees)
- Facets are currently Beta (April 2026); track GA timing

No `parse()`-hosting spike is needed in this task — `compileTypesToParseModule()`'s output shape and facet-loading mechanics are resolved in 5.2.4.1 Phase 1. Phase 1 below focuses on measuring warm/cold latency and integration complexity for this specific wiring.

## Design Decisions

1. **Galaxy owns the registry.** On ontology update, Galaxy calls `compileTypesToParseModule()` once — compilation failure rejects the update at submit time, not at first request. Galaxy stores the resulting `validatorBundle` string (one bundle per ontology version, containing all resource-type validators in one JS module) alongside the ontology version metadata.

2. **One JS module per ontology version.** `compileTypesToParseModule()` emits a single JS module containing assert/parse functions for all resource types in the ontology plus an exported `parse(value, typeName): { valid: true, data } | { valid: false, errors }` that dispatches by name. Stars fetch this one string, not N strings per type. Shared runtime helpers and `typeMetadata` are baked into the bundle. Call site after loading into the facet: `facet.parse(value, typeName)`. The exact module shape (exported functions vs class methods) is pinned by 5.2.4.1 Phase 1.

3. **Push-based propagation, lazy bundle fetch.** Galaxy pushes "new version N is live" to connected Stars via `@mesh` — the notification payload is just `{ version, metadata }`, NOT the validator bundle. Star bookkeeps "current version is N" but does not fetch the bundle yet. On the first transaction for version N, Star fetches the `validatorBundle` from Galaxy (one RPC), loads the facet, and validates. This lazy-on-first-use pattern also covers hibernation/rehydration cleanly — a waking Star just discovers it needs the bundle and fetches.

4. **UI-driven recovery (belt-and-suspenders).** Push notifications are best-effort; the robust fallback is the UI. When a user logs in or refreshes the page, the browser fetches the latest UI bundle from Galaxy (which has the current ontology version embedded). The UI tags every resource request with that version. If Star sees a transaction tagged for a newer version than it knows about, it queries Galaxy for the bundle and updates. This means missed push notifications are self-healing on any user-initiated refresh — no polling needed.

5. **Eager version switch, JS references + eTag double-check handle concurrency.** When Star receives a version notification, it eagerly replaces the SQLite cache row with the new version's bundle. In-flight transactions that already grabbed the old bundle into a local variable continue to use it (JS closure semantics keep the reference alive across awaits); when they return, the local reference drops and the old bundle is GC'd. **Concurrency safety** comes from the existing double-eTag-check protocol in `Resources.transaction()` (optimistic pre-check → parse/guards → pessimistic recheck → `transactionSync` write). Writing data that was validated under version N is safe even if the current version becomes N+1 mid-transaction — Phase 5.5's lazy migration handles version skew at read time. No refcount bookkeeping, no TTL. Star's SQLite cache holds exactly one bundle at all times.

   *Note for Phase 5.5*: Migrations running in facets may want an additional version check at write time (not just data eTag) to avoid writing migrated data against a stale target schema. Design this when Phase 5.5 picks up.

6. **Stale-tagged transactions are rejected.** If a transaction arrives tagged for a version older than current (e.g., client UI hasn't refreshed after a switch), Star rejects it with a clear "stale version, refresh" error. The UI-driven recovery path then handles it: browser fetches current UI from Galaxy, retries. This is simpler than lazy-fetching old bundles on demand, and the window where stale-tagged requests can occur is tiny (between version switch and UI refresh).

7. **`parse()` replaces `validate()` in the transaction pipeline.** `Resources.transaction()` calls `parse()` (fill defaults + validate) instead of the old tsc-based `validate()`. `@default` filling happens automatically without additional pipeline code. Callers discriminate on `result.valid` to narrow to `data` (success) or `errors` (failure).

8. **Security framing.** DO facet sandboxing (DW-based) is the security boundary; compiling at schema-registration time (not per-request) is a bonus, not the primary defense.

## Phase 1: Facet Integration Validation

**Goal**: Validate the facet-hosted validator end-to-end and measure the numbers we'll commit to in later phases. Hosting approach (facet) and bundle shape (module vs class) are already decided in 5.2.4.1 Phase 1 — this phase integrates and measures.

**Work**:
- Build a minimal test app where a parent DO (stand-in for Star) loads a real `compileTypesToParseModule()` output as a facet and calls `parse()` via same-isolate RPC
- Measure: cold start (first call after DO wake), warm call latency (mean, p50, p99), memory footprint
- Measure: lines of setup/orchestration code required
- Verify: does the facet approach actually achieve "near-zero" same-isolate latency in practice?
- Check facet beta status: any production blockers? API stability signals from Cloudflare?

**Decision gate**: None — hosting is decided. If facets prove to have production blockers (API instability, correctness issues, severe perf regressions), pause and reopen the plain-DW path as a fallback before continuing.

**Success Criteria**:
- [ ] Facet loads a real `compileTypesToParseModule()` output and `parse()` returns correct results end-to-end
- [ ] Latency numbers (cold / warm p50 / warm p99) recorded in this file
- [ ] Memory footprint per cached bundle measured
- [ ] Facet beta-status risks documented

## Phase 2: Galaxy-as-Registry

**Goal**: Wire validator compilation into Galaxy's existing ontology-version promotion.

**Work**:
- Galaxy accepts new ontology version → call `compileTypesToParseModule()` → store the `validatorBundle` string in Galaxy's ontology-version metadata → promote version atomically
- Submit-time rejection on compilation failure (surface typia's error to the caller)
- Galaxy stores the `validatorBundle` string and version number in SQLite; no DW provisioning at promotion time. Stars fetch the bundle lazily on first use (see Phase 3)
- Push notification to connected Stars via `@mesh` on promotion — payload is `{ version, metadata }` only, NOT the bundle itself
- Galaxy exposes an RPC endpoint for Stars to fetch `validatorBundle` for a given version

**Success Criteria**:
- [ ] Galaxy rejects bad ontology definitions at submit time with clear error
- [ ] `validatorBundle` stored in ontology-version metadata
- [ ] Stars can fetch `validatorBundle` from Galaxy via RPC
- [ ] Connected Stars receive push notification of new version
- [ ] Push notification payload does not include the bundle (keep notifications small)

## Phase 3: Star Parse Pipeline

**Goal**: Stars use `parse()` via the chosen mechanism instead of in-process tsc validation.

**Work** (lazy-on-first-use via facet):
1. Star receives version notification → bookkeeps "current version is N" — no fetch yet
2. First transaction tagged for version N arrives
3. Star checks its cache: bundle for N? If not, RPC to Galaxy → fetch `validatorBundle` → cache it (in DO storage, not just memory, to survive hibernation)
4. Star loads the facet with the bundle → calls `parse()` via same-isolate RPC
- **Recovery via UI-driven version bumps**: If Star missed the push notification, the next user-initiated refresh delivers the current version. Browser fetches UI from Galaxy → UI embeds version → first resource request tags it → Star sees unknown version → fetches bundle from Galaxy → catches up. No polling, no TTL — user refresh is the self-healing mechanism.
- `parse()` fills `@default` values and validates in one call — no separate fill step needed in `Resources.transaction()`
- Update `Resources.transaction()` to use `parse()` from the new package instead of `validate()` from the old package. Convert the current `ValidationResult` discriminant (`valid: true | { valid: false, errors }`) consumers to the new `{ valid: true, data } | { valid: false, errors }` shape — note `data` replaces the caller's original value because defaults are now filled
- In-flight policy: current transaction completes on old version, next call uses new version
- Version bookkeeping: Star reports current version to Galaxy

**Nebula `Ontology` / `Resources` API changes** (consequence of defaults moving from config to `@default` JSDoc per 5.2.4.1):
- Remove `defaults?` field from `OntologyVersionConfig` in `apps/nebula/src/ontology.ts` — defaults now come from `@default` tags in `OntologyVersionConfig.types`
- Remove `Ontology.getDefaults(typeName)` method — no callers after the `Resources.transaction()` change below
- Remove `#latestDefaults` instance field and its constructor initialization
- Replace `Ontology.validate(value, typeName): ValidationResult` with `Ontology.parse(value, typeName): { valid: true, data } | { valid: false, errors }`. Internally delegates to the facet's `parse()`. Callers in `apps/nebula/src/resources.ts` switch from `ontology.validate()` to `ontology.parse()`
- In `Resources.transaction()` Step 5, remove the manual defaults-spread in `apps/nebula/src/resources.ts` — locate via search for `ontology.getDefaults(typeName)`; the block is `const defaults = ontology.getDefaults(typeName); if (defaults) op.value = { ...defaults, ...op.value };`. Filling is now inside `parse()`; after a successful `parse()` result, write `result.data` back onto `op.value` so downstream steps see the filled object
- Update existing tests that set `defaults` in `OntologyVersionConfig` (e.g., `apps/nebula/test/test-apps/baseline/star-ontology.test.ts`) to use `@default` JSDoc tags in the `types` string instead
- Update `ValidationError` import in `apps/nebula/src/resources.ts` (currently from `@lumenize/ts-runtime-validator`) to the new package

**Success Criteria**:
- [ ] Star parses+validates via the facet, not in-process tsc
- [ ] Bundle fetch is lazy on first use, not eager on push notification
- [ ] Bundle cached in DO storage — survives hibernation without re-fetching
- [ ] `@default` filling works through the parse pipeline; `Resources.transaction()` uses `data` from the parse result
- [ ] `Resources.transaction()` uses new package; all old `ontology.validate()` call sites migrated
- [ ] `OntologyVersionConfig.defaults` removed; `Ontology.getDefaults()` removed; manual defaults-spread in `Resources.transaction()` Step 5 removed; tests migrated to use `@default` JSDoc tags
- [ ] Two Stars on different versions can run concurrently during a migration window
- [ ] Disconnected Star recovers on first resource request tagged with a newer version (UI-driven recovery path)
- [ ] Version switch latency measured end-to-end (promotion → Star observes new version)

## Phase 4: Lifecycle and Eviction

**Goal**: Decide and implement what happens to old validator instances and cached bundles over time.

**Work** (keep-only-current, JS-references-as-refcount):
- Star's SQLite holds exactly one `validatorBundle` row — the current version. On version notification, this row is replaced eagerly.
- In-flight transactions that already loaded the old bundle into a local variable continue against it via normal JS closure semantics. When those transactions return, their local references drop and the old bundle is GC'd from memory. No explicit refcount, no drain bookkeeping.
- Stale-tagged transactions (older than current) are rejected with a "stale version" error. Clients handle this via UI refresh (see design decision #6).
- **Facet instance retention vs hibernation**: Don't manually manage facet warm/cold — let DO hibernation handle it. When Star hibernates, the facet goes with it. When Star wakes, the facet is reconstructed from the cached bundle string. No explicit warm-keeping logic.
- **No TTL anywhere.** The old TTL-polling model (pre-mesh-push era) is obsolete. Push notifications + UI-driven recovery + eager cache replacement + JS closures for in-flight safety replace it fully.

**Success Criteria**:
- [ ] Star's SQLite holds exactly one `validatorBundle` row at all times
- [ ] In-flight transactions mid-switch complete correctly against their locally-referenced bundle (tested via a targeted race test)
- [ ] Stale-tagged transactions after a switch are rejected with a clear error
- [ ] Long-lived Stars through many version transitions don't leak memory or accumulate cached bundles

## Phase 5: Old Package Removal and Deprecation

**Goal**: Remove `@lumenize/ts-runtime-validator` dependency from Nebula and deprecate the package on npm.

**Work**:
- Verify all call sites in `apps/nebula/` use new package
- Remove old package from `apps/nebula/package.json`
- Update any remaining imports
- `npm deprecate @lumenize/ts-runtime-validator "Use @lumenize/ts-runtime-parser-validator instead — see migration guide at https://lumenize.com/docs/ts-runtime-parser-validator/migrating-from-ts-runtime-validator"` (moved here from 5.2.4.1 Phase 7 — pairing deprecation with Nebula's removal lets us postpone the deprecate if integration uncovers problems, without needing to un-deprecate)

**Success Criteria**:
- [ ] Zero imports of `@lumenize/ts-runtime-validator` in `apps/nebula/`
- [ ] All tests pass with new package only
- [ ] `@lumenize/ts-runtime-validator` deprecated on npm with pointer to new package and migration guide

## Phase 6: Announcement Blog Post

**Goal**: Announce the parse-validate pipeline with a single post that covers both the new package and Nebula's wiring end-to-end.

Moved here from 5.2.4.1 Phase 7. Rationale: writing the announcement after Nebula integration lets us describe the full working system (parse-validate + Galaxy/Star wiring + `@default` lifted into JSDoc + DO facet hosting) in one post, and avoids announcing something that might still hit integration snags. If 5.2.4.1 ships and 5.2.4.2 stalls, we hold the post until 5.2.4.2 lands.

**Work**:
- Draft post covering: why parse-over-validate, the typia + DO facet architecture, the `@default`-in-JSDoc migration, the before/after performance numbers (from 5.2.4.1 Phase 6 and 5.2.4.2 Phase 1), and the deprecation of `@lumenize/ts-runtime-validator`
- Cross-post per the content-distribution memory (Lumenize site + Substack + Medium)

**Success Criteria**:
- [ ] Blog post published on the Lumenize site
- [ ] Cross-posts scheduled/published per distribution channels

## Open Questions

- Cold-start and call-latency numbers for the facet path (Phase 1 answers this)
- Bundle size of generated validators — fits comfortably in a Worker isolate?
- DO facets are beta — any API stability or GA timing signals from Cloudflare that affect the rollout schedule?
- How does 5.2.6 (validation in plain Worker) relate? It was designed for the tsc engine. With this work, the facet IS the validator — 5.2.6 may be superseded or simplified.
- Plain-DW deployment without a facet parent is a future enhancement — revisit if we need cross-Star bundle sharing
- Dev mode deferred to `tasks/dev-mode-branching.md` — no facet provisioning in dev

## Notes

- **CLI naming**: `lmz` was rejected by npm. Using `lumenize`.
- **Dev-mode concerns** deferred to `tasks/dev-mode-branching.md`.
