# Monorepo vitest 3 → 4 Upgrade

**Status**: Not started
**Blocks**: `tasks/nebula-5.2.4.1-validator-engine-upgrade.md` (Phase 1 Suite 1 facet tests)
**Type**: Tooling cleanup — implementation-first

## Objective

Upgrade `vitest` from `3.2.4` → `^4.1.0` across the monorepo, along with the compatible `@cloudflare/vitest-pool-workers` (`0.12.21` → latest `0.14.x`) and `@vitest/coverage-istanbul`. This is prerequisite work for Phase 5.2.4.1's Suite 1 facet tests — DO facets were announced 2026-04-13, and the miniflare/workerd versions that support them ship only in `vitest-pool-workers@0.13.0+`, which peer-requires `vitest@^4.1.0`.

This task was carved out of 5.2.4.1 Phase 1 on 2026-04-19 when the peer-dep constraint surfaced. Keep the upgrade narrowly scoped: bump versions, resolve breakage, leave everything else alone. No API redesigns, no test rewrites beyond what the upgrade forces.

## Scope

**In scope:**
- Bump `vitest`, `@cloudflare/vitest-pool-workers`, `@vitest/coverage-istanbul` across every `package.json` that pins them (23 files identified on 2026-04-19 — `packages/*`, `apps/nebula`, `tooling/email-test`, `tooling/doc-testing`, `lumenize-monolith`, `doc-test/*/*`). Keep peer-dep versions consistent with dev-dep versions inside each package.
- Fix any vitest 3→4 breaking changes that surface: config shape (`defineWorkersProject` changes, if any), reporter API, watch mode, `globals` semantics, `coverage.include/exclude` path globbing — whatever actually breaks when tests run.
- Re-run each package's test suite and verify it passes. Don't touch tests that pass unchanged.
- Update any vitest config files (`vitest.config.js` / `.ts`) that need shape changes.

**Out of scope:**
- Any non-upgrade refactoring, even if tempting while in a config file.
- Test rewrites beyond what the upgrade forces. If a test was flaky before, it stays flaky now.
- Fixing unrelated type-check or lint issues that surface.
- Touching `tooling/doc-testing`'s `vitest@^2.1.8` pin **unless** it breaks something else. That's a very old pin and may be intentional (generated-test harness); investigate before upgrading.
- Bumping wrangler or miniflare independently. Accept whatever vitest-pool-workers 0.14.x pulls in.

## Known Breaking Changes to Watch For

### vitest 4 (core)

