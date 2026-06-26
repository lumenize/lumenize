# Bring `apps/nebula` into the CI / cloud-test lanes

**Status**: DEFERRED — not started. Split out of the former `cloud-tests-email-and-nebula.md` (2026-06-26). **Do AFTER [`tasks/lumenize-email.md`](lumenize-email.md)** — it consumes that work. Per Larry: *"We'll start over with analysis/discussion when we get to expanding CI to nebula."* Treat the scope below as **captured notes, not a designed plan** — re-review/`/review-task` before building.

## Why deferred / separate
`apps/nebula` was deliberately excluded from CI (the loop is `packages/*` only). Including it is a bigger lift across Docker / `env.AI` / browser gating, and it depends on the email-send unification landing first so `nebula-auth`'s email tests stop needing the CF token (resolved by `tasks/lumenize-email.md`).

## Known scope (re-analyze when picked up)
`apps/nebula`'s `test` runs projects: `unit / frontend / baseline / container / dev-studio / browser`.
- **container** → needs Docker + CF Containers. Docker is pre-installed in Claude Code web (could run there); GitHub-Actions-for-CF-Containers is unverified. Per `container-no-construct-pool-workers`, `extends Container` can't construct under pool-workers — these may be `it.skip` / prototype-only; **verify what actually runs** (determines the Docker-in-CI need).
- **dev-studio** → needs `env.AI` (Workers AI binding = real CF account access). The live `chat()` turn is already `it.skip` (runs under `wrangler dev`). Decide: gate-on-`env.AI` vs keep skipped.
- **browser** → real Playwright/chromium (works in CI; pre-installed in Claude Code).
- **nebula-auth email** → **resolved** by `tasks/lumenize-email.md` (`NebulaEmailSender` composes the transport; gated by secret-presence like auth). No new CF-token concern from email once that lands.

## Open questions (carry over)
- Does the `container` project actually run anything under pool-workers, or is it all `it.skip` / prototype? (Determines Docker-in-CI need.)
- `apps/nebula` uses `CLOUDFLARE_API_TOKEN` in its **own** env (containers / deploy) — independent of the email canary; analyze that exposure separately when this is picked up.

## Related
- [`tasks/lumenize-email.md`](lumenize-email.md) — prerequisite (email-send unification + secret-presence gating).
- Memory `project_ci_cloud_tests` — the CI-green recipe.
- Memory `project_nebula_pre_alpha` — first CF deploy ~2026-06-30; this CI work is downstream of the deploy work, not a blocker for it.
