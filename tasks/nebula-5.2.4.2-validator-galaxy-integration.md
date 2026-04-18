# Phase 5.2.4.2: Galaxy Validator Integration

**Status**: Not started
**Depends on**: 5.2.4.1 (parse-validate package)
**Package**: `apps/nebula/` (Galaxy + Star) consuming `@lumenize/ts-runtime-parser-validator`

## Objective

Wire `@lumenize/ts-runtime-parser-validator`'s `createValidator()` and `parse()` into Nebula's Galaxy/Star architecture. Galaxy compiles validators at ontology registration time. Stars run the pre-compiled validator via a Dynamic Worker mechanism (plain DW vs DO facet — see Architecture Decision below). `parse()` fills `@default` values and validates in one call on the transaction hot path.

This phase also updates `Resources.transaction()` to use `parse()` instead of the old `validate()` from `@lumenize/ts-runtime-validator`, completing the migration from tsc-based validation to the new parse-validate pipeline.

## Architecture Decision: Plain DW vs DO Facet on Star

Two viable approaches for hosting the pre-compiled validator:

| | Plain Dynamic Worker | DO Facet on Star |
| --- | --- | --- |
| Ownership | Galaxy provisions one DW per ontology version; Stars share it | Each Star hosts its own facet, loaded lazily from Galaxy on first use of a version |
| Routing | Star → Service Binding → DW | Star → same-isolate RPC → facet |
| Call latency | Service Binding hop (may cross network) | Near-zero (same thread, same isolate per Cloudflare docs) |
| Cold start | Per-DW (one cold start shared across many Stars) | Per-facet per Star (but Star already pays its own cold start) |
| Caching | DW caches validator across all Stars on that version | Each Star holds its own copy of the validator bundle for its current version |
| Version switch | Stars re-route to new DW | Star fetches new bundle from Galaxy, rebuilds facet |
| Galaxy's role | Compute provisioner (manages DWs) | Metadata registry (stores `validatorBundle` strings) |
| Duplication | None — shared DW | Each Star caches the bundle string (~5-50KB per ontology version) |
| Sandboxing | Yes (DW isolation) | Yes (DW-based, same constraints) |
| Maturity | GA | Beta (April 2026) |

**DO facets** ([announced 2026-04-13](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/)) are Dynamic Workers that live as children of a parent DO, sharing the DO's isolate and thread. For our workload — each Star has one active ontology at a time, and the validator is hot only for that Star's transactions — the facet model is semantically cleaner and likely faster on the hot path.

**Decision gate**: Early in Phase 1 below, spike both approaches in a minimal test app. Measure cold start, warm latency, and code complexity. Pick one. This decision shapes the rest of this task file.

**Default bias**: Toward DO facets. The same-isolate latency win is compelling, the per-Star duplication cost is negligible (~5-50KB per ontology version; one string in SQLite per active Star), and the model semantically matches Star's lifecycle. Galaxy becomes a pure metadata registry rather than a compute provisioner. Plain DW is the fallback if facets have production blockers.

## Design Decisions

1. **Galaxy owns the registry.** On ontology update, Galaxy calls `createValidator()` once — compilation failure rejects the update at submit time, not at first request. Galaxy stores the resulting `validatorBundle` string (one bundle per ontology version, containing all resource-type validators in one JS module) alongside the ontology version metadata.

2. **One JS module per ontology version.** `createValidator()` emits a single JS module containing assert/parse functions for all resource types in the ontology plus an exported `parse(value, typeName): { data, errors }` that dispatches by name. Stars fetch this one string, not N strings per type. Shared runtime helpers and `typeMetadata` are baked into the bundle. Call site after loading: `module.parse(value, typeName)`. (Open question in Phase 1 spike: does the DO facet loading mechanism accept a module that exports multiple functions, or does it require a single class? This constrains the bundle shape — if it requires a class, `parse` becomes a method instead of an exported function.)

3. **Version-string naming (plain DW path).** If we go with plain DW, workers are named by `universe.galaxy.${ontologyVersion}` (period separator, matching existing `universe.galaxy.star` convention).

4. **Push-based propagation, lazy bundle fetch (facet path).** Galaxy pushes "new version N is live" to connected Stars via `@mesh` — the notification payload is just `{ version, metadata }`, NOT the validator bundle. Star bookkeeps "current version is N" but does not fetch the bundle yet. On the first transaction for version N, Star fetches the `validatorBundle` from Galaxy (one RPC), loads the facet, and validates. This lazy-on-first-use pattern also covers hibernation/rehydration cleanly — a waking Star just discovers it needs the bundle and fetches.

5. **UI-driven recovery (belt-and-suspenders).** Push notifications are best-effort; the robust fallback is the UI. When a user logs in or refreshes the page, the browser fetches the latest UI bundle from Galaxy (which has the current ontology version embedded). The UI tags every resource request with that version. If Star sees a transaction tagged for a newer version than it knows about, it queries Galaxy for the bundle and updates. This means missed push notifications are self-healing on any user-initiated refresh — no polling needed.

