# Bring `apps/nebula` into the CI / cloud-test lanes

**Status**: DEFERRED — not started. Split out of the former `cloud-tests-email-and-nebula.md` (2026-06-26). **Do AFTER [`tasks/lumenize-email.md`](archive/lumenize-email.md)** (✅ DONE + archived 2026-06-26) — it consumes that work. Per Larry: *"We'll start over with analysis/discussion when we get to expanding CI to nebula."* Treat the scope below as **captured notes, not a designed plan** — re-review/`/review-task` before building.

**NEXT (Larry, 2026-06-26) — gate cleared, ready to design.** The hosted-sandbox enablement merged (`17d1858`, pushed) and the **Claude hosted lane has now LEAPFROGGED GHA** — it runs even the container-dependent + real-email tests (Docker is present in the hosted sandbox). The plan: **(A) get GHA to catch up** (real containers in CI), **then (B) make `apps/*` testable in BOTH GHA + the hosted env.** Refinements to carry into design:
- **(A) and (B) overlap — treat as one effort, not two clean phases.** The real-container tests largely live in `apps/nebula` (the `container` / `ui-smoke` lanes) + the one skipped mesh `#1a`, so "GHA catch up on containers" ≈ "the apps container lane runs in CI."
- **Spike first.** CF Containers under `wrangler dev` on a **headless GHA runner** is the open unknown — the hosted sandbox proves Docker-based containers run there, but a GHA runner is unverified. Spike that before choosing path **(2)** (run `wrangler dev`+Docker on the runner) vs **(1)** (the deployed-e2e `#1a`).
- **Entry point:** `/review-task tasks/nebula-in-ci.md`, then build. (Almost certainly a fresh session — this one carried the whole email/CI/hosted-lane arc.)

## Why deferred / separate
`apps/nebula` was deliberately excluded from CI (the loop is `packages/*` only). Including it is a bigger lift across Docker / `env.AI` / browser gating, and it depends on the email-send unification landing first so `nebula-auth`'s email tests stop needing the CF token (resolved by `tasks/lumenize-email.md`).

## Known scope (re-analyze when picked up)
`apps/nebula`'s `test` runs projects: `unit / frontend / baseline / container / dev-studio / browser`.
- **container** → needs Docker + CF Containers. **CONFIRMED 2026-06-26: no real container runs in CI today.** `extends Container` can't construct under pool-workers (proven by `packages/mesh/test/container/precheck.test.ts`), so CI's container tests are prototype/precheck/seam-logic + the one real-container assertion is `it.skip`'d (`container-seam.test.ts:138`, *"deployed e2e, #1a"*); apps/nebula's `container-node` tests are prototype-only AND not in CI (`--scope packages`). A **real** container runs ONLY via `wrangler dev` + Docker — `scripts/dev-studio.sh` / the `ui-smoke` lane — both **manual**, in neither `npm test` nor CI. **Docker IS present on GHA `ubuntu-latest` AND in the Claude hosted sandbox — just never invoked.** Two paths to real-container CI: **(1)** the **#1a deployed e2e** (deploy Worker+Container, hit it like the email/fetch e2e), or **(2)** run `wrangler dev` + Docker on the runner (the `ui-smoke` lane) — CF-Containers-under-`wrangler dev`-on-a-CI-runner is still **UNVERIFIED**.
- **dev-studio** → needs `env.AI` (Workers AI binding = real CF account access). The live `chat()` turn is already `it.skip` (runs under `wrangler dev`). Decide: gate-on-`env.AI` vs keep skipped.
- **browser** → real Playwright/chromium (works in CI; pre-installed in Claude Code).
- **nebula-auth email** → **resolved** by `tasks/lumenize-email.md` (`NebulaEmailSender` composes the transport; gated by secret-presence like auth). No new CF-token concern from email once that lands.

## Open questions (carry over)
- ~~Does the `container` project run real containers under pool-workers?~~ **ANSWERED 2026-06-26: no — prototype/skip only (see the container bullet). Real-container CI needs the Docker work, which is the NEXT slice above.**
- `apps/nebula` uses `CLOUDFLARE_API_TOKEN` in its **own** env (containers / deploy) — independent of the email canary; analyze that exposure separately when this is picked up.

## Related
- [`tasks/lumenize-email.md`](archive/lumenize-email.md) — prerequisite, ✅ DONE 2026-06-26 (email-send unification + secret-presence gating).
- Memory `project_ci_cloud_tests` — the CI-green recipe.
- Memory `project_nebula_pre_alpha` — first CF deploy ~2026-06-30; this CI work is downstream of the deploy work, not a blocker for it.
