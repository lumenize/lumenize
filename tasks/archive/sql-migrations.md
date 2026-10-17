# `@lumenize/sql-migrations` — a DO SQL schema-migration runner (MIT)

**Status**: **BUILT + VERIFIED + ARCHIVED 2026-06-29** (`/build-task`). Package live at `packages/sql-migrations/`; 10/10 tests green (9 unit + 1 for-docs), `tsc` clean, `check-examples` green, both phases passed the verifier fan-out; doc `@skip-check-approved` annotations added by Larry. First consumer = the consent flag ([`nebula-consent-flag.md`](../nebula-consent-flag.md)); second = `apps/nebula` index-column migrations. *(Prior: 2-stage `/review-task` complete 2026-06-29 — public API pinned + narrowed, `params` added; `runAll` name kept as a faithful sync port of durable-utils.)* **Frozen on archive — do not edit.**
**Lineage**: **NOT a Nebula pre-alpha child** — a standalone **MIT substrate package** (`UNLICENSED` does not apply). First consumers: **`nebula-auth`** (the consent-flag migration — [`nebula-consent-flag.md`](nebula-consent-flag.md)) **and `apps/nebula`** (imminent user-added index-column migrations). Build this **first**; the consent flag depends on it.

## Objective

- **What:** stand up `@lumenize/sql-migrations`, a **minimal id-gated DO SQL schema-migration runner**, **vendored + modified** from durable-utils' `SQLSchemaMigrations` (MIT) to use Lumenize's **synchronous** storage API.
- **Why:** prod went live 2026-06-26 — the first time any DO can need schema evolution — and the need now recurs every schema change (the registry's consent column now; `apps/nebula` index columns next). DOs have no built-in SQL-schema migration; ORMs are messy on DOs; durable-utils is the usual community pointer but uses the **forbidden legacy async storage API**. A small, sync-API, MIT runner is on-mission ("MIT-licensed packages… particular focus on Durable Objects") and fills a real gap.
- **Shape:** an **append-only, monotonic-id** migration list; a stored **last-applied marker**; each step runs **exactly once**, the batch atomic. Nothing more.

**Out of scope (explicit):**
- **A migration *framework* with bells** — auto-diff, down-migrations, ORM-style schema modeling. Add capability only when a real consumer needs it.
- **Any registry-specific / consent-specific migration** — `REGISTRY_MIGRATIONS`, the `improveProductConsent` column, the `Instances` backfill, and the prod-path test that exercises them all live in the **consumer** ([`nebula-consent-flag.md`](nebula-consent-flag.md)). This package's own tests use **synthetic** migrations only (a library's tests stay consumer-agnostic).

## Background — why vendor, and the marker mechanism (research, 2026-06-29)

