# Release Process Improvements

## Objective

Make `npm publish` releases of the `@lumenize/*` packages reliably finish on the first try, without the operator (Larry) having to play whack-a-mole with drift in test infrastructure, lerna's broad workspace sweep, and one-off recovery commits to clean up half-bumped state.

## Context

The v0.25 release cycle (2026-05-02) surfaced 13 distinct issues across two release attempts before the publish completed. The session transcript is the empirical inventory. Releases have been getting more painful over time as the monorepo accumulates apps, doc-tests, experiments, and shared test infrastructure — every accumulation increases the surface that can drift between releases.

## Inventory of v0.25 release pain (the empirical baseline)

Grouped by theme. Each is the symptom we hit; the fix sketch comes in the phases below.

**Drift in test/config infrastructure (5)**
1. `@cloudflare/vitest-pool-workers` removed its `./config` subpath export — `packages/auth/vitest.config.js` failed to load with `ERR_PACKAGE_PATH_NOT_EXPORTED` mid-release.
2. `packages/rpc/test/map-set-debug.test.ts` — exploratory debugging artifact left in. ~600 unhandled `DataCloneError` rejections in vitest-pool-workers cleanup; non-deterministically pushed vitest's runner over its file-fail threshold.
3. `packages/ts-runtime-validator/test/ontology.test.ts` — orphaned: imported `apps/nebula/src/ontology` which had been deleted in PR #10.
4. `packages/rpc/test/test-worker-and-dos.ts` re-exported `DebugDOWithRpc` from a deleted test file. Same wrangler.jsonc held a `DEBUG_DO` binding + `v12` migration for the dead class.
5. Doc-test infrastructure (`doc-test/testing/testing-plain-do/vitest.config.js`) loads `@cloudflare/vitest-pool-workers` via `require`, which the package no longer supports (ESM-only).

