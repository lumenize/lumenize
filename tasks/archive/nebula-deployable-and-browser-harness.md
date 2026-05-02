# Nebula: Deployable + Browser Test Harness

**Status**: Complete 2026-04-28. Archived.
**Outcome**: Phase 1 (boot crash) and Phase 2 (browser harness) both shipped on `feat/nebula-resources`. Phase 3 (Lumenize Mesh retrofit) marked won't-do for now — file backlog item if it becomes worth doing later.
**Unblocks**: `tasks/parse-validate-release.md` Phase 1 (integrated bench), `tasks/nebula-5.3-subscriptions.md` (reactivity tests), production deployment of Nebula (no longer blocked by the boot crash).

## Closing summary

### Phase 1 — boot crash diagnosis and fix

**Root cause identified and fixed.** Bundled `typescript` (inside `@lumenize/ts-runtime-parser-validator/dist/deps.bundle.mjs`) runs `process.argv.slice(2)` at module-init. Workers' `nodejs_compat_v2` polyfill defines `process` but does NOT populate `argv`. The old shim in `scripts/stubs/globals.mjs` was `typeof process !== 'undefined' ? process : { ...fallback... }` — trusting the partial polyfill whole, so `process.argv.slice(...)` blew up on `undefined.slice`.

Vitest-pool-workers' miniflare hides the bug because it passes Node's real `process` (which has `argv`) through. The diagnosis route was an isolated minimal repro at `experiments/nebula-boot-repro/` — bisecting deps one import at a time isolated `@lumenize/ts-runtime-parser-validator` as the offender, then dumping the bundle (`wrangler deploy --dry-run --outdir`) found the offending pattern at column 1003.

**Fix**: defensive merge in `packages/ts-runtime-parser-validator/scripts/stubs/globals.mjs`. Each field of the shimmed `process` is now sourced from the real `process` if present and well-formed, falling back to a sane default otherwise. Added `postinstall: "node scripts/bundle-dependencies.mjs"` so fresh clones / CI rebuild the bundle automatically.

**Side effects**:
- Mono-repo wrangler bumped to `^4.86.0` (and `@cloudflare/vitest-pool-workers` to `^0.15.1` to release wrangler from its `4.84.1` exact pin).
- Confirmed `wrangler deploy --dry-run` succeeds with the same Worker — Nebula is now genuinely deployable.

### Phase 2 — browser-driven test harness

**Deviation from the original plan**: dropped vitest-browser/Playwright. Replaced with a plain vitest-node project that uses `@lumenize/testing`'s `Browser` class for cookie-aware fetch + CORS + redirects. Reasons:

1. `vitest-browser` runs tests inside an iframe served from vitest's origin; cross-origin cookies and CORS against wrangler-dev are awkward to thread through the iframe.
2. `Browser` is already battle-tested in `packages/auth/test/e2e-email/` and solves exactly these problems in pure Node.
3. Real-Chromium tests can be added later (separate task) if UI-rendering behavior ever needs verification.