**Prior art:** durable-utils `SQLSchemaMigrations` ([src/sql-migrations.ts](https://github.com/lambrospetrou/durable-utils/blob/main/src/sql-migrations.ts)); `@cloudflare/actors` `packages/storage/src/sql-schema-migrations.ts` is a **near-verbatim fork** of it (same interface/class/logic + the same `// TODO`) — so there's one pattern, now adopted by Cloudflare, not two to weigh. Both are **MIT** (verified).

**The pattern (what we keep):** append-only `migrations[]` each with a monotonic `idMonotonicInc`, sorted + duplicate-checked at construction, **immutable once applied** (never edit a shipped migration — append a new one); track the **last-applied id**; skip everything `<= lastId`; run the remainder in **one transaction**, persisting the new lastId *inside* it. **Run-once = id-gating, not SQL introspection** — which is exactly what makes a bare `ALTER TABLE ADD COLUMN` (no `IF NOT EXISTS` in SQLite) safe to ship: it can only ever run once.

**Why we can't just depend on it:** both libs track the marker with the **legacy async storage API** (`doStorage.get`/`put`/`transaction`), which `critical.md` forbids ("Synchronous storage only … Never the legacy async API"). So we **vendor-and-modify**: copy the class, swap the storage calls for the sync API.

**The marker — sync `ctx.storage.kv`, NOT `PRAGMA user_version`:** `user_version` is **rejected by workerd outright** (verified against the `ALLOWED_PRAGMAS` allowlist in `workerd/src/workerd/util/sqlite.c++` — read-only no-arg pragmas + a few BOOLEAN toggles; **no settable integer pragma**; `data_version` is read-only/useless). A `_migrations` audit table is heavier than this warrants. So the marker is durable-utils' KV approach, on our **sync `ctx.storage.kv.get/put`**.

## Decisions (pinned)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Vendor vs depend vs copy | **Vendor-and-modify with attribution.** Copy `SQLSchemaMigrations` into this package; modify it to the sync storage API; **keep the class name + core design**, with a **deliberately narrowed public surface + a `params` addition** (see **Public API**). Retain durable-utils' **MIT copyright header** **and** add an `ATTRIBUTIONS.md` row. **No npm dependency** on either lib. | Both libs use the forbidden legacy async API, so neither is usable as-is; the *design* is sound and small (~150 SLOC, under the `workflow.md` copy-paste-with-attribution threshold). MIT→MIT is clean. |
| D2 | Last-applied marker | **Sync `ctx.storage.kv` key.** **NOT** `PRAGMA user_version` (workerd rejects it), **not** a `_migrations` table. | See Background. Keeps durable-utils' mechanism on our allowed accessor. |
| D3 | Atomicity | Wrap the pending-migrations batch **+ the marker write** in **`ctx.storage.transactionSync(() => …)`**. | Atomic rollback on a partial failure (the output gate gives durability-on-return, not cross-statement rollback). `transactionSync` lacks the options param of async `transaction(closure, options?)`, but **neither durable-utils nor actors passes options** (verified — both call `transaction(closure)` bare), so the gap is irrelevant. |
| D4 | Home / name / license | **New MIT package `@lumenize/sql-migrations`** (name confirmed; `sql-` prefix disambiguates from the wrangler DO-class `migrations` registry that `durable-objects.md` flags as already-overloaded). | The only packages both early consumers share (`auth`/`debug`/`routing`) are no semantic fit; the API is durable-utils' stable legacy (won't churn post-publish — Larry has shipped it in prod before, Lambros is a reachable friend); on-mission MIT DO utility filling a real community gap. |
| D5 | Construction-agnostic | The package does **not** decide *where/when* migrations run. `runAll()` is an explicit call the **caller** makes — constructor body (sync), `blockConcurrencyWhile` (if a step must `await`), or lazily — its choice. | One consumer (`nebula-auth`) runs it from a sync constructor body; another may differ. Keeps the package free of host-lifecycle assumptions. |

## Public API (pinned — single source of truth; the consumer cites this, never redefines it)

A port of durable-utils' `SQLSchemaMigrations` with a **deliberately narrowed surface** (D1). The changes from upstream: **(1)** async storage methods → sync; **(2)** **drop** three unused vendored members — `keyNameTrackingLastMigrationID` (the kv marker key name is hardcoded, à la the `@cloudflare/actors` fork), the `sqlGen` callback, and `hasMigrationsToRun()` (no consumer needs them); **(3)** **add** one field — per-migration bind `params`.

- **`class SQLSchemaMigrations`**, constructed with `{ doStorage, migrations }`:
  - `doStorage` — the DO's **`ctx.storage`** handle (a `DurableObjectStorage`). durable-utils' option name, kept. ⚠️ `doStorage` names the *handle*; the port changes the *methods* called on it — async `.get/.put/.transaction` → **sync `.kv.get/put` + `.transactionSync`**. Same handle; the forbidden thing was the async methods, never the handle.
  - `migrations: SQLSchemaMigration[]`, where **`SQLSchemaMigration = { idMonotonicInc: number; description: string; sql: string; params?: SqlStorageValue[] }`**. `sql` is **required** (the `sqlGen` callback was dropped — #2). `params` is the **one addition** (#3), threaded into `doSql.exec(sql, ...(params ?? []))`, so value-bearing migrations **bind `?`** instead of interpolating (`security.md`; the first consumer's backfill binds `PLATFORM_INSTANCE_NAME`).
- **`runAll(): { rowsRead: number; rowsWritten: number }` — synchronous** (no `sqlGen` param — dropped). durable-utils' is `async` only because of legacy async storage; the sync port has no `await`, so it returns synchronously — which is what lets a consumer call it in a sync constructor body (D5). **Counts are SQL-cursor rows aggregated across the batch** (the kv marker write is **not** counted). The per-migration `cursor.toArray()` drain upstream is **load-bearing** — it forces statement execution and populates the counts; **do not drop it** as dead code during the port (n1).

The consumer ([`nebula-consent-flag.md`](nebula-consent-flag.md)) constructs `new SQLSchemaMigrations({ doStorage: ctx.storage, migrations: REGISTRY_MIGRATIONS }).runAll()` against **this** pinned shape — it does not define the signature itself.

## Phases

### Phase 1 — Create the package
**Goal**: Stand up the MIT package with the vendored+modified `SQLSchemaMigrations` and a consumer-agnostic test suite.

**Success Criteria**:
- [ ] New `packages/sql-migrations` workspace entry (`package.json` **MIT**, `wrangler.jsonc`/`tsconfig`/`vitest.config` per `packaging.md`); installs from repo root (added to root `package.json` `workspaces`).
- [ ] `SQLSchemaMigrations` vendored, with durable-utils' **MIT copyright header** retained + an `ATTRIBUTIONS.md` row.
- [ ] Modified to our API per the **Public API (pinned)** section: marker via **sync `ctx.storage.kv.get/put`** (not legacy async `storage.get/put`); batch wrapped in **`ctx.storage.transactionSync`** (not async `transaction`); `runAll()` is **synchronous**. **No legacy-async storage *method* calls remain** (`.get`/`.put`/`.transaction`) — but the **`import type { DurableObjectStorage }`** stays (it's an API-agnostic *type*, not a legacy import; prefer the generated global type or `@cloudflare/workers-types`, consistent with how `structured-clone` does it) (m3). The `doStorage` option is the **`ctx.storage`** handle (never the generated `Env`).
- [ ] `runAll()` is caller-invoked and construction-agnostic (D5).
- [ ] Any test/example DO is registered with **`new_sqlite_classes`** (sync storage requires SQLite-backed — `durable-objects.md`; `new_classes` makes `ctx.storage.kv` throw).
- [ ] **Test suite on synthetic migrations** (ported/adapted from durable-utils' `test/sql-migrations.test.ts`); every assertion capable-of-failing (via return counts / a write probe, **not** "didn't throw"):
  - [ ] **happy path + return contract (M3):** applies in id order; an INSERT-bearing migration returns `rowsWritten > 0` (and `rowsRead` non-zero where it reads). This also reddens if the load-bearing per-migration `cursor.toArray()` drain is dropped during the port (n1).
  - [ ] **`params` binding (the #3 addition):** a migration `{ sql: 'INSERT … VALUES (?)', params: [v] }` lands `v` correctly, **and** a `v` containing SQL metacharacters is **bound, not interpreted** — proving `params` threads into `doSql.exec(sql, ...params)` and is never concatenated. Mutation-check: drop `...params` from the `exec` call → this test reddens.
  - [ ] **edge paths (m2):** (a) **empty** migrations list → `runAll()` returns `{0,0}`, no marker write; (b) **marker present-and-current** → no-op fast path, no transaction entered; (c) **partial-prefix** (marker=1, supply `[id1,id2]`) → only id2 runs — **the literal prod path the consumer depends on**, proven here in isolation.
  - [ ] **run-twice-is-noop:** a second `runAll()` enters no transaction and writes nothing — assert via `rowsWritten === 0` / marker-unchanged, **not** "storage untouched" (a cold construct still costs one kv marker READ — n2).
  - [ ] **construction validation — negative (M2/m5), independent assertions (`it.each`):** construction **throws on a negative id** and **throws on a duplicate id** — assert each separately. That is *all* the vendored constructor enforces — it **sorts** by id, so out-of-order does **not** throw; do **not** invent non-vendored validation.
  - [ ] **immutability of an applied migration:** an already-applied migration whose `sql` is later edited is **not** re-run — this is durable-utils' marker-gated behavior detected at `runAll` time, **not** a construction throw. Assert an edited id-1 does not re-execute when the marker is already ≥ 1.
  - [ ] **atomic rollback (proves D3) — pin the mechanism (m4):** id-1 = a valid write that **lands a row**; id-2 = a valid write **followed by an exec-time throw** (e.g. a constraint violation, or DDL referencing a missing column), all in one `transactionSync` batch. Assert (1) **id-1's row is absent** after the throw and (2) the marker still reads its **pre-batch** value (a re-run then re-applies cleanly). **Mutation-check:** replace the `transactionSync` wrapper with a plain loop → id-1's row persists after the throw → assertion (1) reddens. *(Moving only the marker write outside would NOT redden — the throw short-circuits it regardless; the rollback of id-1's actual write is what `transactionSync` uniquely provides, and assertion (1) is what proves it.)*

### Phase 2 — Docs
**Goal**: A small published doc page — it's a public `@lumenize/*` surface.

**Success Criteria**:
- [ ] **One short file** `website/docs/sql-migrations/index.md` (`.md`, not `.mdx` — `critical.md` default) — overview + the canonical usage example: define a migrations list, call `runAll()` from a DO **constructor body** (sync); a one-liner notes `blockConcurrencyWhile` is only needed if a migration step `await`s (D5).
- [ ] Every code block is **`@check-example`-validated** against real source (`documentation.md`) — prefer an exact complete match over a `// ...` wildcard ([[check-example-exact-over-wildcard]]). The example's code is **matched against the Phase-1 synthetic-migration test** (an already-executed real source file — no separate for-docs mini-app needed), so `npm run test:doc` validates against **live-runner** code, not a vacuous snippet (n3).
- [ ] Registered in `website/sidebars.ts` alongside the other package docs.

### Final Verification
- [ ] `npx vitest run` green in `packages/sql-migrations`; `npm run type-check` clean.
- [ ] `npm run test:doc` green for the new page.
- [ ] MIT header + `ATTRIBUTIONS.md` row present.
- [ ] On completion: archive this file; leave a one-line pointer in the consumer ([`nebula-consent-flag.md`](nebula-consent-flag.md)) and note the package exists for the `apps/nebula` index-column consumer. (Not a `nebula-pre-alpha.md` child — no nugget extraction there beyond a "the migration runner is `@lumenize/sql-migrations`" pointer if useful.)

## Notes / risks
- **Consumer-agnostic by construction.** This package never imports `nebula-auth` / `apps/nebula` types and never references the generated `Env`. The registry's `REGISTRY_MIGRATIONS` and its prod-path (seed-old-schema) test live in the consumer, exercising *this* runner against real migrations — that's where the end-to-end migration proof lives, by design.
- **API stability.** A port of durable-utils' proven design with a **deliberately narrowed** public surface (drop `keyNameTrackingLastMigrationID` / `sqlGen` / `hasMigrationsToRun`) plus one consumer-driven addition (`params` bind) — every change recorded in the Public API section, not speculative API design. If a consumer surfaces a further genuine gap, widen then.