6. **Eager version switch, JS references + eTag double-check handle concurrency.** When Star receives a version notification, it eagerly replaces the SQLite cache row with the new version's bundle. In-flight transactions that already grabbed the old bundle into a local variable continue to use it (JS closure semantics keep the reference alive across awaits); when they return, the local reference drops and the old bundle is GC'd. **Concurrency safety** comes from the existing double-eTag-check protocol in `Resources.transaction()` (optimistic pre-check → parse/guards → pessimistic recheck → `transactionSync` write). Writing data that was validated under version N is safe even if the current version becomes N+1 mid-transaction — Phase 5.5's lazy migration handles version skew at read time. No refcount bookkeeping, no TTL. Star's SQLite cache holds exactly one bundle at all times.

   *Note for Phase 5.5*: Migrations running in facets may want an additional version check at write time (not just data eTag) to avoid writing migrated data against a stale target schema. Design this when Phase 5.5 picks up.

7. **Stale-tagged transactions are rejected.** If a transaction arrives tagged for a version older than current (e.g., client UI hasn't refreshed after a switch), Star rejects it with a clear "stale version, refresh" error. The UI-driven recovery path then handles it: browser fetches current UI from Galaxy, retries. This is simpler than lazy-fetching old bundles on demand, and the window where stale-tagged requests can occur is tiny (between version switch and UI refresh).

8. **`parse()` replaces `validate()` in the transaction pipeline.** `Resources.transaction()` calls `parse()` (fill defaults + validate) instead of the old tsc-based `validate()`. `@default` filling happens automatically without additional pipeline code.

9. **Security framing.** Dynamic Worker sandboxing is the security boundary; compiling at schema-registration time (not per-request) is a bonus, not the primary defense. Both plain-DW and facet paths preserve this boundary.

## Phase 1: Spike — Plain DW vs DO Facet

**Goal**: Pick the validator hosting approach before building out Galaxy/Star integration.

**Work**:
- Build a minimal test app that loads a pre-compiled validator bundle (one JS module containing multiple assert/parse functions) both ways:
  - Plain DW: provision a DW with the bundle, call via Service Binding
  - DO facet: parent DO (stand-in for Star) loads the bundle as a facet, calls via same-isolate RPC
- **Check facet API shape**: does the facet loading mechanism accept a module exporting multiple functions, or does it require a single class? If it requires a class, our `createValidator()` output needs to be a class with methods per resource type instead of a module with exports. Either is fine, but this affects 5.2.4.1's output format.
- Measure for both paths: cold start (first call), warm call latency (mean, p50, p99), memory footprint
- Measure code complexity: how many lines of setup/orchestration code does each approach need?
- Verify: does the facet approach actually achieve "near-zero" same-isolate latency in practice?
- Check facet beta status: any production blockers? API stability signals from Cloudflare?

**Decision gate**: Record spike results. Choose plain DW or facet for the rest of this task file. If facet wins, later phases assume Star-hosted facets; if plain DW wins, they assume shared DWs. If the facet API constrains bundle shape (class vs module), feed that constraint back into 5.2.4.1.

**Success Criteria**:
- [ ] Both approaches work end-to-end with a real `createValidator()` output
- [ ] Facet bundle shape (module vs class) documented
- [ ] Latency and complexity numbers recorded
- [ ] Decision recorded with rationale

## Phase 2: Galaxy-as-Registry

**Goal**: Wire validator compilation into Galaxy's existing ontology-version promotion.

**Work** (approach-dependent based on Phase 1 decision):
- **Always**: Galaxy accepts new ontology version → call `createValidator()` → store the `validatorBundle` string in Galaxy's ontology-version metadata → promote version atomically
- **Always**: Submit-time rejection on compilation failure (surface typia's error to the caller)
- **Plain DW path**: Galaxy also provisions a DW named `universe.galaxy.${ontologyVersion}` with the bundle. Stars share this DW.
- **Facet path**: Galaxy stores the `validatorBundle` string and version number in SQLite; no DW provisioning at promotion time. Stars fetch the bundle lazily on first use (see Phase 3).
- Push notification to connected Stars via `@mesh` on promotion — payload is `{ version, metadata }` only, NOT the bundle itself (both paths)
- Galaxy exposes an RPC endpoint for Stars to fetch `validatorBundle` for a given version

**Success Criteria**:
- [ ] Galaxy rejects bad ontology definitions at submit time with clear error
- [ ] `validatorBundle` stored in ontology-version metadata
- [ ] (Plain DW) DW provisioned and named correctly, or (Facet) Stars can fetch `validatorBundle` from Galaxy via RPC
- [ ] Connected Stars receive push notification of new version
- [ ] Push notification payload does not include the bundle (keep notifications small)

## Phase 3: Star Parse Pipeline

**Goal**: Stars use `parse()` via the chosen mechanism instead of in-process tsc validation.

**Work** (approach-dependent):
- **Plain DW path**: Star receives version notification → routes to the DW for that version → calls `parse()` via Service Binding on first transaction
- **Facet path** (lazy-on-first-use):
  1. Star receives version notification → bookkeeps "current version is N" — no fetch yet
  2. First transaction tagged for version N arrives
  3. Star checks its cache: bundle for N? If not, RPC to Galaxy → fetch `validatorBundle` → cache it (in DO storage, not just memory, to survive hibernation)
  4. Star loads the facet with the bundle → calls `parse()` via same-isolate RPC
- **Recovery via UI-driven version bumps**: If Star missed the push notification, the next user-initiated refresh delivers the current version. Browser fetches UI from Galaxy → UI embeds version → first resource request tags it → Star sees unknown version → fetches bundle from Galaxy → catches up. No polling, no TTL — user refresh is the self-healing mechanism.
- `parse()` fills `@default` values and validates in one call — no separate fill step needed in `Resources.transaction()`
- Update `Resources.transaction()` to use `parse()` from the new package instead of `validate()` from the old package
- In-flight policy: current transaction completes on old version, next call uses new version
- Version bookkeeping: Star reports current version to Galaxy

**Success Criteria**:
- [ ] Star parses+validates via the chosen mechanism, not in-process tsc
- [ ] (Facet) Bundle fetch is lazy on first use, not eager on push notification
- [ ] (Facet) Bundle cached in DO storage — survives hibernation without re-fetching
- [ ] `@default` filling works through the parse pipeline
- [ ] `Resources.transaction()` uses new package
- [ ] Two Stars on different versions can run concurrently during a migration window
- [ ] Disconnected Star recovers on first resource request tagged with a newer version (UI-driven recovery path)
- [ ] Version switch latency measured end-to-end (promotion → Star observes new version)

## Phase 4: Lifecycle and Eviction

**Goal**: Decide and implement what happens to old validator instances and cached bundles over time.

**Work** (approach-dependent):

**Plain DW path**:
- Refcount-based GC — Galaxy tracks which ontology versions are in use by Stars; when refcount for a non-live version hits zero, Galaxy drops the DW. Grace period before GC handles race conditions.

**Facet path** (keep-only-current, JS-references-as-refcount):
- Star's SQLite holds exactly one `validatorBundle` row — the current version. On version notification, this row is replaced eagerly.
- In-flight transactions that already loaded the old bundle into a local variable continue against it via normal JS closure semantics. When those transactions return, their local references drop and the old bundle is GC'd from memory. No explicit refcount, no drain bookkeeping.
- Stale-tagged transactions (older than current) are rejected with a "stale version" error. Clients handle this via UI refresh (see design decision #7).
- **Facet instance retention vs hibernation**: Don't manually manage facet warm/cold — let DO hibernation handle it. When Star hibernates, the facet goes with it. When Star wakes, the facet is reconstructed from the cached bundle string. No explicit warm-keeping logic.
- **No TTL anywhere.** The old TTL-polling model (pre-mesh-push era) is obsolete. Push notifications + UI-driven recovery + eager cache replacement + JS closures for in-flight safety replace it fully.

**Success Criteria**:
- [ ] (Plain DW) Old DWs GC'd once no Star references them, with grace period
- [ ] (Facet) Star's SQLite holds exactly one `validatorBundle` row at all times
- [ ] (Facet) In-flight transactions mid-switch complete correctly against their locally-referenced bundle (tested via a targeted race test)
- [ ] (Facet) Stale-tagged transactions after a switch are rejected with a clear error
- [ ] (Facet) Long-lived Stars through many version transitions don't leak memory or accumulate cached bundles

## Phase 5: Old Package Removal

**Goal**: Remove `@lumenize/ts-runtime-validator` dependency from Nebula.

**Work**:
- Verify all call sites in `apps/nebula/` use new package
- Remove old package from `apps/nebula/package.json`
- Update any remaining imports
- Coordinate with 5.2.4.1 Phase 7 (`npm deprecate` of old package)

**Success Criteria**:
- [ ] Zero imports of `@lumenize/ts-runtime-validator` in `apps/nebula/`
- [ ] All tests pass with new package only

## Open Questions

- Cold-start and call-latency numbers for both approaches (Phase 1 spike answers this)
- Bundle size of generated validators — fits comfortably in a Worker isolate?
- DO facets are beta — any API stability or GA timing signals from Cloudflare that affect our choice?
- How does 5.2.6 (validation in plain Worker) relate? It was designed for the tsc engine. With this work, the DW (or facet) IS the validator — 5.2.6 may be superseded or simplified.
- Dev mode deferred to `tasks/dev-mode-branching.md` — no DW/facet provisioning in dev

## Notes

- **CLI naming**: `lmz` was rejected by npm. Using `lumenize`.
- **Dev-mode concerns** deferred to `tasks/dev-mode-branching.md`.
