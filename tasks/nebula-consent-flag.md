# Nebula — Data-use consent flag (first prod DO schema migration)

**Status**: `/review-task` 2-stage panel complete 2026-06-29 (framing + conformance resolved). **Prereq `@lumenize/sql-migrations` is BUILT + archived** ([`archive/sql-migrations.md`](archive/sql-migrations.md)). **Ready for `/build-task`** (pending a fresh human read; trim this file's runner-mechanism prose to pointers during the build).
**Parent**: [`nebula-pre-alpha.md`](nebula-pre-alpha.md) § Wave 1 leftovers — "Data-use consent flag".
**Prerequisite**: **[`@lumenize/sql-migrations`](archive/sql-migrations.md)** — the id-gated DO SQL-migration runner this task uses. Build that **first**; its design + the runner-mechanism decisions (vendor-from-durable-utils, sync `ctx.storage.kv` marker, `transactionSync`) live there.
**Runs parallel to** the chat thread (Child 1 = [`nebula-devstudio-data-plane.md`](nebula-devstudio-data-plane.md)); **zero file overlap** — this task touches `packages/nebula-auth` (the registry) + a small `nebula-studio-ui` slug-pick notice (Phase 4, may trail); the chat-thread session lives in `apps/nebula` data-plane / `nebula-client.ts` / the `baseline/` harness.

## Objective

- **What:** add a **nullable** `improveProductConsent` column to the `NebulaAuthRegistry` `Instances` table, applied via the `@lumenize/sql-migrations` runner. **Consent is per-scope; Universe-level is the only level implemented now:** `claimUniverse` sets the Universe row to `1` (the slug-pick notice is the human decision point); sub-instance rows (galaxy/star) are left **`NULL` = "no level-specific decision yet → inherit from the nearest ancestor that has one"** (the Universe today). Corpus pool = `SELECT instanceName FROM Instances WHERE improveProductConsent = 1 AND instanceName != ?` (bind `PLATFORM_INSTANCE_NAME`; NULL sub-rows fall out naturally, the reserved `nebula-platform` row is excluded). **Assume `true` for now** (hard yes for F&F testers — no opt-out UI yet). The per-row column is already **per-level-ready**, so galaxy/star consent later is UI-only, never a schema change.
- **Why:** the **migration-critical** piece is locking the column shape in **before more instances claim** (one-way door — pre-alpha caveat) + writing consent at claim time. The corpus filter is built now too, but its consumers (turn-log inspection v0, daily digest v1) are **deferred** — so it ships as a cheap guard test, **not** because a live reader needs it yet.
- **The real reason it's a task file, not a quick edit:** this is **our first schema migration against a deployed prod DO** (`NebulaAuthRegistry` is live on `nebula.lumenize.com`). The `Instances` table already exists in prod, so editing the `CREATE TABLE` constant **silently no-ops** there (`IF NOT EXISTS` skips the existing table). The migration runner (the prereq package) is what makes the column add real, eager, and idempotent.

**Naming:** the column is **generically named** (`improveProductConsent` — consent to use your data to improve *the product*), never `nebula`/`studio`-specific, so `nebula-auth` stays product-agnostic. (Home rationale: self-signup is an auth feature; consent lives where the `claimUniverse` call happens — `packages/nebula-auth`.)

## Out of scope (explicit)

- **The migration runner itself** → [`sql-migrations.md`](archive/sql-migrations.md). This task only *uses* `@lumenize/sql-migrations`; its vendoring, sync-API port, generic test suite, and docs are that package's task.
- **Opt-out UI + per-scope (galaxy/star) consent** — pre-alpha assumes `true` and implements **Universe-level only**. The model is already per-level-ready (`Instances` carries the column per-row; `NULL` = inherit), so adding galaxy/star consent later is **UI + an effective-consent walk-up resolution, NOT a schema migration**; the opt-out toggle (set a row to `0`) is likewise later. **Don't build the walk-up resolution now** — no consumer until turn-log inspection ships (YAGNI).
- **The `synthetic:true` flag / other `Instances` columns** — separate, YAGNI-deferred (pre-alpha caveat).

## What exists today (grounding — verified 2026-06-29)

- `NebulaAuthRegistry extends DurableObject` — a **raw DO**, not `LumenizeDO` (`workers-projects.md`: nebula-auth is raw-DO infrastructure). **No `onStart` hook** — the eager-at-boot equivalent is **synchronous setup in the constructor body** (`durable-objects.md`).
- Schema setup is **lazy today**: `#ensureSchema()` ([nebula-auth-registry.ts:47](../packages/nebula-auth/src/nebula-auth-registry.ts)) runs `for (const schema of REGISTRY_SCHEMAS) sql.exec(schema)` guarded by a `#schemaInitialized` instance flag, called at the **top of every public method**. It only runs `CREATE TABLE/INDEX IF NOT EXISTS` — **no column-evolution / ALTER path.**
- `REGISTRY_SCHEMAS` = `[Instances, Emails, Emails-index]` ([schemas.ts:123](../packages/nebula-auth/src/schemas.ts)). `Instances` = `(instanceName TEXT PRIMARY KEY, createdAt INTEGER NOT NULL) WITHOUT ROWID` ([schemas.ts:101](../packages/nebula-auth/src/schemas.ts)).
- `Instances` is INSERTed at **five** sites: `registerEmail` `INSERT OR IGNORE` (~78), `claimUniverse` (~190), `claimStar` (~270), `createGalaxy` (~332), `createStar` (~377). Only `claimUniverse` is changed by this task; the rest stay `NULL` (inherit).
- The reserved platform pseudo-Universe `nebula-platform` (`PLATFORM_INSTANCE_NAME`, types.ts:139) is single-segment and `registerEmail`-creatable in prod — it must **not** be consented (excluded from backfill + corpus).
- The registry is **deployed** (`nebula.lumenize.com`); the migrations one-way door is open as of the 2026-06-26 first prod deploy.

## Decisions (pinned — consent/registry side; runner-mechanism decisions live in [`sql-migrations.md`](archive/sql-migrations.md))

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D2 | Where the migration runs | **Eager, in the registry's constructor body** (synchronous) — calls `@lumenize/sql-migrations` `runAll()`. **No `blockConcurrencyWhile`** (the migration has no `await`; `transactionSync` in the runner gives atomicity). **Replaces** the lazy per-method `#ensureSchema()` guard. | Registry is raw-DO (no `onStart`), so the constructor body is the home; wrapping fully-sync work in `blockConcurrencyWhile` is an unneeded rule-deviation. Add it only if a future migration step must `await`. |
| D4 | Baseline vs delta + column shape | **Model A — one mechanism.** The migration list is an **exported `REGISTRY_MIGRATIONS` constant** (not buried in the constructor, so it's independently testable — B1): **id 1 = the current baseline** (existing `CREATE TABLE … IF NOT EXISTS` set, verbatim). **id 2 = `ALTER TABLE Instances ADD COLUMN improveProductConsent INTEGER`** (**nullable, no DEFAULT**); **id 3 = backfill `UPDATE Instances SET improveProductConsent = 1 WHERE instanceName NOT LIKE '%.%' AND instanceName != ?`** with the runner's **`params: [PLATFORM_INSTANCE_NAME]`** (bound `?`, never interpolated). *(Two single-statement migrations — not one multi-statement entry — so the `?` bind is unambiguous; both run in the same atomic `transactionSync` batch.)* Existing **user-developer** Universe rows → consented assume-true; sub-instance rows **and** `nebula-platform` stay `NULL`. | **Nullable on purpose:** three states are distinct (`NULL` = no level-specific decision/inherit, `0` = declined, `1` = consented — the `coding-style.md` nullable exception), and `NULL` keeps the model **per-level-ready**. A **fresh DO** runs 1 then 2 (nothing to backfill); an **existing prod DO** runs *all*: id 1 `IF NOT EXISTS` no-op, id 2 adds the column **and backfills existing user Universe rows to `1`** (excluding `nebula-platform`). **Both converge** — the load-bearing prod-path test (Phase 2). The backfill `UPDATE` is the first **non-trivial** migration step (data, not just DDL), so it genuinely exercises the runner. *(Tier = dot-count in `instanceName`; `parseId` knows it; `NOT LIKE '%.%'` is the Universe filter, platform excluded explicitly.)* |
| D6 | Scope reminder | The prod `NebulaAuthRegistry` is a **singleton** — one live DO, but it **holds every instance record**, so correctness is critical and there's no second instance to catch a mistake. | Low fan-out, high stakes. The runner-level seed-old-schema test (Phase 2) is the only pre-deploy proof of the existing-DO path. |

## Phases

### Phase 1 — Prerequisite: `@lumenize/sql-migrations`
**Goal**: The runner package exists and is green. **Built first, in its own task** ([`archive/sql-migrations.md`](archive/sql-migrations.md)) — this phase is just the dependency gate.

**Success Criteria**:
- [x] `@lumenize/sql-migrations` is built, tested, and available to `packages/nebula-auth` (DONE 2026-06-29 — `packages/sql-migrations/`). **`nebula-auth` must add it as a workspace dep (`"@lumenize/sql-migrations": "*"`) when Phase 2 wires it in.**

### Phase 2 — Wire the runner into the registry + add the column
**Goal**: `NebulaAuthRegistry` runs `REGISTRY_MIGRATIONS` via `@lumenize/sql-migrations` eagerly in its constructor (D2/D4), adding the nullable column + the Universe backfill.

**Success Criteria**:
- [ ] `CREATE TABLE` constant for `Instances` includes the new **nullable** column (covers fresh DOs). The migration list is an **exported constant** (`REGISTRY_MIGRATIONS`) — **not buried in the constructor** — so the prod-path test can invoke it directly (B1): **id 1 = baseline (verbatim, `IF NOT EXISTS`)**, **id 2 = `ALTER … ADD COLUMN improveProductConsent INTEGER`** (nullable, no DEFAULT), **id 3 = backfill `UPDATE … SET = 1 WHERE instanceName NOT LIKE '%.%' AND instanceName != ?`** with the runner's `params: [PLATFORM_INSTANCE_NAME]` (M4 — the reserved platform pseudo-Universe must not be consented; bound `?`, two single-statement migrations in one atomic batch).
- [ ] The registry constructor calls **`super(ctx, env)` first**, then runs the migration list **synchronously** (D2 — no `blockConcurrencyWhile`). The `#schemaInitialized` field **and every `#ensureSchema()` call site** (not just the method) are removed (N1).
- [ ] **Capable-of-failing test — the prod path (B1; the load-bearing one).** Because the migration runs in the constructor body, it has already run by the time a test holds the registry stub — so this test does **NOT** go through the registry constructor. It hand-creates the **old** `Instances` schema (`instanceName, createdAt` only) in a DO's `ctx.storage`, inserts a **Universe**, a **galaxy/star**, and a **`nebula-platform`** row, leaves the kv marker unset, then runs `new SQLSchemaMigrations({ doStorage: ctx.storage, migrations: REGISTRY_MIGRATIONS }).runAll()` (per the **Public API (pinned)** in [`sql-migrations.md`](archive/sql-migrations.md)) and asserts: column added, **Universe → `1`**, **sub-instance + `nebula-platform` → `NULL`**, marker advanced. **Re-run** → no throw, no row changes. **And re-run idempotency of the data step (M8):** set the Universe row to `0`, `runAll()` again → it is **not** reset to `1` (the marker gate prevents the backfill re-touching a since-declined row). Reddens on a bare `ALTER`, a `DEFAULT 1`, a missing platform-exclusion, or a re-runnable backfill.
- [ ] **Capable-of-failing test — the fresh path:** constructing the registry on a brand-new DO yields the (nullable) column with all `REGISTRY_MIGRATIONS` recorded (marker at the highest id); second construct is a no-op. (Proves the constructor *wires* the runner; the prod path above proves the *migration*.)
- [ ] `WITHOUT ROWID` write-cost discipline respected (`durable-objects.md` § write costs) — no new index for this flag (the corpus `SELECT` is a rare full scan, not a hot path; a partial index is YAGNI).

### Phase 3 — Record consent at `claimUniverse` + the corpus query
**Goal**: `claimUniverse` writes the Universe consent; verify the corpus selection.

**Success Criteria**:
- [ ] `claimUniverse` sets the Universe row's `improveProductConsent` to `1`, **conflict-safe** — `INSERT … ON CONFLICT(instanceName) DO UPDATE SET improveProductConsent = 1` (or an explicit UPDATE) so a **pre-existing** Universe row (e.g. one created by `registerEmail`'s `INSERT OR IGNORE` before the claim) is still set, never left `NULL`. The user-supplied `slug` stays a **bound `?`** (mirror the bound INSERT at `nebula-auth-registry.ts:189`; never string-concatenated — `security.md`) (M5). Sub-instance INSERT sites (`claimStar`/`createGalaxy`/`createStar`/`registerEmail`) are **unchanged** — their rows stay `NULL` (inherit).
- [ ] **Capable-of-failing test — the upsert ordering case (M3, load-bearing):** `registerEmail(…)` first (row created `NULL`), **then** `claimUniverse(…)` → assert consent `1` and the corpus `SELECT` returns it. Mutation-check: revert to a bare `INSERT` → **this test must redden** (the bare insert no-ops on the existing PK, leaving `NULL`).
- [ ] **Capable-of-failing test — the corpus filter:** corpus query = `SELECT instanceName FROM Instances WHERE improveProductConsent = 1 AND instanceName != ?` (bind `PLATFORM_INSTANCE_NAME`) returns a consented Universe; a sub-instance row (`NULL`), an explicit-`0` row, and the `nebula-platform` row are **all excluded**. The `0` row is a **test fixture** — no product path writes `0` until the deferred opt-out UI; it guards the filter `= 1` against weakening to `IS NOT NULL`. Keep the `NULL` and `0` excludes as **independent** assertions (mutate each separately) (M7).
- [ ] Existing registry suite green, unchanged (`npx vitest run` in `packages/nebula-auth`).

### Phase 4 — Consent notice at the slug-pick prompt  *(may trail — pure copy, no migrations-door consequence)*
**Goal**: Surface a short consent notice in the `nebula-studio-ui` slug-pick / claim view.

**Success Criteria**:
- [ ] A consent notice renders at the slug-pick prompt (locate the view: grep `nebula-studio-ui` for the claim-universe / slug input). Copy TBD — generic "improve the product" framing, never nebula/studio-specific.
- [ ] No functional gating yet (assume-true) — the notice is informational.

### Final Verification (every phase)
- [ ] `npx vitest run` green in `packages/nebula-auth`; `npm run type-check` clean.
- [ ] Nuggets extracted up into `nebula-pre-alpha.md` (consent is Universe-level/per-level-ready; the migration runner is `@lumenize/sql-migrations`), then archive this file.

## Notes / risks

- **First prod migration — the runner-level test + the deploy are the real proof.** Constructing the registry always runs the migration first (constructor body), so the *prod* (table-already-exists) path can only be exercised by the **runner-level** seed-old-schema test (Phase 2 — hand-seed the old table, invoke `REGISTRY_MIGRATIONS` directly, NOT via the registry constructor — B1) + the actual deploy. Treat that test as load-bearing, not optional.
- **Assume-true is opt-out by default** (consent presumed, no withdrawal UI yet) — a defensible pre-alpha F&F choice, but keep it honest: the corpus query is built now as a **guard test only**; **no live consumer may read the corpus until the Phase-4 consent notice actually renders** (M6). The consumers (turn-log inspection v0, daily digest v1) are deferred anyway, so this costs nothing now.
- **Raw DO, so "onStart" = constructor body** (synchronous, per `durable-objects.md`). Don't reach for a `LumenizeDO` hook. No `blockConcurrencyWhile` — `transactionSync` (in the runner) is the belt-and-suspenders; add `blockConcurrencyWhile` only if a future migration step must `await`.
- **Lifecycle reminder:** consent lives on the `Instances` row of the **Universe** because a Universe is 1:1 with its claiming user-developer (Universe admin) in pre-alpha, and `claimUniverse` is the human consent moment. (Considered Subjects instead — rejected: parent spec pins `Instances`, and the Universe row is the natural record.)
