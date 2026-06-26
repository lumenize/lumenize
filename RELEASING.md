# Releasing

This monorepo has **two independent release vehicles**. They share no ordering — pick the one
that matches what you changed.

| You changed… | Run | What it does |
|---|---|---|
| An `@lumenize/*` **package** (the MIT/published libraries) | `npm run release` (root) | Lerna: synchronized version bump + `publish from-package` to npm. Repoints `package.json` from `src/` → `dist/`, builds, publishes, reverts. |
| **Nebula** (`apps/nebula`, the app) | `npm run deploy:nebula` (root) or `npm run deploy` (in `apps/nebula`) | `wrangler deploy` — bundles `apps/nebula/src/` + its workspace deps and pushes the Worker **and** the DevContainer image. |

## Package publish — `npm run release`

Lerna owns the published-package stream. `apps/nebula` is `private`, so Lerna **skips it
entirely** — `release.sh` never deploys Nebula. See `scripts/release.sh`.

## Nebula deploy — `npm run deploy:nebula`

A single repeatable command (`apps/nebula/scripts/deploy.sh`) that captures the **current
monorepo `src/`** — there is no publish-then-deploy ordering and no unpublished-local-dependency
trap: `wrangler` bundles workspace `@lumenize/*` deps from `src/`, so the deploy ships exactly
what the tests run. The script, in order:

1. **Computes the git SHA + dirty flag** first (before any build step touches the tree).
2. **Preflights** (refuses before building):
   - migrations / DO-class consistency (`scripts/audit-migrations.mjs`) — the DO-class registry is
     a one-way door once deployed.
   - the super-admin bootstrap secret (`NEBULA_AUTH_BOOTSTRAP_EMAIL`) is set (name-only check;
     never echoes a value).
3. **Builds the Studio SPA** (`vite build` → `apps/nebula-studio-ui/dist`) so the Workers-Assets
   upload sees it, and prints the resolved `AUTH_EMAIL_FROM` for an eyeball against the
   Cloudflare verified-senders list.
4. **`wrangler deploy`** with a `--define` build stamp (`__GIT_SHA__` / `__DIRTY__` /
   `__BUILD_TIME__`) — also builds + pushes the DevContainer image.
5. **Self-checks** the new build is live via `GET <prod>/_version?sha=<HEAD>` → `{ match: true }`.

### Prerequisites (pre-alpha)

- **Cloudflare WARP on** + **Docker Desktop running** — the container image build/push needs both
  (see the `cf-container-deploy-proxy` note). The headless/CI deploy is deferred.
- **First deploy only:** set the super-admin seed **before** the first `npm run deploy:nebula` —
  `wrangler secret put NEBULA_AUTH_BOOTSTRAP_EMAIL` (enter `larry@lumenize.com`). The preflight is a
  name-only check that the secret exists; `wrangler secret put` works against a not-yet-deployed
  worker, so set it first and the preflight passes.
- Override the self-check origin with `NEBULA_PROD_URL` if the deploy target isn't
  `https://nebula.lumenize.com` (e.g. a `*.workers.dev` subdomain).

### Bench test worker

The deployed benchmark worker (`nebula-browser-test`) is a **separate** deploy:
`npm run deploy:test-worker` (in `apps/nebula`) — same `--define` build stamp, its own
`--config`. The bench/throughput suites refuse to run against a stale deploy via the
`/_version` staleness guard in `test/browser/global-setup.ts`.

## Deferred (un-park at the **alpha** milestone)

Reproducibility-from-published-versions, CI deploys, and `wrangler rollback` →
`tasks/on-hold/nebula-release-hardening.md`.
