# Nebula Release Hardening (post-pre-alpha) — ON HOLD

**Status**: **ON HOLD** — split out of [`../nebula-release-process.md`](../nebula-release-process.md) on
2026-06-23 (descoped for the pre-alpha milestone). These are the release-discipline pieces that **don't**
block inviting friends-and-family to a deployed app: registry-tarball reproducibility, CI automation, and
rollback. **Un-park trigger:** the **alpha** milestone (real-use publish path + data migration), where a
deploy must be reproducible and the manual laptop sequence is no longer acceptable. Master:
[`../nebula-pre-alpha.md`](../nebula-pre-alpha.md).

> **Why deferred (rationale, do not re-litigate for pre-alpha):** `apps/nebula` is `private` (never
> `npm publish`ed); `wrangler deploy` bundles its workspace `src/` directly — which is exactly what the
> tests exercise. So the "npm dist `.js` shape ≠ `.ts` source" divergence trap (which bit
> `ts-runtime-parser-validator`, a *built* package) does not apply to deploying Nebula from workspace
> symlinks. And CI buys nothing for a solo dev who `wrangler deploy`s from a laptop over WARP
> (`cf-container-deploy-proxy`) — the repo has no CI to build on. Both become real once there are external
> package consumers / real releases.

## Phase A — Reproducibility from npm (was Phase 4)

**Goal**: the deployed Nebula is built from registry tarballs, not workspace symlinks — so what we deploy
is the same bytes a fresh `npm install` would produce.

**Approach** (decide when un-parked):
- **Option A**: `npm pack` every `@lumenize/*` dependency, install Nebula in a temp dir from those tarballs,
  deploy from there.
- **Option B**: clean-clone the repo at the publish tag, `npm install --omit=dev --workspaces=false` (or
  `overrides` pinning), deploy from there.
- **Option C**: leave workspace links in dev; add a `prepublish-nebula` step that swaps `package.json` to
  registry refs, deploys, then restores (mirrors the existing `prepare-for-publish.sh` /
  `restore-dev-mode.sh` dance for packages).

**Success criteria**:
- [ ] Decision recorded with rationale (pinned).
- [ ] Chosen approach implemented; deploy from a clean checkout reproduces the deployed bundle byte-for-byte
  (or close — wrangler may stamp build IDs).

## Phase B — CI wiring & rollback (was Phase 5)

**Goal**: the manual deploy sequence becomes mechanical; a bad deploy can be backed out.

**Approach**:
- **CI container deploy** (the pre-alpha "first prod deploy" bullet's *"not just WARP-from-Mac"* rider —
  deferred here): a headless deploy path so a deploy doesn't depend on Larry's laptop + WARP. Pre-alpha
  uses laptop+WARP (`cf-container-deploy-proxy`); CI is the post-pre-alpha replacement.
- **Tag-driven**: pushing `nebula-vX.Y.Z` triggers `apps/nebula/scripts/deploy.sh`.
- **Or** a GitHub Actions workflow that runs after `release.sh` succeeds, gated on smoke tests against the
  freshly-deployed test worker.
- **Rollback**: `wrangler rollback` (CF supports it) + a script to redeploy from a prior tag's tarballs.
  Document the failure modes that trigger rollback (SHA mismatch in `/_version`, smoke red after deploy).

**Success criteria**: TBD; defer detailed planning until Phase A lands and the deploy flow CI automates is
known. (Note: the repo has **no CI** today — standing CI up is itself in scope here, not assumed.)

## Related
- [`../nebula-release-process.md`](../nebula-release-process.md) — the pre-alpha-scoped parent (SHA-stamp +
  `/_version` + `deploy.sh` + first-deploy readiness).
- Memory: `cf-container-deploy-proxy` (WARP fixes the laptop push; CI is the headless fallback).