`apps/nebula/test/browser/` now contains:
- `global-setup.ts` — auto-spawns `wrangler dev` over HTTPS (`--local-protocol https`, NODE_TLS_REJECT_UNAUTHORIZED=0 for the self-signed cert), picks a free port, exposes `wranglerBaseUrl` and `emailTestToken` via `project.provide()`, tears down on test complete.
- `auth-bootstrap.ts` — real magic-link e2e helper. Triggers `/auth/<scope>/email-magic-link`, waits for the email via WebSocket from the deployed `email-test` Worker (port of `packages/auth/test/e2e-email/email-test-helpers.ts`), follows the magic-link, captures the refresh cookie. NO test mode bypass.
- `smoke.test.ts` — three discrete `it` blocks: (1) boot non-5xx (regression test for the deps-bundle crash), (2) magic-link → cookie → JWT mint, (3) full NebulaClient round-trip — register ontology version on Galaxy, fire transaction on Star, assert success.
- `worker/index.ts` + `worker/wrangler.jsonc` — Nebula Worker with all DO bindings, including the `send_email` binding (`EMAIL`, `remote: true`) so wrangler-dev proxies to real Cloudflare Email Sending. Includes a test-only `TestNebulaEmailSender` subclass that overrides `from` to `test@lumenize.io` (the production `auth@nebula.lumenize.com` isn't a verified Cloudflare Email Sending sender).

**End-to-end timing**: all three smoke tests in ~10.6s on a developer machine. Real magic-link round-trip via Cloudflare Email Sending → Email Routing → WebSocket pushback completes in ~3.5s alone — much faster than expected.

**TEST_MODE leak audit + CI gate**: in the course of building the harness, I almost shipped a leak by passing `--var NEBULA_AUTH_TEST_MODE:true` to wrangler-dev from `global-setup.ts`. Caught by the user. Encoded the catch automatically: `scripts/audit-test-mode.sh` now fails CI if `*_TEST_MODE` appears in any wrangler config, npm script, shell script, CI workflow, or `.dev.vars` file. Wired into `npm run audit:test-mode`, `scripts/test-code.sh` (pre-test gate), `scripts/prepare-for-publish.sh` (pre-publish gate), and `.github/workflows/ci.yml`.

### Phase 3 — won't-do for now

The auto-spawn pattern is straightforward enough that retrofitting `packages/mesh/` is a small amount of work whenever a mesh test actually needs it (most don't — vitest-pool-workers' in-process miniflare is faster). Not worth doing speculatively. If a mesh test surfaces a need for honest wall-clock timing or out-of-process browser fidelity, copy this task's harness pattern and adjust.

## Commits on `feat/nebula-resources` for this task

1. `202afb3` Merge main (60+ conflicts, picks up the Cloudflare email migration)
2. `ffbe569` Post-merge alignment (versions 0.23.0 → 0.24.0, regenerated worker-configuration.d.ts, restored harness scaffolding)
3. `3f77ae7` Bump wrangler / vitest-pool-workers
4. `10475b7` **Fix the boot crash** (defensive process shim in `globals.mjs`)
5. `f76a0b4` Postinstall hook to rebuild deps bundle
6. `bb07e31` Refactor harness to `@lumenize/testing` Browser
7. `071c8ba` TEST_MODE leak audit script + CI gate
8. `5fb6e3e` Real magic-link e2e auth bootstrap
9. `250b5ec` `@lumenize/nebula/client` Node-safe entry point + full round-trip smoke test

## Backlog items spawned

- **Surface email-send failures in NebulaAuth/LumenizeAuth instead of swallowing** — `tasks/nebula-scratchpad.md` § Auth Related. Failures during `await sendEmail()` are caught and only logged via debug; client gets `200 OK` with no email actually sent. Took multiple iterations to debug in this session because the symptom was just "no email arrived".
- **Upgrade `@lumenize/testing`'s `websocket-shim`** to use a real WS client + Browser cookie jar (today the shim relies on the Cloudflare Workers / miniflare convention where a fetch response carries a `webSocket` property — undici doesn't). `tasks/backlog.md` § Testing & Quality.
- **Promote `waitForEmail` / `extractMagicLink` helpers** to a shared package once a third consumer needs them. Currently duplicated across `packages/auth/test/e2e-email/email-test-helpers.ts` and `apps/nebula/test/browser/auth-bootstrap.ts`. `tasks/backlog.md` § Testing & Quality.

## Original Phase 1 / Phase 2 detail (preserved for reference)

(The original task body is preserved below for traceability — what we knew, what we tried, and what shipped.)

---

## Why this exists (original)

Two coupled concerns surfaced together:

1. **Nebula doesn't start under real `wrangler dev`.** Importing any one of `@lumenize/nebula`'s DO classes (even just `Universe`) into a Worker that runs under `wrangler dev` crashes at module-load with `Cannot read properties of undefined (reading 'slice')`. Vitest-pool-workers' miniflare hides the bug because it has different env-initialization timing. **Implication**: Nebula has never been deployed to production, and currently *cannot* be deployed via standard `wrangler deploy` either (deploy bundles the same way dev does). This is a production-blocking bug, not a test-only quirk.

2. **There is no Node/browser-driven test platform for NebulaClient end-to-end.** All existing Nebula tests run inside vitest-pool-workers, where `performance.now()` is pinned by Cloudflare's Worker isolate semantics — honest wall-clock timing is impossible. Worse, NebulaClient itself is meant to run in a real browser (it uses `sessionStorage`, `BroadcastChannel`, native `WebSocket`), and we've never exercised it in that environment. The `@lumenize/mesh/client` Node-compatible entry point exists but is currently unproven.

These solve together because the harness needs `wrangler dev` to work, and `wrangler dev` working unblocks deploy.

## Phase 1: Diagnose and fix the `wrangler dev` startup bug — DONE

(Resolved as documented in the closing summary above.)

## Phase 2: Vitest browser harness with auto-spawn `wrangler dev` — DONE

(Shipped as documented in the closing summary above. Used `@lumenize/testing`'s `Browser` instead of vitest-browser/Playwright.)

## Phase 3: retrofit the auto-spawn pattern to Lumenize Mesh — won't do

Trivial to copy the pattern when a mesh test actually needs it. Not worth doing speculatively.
