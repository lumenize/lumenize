# Adopt declarative DO `exports`; upgrade wrangler / vitest / pool-workers toolchain

**Status**: **✅ COMPLETE + ARCHIVED 2026-07-16 — Phases 1–4 built, verified, committed.** **Follow-ups live on (this file is now frozen):** full workers-types elimination → [`backlog.md`](../backlog.md); M2 wipe-supersession → the prod `apps/nebula/wrangler.jsonc` comment + [`nebula-pre-alpha.md:88`](../nebula-pre-alpha.md); devstudio count coordination (8→7) → [`nebula-devstudio-collapse.md`](../nebula-devstudio-collapse.md) items 4/5 + the `audit-migrations.mjs` count comment; d.ts regen **NOT needed** (verified 0 TS errors — `exports` changes no bindings). Phase 1 (toolchain) committed (`5e903bc` packages+nebula, `a105a50` doc-test+tooling): all active workspaces on wrangler 4.111 / vitest 4.1.10 / pool-workers 0.18.5, no-worse; `@cloudflare/workers-types` **removed** (see decision below). Phases 2–4 (`migrations`→`exports`) built via `/build-task`: **41 test/harness/doc-test/prod configs + website-docs prose + teaching rules converted; `audit-migrations.mjs` preflight reworked exports-aware (selftest 7/7 — baseline + 6 must-red); `/build-task` verifier fan-out CLEAN (all 3 phases conform, 0 blockers).** Phases 2–4 are **UNCOMMITTED**, ready for human review; prod config is **STAGED, never deployed**. ⚠️ **2 items deferred to Larry (both task files, need his OK):** the M2 re-home note at [`nebula-pre-alpha.md:88`](nebula-pre-alpha.md), and the parked icebox straggler [`tasks/icebox/proxy-fetch-stress-test.md:187`](icebox/proxy-fetch-stress-test.md). Reviewed via `/review-task` (Stage 1+2 applied). M3 → **best-effort docs cleanup, `@check-examples` explicitly OUT** (release-gated). Conformance #7 → `nebula-devstudio-collapse.md` items 4/5 **reconciled to the `exports` model**. Note Phase 1's completion gate (repo-wide `npm install`/`npm run types`/tests) runs through Larry. Profile has landed, so this is unblocked. **Only Phase 4 (prod config) is wipe-gated** — Phases 1–3 (the *overdue* toolchain upgrade + internal test/doc-config conversion) depend only on the toolchain and may land ahead of the wipe if the staleness bites; the convert-all rationale is repo-wide and needs no wipe. Scope decisions (convert-all + doc-test + docs prose) are Larry's calls (2026-07-15). **Next: `/build-task` once Stage 2 clears.**

> **Wipe runbook — precise, and frozen.** The deploy runbook this task's Phase 4 is fenced to is **Phase 4 of the frozen archive [`tasks/archive/nebula-auth-surrogate-sub.md`](archive/nebula-auth-surrogate-sub.md) (§Phase 4, ~lines 224–242)**, reached via the pointer at [`nebula-pre-alpha.md:88`](nebula-pre-alpha.md) (⚠️ `nebula-pre-alpha.md` itself has **no** Phase 4 — it's Wave-structured, and a grep there also hits an *unrelated* "archived Phase 4" consent-UI pointer). Being archived, that runbook is **frozen** (never edited) and its steps **narrate the `migrations` shape verbatim + invoke the migrations-shaped `audit-migrations.mjs`** — both **superseded** by this task. Phase 4 re-homes the delta into a live surface; do not edit the frozen file.

## Objective
Two coupled changes, done together because the wipe makes the first one free of legacy baggage:

