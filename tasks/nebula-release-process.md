# Nebula Release Process

**Status**: Wave 1 of [`nebula-pre-alpha.md`](nebula-pre-alpha.md) — **not started; descoped + merged 2026-06-23, ready for `/review-task`.** This is now **the first-prod-deploy task** (the pre-alpha "first prod deploy" bullet folded in as Phase 0) AND the reusable deploy/release process. **Scoped to Phases 0–3** for pre-alpha (first-deploy readiness + SHA-stamp/`/_version` + `deploy.sh`); the heavier release-discipline pieces (registry-tarball reproducibility, CI, rollback) are **deferred to [`on-hold/nebula-release-hardening.md`](on-hold/nebula-release-hardening.md)**. Short-term mitigations are in place (bench files carry the "deploy first or you're measuring stale code" warning).

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

## Phase 0: First-deploy readiness (merged from the pre-alpha "first prod deploy" bullet)

**Goal**: the one-time things that must be true before `apps/nebula` can serve ~5 external pre-alpha users
on a real Cloudflare deploy. (These ride the deploy machinery in Phases 1/3; the recurring deploy itself is
Phase 3.)

**Approach**:
- **`migrations` block** in `apps/nebula/wrangler.jsonc` — registers every DO class with
  `new_sqlite_classes` (NOT `new_classes`). **This is a one-way door**: the first prod deploy freezes
  DO-class add/rename/delete into a migration-forever commitment (`.claude/rules/durable-objects.md` § DO
  class registration). Enumerate every DO class shipped (Universe/Galaxy/Star/Resources/Subscriptions/DagTree/
  NebulaContainer/DevContainer/DevStudio/…) before cutting it.
- **Super-admin seed** — set `NEBULA_AUTH_BOOTSTRAP_EMAIL=larry@lumenize.com` as a deployed Worker secret
  (`wrangler secret put`, never committed). The deploy script (Phase 3) confirms it's set.
- **Concurrency sanity** for ~5 external users (no per-tenant limits tripped; DO/Gateway defaults fine — a
  confirm, not a build).
- **DevStudio source-of-truth durability** — confirm the shell `Workspace` (git over `ctx.storage.sql`)
  survives a real deploy + DO restart (it's the dev-user's app source; losing it loses their work).
- Deploy is **laptop + WARP** for pre-alpha (`cf-container-deploy-proxy`); the headless/CI deploy is
  deferred → `on-hold/nebula-release-hardening.md`.

**Success criteria**:
- [ ] `apps/nebula/wrangler.jsonc` has a `migrations` block with all DO classes under `new_sqlite_classes`; the class list is enumerated in this file (pinned) before first deploy.
- [ ] First prod deploy succeeds from laptop+WARP; super-admin can log in at the reserved `nebula-platform` instance with the seeded email.
- [ ] The codegen loop's live `it.skip`s (which need `wrangler dev` + Docker today) are validated against the deploy.
- [ ] DevStudio Workspace source survives a redeploy (a generated app's source is still there after).

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

## Phase 2: Pre-bench / pre-test deployment guard *(optional for pre-alpha)*

**Pre-alpha call (unresolved — decide at `/review-task` or build):** this guards *benchmark integrity*, which
isn't F&F-blocking (we're not benchmarking for pre-alpha users). It's **cheap once Phase 1 exists** (a small
helper reusing `/_version`), so include it if quick, else defer with the rest of the bench hygiene. Not a
gate either way.

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
- **PINNED (2026-06-23): all logic lives in `apps/nebula/scripts/deploy.sh`.** Two thin wrappers invoke it:
  the root `package.json` exposes `npm run deploy:nebula`; `apps/nebula/package.json` exposes `npm run deploy`
  (local, unprefixed). The script:
  1. Confirms the super-admin secret is set (`NEBULA_AUTH_BOOTSTRAP_EMAIL`, Phase 0) — refuse otherwise.
  2. Runs `wrangler deploy` with the SHA/dirty define from Phase 1.
  3. Verifies `/_version` after deploy and surfaces a mismatch (the SHA we just built ≠ what's live).
  - *(Registry-tarball reinstall + version-match-against-npm + auto-rollback are deferred → `on-hold/nebula-release-hardening.md`. For pre-alpha, `apps/nebula` is `private` and `wrangler deploy` bundles workspace `src/` directly — which is what the tests run — so a workspace-symlink deploy is correct, not the divergence trap.)*
- Document when to run each script in a new top-level `RELEASING.md`.

**Success criteria**:
- [ ] `scripts/release.sh` only publishes packages; never deploys Nebula.
- [ ] `apps/nebula/scripts/deploy.sh` holds the deploy logic; `npm run deploy:nebula` (root) and `npm run deploy` (apps/nebula) both invoke it.
- [ ] Post-deploy, `/_version` reports the expected SHA *and* the expected `packageVersion`.

## Deferred (post-pre-alpha) → `on-hold/nebula-release-hardening.md`

The heavier release-discipline pieces are **out of scope for pre-alpha** and split to
[`on-hold/nebula-release-hardening.md`](on-hold/nebula-release-hardening.md) (un-park at the **alpha**
milestone): **Phase A — reproducibility from npm** (deploy from registry tarballs vs workspace symlinks —
doesn't apply while `apps/nebula` is `private` and `wrangler` bundles `src/`); **Phase B — CI wiring +
rollback** (incl. the headless/CI container deploy that replaces laptop+WARP; the repo has no CI today).

## Open questions

- **Version-locking apps with packages** — `nebula-auth` (a package) currently version-locks with the rest via Lerna. Should Nebula (the app) version with packages, or have its own version stream? Both have arguments. Resolve before Phase 3.
- **What about `email-test`?** It's a deployed Worker too, currently in `packages/auth/test/e2e-email/`. Same staleness problem. Probably needs its own deploy script + version assertion. Could ride on Phase 1 / 2 for free.
- **Dirty-tree deploys** — block them, warn-and-allow, or stamp them as `dirty:true` in `/_version`? Current draft says stamp, not block. Revisit.
- **Future apps in `apps/`** — assume the Nebula pattern generalizes. If we add another app and the assumptions break, refactor then.

## Notes

- Short-term mitigation already in place (2026-04-30): warning headers in both `.bench` / `.benchmark` files, plus they run on demand only (`npm run bench`, `npm run test:throughput`), not in `npm test`. This task supersedes those mitigations once Phase 2 lands.
- Memory entry referencing the deployed test worker subdomain and configured secrets lives in `MEMORY.md` under "Active: parse-validate release publish" — keep that in sync if the test worker name or config changes.