**Lerna's broad workspace sweep (4)**
6. Without `--no-private`, `lerna version` swept all 25+ private workspaces — apps/nebula, every doc-test/* package, examples/*, the typia forks. Among other things this proposed downgrading the typia forks from `12.0.2-lumenize-fork` to `0.25.0`.
7. `experiments/alarm-accuracy` was still in the root `workspaces` array — `npm install --package-lock-only --ignore-scripts` (run inside `lerna version`) couldn't resolve its transitive deps and aborted the release.
8. `experiments/nebula-boot-repro` similar — even with the workspace entry removed, leftover `node_modules` symlinks and `package.json` references kept it in the resolution graph.
9. **Caret-with-major-0 trap**: every private workspace declared `"@lumenize/foo": "^0.24.0"`, but in semver `^0.X.Y` with major-0 means `>=0.X.Y <0.(X+1).0`. Once lerna bumps `@lumenize/foo` to `0.25.0`, the private workspace's `^0.24.0` no longer accepts the local workspace and npm falls back to the registry copy — which has stale peer-deps that conflict with the current install.

**Brittle ergonomics (4)**
10. `release.sh` re-runs every package's tests after the dry-run already ran them. Duplicate work that surfaces flake at the worst possible moment (mid-release, with package.json files already in publish-mode).
11. Cap'n Web / `@cloudflare/actors` version-mismatch interactive prompts existed inside release.sh, blocking automated runs. (Made advisory in v0.25 cycle.)
12. Doc-test failures gate the release pipeline by default. (Made advisory in v0.25 cycle.)
13. `lerna publish` prompts for an OTP per-package interactively. With ~9 packages and a ~2-minute OTP rotation window, this is a tight race and a recurring source of half-published releases.
14. **No clear success signal after OTP-bearing commands.** `npm publish` and `npm deprecate` both print verbose info during execution and then exit silently after the OTP-gated step completes. The operator can't easily distinguish "succeeded, output already scrolled past" from "failed, no error reported" — and re-running `npm publish` on an already-published version produces a 403 ("you cannot publish over the previously published versions") which reads to a tired operator like a confirmation that the original publish *failed*. (Hit during v0.25.1's deprecation publish, 2026-05-02.) Mitigations: a wrapper script that always ends with an explicit `✅ Published <name>@<version>` banner verified against the registry; or move to automation-token + CI per Phase 4, where success/failure is whatever the workflow run reports.

**Process artifacts**
- "mid-release commit" pattern on main: when releases fail mid-way, the operator commits the partial state to preserve recovery context. This litters main with non-meaningful commits like `b348421 mid-release commit`, `5fb1a35 mid-release commit`, `085b7b4 second mid-release commit`, etc. Visible in `git log` going back several releases.

## Goals

A successful release should:
- Run unattended end-to-end (no OTP-typing race, no interactive prompts in the happy path).
- Be reproducible — same commit ⇒ same published bytes.
- Not depend on incidental local state (uncommitted edits, stale `node_modules`, one-off test re-runs).
- Fail fast and locally if anything is wrong, before any external publish action runs.
- Leave a clean main history — one release commit, not five "mid-release commit"s.

## Phase 1: Cleanups identified during v0.25 (small, mechanical, high-value)

**Goal**: knock out the 13 issues above with the minimum-cost fix per issue. Most are one-line or one-file changes.

**Items**:
- [ ] Bulk-rewrite all private-workspace `@lumenize/*` deps from `"^0.X.Y"` to `"*"`. Files: `apps/nebula/package.json`, every `doc-test/*/*/package.json`, any `experiments/*` we keep, any `examples/*`. (Eliminates issue 9 entirely. Mechanical sed.)
- [ ] Sweep `experiments/` per CLAUDE.md guidance: drop completed experiments from `workspaces`. v0.25 dropped `alarm-accuracy`; do the same audit for the rest. Add a checklist item to the release runbook.
- [ ] Audit existing test files for orphaned imports — find every `test/*.ts` that re-exports from another `test/*.ts`, and cross-check the targets exist. Same for `wrangler.jsonc` `class_name` references that point at non-existent classes. Could be a one-off `grep`-based audit or a permanent CI check.
- [ ] Add a "find debug/exploratory test files" check — any `*.test.ts` whose docstring contains "debug" or "exploratory" or that's the only file with `console.log` spam in `src` doesn't belong in a release.

**Success criteria**:
- [ ] Releases stop hitting issues 1–9 (verified against the v0.25 transcript).

## Phase 2: De-flake `packages/rpc` cleanup

**Goal**: kill the ~600 `DataCloneError: Could not serialize object of type "LoopbackServiceStub"` unhandled rejections so vitest-pool-workers' file-fail threshold isn't a recurring random number generator at release time.

**Approach** (sketch — needs investigation):
- Errors come from vitest-pool-workers cleanup serializing test-internal stubs across the isolate boundary at file teardown. Likely root cause: tests holding live RPC stubs in module-scope or `beforeEach`-cached state when the test file unloads.
- Audit: which test files generate the rejections? Probably the WebSocket and stub-heavy ones (`websocket-integration.test.ts`, `map-set-identity.test.ts`).
- Fix candidates: explicit `client.disconnect()` in `afterEach`, or move stub creation inside `it()` blocks with `using` for auto-disposal.
- Verify by running the file in isolation and confirming the rejection count drops to zero before declaring done.

**Success criteria**:
- [ ] `npm test -w @lumenize/rpc` produces 0 unhandled rejections (down from ~600).
- [ ] Three consecutive runs all pass — no file-fail flake.

## Phase 3: Bump-then-publish split + dry-run as the gating test

**Goal**: stop running the full test sweep again inside release.sh. Make the dry-run authoritative; the actual release skips redundant work.

**Approach**:
- Drop the test step from `release.sh` entirely. The dry-run runs tests; the release run trusts the dry-run was just run successfully.
- Add a sanity gate: refuse to run release.sh if `git rev-parse HEAD` differs from the commit the last successful dry-run validated. (Track this via a `.last-dry-run-sha` file or equivalent.)
- Pre-version detection (already landed in v0.25): keep.
- Make `lerna version` and `lerna publish` two separate scripts: `scripts/version.sh` and `scripts/publish.sh`. `release.sh` becomes a thin wrapper that calls them in order. Easier to recover from a partial failure.

**Success criteria**:
- [ ] Release runs in <2 minutes (vs ~15 today) by skipping the test re-run.
- [ ] If publish fails, re-running publish (without re-versioning) is a one-command operation.

## Phase 4: npm automation token + CI release

**Goal**: eliminate the OTP-per-package race. Make releases tag-driven and automated.

**Approach**:
- Generate an npm automation token (bypasses 2FA for `npm publish`). Store as `NPM_TOKEN` GitHub secret.
- New GitHub Actions workflow `.github/workflows/release.yml`:
  - Triggered by pushing a tag matching `v*.*.*`
  - Runs the dry-run gating (tests + build + verify)
  - Runs `lerna publish from-package --yes` with the registry token
  - Verifies registry afterwards
  - Comments on the tag's commit with "✅ Published v0.X.Y" or rolls back on failure
- Local release flow becomes: `git tag v0.X.Y && git push --tags`. CI does the rest.
- Local `release.sh` stays as a fallback / documentation, but the canonical path is tag-driven.

**Tradeoffs**:
- Automation tokens are a credential to manage and rotate. Lower bar than 2FA OTP, but still worth treating with care (don't expose in PR logs, scope to publish-only if npm supports it).
- CI has its own brittleness (runner version drift, secret rotation, etc.) — but the failure mode is "tag didn't publish, retry CI" rather than "main is in a half-bumped state."

**Success criteria**:
- [ ] A release runs end-to-end from `git push --tags` with no human interaction.
- [ ] Half-published states are no longer possible (CI either commits the full set or nothing).
- [ ] Main no longer collects "mid-release commit"s.

## Phase 5: Drift detection (preventive)

**Goal**: catch the issues from Phase 1 before they're release-blocking, by surfacing them in regular `npm test` or pre-push hooks.

**Approach** (lower priority — Phases 1-4 cover most pain):
- A `scripts/audit-release-readiness.sh` that runs as part of `npm test:code` or as a pre-push hook:
  - Verify no private workspace declares `"@lumenize/*": "^0.X.Y"` (catch issue 9 regressions).
  - Verify every `experiments/*` listed in `workspaces` actually has a runnable test suite or is marked as documented-only.
  - Verify every `class_name` in `wrangler.jsonc` resolves to an export somewhere in the package's source.
  - Verify every `test/*.test.ts` re-exported by `test-worker-and-dos.ts` (or equivalent) actually exists.
- Similarly, a release runbook (`tasks/RELEASING.md`?) that lists the pre-flight checks the operator runs.

**Success criteria**:
- [ ] First-attempt release success rate trends to 100%.

## Open questions

- **CI secret-management strategy** — the token rotation discipline is a real cost. Is it worth the lift, or is the OTP race tolerable? My read: with 9 packages today and growing to 12+, the race gets worse not better. CI is right.
- **What about Nebula's release flow?** That's [tasks/nebula-release-process.md](tasks/nebula-release-process.md) — distinct task, but the CI work in Phase 4 here would benefit Nebula's deploy flow too. Coordinate when Phase 4 is sized.
- **Do we want to drop lerna entirely?** Lerna's `version` step (with its `npm install --package-lock-only` side effect) was the primary trip-hazard in v0.25. We use lerna for two things: synchronized version bumping and `publish from-package`. Both are doable in plain shell + `npm version` + `npm publish` loops. Consider as Phase 4 prerequisite.

## Notes

- The v0.25 release transcript is the canonical "what hurt" reference for sizing this work — concrete examples for every phase.
- Memory entry: see "Active: parse-validate release publish" for the v0.25 release status. Once the post-release work (deprecate, blog publish) lands, this task file becomes the next active release-process work item.
