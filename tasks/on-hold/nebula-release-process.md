# Nebula Release Process

**Status**: On Hold — demo focus. Short-term mitigations are in place (bench files carry the "deploy first or you're measuring stale code" warning); Phases 1–5 (SHA-stamping, `/_version`, `deploy-nebula.sh` split) not started.

## Objective

Build a release process for Nebula that fits its actual nature — an **app** that gets `wrangler deploy`d, not a package that gets `npm publish`d — and that prevents the "tested locally, deployed something else" failure mode.

## Background

The repo's existing release flow (`scripts/release.sh` + Lerna `version` / `publish from-package`) treats every workspace as a publishable package: bump version, build to `dist/`, push to npm. Nebula is `private: true` so Lerna already skips its publish step, but that's the *only* way Nebula is acknowledged by the release flow. Its real release — `wrangler deploy` — happens (today) entirely outside the script.

Three concrete symptoms of the mismatch surfaced during the parse-validate release pre-flight (2026-04-30):

1. **`apps/nebula/test/browser/{transactions.bench.ts, throughput.benchmark.ts}`** target the deployed `nebula-browser-test.transformation.workers.dev` worker. There is no version-stamp on that worker and no check that it matches local `HEAD`. The benchmark numbers in `RESULTS.md` / `THROUGHPUT-RESULTS.md` could have been measured against any prior commit.
2. **Smoke tests** (`smoke.test.ts`) hit local `wrangler dev` for the code under test — fine — but the email-magic-link path bounces through deployed Email Routing → deployed `email-test` worker → WS callback. A drift between local Nebula (HEAD) and deployed `email-test` worker (whenever) is invisible until something changes the wire format.
3. **Deploy is manual.** `wrangler deploy` is run by hand, after-the-fact, with no enforced ordering against package publishes Nebula consumes (`@lumenize/nebula-auth`, `@lumenize/ts-runtime-parser-validator`, `@lumenize/mesh`, etc.). A deploy can be cut against a `package.json` that references package versions newer than what's actually live on npm.

The short-term fix landed alongside this task (2026-04-30): warning headers were added to the two `.bench` / `.benchmark` files reminding the operator to deploy first, and those files were moved off the default `npm test` path so they don't run unintentionally. That's a reader-visible reminder, not a guarantee.

## Goals

A robust process that answers, with no human discipline required:

- **Did the deployed Nebula match the local commit when bench/throughput were measured?**
- **Did the deployed Nebula's `package.json` resolve to the actual published `@lumenize/*` versions on npm, not workspace symlinks?**
- **Are package publishes and Nebula deploys ordered correctly?**
- **What's the rollback story?**

Non-goal: solving every monorepo "apps vs packages" pattern. Just Nebula and `email-test` for now; future apps inherit the pattern.

## Phase 1: Version-stamp deployed Workers

**Goal**: every deployed Worker exposes the git SHA it was built from, and tests can assert against it.

**Approach**:
- Use Wrangler's `define` (or `vars`) to inject `__GIT_SHA__` and `__BUILD_TIME__` at deploy time:
  ```
  wrangler deploy --define __GIT_SHA__:"\"$(git rev-parse HEAD)\"" --define __DIRTY__:"\"$([ -z \"$(git status --porcelain)\" ] && echo clean || echo dirty)\""
  ```
- Add a `/_version` (or RPC) endpoint to Nebula that returns `{ sha, dirty, buildTime, packageVersion }`.
- Same for `email-test` and the `nebula-browser-test` test worker.

**Success criteria**:
- [ ] `curl https://nebula-browser-test.transformation.workers.dev/_version` returns the SHA the Worker was built from
- [ ] `wrangler deploy` from a dirty tree marks the deploy `dirty: true` (signals "not reproducible")

## Phase 2: Pre-bench / pre-test deployment guard

**Goal**: bench and throughput tests refuse to run unless the deployed worker's SHA matches local `HEAD`.

**Approach**:
- Helper in `apps/nebula/test/browser/` (e.g. `assert-deployed-version.ts`) that fetches `/_version` from the configured base URL and compares to `git rev-parse HEAD`. Exits with a clear "deployed=A, local=B; run `npm run deploy:test-worker` first" if they differ.
- Wire into the bench and throughput entrypoints (or as a vitest `globalSetup` for the benchmark project).
- New script: `npm run deploy:test-worker` runs `wrangler deploy --name nebula-browser-test` with the SHA define from Phase 1. Bench README points users at it.