Skim the [vitest 4.0 migration guide](https://vitest.dev/guide/migration) before starting. Things that historically break in major vitest bumps:
- `defineConfig` / `defineProject` exports may have moved. The Cloudflare pool's `defineWorkersProject` wraps this — check its new signature.
- `vi.mock` hoisting and timing behavior tightened in each major.
- Coverage: continue using Istanbul. v8 coverage remains unsupported in pool-workers ([docs](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)).
- `globals: true` interactions with TypeScript `types: ["vitest/globals"]` — occasionally needs a `types` bump to a matching version.
- Snapshot format — unlikely to bite this repo (snapshots aren't heavily used), but verify.

### @cloudflare/vitest-pool-workers 0.13+ / 0.14+

`0.13.x` is the breaking release that adds vitest 4 support and drops vitest 2 / 3 support. Known-breaking items sourced from the [workers-sdk tracking issue #11064](https://github.com/cloudflare/workers-sdk/issues/11064) and [Cloudflare vitest-integration docs](https://developers.cloudflare.com/workers/testing/vitest-integration/):

- **`isolatedStorage`**** removed** — the per-test isolation option is gone. Storage isolation is now per-**test file** by default, matching Vitest's worker model. Our convention has been to run with `isolatedStorage: false` and get isolation by using a fresh DO id per test, which lines up with the new default. **Our strategy for this upgrade**: stay on fresh-DO-per-test. Audit every `vitest.config.*` for `isolatedStorage: true` (explicit or defaulted-on in older pool versions) — any such test was relying on per-test reset, and will need to be rewritten to use a fresh DO id per test. We explicitly don't want to go the `beforeEach`/`afterEach` + `deleteAll()` route (serializes/couples tests) or the `--max-workers=1 --no-isolate` route (reduces parallelism).
- **`singleWorker`**** removed** — same simpler-isolation-model rationale. Remove from configs; rely on the default.
- **`import { env, SELF } from "cloudflare:test"`**** removed** — replaced by `import { env, exports } from "cloudflare:workers"`. `SELF` specifically maps to an entry in `exports`. Every `for-docs` and integration test in the repo imports from `cloudflare:test` — expect lots of mechanical edits here, and the codemod (below) handles most of them.
- **`import { fetchMock } from "cloudflare:test"`**** removed** — find alternate mocking approach (likely Vitest's built-in `vi.stubGlobal('fetch', ...)` or MSW). Grep for `fetchMock` usages before starting so we know the blast radius.
- **Codemod available**: `npx jscodeshift -t node_modules/@cloudflare/vitest-pool-workers/dist/codemods/vitest-v3-to-v4.mjs vitest.config.ts`. Run it on every `vitest.config.*` in the repo; review its diff rather than trusting it blindly.
- **Istanbul coverage + Vite 8 regression**: [workers-sdk #12994](https://github.com/cloudflare/workers-sdk/issues/12994) reported `TypeError: template is not a function` when running Istanbul coverage against pool-workers 0.13.x on Vite 8. Marked done as duplicate of #12951 — verify it's actually fixed on whatever version Phase 1 settles on. If not, pin to a fixed patch or skip coverage on affected packages for this upgrade and file a follow-up.
- [**#12889**](https://github.com/cloudflare/workers-sdk/issues/12889)** is not a way out**: the issue was closed by confirming `ctx.storage.deleteAll()` works, so tests *could* implement their own reset in `beforeEach`/`afterEach`. We're deliberately not going that route — see the `isolatedStorage` bullet above. Fresh-DO-per-test is the strategy; this issue is a non-solution for us.

## Phase 0: Baseline

Establish ground truth on the current `vitest@3.2.4` setup before touching anything. This is a pre-flight gate — if real (non-flake) failures exist, they get fixed here, not blamed on the upgrade later.

- From the monorepo root, run `npm run test` and `npm run type-check`. `npm run test` is the tests-that-matter entrypoint — do not try to recurse into each package manually, the per-package invocations don't all wire up the right projects/env.
- **Cold-start flakes**: A handful of tests (suspected culprit: the `test-endpoints` project deployed to Cloudflare) intermittently fail on the first run because of cold starts and pass on the second. If a test fails once and then passes on a re-run, treat it as a known cold-start flake — record it but don't count it as a real failure.
- **Real failures**: Anything that fails twice in a row on the current version is a pre-existing bug, not upgrade fallout. Fix those here — otherwise we can't cleanly attribute post-upgrade failures, and they'll masquerade as vitest 4 regressions.
- **Coverage baseline**: **the user runs ****`npm run coverage`** — Claude's sandbox shell doesn't have `node` or `npm` on PATH (nvm isn't loaded in non-interactive shells), so Claude cannot invoke the root script. Claude can verify individual packages via an absolute-path workaround (e.g. `/Users/larry/.nvm/versions/node/<version>/bin/npm run coverage -w <package>`) or by reading the resulting coverage report files, but the full-suite run is a user action. The root script (`scripts/coverage.sh`) fans out to every `packages/*` and `apps/*` with a `coverage` script; deliberately skips `tooling/*` and `doc-test/*/*` since doc-test coverage measures the test code itself, not the package under test. First run may need iteration to make sure it hits exactly the right folders — the script is new and unproven. Capture per-package branch/statement/line percentages here so we have something to compare against after the upgrade.
- Record the passing baseline and the cold-start flake list in this file before moving on to Phase 1.

**Success Criteria**:
- [ ] `npm run test` (from repo root) green on a fresh run, or green on re-run with only known cold-start flakes
- [ ] `npm run type-check` clean on the current version
- [ ] `npm run coverage` runs successfully on the current version; per-package numbers recorded
- [ ] Cold-start flake list recorded; any real (twice-in-a-row) failures fixed or explicitly deferred with rationale

## Phase 1: Inventory and Dry Run

- Run `npm install --dry-run` with the bumped versions in one package (recommend `packages/debug/` — smallest surface, no Workers pool) to confirm the resolution graph works.
- List the exact resolved versions for `vitest`, `@vitest/*`, `@cloudflare/vitest-pool-workers`, `miniflare`, `workerd`. Record here before making actual changes.
- Skim the vitest 4 migration guide for anything that might affect our config style (ESM-only config files, `defineWorkersProject` wrapper changes, pool API changes in 0.13/0.14).
- Verify the Istanbul-coverage regression ([workers-sdk #12994](https://github.com/cloudflare/workers-sdk/issues/12994) / #12951) is fixed in the pool-workers patch we land on. If not, pin to a fixed patch or skip coverage on affected packages and file a follow-up. Capture the decision here.
- **Audit what the pool-workers breaking changes touch in our codebase** — grep across the repo and record counts so we know the blast radius before Phase 2:
  - `isolatedStorage` in any `vitest.config.*` — list each config. Any `isolatedStorage: true` (or configs that never set it when the old default was `true`) need test-level review, not just mechanical edits.
  - `singleWorker` in any `vitest.config.*`.
  - `from "cloudflare:test"` imports — especially `SELF`, `env`, `fetchMock`.
  - `fetchMock` usages — these have no direct replacement, plan the substitute (likely `vi.stubGlobal` or MSW) before touching code.

**Success Criteria**:
- [ ] Resolved versions recorded here
- [ ] Migration-guide risks cataloged (list of things to actively check)
- [ ] Istanbul-coverage regression status confirmed (fixed on target version, or workaround chosen)
- [ ] Audit counts recorded for `isolatedStorage`, `singleWorker`, `cloudflare:test` imports, and `fetchMock` usages — with a plan for any `isolatedStorage: true` config or `fetchMock` usage

## Phase 2: Bump + Fix

- Update every `package.json` to the target versions in one pass:
  - `vitest`: `3.2.4` → `^4.1.0` (or whatever Phase 1 settled on)
  - `@cloudflare/vitest-pool-workers`: `0.12.21` / older → `^0.14.7` (or latest compatible)
  - `@vitest/coverage-istanbul`: `3.2.4` → match vitest's minor
  - `peerDependencies` in each package must track the devDependencies so downstream consumers see consistent ranges
- `lumenize-monolith` currently pins `@cloudflare/vitest-pool-workers@^0.8.47` and `vitest@~3.2.3` — likely needs a larger jump; if the package is still actively used, upgrade it alongside everything else. If it's deprecated legacy, skip it and note here.
- `tooling/email-test` pins `@cloudflare/vitest-pool-workers@^0.9.3` — similar situation, verify and decide.
- `tooling/doc-testing` pins `vitest@^2.1.8` — keep if nothing forces it, upgrade only if it breaks under the new resolution.
- Run `npm install` at the root. Resolve any `ERESOLVE` conflicts.
- Run the pool-workers codemod on every `vitest.config.*` in the repo: `npx jscodeshift -t node_modules/@cloudflare/vitest-pool-workers/dist/codemods/vitest-v3-to-v4.mjs <config>`. Review the diff per file — don't trust it blindly.
- Migrate `cloudflare:test` imports that the codemod didn't catch: `env` and `SELF` → `cloudflare:workers` (`SELF` becomes an `exports` entry); remove `fetchMock` usages and swap in the substitute chosen in Phase 1.
- For every config that was relying on `isolatedStorage: true` (per the Phase 1 audit), review the affected tests. If they pass on the new per-test-file model, great. If they depend on per-test storage reset, rewrite them to use a fresh DO id per test (our existing pattern). Do not fall back to `beforeEach`/`afterEach` + `deleteAll()` or `--max-workers=1 --no-isolate`.
- Run `npm run types` — regenerate worker-configuration.d.ts for every package (newer wrangler may emit a different shape).
- Run `npm run test` from the monorepo root and fix failures. Most failures should be config-shape issues, not real test bugs. Apply the same cold-start rule as Phase 0: a test that fails once then passes on re-run is a known flake, not an upgrade regression. Compare the post-upgrade failure set against the Phase 0 baseline before blaming vitest 4.
- **User runs ****`npm run coverage`** (same sandbox-PATH constraint as Phase 0) and produces a **complete before/after comparison report** in this file: for every package, the Phase 0 baseline percentages vs. the post-upgrade percentages (branch, statement, line). Claude can help by reading the per-package coverage output files after the user's run completes. Call out any package where coverage regressed — a drop is either a new Istanbul-instrumentation gap (see #12994) or a test that stopped running, both of which need investigation before declaring the upgrade done.
- **Audit \****`@lumenize/testing`****\*\*\*\* docs****\*\* in ****\*******`website/docs/testing/`****\* (****\*******`usage.mdx`****\*, ****\*******`agents.mdx`****\*, ****\*******`cors-support.mdx`****\*). ****\*******`@check-example`****\* blocks get caught automatically by ****\*******`npm run test:doc`****\*, so fix any failures there first. The bigger risk is ****\*\*unchecked config snippets****\*\* — \`vitest.config.*` examples that show `defineWorkersProject`, `isolatedStorage`, `singleWorker`, `import ... from "cloudflare:test"`, or `fetchMock`. Two of the three files (`usage.mdx`, `agents.mdx`) have zero `@check-` annotations, so every code block in them is unvalidated — hand-read each and update anything that uses the old shape to the new one.
- Record any vitest config shape changes that needed to propagate to every package.

**Success Criteria**:
- [ ] All 23 `package.json` files updated (or documented reasons for skipping)
- [ ] `npm install` clean (no `ERESOLVE`, no `--legacy-peer-deps`)
- [ ] `npm run test` (from repo root) passes cleanly against the Phase 0 baseline — no new failures beyond the known cold-start flake list
- [ ] `npm run type-check` clean
- [ ] Complete before/after coverage comparison recorded; any regressed package investigated and either resolved or documented with a follow-up
- [ ] `website/docs/testing/` audited; checked examples pass and unchecked config snippets updated to the new shape
- [ ] No new `@ts-ignore` / `@ts-expect-error` / `as any` added to silence upgrade fallout — fix the underlying typing issue or file a follow-up

## Phase 3: Facet Smoke Test

Once the upgrade is green, do a 10-minute smoke test to confirm the upgrade actually unblocks 5.2.4.1 Phase 1:

- In `packages/ts-runtime-parser-validator/`, re-run `npm test`. The two tests in `test/facet-roundtrip.test.ts` should pass against the hand-written stub in `src/compile-types-to-parse-module.ts`.
- If they fail with `this.ctx.facets` still undefined, the upgrade didn't actually land the facet-capable miniflare — investigate before declaring the upgrade done.

**Success Criteria**:
- [ ] `packages/ts-runtime-parser-validator/`'s `facet-roundtrip.test.ts` passes — 5.2.4.1 Phase 1 is unblocked and can resume.

## Rollback

If something catastrophic surfaces mid-upgrade (e.g., vitest-pool-workers 0.14 has a regression that blocks `packages/rpc/`), revert the commit and re-pin everything to `vitest@3.2.4` + `@cloudflare/vitest-pool-workers@0.12.21`. File an upstream issue. Phase 5.2.4.1 falls back to Suite-2-only facet validation (option C from the 5.2.4.1 Phase 1 blocker discussion).

## Notes

- The 23-file inventory was taken 2026-04-19 — if this task sits for a while before being picked up, re-run `grep '"vitest":' **/package.json` to get a fresh count.
- When this task completes, update `tasks/nebula-5.2.4.1-validator-engine-upgrade.md`'s **Current State** section: change the Status back to "Phase 1 in progress" and remove the blocker line.
