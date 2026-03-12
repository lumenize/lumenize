# Phase 5.2.1.1: Wrangler & Toolchain Upgrade

**Status**: Pending
**Package**: Monorepo-wide
**Depends on**: None
**Parent**: `tasks/nebula-5.2-tsc-validation.md`

## Goal

Upgrade `wrangler`, `@cloudflare/vitest-pool-workers`, and `compatibility_date` across the monorepo. This is standalone infrastructure work that benefits all packages and is a prerequisite for DWL-based testing (Phase 5.2.1.2) and `toTypeScript()` (Phase 5.2.1).

## Why

- The lockfile has wrangler `4.44.0` installed despite `^4.66.0` in package.json — 6+ months stale.
- `compatibility_date` is `"2025-09-12"` everywhere — also 6+ months behind.
- DWL (Dynamic Worker Loader) requires a current wrangler to function correctly.
- `@cloudflare/vitest-pool-workers` `0.9.14` → latest may include DWL improvements and bug fixes needed for Phase 5.2.1.2.

## Steps

### Step 0: Baseline the existing test suite

Run `npm test` from the monorepo root (which runs `scripts/test-code.sh` then `scripts/test-doc.sh`, auto-discovering all `packages/*/` and `apps/*/` with test scripts). If any tests fail, re-run once — a few tests that hit external services (deployed test endpoints, e2e email tests via the email worker) can be flaky on cold start but reliably pass on the second run.

**HARD STOP**: If any tests are still failing after the re-run, fix them before proceeding. The baseline must be green — otherwise you can't distinguish pre-existing failures from upgrade regressions in Step 5.

### Step 1: Bump dependency versions

Update `devDependencies` in every `packages/*/package.json` and `apps/*/package.json`:

| Package | Current spec | Current installed | Target |
|---|---|---|---|
| `wrangler` | `^4.66.0` | `4.44.0` (stale lockfile) | Latest `^4.x` |
| `@cloudflare/vitest-pool-workers` | `^0.9.3` | `0.9.14` | Latest |
| `vitest` | `3.2.4` | `3.2.4` | No change (unless pool-workers requires it) |
| `@vitest/coverage-istanbul` | `3.2.4` | `3.2.4` | No change |
| `@vitest/browser` | `^3.2.4` | `3.2.4` | No change |

**Note**: The `@cloudflare/vitest-pool-workers` jump from `0.9.x` to latest may include breaking changes. Check the [changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-pool-workers/CHANGELOG.md) before upgrading and note any migration steps needed.

After editing, run `npm install` from the monorepo root to regenerate the lockfile.

### Step 2: Update compatibility_date

Set `compatibility_date` to today's date in every `wrangler.jsonc` across `packages/`, `apps/`, and `experiments/`. All currently use `"2025-09-12"`. Use the same date everywhere. If wrangler warns that the date is too recent, back off to the most recent date it accepts.

### Step 3: Regenerate types

Run `npm run types` from the monorepo root to regenerate `worker-configuration.d.ts` for all packages with wrangler.jsonc. This can go very deep because test/ folders and sub-folders of test/ can have their own wrangler.jsonc.

### Step 4: Update CLAUDE.md

Update the `compatibility_date` reference in CLAUDE.md to reflect the new minimum.

### Step 5: Run the full test suite

Run `npm test` from the monorepo root. Any failures are upgrade regressions — fix them before proceeding. As in Step 0, re-run once if external-service tests (e2e email, deployed test endpoints) fail on cold start.

### Step 6: Prompt the Human to Commit

Prompt the human to commit as a standalone change so it's reviewable independent of subsequent work.

## Success Criteria

- [ ] All `wrangler.jsonc` files use the same updated `compatibility_date`
- [ ] `wrangler` and `@cloudflare/vitest-pool-workers` are at latest versions in lockfile
- [ ] `npm run types` succeeds across all packages
- [ ] `npm test` passes with no new regressions vs. Step 0 baseline
- [ ] CLAUDE.md reflects updated `compatibility_date`
- [ ] Single clean commit with only upgrade changes
