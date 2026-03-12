# Phase 5.2.1.1: Wrangler & Toolchain Upgrade

**Status**: In Progress
**Package**: Monorepo-wide (`packages/` and `apps/` only — `experiments/` excluded)
**Depends on**: None
**Parent**: `tasks/nebula-5.2-tsc-validation.md`

## Goal

Upgrade `wrangler`, `@cloudflare/vitest-pool-workers`, and `compatibility_date` across the monorepo. This is standalone infrastructure work that benefits all packages and is a prerequisite for DWL-based testing (Phase 5.2.1.2) and `toTypeScript()` (Phase 5.2.1).

## Why

- The lockfile has wrangler `4.44.0` installed despite `^4.66.0` in package.json — 6+ months stale.
- `compatibility_date` is `"2025-09-12"` everywhere — also 6+ months behind.
- DWL (Dynamic Worker Loader) requires a current wrangler to function correctly.
- `@cloudflare/vitest-pool-workers` `0.9.14` → latest may include DWL improvements and bug fixes needed for Phase 5.2.1.2.

## Scope

**Included**: `packages/`, `apps/`
**Excluded**: `experiments/` — these are throwaway spikes with potentially broken dependencies. Not worth the churn.

## Completed Pre-Work

### Fix `generate-types.sh` to process all wrangler.jsonc files (DONE)

The original `scripts/generate-types.sh` skipped `test/` directories. This was a latent bug — packages like `nebula-auth`, `fetch`, and `testing` only have `wrangler.jsonc` inside `test/` and were never getting types regenerated. The mesh for-docs test apps also have their own wrangler configs.

**Fix applied**: Removed the test-directory skip. The script now processes every `wrangler.jsonc` under `packages/` and `apps/` (excluding `node_modules/` and `dist/`). Also removed `tooling` from the find path (only `packages` and `apps` are in scope).

**Result**: 22 wrangler.jsonc files processed (up from ~9). All tests still pass. Type-check errors in `nebula` app dropped from 7 to 3 (the newly generated types for `apps/nebula` now include JWT key bindings that were previously missing).

### Baseline test suite (DONE)

All tests green. Type-check has 3 packages with pre-existing errors (mesh: 8, nebula-auth: 10, nebula: 3) — all pre-existing, not blockers.

## Steps

### Step 1: Bump dependency versions

Check latest available versions:

```bash
npm info wrangler version
npm info @cloudflare/vitest-pool-workers version
```

Then update `devDependencies` in every `packages/*/package.json` and `apps/*/package.json`:

| Package | Current spec | Current installed | Target |
|---|---|---|---|
| `wrangler` | `^4.66.0` | `4.44.0` (stale lockfile) | Latest `^4.x` |
| `@cloudflare/vitest-pool-workers` | `^0.9.3` | `0.9.14` | Latest |
| `vitest` | `3.2.4` (pinned, except `packages/debug` uses `^3.2.4`) | `3.2.4` | Pin to same version everywhere (unless pool-workers requires a bump) |
| `@vitest/coverage-istanbul` | `3.2.4` | `3.2.4` | Keep in sync with vitest |
| `@vitest/browser` | `^3.2.4` | `3.2.4` | Pin to same version as vitest |

**Vitest pinning note**: Most packages pin vitest without `^` but `packages/debug` uses `^3.2.4`. Make all consistent — pin without `^`.

**Duplicate entries note**: Some `package.json` files list `@cloudflare/vitest-pool-workers` in both `devDependencies` and vitest project config. Update all occurrences.

**Note**: The `@cloudflare/vitest-pool-workers` jump from `0.9.x` to latest may include breaking changes. Check the [changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-pool-workers/CHANGELOG.md) before upgrading and note any migration steps needed.

After editing, run `npm install` from the monorepo root to regenerate the lockfile.

### Step 2: Update compatibility_date

Set `compatibility_date` to today's date in every `wrangler.jsonc` under `packages/` and `apps/`, **including nested test directories**. Several packages have `wrangler.jsonc` only inside `test/` (not at the package root):

- `packages/nebula-auth/test/wrangler.jsonc`
- `packages/fetch/test/wrangler.jsonc`
- `packages/testing/test/integration/wrangler.jsonc`
- `packages/auth/test/e2e-email/wrangler.jsonc`
- `packages/auth/test/hono/wrangler.jsonc`
- `packages/mesh/test/for-docs/*/wrangler.jsonc` and `packages/mesh/test/for-docs/*/test/wrangler.jsonc`
- `apps/nebula/test/test-apps/baseline/test/wrangler.jsonc`

Use the same date everywhere. If wrangler warns that the date is too recent, back off to the most recent date it accepts.

**Verify** no files were missed:

```bash
grep -r '"compatibility_date"' packages/ apps/ --include='wrangler.jsonc' | grep -v node_modules
```

All lines should show the new date.

### Step 3: Regenerate types

Run `npm run types` from the monorepo root to regenerate `worker-configuration.d.ts` for all 22 wrangler.jsonc files under `packages/` and `apps/`.

### Step 3.5: Type-check

Run `npm run type-check` to catch type errors early before the full test suite. Compare against baseline (mesh: 8, nebula-auth: 10, nebula: 3 pre-existing errors). Any new errors are regressions.

### Step 4: Update CLAUDE.md

Update the `compatibility_date` reference in CLAUDE.md to reflect the new minimum.

### Step 5: Run the full test suite

Run `npm test` from the monorepo root. Any failures are upgrade regressions — fix them before proceeding. As in baseline, re-run `npm test` in full if external-service tests (e2e email, deployed test endpoints) fail on cold start.

### Step 6: Commit (wrangler/vitest/compatibility_date)

Do NOT commit automatically. Ask the user to review and commit as a standalone change so it's reviewable independent of subsequent work.

### Step 7: Bump all other dependencies

Separate commit from Step 6 for bisectability.

```bash
npx npm-check-updates -u --reject 'wrangler,@cloudflare/vitest-pool-workers,vitest,@vitest/*' --deep
```

Scope to `packages/` and `apps/` only. Then:

1. `npm install` to regenerate lockfile
2. `npm run types` to regenerate types
3. `npm run type-check` — compare against baseline
4. `npm test` — full run, re-run if flaky external-service tests

### Step 8: Commit (all other dependencies)

Do NOT commit automatically. Ask the user to review and commit separately from Step 6.

## Success Criteria

### Commit 1: Wrangler & vitest upgrade
- [x] `scripts/generate-types.sh` processes all wrangler.jsonc (including test directories)
- [x] Baseline: all tests green, pre-existing type errors documented
- [ ] All `wrangler.jsonc` files in `packages/` and `apps/` use the same updated `compatibility_date`
- [ ] `wrangler` and `@cloudflare/vitest-pool-workers` are at latest versions in lockfile
- [ ] `vitest` version is pinned consistently (no `^`) across all packages
- [ ] `npm run types` succeeds across all packages
- [ ] `npm run type-check` passes with no new errors vs. baseline
- [ ] `npm test` passes with no new regressions vs. baseline
- [ ] CLAUDE.md reflects updated `compatibility_date`

### Commit 2: All other dependencies
- [ ] All non-wrangler/vitest dependencies bumped to latest
- [ ] `npm run types` succeeds
- [ ] `npm run type-check` passes with no new errors vs. baseline
- [ ] `npm test` passes with no new regressions