1. **Replace the imperative `migrations` array with the declarative `exports` map** for DO class registration, everywhere in active code. New Cloudflare feature (changelog [2026-06-30](https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/)): a class→config map that is the single source of truth, with **no version tags and no tombstones** on a fresh deploy.
2. **Upgrade the Workers toolchain** (`wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`) across all active workspaces — overdue, and a hard prerequisite for `exports` (old wrangler/pool-workers don't know the field).

**Why now:** the prod DO storage is about to be wiped and redeployed from scratch. A fresh deploy is the *only* clean moment to adopt `exports` for prod without carrying migration history — and adopting the new model everywhere (not just prod) avoids a lasting `migrations`-vs-`exports` split-brain that would become a re-read unlearning-tax surface ([[interim-unlearning-tax]]).

---

## Verified facts (grounding — do NOT re-derive during build)
Empirically established 2026-07-15 in this repo; a reviewer/builder can trust these.

- **`exports` is mainline** (not experimental-gated) in **wrangler 4.111.0** — present in `RawConfig` of the shipped `config-schema.json`, description: *"mutually exclusive with `migrations`."* `migrations` still supported for back-compat.
- **`@cloudflare/vitest-pool-workers` 0.18.5 fully parses AND validates `exports`.** Probe: converted `experiments/rpc-stub-disposability` (already on target versions) `migrations`→`exports`, ran its suite → **green**; fed an invalid `storage: "BOGUS"` → precise schema error `"exports.ProbeFacet.storage" ... must be one of sqlite and legacy-kv`. So converting **test** configs is safe end-to-end, not just at deploy. (Experiment restored to committed state; do not re-run the probe — result is captured here.)
- **`exports` does NOT replace `durable_objects.bindings`.** Bindings (env name → class) stay exactly as-is; `exports` replaces **only** `migrations`. Both blocks coexist.
- **Target versions already proven to run in this repo** (the same experiment, 2026-07-15): `wrangler 4.111.0`, `pool-workers 0.18.5`, `vitest 4.1.10`, transitive `miniflare 4.20260710.0`.

### The `exports` shape (what a converted config looks like)
> ⚠️ **Name collision — `exports` is now overloaded.** wrangler.jsonc `exports` (this task's DO class registry) is a **different thing** from the package.json `exports` field (Node subpath / condition map) that is load-bearing across ~18 `package.json` files and taught at length in `packaging.md` (the mesh-DO-subpath fix, the cross-platform `cloudflare:workers` condition-map). **Never conflate them.** Every edit and rule-rewrite below must keep the two meanings distinct (see Phase 4 / M4).

```jsonc
// BEFORE — imperative, tagged, append-only:
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["Universe", "Galaxy", "Star"] }
]

// AFTER — declarative map; `state` defaults to "created", so omit it.
// durable_objects.bindings is UNCHANGED and still required.
"exports": {
  "Universe": { "type": "durable-object", "storage": "sqlite" },
  "Galaxy":   { "type": "durable-object", "storage": "sqlite" },
  "Star":     { "type": "durable-object", "storage": "sqlite" }
}
```
Field values: `type` = `"durable-object"` for our conversion — but the schema's `exports` value is `DurableObjectExport | WorkerEntrypointExport`, so `type` **may also be `"worker"`** (conformance #8); the audit's DO checks must therefore scope to `type: "durable-object"` entries, not assume every entry is a DO. `storage` = `"sqlite"` (ours) or `"legacy-kv"` (the one non-sqlite exception below); `state` ∈ created (default) / deleted / renamed / transferred / expecting-transfer — **on a fresh wipe we only ever emit `created`, so no `deleted`/`renamed` tombstones.**

---

## Pinned decisions
| Decision | Choice | Rationale |
|---|---|---|
| Conversion breadth | **Convert-all active** — prod + every active test/harness config + `doc-test/*` | Larry 2026-07-15. One model everywhere; kills tombstone cruft; pool-workers support verified. |
| Doc examples | **Convert doc-test *configs* to `exports`; best-effort prose cleanup; `@check-examples` explicitly OUT** | Larry 2026-07-16. Configs must convert (pool-load consistency). Prose is a best-effort `migrations`→`exports` pass. `@check-examples` is **release-gated** (a full enforced pass before release) — this task does not wire/validate/track it (Phase 3). M3 external-reader footgun mitigated by an *optional* best-effort compat note on public snippets, not a gate. |
| Out of scope | `experiments/*` (throwaway, pinned separately), `lumenize-monolith/` (not in workspaces, legacy) | `.claude/rules/workflow.md` § Experiments; monolith last touched 2026-05-02. If dep-hoisting bumps an experiment's wrangler, that's fine — don't fix. |
| Target versions | `wrangler ^4.111.0`, `@cloudflare/vitest-pool-workers ^0.18.5`, `vitest 4.1.10` | Latest; proven in-repo. Match each file's existing caret-vs-exact convention when bumping. |
| `compatibility_date` | **Unchanged** (stays `2026-04-01` etc.) | Newer wrangler bundles newer workerd but doesn't force a date bump; opting into newer default behaviors is a separate, riskier decision — not bundled here. |
| Non-sqlite class | **Preserve as `storage: "legacy-kv"`, do NOT "fix" to sqlite** | `packages/auth/test/hono` `EchoDO` is intentionally `new_classes` (non-sqlite) — a deliberate test surface; converting it to sqlite would silently change what's tested. |
| Prod deploy timing | **Prod config conversion is STAGED, fenced to the frozen wipe runbook** (Status banner has the precise chain) | Switching a *live* worker `migrations`→`exports` via plain `wrangler deploy` may be rejected — same hazard as the `NebulaAuth`-removal warning in the file. Nothing auto-deploys, so committing the converted config is safe. ⚠️ But the wipe's own `audit-migrations.mjs` preflight must be made `exports`-aware **first** (Phase 4 / M1) or the deploy aborts at preflight. |

### `@cloudflare/workers-types` — RESOLVED (Larry 2026-07-16): **REMOVED entirely; rely on `wrangler types`**
Empirically, wrangler 4.111 **peer-wants workers-types v5** (`^5.20260710.1`), so keeping v4 broke `npm install` (ERESOLVE). Rather than take the v5 major, Larry's directive: workers-types is a lazy workaround — `wrangler types` output (`worker-configuration.d.ts`) provides the same globals. **Done in Phase 1:** dropped from packages/* (root + routing/sql-migrations/structured-clone `package.json`, `routing/tsconfig.json`, the `sql-migrations` src import) → install unblocked, packages/* dev type-check 12/12 clean (proves it). apps/nebula never declared it. ⚠️ **Follow-up (task #6, NOT this task):** the 6 publish `tsconfig.build.json` still name it (resolved via the still-hoisted copy from out-of-scope apps/nebula/website/experiments) — but that `tsc -p tsconfig.build.json` path was **already broken pre-session** (cloudflare:test-in-src, cross-package `Env`), so making the publish build workers-types-free is its own careful pass.

---

### Pre-upgrade test baseline (recorded 2026-07-16) — the "no worse" reference
Captured on CURRENT versions (wrangler 4.86 / vitest 4.1.4 / pool-workers 0.15.1) so post-upgrade regressions are attributable. Full per-test logs live in the session scratchpad (`baseline/` + `nebula-baseline/`); failures were consistent across both flaky-guard passes (not cold-start/contention noise).
- **`packages/*` — 12/12 GREEN**, ~2,950 tests, first pass, zero flakes (incl. browser/container/`remote:true` lanes, all local). **Upgrade target: stay 12/12 green.**
- **`apps/nebula` (per-project) — 5 green, 4 with PRE-EXISTING failures** (apps/nebula is mid-turnover; expected):
  - GREEN: `unit` (14), `frontend` (189), `secrets-facet` (4), `egress-choke` (4), `container` (61).
  - `dev-studio` **44/45** (1 fail: `@mesh surface freeze` non-admin-surface assertion).
  - `baseline` **91/334** (243 fail — known no-mint-login / DAG / client turnover; [[nebula-auth-surrogate-sub]] straggler).
  - `browser` **1/6** (3 fail, 2 skip — deployed-worker e2e: auth / round-trip / multi-client).
  - `chromium` **13/15** (2 fail — real-browser conflict-modal + factory-lifecycle).
  - **Upgrade target: NO NEW failures** — the same lanes/tests stay red, and none of the currently-green ones flip.

## Phase 1 — Toolchain upgrade ✅ DONE (2026-07-16; committed `5e903bc` + `a105a50`)
All active workspaces (packages/* · apps/nebula · doc-test/* · tooling/{email-test,test-endpoints}) bumped to **wrangler ^4.111 / vitest 4.1.10 / @cloudflare/vitest-pool-workers ^0.18.5 / @vitest/{browser,browser-playwright,coverage-istanbul} 4.1.10**. `tooling/doc-testing` (plain vitest 2.x, no Workers config) intentionally left. **DO registration still on `migrations`** — Phases 2–4 do the `exports` conversion.

**Deviations from the as-designed plan (all deliberate):**
- **workers-types REMOVED, not kept-v4** (decision above — wrangler 4.111 peer-forced v5; removed instead).
- **`@vitest/*` bumped in lockstep** (pool-workers 0.18.5 peer-requires vitest ^4.1; the `@vitest/*` exact pins ERESOLVE'd otherwise).
- **1 upgrade-caused code fix:** `auth` test cast an `AUTH_EMAIL_SENDER: {}` stub via `unknown` (4.111's stricter `Fetcher` type).
- **d.ts regen deferred** to one consistent `npm run types` pass (not needed for the test run; the 4.111 format diff is large but benign).

**Verified — the "no worse" bar met:** packages/* 12/12 tests green + 12/12 dev type-check clean (exact baseline match); apps/nebula per-project re-run EXACTLY no-worse (identical failure set); doc-test/tooling 9/9 green. Reference: the "Pre-upgrade test baseline" section above.

## Phase 2 — Convert test/harness configs to `exports` (packages + app test lanes + tooling)
**Goal**: Every active **non-prod, non-doc-test** config on `exports`, suites still green.

**Inventory (self-verifying)**: `find . -name wrangler.jsonc -not -path '*/node_modules/*' -not -path '*/experiments/*' -not -path '*/lumenize-monolith/*' -exec grep -l '"migrations"' {} \;` — **minus** `apps/nebula/wrangler.jsonc` (Phase 4) and the `doc-test/*` configs (Phase 3). (~31 files at time of writing: all `packages/**` test + for-docs + browser + container configs, the `apps/nebula/test/**` lanes, `tooling/email-test`, `tooling/test-endpoints`.)

**Mechanical rule**: for each config, replace the whole `"migrations": [ … ]` block with an `"exports": { … }` map — one `{ "type": "durable-object", "storage": "sqlite" }` entry **per class ever registered as live**, keyed by class name. Leave `durable_objects.bindings` untouched.

**Special cases (do NOT auto-normalize)**:
- **`packages/auth/test/hono/wrangler.jsonc`** — `EchoDO` is `new_classes` (non-sqlite). Convert it to `"EchoDO": { "type": "durable-object", "storage": "legacy-kv" }`, **not** sqlite. `LumenizeAuth` in the same file stays sqlite.
- **`apps/nebula/test/browser/worker/wrangler.jsonc`** — carries `deleted_classes` **tombstones** (`BenchBroadcaster`, `BenchFanoutHelper`, `ResourceHistory`, `DevStar`). In `exports` form, **drop them entirely** — list only the live classes (the whole point: no tombstones). This harness is a **deployed** throwaway; if a future redeploy of it is ever rejected because CF still has its old migration history, dashboard-delete + redeploy it (it holds no durable state worth keeping). Note this in the file's comment.

**Success Criteria**:
- [ ] The Phase-2 inventory grep returns **zero** `"migrations"` hits (every targeted config now on `exports`).
- [ ] `packages/auth/test/hono` `EchoDO` is `legacy-kv` (grep confirms; a mutation to `sqlite` is NOT made).
- [ ] The browser-worker harness `exports` map lists only live classes — **no** `state: "deleted"` entries; `grep -n 'deleted' apps/nebula/test/browser/worker/wrangler.jsonc` is clean.
- [ ] **All affected package suites green** (per-package `npx vitest run`; repo-wide through Larry). The pool-workers validator (Phase-0 spike) means a malformed `exports` fails loudly at pool load, so green = well-formed.

## Phase 3 — `doc-test/*` configs (convert) + website doc prose (best-effort; `@check-examples` OUT)
**Goal**: The **9 doc-test wrangler configs** (across 7 apps — the two `testing/` apps each carry a *second* `test/wrangler.jsonc`) on `exports` (config consistency — they must stay pool-loadable), and a **best-effort** `migrations`→`exports` cleanup of the website doc prose. ⚠️ **`@check-example` work is explicitly OUT of scope here** (Larry 2026-07-16): only a subset of the nebula/website docs have been through `@check-examples`, and the **website release process enforces a full `@check-examples` pass before release** (it won't let us skip it) — so this task does **not** wire new `@check-example` annotations, validate these snippets against it, or track that work anywhere. The release gate owns it.

**Inventory**:
- Configs — ⚠️ **depth-agnostic** (conformance #4; the `doc-test/*/*/wrangler.jsonc` glob is depth-2 and silently misses `doc-test/testing/testing-plain-do/test/wrangler.jsonc` + `doc-test/testing/testing-agent-with-agent-client/test/wrangler.jsonc`, green-lying on an intra-app `exports`-root/`migrations`-`test/` split-brain): `find doc-test -name wrangler.jsonc -not -path '*/node_modules/*' -exec grep -l '"migrations"' {} \;` (the true **9**).
- Prose (source only — `website/build/` is generated/gitignored, never touch it): `grep -rln 'new_sqlite_classes\|"migrations"' website/docs` — `mesh/{services,getting-started,lumenize-container}`, `testing/{usage,agents}`, `rpc/{quick-start,operation-chaining-and-nesting,capn-web-comparison-basics-and-types,capn-web-comparison-just-works}`, `ts-runtime-parser-validator/getting-started` (`.md`/`.mdx`).

**Work**: convert each `doc-test` config like Phase 2 (they must stay pool-loadable). **Best-effort** update the corresponding prose code block(s) `migrations`→`exports`. **Do NOT chase `@check-example`/`@skip-check` wiring or validation** for these — the release gate owns it (Goal above). Best-effort M3-footgun touch (optional, not a gate): where easy, add a one-line compat note to a *public* MIT-package snippet — *"Requires wrangler ≥ 4.111 / @cloudflare/vitest-pool-workers ≥ 0.18.5; the still-supported `migrations` form works on older toolchains"* — since a copy-paste reader on older wrangler hits a hard "unknown field" fail.

**Success Criteria**:
- [ ] **Configs (hard):** `find doc-test -name wrangler.jsonc -not -path '*/node_modules/*' -exec grep -l '"migrations"' {} \;` returns nothing (**depth-agnostic** — conformance #4; catches the two `test/` configs the old depth-2 glob missed).
- [ ] **Prose (best-effort):** `grep -rn 'new_sqlite_classes\|"migrations"' website/docs` is substantially reduced (ideally empty); any snippet left on `migrations` is a conscious call, not an oversight.
- [ ] **No regression:** the converted `doc-test` configs pool-load, and an already-green `npm run test:doc` isn't newly broken. ⚠️ **`@check-examples` completeness is NOT a gate here** — the release process enforces it separately (Goal).

## Phase 4 — Prod config (staged) + `exports`-aware deploy preflight + teaching surfaces
**Goal**: Convert `apps/nebula/wrangler.jsonc` to `exports`, make the deploy **preflight** `exports`-aware (M1 — else the wipe aborts at preflight), re-home the frozen runbook's delta into a **live** surface (M2), and update the repo's teaching rules/comments — the prod conversion **committed but explicitly deploy-gated to the frozen wipe runbook** (Status banner).

**Work**:
- **Convert `apps/nebula/wrangler.jsonc` `migrations`→`exports`** (all 8 live classes sqlite, incl. `Profile`; `durable_objects.bindings` unchanged). **Rewrite the `migrations`-block comment** (`apps/nebula/wrangler.jsonc:110-119`) to describe `exports` + restate the wipe coupling: a plain `wrangler deploy` on the *live* worker may be rejected switching `migrations`→`exports`; the conversion lands via the frozen wipe runbook (CF-dashboard worker-delete → fresh deploy), not an incremental deploy.
- **⚠️ M1 (hard prerequisite for the wipe) — make the deploy preflight `exports`-aware.** `apps/nebula/scripts/deploy.sh:35` runs `apps/nebula/scripts/audit-migrations.mjs` under `set -euo pipefail` **before** `wrangler deploy`; the audit is wholly `migrations`-shaped and **hard-returns `{ok:false}` the instant `migrations` is absent** → the converted config aborts the deploy at preflight. It is **already broken today**: `EXPECTED_DO_CLASS_COUNT = 7` but live prod has **8** classes (Profile was added without the deliberate bump its header demands), so `npm run audit:migrations:selftest`'s baseline is **RED right now** (throws "expected 7 … found 8") — it goes green when the count reconciles to 8; don't mistake that for the `exports` edit breaking it (conformance #6). Rework `auditMigrations` to read `exports`:
  - **Pin the SQLite invariant — don't soften it to an enum check (conformance #2).** The audit must red when **any** `exports` entry has `storage !== "sqlite"`, *preserving the force* of the old `new_classes` ban (a non-SQLite prod DO throws on first sync-storage access = hard prod failure); CF already rejects a bad enum *value* at load, so "just validate the enum" is vacuous. Scope the bindings↔`exports` **set-equality to `type: "durable-object"` keys only** (conformance #8 — `exports` values are `DurableObjectExport | WorkerEntrypointExport`; our conversion emits only durable-object, but the guard must be type-aware). Keep an `exports`-absent/malformed → `{ok:false}` guard and a DO-keys **`size === 8`** tripwire (mirroring the old `:148-151` / `:173-184`).
  - **The proof is ONE file — `scripts/audit-migrations.selftest.mjs`, NOT a vitest test (conformance #1).** There is **no** `test/audit-migrations.test.ts` — the script header (`:27-28`) that names it is **stale; fix it in this same change** so the drift source dies. The selftest is plain Node, run via `npm run audit:migrations:selftest`, deliberately **outside** vitest/tsconfig and **not** in `npm run test:code`/CI. Do **not** spawn a vitest `.test.ts` (wrong runtime — it can't `readFileSync` the config the way the Node selftest does).
  - **Port ALL SIX must-red mutations to the `exports` shape (conformance #3), not three.** Each current fixture `.replace()`s a `new_sqlite_classes`/`new_classes` literal that vanishes under `exports`, so all six need reconstruction: (a) a 9th class only in `exports` (absent from bindings); (b) a class missing from `worker.ts` re-exports; (c) a prod class typed `storage: "legacy-kv"` — replaces the old `new_classes` case; this is the SQLite-ban proof; (d) a non-DO export (`NebulaEmailSender`) present as a `type: "durable-object"` export; (e) parse-not-grep — ⚠️ its old `NebulaAuth`/`NebulaAuthRegistry` substring fixture is **dead** (standalone `NebulaAuth` dissolved; `worker.ts` exports `NebulaAuthRegistry, NebulaEmailSender`), so **re-anchor on a currently-valid substring pair or drop it with a stated rationale (conformance #6)**; (f) malformed JSONC → parse-failure, not vacuous pass. (Or retire the audit with a stated rationale — but default to reworking it; it's a real guard.)
- **⚠️ M2 — re-home the wipe delta into a live surface.** The runbook is frozen (Status banner); its steps narrate the `migrations` shape (step 2) and invoke the old audit (step 4) — both superseded. The wrangler.jsonc comment alone is insufficient (the operator runs the runbook, not the comment). Add a **live** superseding note — in this task file's Phase 4, and in the `nebula-pre-alpha.md:88` pointer region (⚠️ that's a **task file → ask Larry before editing `nebula-pre-alpha.md`**) — stating: prod config is now `exports`; `audit-migrations.mjs` is `exports`-aware; the archived runbook's migrations narration (steps 2 + 4) is superseded by this Phase 4.
- **Update teaching surfaces so the repo doesn't contradict its own code:**
  - **`.claude/rules/durable-objects.md`** § "DO class registration" (teaches `new_sqlite_classes` at length) — rewrite to `exports` as the standard; keep "this is a class registry, NOT SQL schema migration"; map the sqlite-vs-`legacy-kv` guidance onto `storage`.
  - **`.claude/rules/packaging.md:29`** — "DO bindings + class-registration `migrations`" → `exports`, **and disambiguate** (M4): this file *also* uses `exports` for the package.json condition/subpath map (:78-80, :21), so the edit must **not** be a bare word-swap — add a parenthetical distinguishing wrangler.jsonc `exports` (DO registry) from package.json `exports` (Node subpath/conditions).
  - **m4 — `.ts` source-comment sweep.** `grep -rn 'new_sqlite_classes\|new_classes' packages apps --include='*.ts'` — update `packages/mesh/src/lumenize-container.ts:59` (shipped MIT JSDoc teaching `new_sqlite_classes`) in lockstep with its published mirror (`website/docs/mesh/lumenize-container.md`, converted in Phase 3), else the exact drift this task exists to prevent is reintroduced. (Only source hit at time of writing.)

**Success Criteria**:
- [ ] `apps/nebula/wrangler.jsonc` on `exports`, all 8 classes. **Prod-map validation path (conformance #5):** there is **no** pool-workers project over the prod config and it isn't pool-loadable (`send_email remote:true`, placeholder KV id, `DevContainer extends Container` can't construct under pool-workers), and `npm run types` validates *bindings*, not `exports` — so validate via (1) the reworked `audit-migrations.mjs`'s explicit `storage`/DO-set checks and (2) the **Phase-2 baseline pool-load**, which mirrors the same class *set* under different names (`StarTest`/`DevStudioTest`/`DevContainerServeStub`/`ProfileTest`) so it exercises the `exports` **schema** at pool load. ⚠️ **Do NOT** use `wrangler deploy --dry-run` (m5 — HANGS, `deploy.sh:70-72`) or claim a prod pool-workers parse (doesn't exist).
- [ ] **`npm run audit:migrations:selftest` prints its baseline + all 6 must-red lines green** on the reworked `exports` audit (conformance #1/#3/#6) — baseline (RED today at 7-vs-8) green after the count→8 reconciliation; the 6 mutations red as enumerated in M1. This replaces the old "config validation passes" criterion, which **false-greened** by never invoking the preflight. Run it explicitly — it is **not** in `npm run test:code`.
- [ ] wrangler.jsonc comment states the wipe coupling + "no incremental deploy" hazard; the wipe delta is re-homed in a live surface (M2).
- [ ] `grep -rn 'new_sqlite_classes\|"migrations"' .claude/rules` returns nothing (both rules on `exports`); `packaging.md` visibly **distinguishes the two `exports` meanings** (M4).
- [ ] `grep -rn 'new_sqlite_classes\|new_classes' packages apps --include='*.ts' | grep -v node_modules | grep -v '\.test\.'` returns nothing (m4 — source JSDoc swept, incl. `lumenize-container.ts:59`).
- [ ] **Straggler cross-check widened to LIVE task files (conformance #7):** `grep -rn 'new_sqlite_classes\|audit-migrations\|EXPECTED_DO_CLASS_COUNT' tasks CLAUDE.md --include='*.md' | grep -v tasks/archive/` — reconcile any stragglers. ✅ `tasks/nebula-devstudio-collapse.md` items 4/5 **already reconciled** to the `exports` model (2026-07-16). ⚠️ **Count coordination:** this task reconciles the audit count to **8** (current live); the devstudio-collapse task then takes it **8→7** (removes `DevContainer`) — whichever lands second sets the final count + selftest. Archive refs stay frozen.

---

## Testing anchors / gotchas
- **Order is load-bearing**: upgrade (P1) *before* any `exports` conversion — pool-workers 0.15.1 (current) rejects the field; 0.18.5 (target) validates it.
- **Repo-wide suites run through Larry** ([[sandbox-npm-on-path]]); self-drive only per-package `npx vitest run`. `pkill -9 -f workerd` between pool-workers runs ([[workerd-zombie-hang]]).
- **A malformed `exports` fails at pool load** (whole project reds, like a bad `remote:true` cred — [[vitest-remote-binding-load-time]]), not as a per-test failure — so a green suite is real evidence the map is well-formed.
- **Container configs** (`packages/mesh/test/container`, `apps/nebula/test/test-apps/container-node`) register DO/container classes too — convert the same way; container behavior should verify under `wrangler dev` + Docker if anything looks off ([[test-container-changes-with-wrangler-dev]]), though this change is config-registry only.
- **`npm run types` regen** happens in P1 (version bump). `exports` adds no bindings, so it should not itself change generated `Env` output — if a `worker-configuration.d.ts` diff appears *because of* an `exports` edit, investigate.

## Not in scope
- **Deploying** the prod config — that's the frozen wipe runbook's job (Status banner has the precise chain). This task only **stages** the converted config and makes the preflight `exports`-aware.
- **`@cloudflare/workers-types` v5** (the major bump) — deferred to its own hygiene task off the wipe milestone (Stage-1 m1); this task keeps workers-types on latest **v4**. *(Not yet created — I'll `ask` before spinning up the separate task file.)*
- `experiments/*` and `lumenize-monolith/` — untouched (throwaway / legacy).
- **`compatibility_date` bumps** and opting into newer workerd default behaviors — separate decision.
- Adopting the new **programmatic** `@cloudflare/config` TS-config API (`defineWorker`/`exports()` builder) seen alongside this in wrangler 4.111 — a *different*, larger change; we stay on `wrangler.jsonc`.
- Rewriting **DO-internal SQL schema** — `exports`/`migrations` is the class registry, never SQL migration.
