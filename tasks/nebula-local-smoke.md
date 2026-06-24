# Local UI Smoke + `it.skip` Cleanup (a `wrangler dev` + Docker e2e lane)

**Status**: Wave 1 **Task ②** of [`nebula-pre-alpha.md`](nebula-pre-alpha.md) — **not started; ready for
`/review-task`.** ① (single-origin serving, model A) is ✅ done + archived; ③ (the deploy task,
[`nebula-release-process.md`](nebula-release-process.md)) follows. This task stands up the **first real
UI-level test of the Studio** (Playwright drives the rendered Studio under the model-A dev setup) and
**relocates the deterministic codegen/Container `it.skip`s** into a lane where they actually run — both riding
one shared `wrangler dev`(+Docker) harness.

## Objective

Two deliverables sharing one harness:
1. **A UI-level smoke (primary)** — Playwright drives the **rendered Studio** (vite `:5174` → proxy → `wrangler dev`
   `:8787` + Docker DevContainer, the proven model-A setup): log in via the **real email magic-link loop** (never
   test-mode — so the *same suite runs identically local + prod*), assert the Studio shell renders, and (richer)
   drive one chat turn → assert the preview updates. This is the confidence check that the Studio actually works
   end-to-end **before F&F invites** — the layer above ①'s routing test and the existing *API-level*
   `smoke.test.ts`.