**Success criteria**:
- [ ] Running `npm run bench` against a stale deployment fails fast with a SHA-mismatch message
- [ ] Running `npm run deploy:test-worker && npm run bench` succeeds end-to-end
- [ ] The recorded numbers in `RESULTS.md` / `THROUGHPUT-RESULTS.md` cite the SHA they were measured against (small footnote)

## Phase 3: Separate the Nebula release from the package release

**Goal**: distinct, individually-runnable flows for "publish packages to npm" vs "deploy Nebula to Cloudflare".

**Approach**:
- Today: `scripts/release.sh` lerna-publishes every public package. Lerna already skips Nebula because it's `private`.
- Add: `scripts/deploy-nebula.sh` (or `apps/nebula/scripts/deploy.sh`) that:
  1. Verifies `package.json` references published `@lumenize/*` versions matching the just-published `lerna.json` version (or a passed-in tag).
  2. Reinstalls from the registry (not workspace symlinks) into a deploy staging dir, so what we deploy is the same bytes a fresh `npm install` would produce. (`npm pack` + extract, or a clean clone, or `--workspaces=false` install — pick the simplest that's bit-reproducible.)
  3. Runs `wrangler deploy` with the SHA define from Phase 1.
  4. Verifies `/_version` after deploy and rolls back if the response doesn't match what we just built.
- Document when to run each script in `tasks/nebula.md` (or a new top-level `RELEASING.md`).

**Success criteria**:
- [ ] `scripts/release.sh` only publishes packages; never deploys Nebula
- [ ] `scripts/deploy-nebula.sh` only deploys Nebula; refuses to run if `package.json` `@lumenize/*` versions are newer than what's on npm
- [ ] Post-deploy, `/_version` reports the expected SHA *and* the expected `packageVersion`

## Phase 4: Reproducibility from npm (not workspace)

**Goal**: the deployed Nebula is built from registry tarballs, not workspace symlinks. Otherwise we're testing "Nebula + workspace src", users would get "Nebula + npm dist" — same divergence trap that bit `ts-runtime-parser-validator` (compiled `.js` shape ≠ `.ts` source).

**Approach** (sketch, decide during Phase 3):
- Option A: `npm pack` every dependency, install Nebula in a temp dir from those tarballs, deploy from there.
- Option B: clean-clone the repo at the publish tag, run `npm install --omit=dev --workspaces=false` (or with `overrides` pinning), deploy from there.
- Option C: leave Nebula's workspace links in dev but add a `prepublish-nebula` step that swaps `package.json` to registry refs, deploys, then restores. (Mirrors the existing `prepare-for-publish.sh` / `restore-dev-mode.sh` dance for packages.)

**Success criteria**:
- [ ] Decision recorded with rationale in this task file (pinned decision)
- [ ] Chosen approach implemented; deploy from a clean checkout reproduces the deployed bundle byte-for-byte (or close to it — wrangler may stamp build IDs)

## Phase 5: CI wiring & rollback

**Goal**: the manual sequence becomes mechanical.

**Approach** — left open until Phases 1–4 land:
- Tag-driven: pushing `nebula-vX.Y.Z` triggers `deploy-nebula.sh`.
- Or: GitHub Actions workflow that runs after `release.sh` succeeds, gated on smoke tests passing against the freshly-deployed test worker.
- Rollback: `wrangler rollback` (CF supports it) plus a script to redeploy from a prior tag's tarballs. Document the failure modes that should trigger rollback (SHA mismatch in `/_version`, smoke red after deploy, etc.).

**Success criteria**: TBD; defer detailed planning until Phase 4 lands and we know what flow CI is automating.

## Open questions

- **Version-locking apps with packages** — `nebula-auth` (a package) currently version-locks with the rest via Lerna. Should Nebula (the app) version with packages, or have its own version stream? Both have arguments. Resolve before Phase 3.
- **What about `email-test`?** It's a deployed Worker too, currently in `packages/auth/test/e2e-email/`. Same staleness problem. Probably needs its own deploy script + version assertion. Could ride on Phase 1 / 2 for free.
- **Dirty-tree deploys** — block them, warn-and-allow, or stamp them as `dirty:true` in `/_version`? Current draft says stamp, not block. Revisit.
- **Future apps in `apps/`** — assume the Nebula pattern generalizes. If we add another app and the assumptions break, refactor then.

## Notes

- Short-term mitigation already in place (2026-04-30): warning headers in both `.bench` / `.benchmark` files, plus they run on demand only (`npm run bench`, `npm run test:throughput`), not in `npm test`. This task supersedes those mitigations once Phase 2 lands.
- Memory entry referencing the deployed test worker subdomain and configured secrets lives in `MEMORY.md` under "Active: parse-validate release publish" — keep that in sync if the test worker name or config changes.