2. **`it.skip` relocation (secondary — rides the same harness)** — move the **deterministic**
   codegen/Container `it.skip`s out of the pool-workers projects (where they can't run) into the
   `wrangler dev`(+Docker) lane as `it.runIf(<gate>)`, so they execute when the env is present.

## Background

- **Model A is settled** (①): the Studio SPA (`apps/nebula-studio-ui`, vite `:5174`) is same-origin with the
  `wrangler dev` Worker via the vite proxy; `npm run dev:studio` boots both. The Studio's own login/chat rides
  the `/gateway` mesh WS (`NebulaClient → NebulaClientGateway → DevStudio.chat`); the preview iframe rides
  `/dev-container`. Driving the *rendered* Studio is therefore a real end-to-end exercise of that stack.
- **What already exists (don't rebuild):** the **API-level** `smoke.test.ts` (the `browser` project, Node-side
  vitest vs auto-spawned `wrangler dev`) already does boot → **real magic-link** (via the deployed `email-test`
  Worker, all-Cloudflare ~1–3 s) → round-trip → **a `client.resources.transaction()` Resources hit**. So the
  "≥1 Resources hit" + "real magic-link loop exercised once" are **already covered at the API level** — Task ②
  adds the *UI* layer, it doesn't duplicate them.
- **The `it.skip`s** are env-gated, not broken — they need `env.AI` and/or a constructible `Container`, which
  vitest-pool-workers can't provide (`container-no-construct-pool-workers`); a real `wrangler dev` + Docker can.
- **Harness starting points:** the `chromium` project (`@vitest/browser-playwright` + the custom
  `dynamic-env-proxy` http-proxy plugin + `globalSetup` that spawns `wrangler dev`) and `testing.md`
  § Real-browser tests. **But** `chromium` today mounts *synthetic* components — driving the **real vite-served
  Studio** is the new bit, hence Phase 1 is exploratory.

## Phase 1: Stand up the `wrangler dev`(+Docker) UI harness — *(EXPLORATORY)*

**Goal**: a harness that boots the model-A Studio setup headlessly and lets a Playwright browser drive the
rendered Studio. Mechanism is empirical (like the §5.3.7 v4 WS-disconnect tooling) — discover it by running.

**Approach** (candidate, not pinned — the spike settles it):
- Boot, in `globalSetup`/fixtures: `wrangler dev` (API + DevContainer — needs **Docker Desktop**) **+** vite
  serving the **real** Studio, proxying `/auth /gateway /dev-container` → the Worker. The Studio's own vite proxy
  supplies same-origin, so the `chromium` project's `dynamic-env-proxy` may be unnecessary here — confirm.
  Playwright navigates to the vite URL.
- **Must not collide with — or corrupt — a manually-running `npm run dev:studio`.** The harness does *teardown*
  (`resetDevData`), so it must **never reuse a manual setup** — that would wipe the live dev session. Prefer:
  - **Dedicated/auto ports (run alongside, no kill):** boot the harness's `wrangler dev` + vite on **auto-assigned
    ports** (the existing `spawnWranglerDev` already auto-ports the Worker; thread `NEBULA_WORKER_URL` + a test
    vite port), so a manual `:8787/:5174` is untouched and the test runs beside it. *Phase-1 spike unknown:* two
    DevContainers in Docker at once (manual + test) — likely fine (different scope → different DO instance →
    different container; container ports go via `containerFetch`, not host-bound), but verify.
  - **Fallback — free the ports before boot, by PORT:** if dedicated ports prove fiddly (vite `strictPort`,
    Docker coexistence), in `globalSetup` do `lsof -ti:<port> | xargs kill` (**by port, never `pkill -f
    wrangler`** — that could kill an unrelated dev). At *setup* (not teardown), so it also reaps a crashed prior
    run's leftover processes.
- **PINNED: raw Playwright** (drive the live vite-served Studio), NOT `@vitest/browser` (which serves the test
  page from its *own* vite on a dynamic port → cross-origin to the Studio/Worker, breaking the `SameSite=Strict`
  cookie and needing a bridge). **No `dynamic-env-proxy` needed.** That plugin (in the `chromium` project) is a
  same-origin http-proxy that bridges vitest-browser's *dynamic-port* test page to the Worker onto one origin
  (and terminates the `wrangler dev --local-protocol https` self-signed cert) — but **here the Studio's own vite
  proxy already IS the same-origin bridge** (browser → `:5174` → proxy → Worker), and everything is plain
  `http://localhost` (no self-signed TLS). So the residual spike is only the **boot orchestration** (vite +
  `wrangler dev` + Docker in `globalSetup`) + the Docker-coexistence unknown above — the Playwright/proxy choice
  is settled.
- **Gating — AUTO-DETECT, no new config** (don't add things to configure). `it.runIf`/`describe.runIf` on
  **auto-probed** capabilities: `HAS_DOCKER` = a Docker daemon ping (e.g. `docker info` exits 0); `HAS_CF_CREDS` =
  the `CLOUDFLARE_*` creds already in `.dev.vars` are present. No new flag, no `HAS_*` env var the dev must set.
  Never a hard dependency in the default `npm test`; mirrors `describe.runIf(BENCH_BASE_URL)`.

**Deliverable (exploratory bar):** the harness boots + one trivial green check (Playwright loads the Studio
shell at `:5174`), **plus a findings note** capturing the mechanism that worked *and the alternatives that
failed* (harvest into a `reference_*` memory or `testing.md`).

**Success criteria**:
- [ ] `<lane> run` boots vite-Studio + `wrangler dev` + Docker and a Playwright test loads `http://localhost:5174`
  showing the Studio shell; skips cleanly (no failure) when Docker/creds are absent.
- [ ] A findings note records the working harness mechanism (+ the dead ends).

## Phase 2: The UI-level smoke (≤5 tests)

**Goal**: confirm the Studio works end-to-end through the UI.

**Design principle — the suite runs IDENTICALLY local + prod, so it must use the REAL email login, never
test-mode.** `NEBULA_AUTH_TEST_MODE` lives only in `.dev.vars` and never deploys, so the Studio's `?_test=true`
"Log in (dev)" button is **inert in prod** — a smoke that drives it can't run against a deployed Studio. The real
magic-link loop is environment-agnostic (`smoke.test.ts` already runs it under local `wrangler dev` via the
deployed `email-test` Worker, ~1–3 s). One test body, parameterized base URL (vite `:5174` local; a deployed URL
later).

**Approach**:
- **Login = the real email magic-link loop** (PINNED — not the test-mode button). **Default: orchestrate the
  login out-of-band** — reuse `smoke.test.ts`'s helpers (`bootstrapAdmin` / `waitForEmail` / `extractMagicLink`
  via the `email-test` Worker) to set the refresh cookie on the Studio origin, then Playwright drives the
  **authenticated** Studio. *(Open alternative: build a real login UI in the Studio — email field → "send magic
  link" → land authenticated — and have Playwright drive IT; that makes the login itself UI-tested but pulls the
  real-login-UI build up from ③. The out-of-band default is simpler + reuses existing helpers — lean that way.)*
- **Remove `NEBULA_AUTH_TEST_MODE` from `.dev.vars` (the rule-compliance fix this work enables — Larry's call).**
  Test-mode flags belong in vitest `miniflare.bindings`, never `.dev.vars` (`packaging.md`); it slipped into
  `.dev.vars` during the demo to power the in-body dev-login. Verified: `NEBULA_AUTH_TEST_MODE` uniquely provides
  only the **in-body magic link** (the `?_test=true` "Log in (dev)" button) — its Turnstile-skip is **redundant**
  (`checkTurnstile` also skips when `TURNSTILE_SECRET_KEY` is unset, `router.ts:283`). So once the Studio uses
  real-email login and we **drop the `?_test=true` dev-login button**, **remove `NEBULA_AUTH_TEST_MODE` from
  `.dev.vars`** (it stays in vitest `miniflare.bindings`, which is compliant); keep `TURNSTILE_SECRET_KEY` unset in
  dev (the no-secret skip carries the magic-link request). **CONFIRMED 2026-06-24 (Larry): drop the button.**
  Tradeoff accepted: manual dev login becomes ~1–3 s (email round-trip) instead of instant.
- **Minimal bar (must-have):** once authenticated, assert the Studio reaches `connected` (the `/gateway` WS
  established; chat input + "Describe the app…" appear) and the **key shell elements** render (chat pane +
  preview pane/iframe).
- **Richer (if cheap on the harness):** type a prompt → assert the **preview iframe updates** (the full
  chat → `DevStudio.chat` → codegen → `/dev-container` preview loop; needs Docker + `env.AI`).
- **Test state — clean up at the END (teardown).** Use a **pre-provisioned test universe/galaxy** for now (it +
  the test admin subject **persist** between runs); in an `afterAll`/`afterEach`, reset the **`.dev` data** via
  `Star.resetDevData()` (the Studio "Wipe" button's call; auth survives it). End-cleanup (not reset-before) is the
  right primary: vitest runs teardown reliably even when tests *fail* (only a process lockup skips it — rare), and
  a DO with leftover storage but no traffic **costs ~nothing**, so a stray orphan from the rare lockup is harmless.
  `ctx.deleteAll()` is the zero-it-completely tool for a disposable scope (the random-scope model below). Use a
  **dedicated `--test--`-prefixed scope** — e.g. `--test--u0.--test--g0.dev`, **not** Larry's manual `acme.app.dev`
  — so the smoke never collides with (or wipes) a manual session, and the prefix is the future reaper's auto-reap
  marker. This needs the **Studio scope to be configurable** (it's hardcoded to `acme.app.dev` in `App.vue`; make
  it a config/env/query input — needed anyway for scope-parameterization + the prod test scope). *Caveat: the
  `--test--` prefix must pass slug validation (a leading `--` may be rejected — pick a valid reserved form).*
- Keep it ≤5 focused tests.

**Success criteria**:
- [ ] The smoke logs in via the **real email loop** (no test-mode), and the **same test body** is structured to
  run against both a local (`:5174`) and a deployed base URL (the prod run itself lands when ③ serves the Studio).
- [ ] Authenticated-shell-renders smoke passes under the harness (capable-of-failing: it reds if the Studio shell
  fails to render or the `/gateway` connect never completes).
- [ ] If included, the prompt → preview-updates test passes (gated on Docker + `env.AI`).

## Phase 3: Relocate the deterministic `it.skip`s into the lane *(secondary)*

**Goal**: the env-gated codegen/Container `it.skip`s run (as `it.runIf`) instead of being perpetually skipped.

**Approach**: relocate these from their pool-workers projects into the `wrangler dev`(+Docker) lane, gated on
`HAS_DOCKER`/`HAS_CF_CREDS`. (Most need rewriting from in-process DO construction to network-driving the
auto-spawned `wrangler dev` — scope that per test.)
- **Container (Docker):** `container-node/dev-container.test.ts:135` (fetch 3-way + applyChanges round-trip),
  `:146` (version contract), `:160` (cold-boot re-push); `dev-studio/dev-studio.test.ts:226` (syncToDevContainer
  push).
- **`env.AI` (deterministic-ish):** `dev-studio/codegen-loop.test.ts:389` (Workers-AI `json_schema` capability
  probe).
- **Classify:** `dev-studio/dev-studio.test.ts:234` (applyOntologyChange ordering — no env note; decide if it's
  Container-gated or pool-workers-able).
- **Belongs in `chromium`:** `dev-studio/dev-studio.test.ts:276` (SFC mounts non-blank, m3 — real-browser mount).
- **Stays `it.skip` by default** even when runnable: `dev-studio/dev-studio.test.ts:253` + `:264` (the **live
  `chat()` turn** — non-deterministic live LLM, costs money; "not a deploy blocker").

**Success criteria**:
- [ ] The deterministic candidates run green under the lane when Docker/creds are present; skip cleanly otherwise.
- [ ] The live-`chat()` `it.skip`s remain skip-by-default; `:276` is homed in `chromium` (or noted if deferred).

## Deferred / out of scope (with pointers)

- **The full "manipulate state via the UI" multi-step journey** (set-state → check → mutate → re-check via the
  rendered app) needs the generated app to **use Resources** — which the Studio doesn't wire yet (Wave-2
  data-bound generation). Deferred there. Today's UI smoke covers login + shell + the codegen→preview loop.
- **A *prod* UI smoke** (the same Playwright suite pointed at a *deployed* Studio) is the **deploy task ③** —
  it's blocked on Decision-3 Workers-Assets serving the Studio from the Worker (which ③ adds). The harness here
  should be written so re-targeting at a deployed URL later is a small change.
  - **Prod Turnstile (decided 2026-06-24):** for **pre-alpha, Turnstile is OFF in prod** (leave `TURNSTILE_SECRET_KEY`
    unset) — invited F&F only, no public signup, so bot-risk is low. The proper **automation bypass** is deferred
    → `tasks/backlog.md` § Nebula Auth (turn Turnstile on at alpha + bypass then). *Design note for then:* the
    magic-link request carries email (body) + scope (URL path) **with** the turnstile token, so the server has both
    at check time — the bypass can key on the **automation email / `--test--` scope** (no separate header secret).
    Never "solve" real Turnstile in a headless browser (designed to block that); the Turnstile secret key only
    *verifies* tokens — it can't mint them.
- **Self-provisioned random scope (≈1 week out — a planned upgrade, not this task).** Upgrade the suite to
  **self-provision a random universe/galaxy/star per run** (through the self-signup flow — `claimUniverse` /
  `createGalaxy`), torn down at the end with `ctx.deleteAll()`. Double duty: it **exercises the self-signup flows**
  AND lets **test suites run in parallel** (no shared-scope collision — valuable as devs/CI grow). For now use the
  fixed pre-provisioned scope, but **write the harness scope-parameterized** (scope as a fixture input, never
  hardcoded into the test) so this upgrade is a small change. → `tasks/backlog.md` § Testing & Quality.

## Open questions

- **`resetDevData` coverage — RESOLVED (verified 2026-06-24):** `Star.resetDevData()` is **Star-only**
  (`deleteAll` on the Star + `onStart` re-init); it does **not** touch the **DevStudio `Workspace` source** or the
  **DevContainer** (separate DOs). For *this* task's fixed-scope smoke that's likely fine — a chat turn regenerates
  the source + preview, overwriting any stale state (confirm in the Phase-1 spike). The **full** scope teardown
  (a uniform gated `teardown()`/`deleteAll()` across `NebulaDO` — covers Universe/Galaxy/Star/DevStudio — **and**
  `NebulaContainer`/`LumenizeContainer` — covers DevContainer, which must also *stop the container* — plus the
  `NebulaAuth` DO + the registry deprovision endpoint) is the **next-week random-scope work** → `tasks/backlog.md`
  § Testing & Quality.
- **Test scope — RESOLVED:** use a `--test--`-prefixed scope (`--test--u0.--test--g0.dev`) via a **configurable
  Studio scope** (Phase 2), separate from manual `acme.app.dev` both locally and in prod; the random-scope upgrade
  later gives each run its own throwaway scope. *(Residual: the `--test--` prefix must pass slug validation.)*
- **Harness mechanism — mostly RESOLVED:** raw Playwright + the Studio's own vite proxy as the same-origin bridge
  (no `dynamic-env-proxy`), per Phase 1. Residual spike = the **boot orchestration** (vite + `wrangler dev` +
  Docker in `globalSetup`) + the two-DevContainer Docker-coexistence check.
- **Gate detection — RESOLVED:** auto-probe (`docker info` for Docker; `CLOUDFLARE_*` presence for creds), no new
  config (Phase 1).
- **Scope of the `it.skip` rewrite** — how much each relocated test must change (in-process → network-driven).
  May make Phase 3 larger than it looks; if so, consider splitting it to its own task at the gate.

## Notes / links

- ① contract (frozen): `tasks/archive/nebula-studio-vite-proxy.md`. Launcher: `scripts/dev-studio.sh`
  (`npm run dev:studio`) — the manual version of what Phase 1 automates.
- Existing API-level smoke: `apps/nebula/test/browser/smoke.test.ts`. Harness patterns: the `chromium` project +
  `globalSetup` in `apps/nebula/vitest.config.js` / `test/browser/global-setup.ts`; `dynamic-env-proxy` +
  `testing.md` § Real-browser tests. Studio SPA: `apps/nebula-studio-ui/src/App.vue`.
- Backlog origin: `tasks/backlog.md` § Testing & Quality ("a `wrangler dev`(+Docker) / prod e2e + smoke lane").
- After this: ③ `nebula-release-process.md` (deploy) extends ①'s `entrypoint-routing-contract.test.ts` with the
  model-B SPA-fallback assertions and adds the *prod* UI smoke.
