# Local UI Smoke + `it.skip` Cleanup (a `wrangler dev` + Docker e2e lane)

**Status**: Wave 1 **Task ②** of [`nebula-pre-alpha.md`](../nebula-pre-alpha.md) — **✅ DONE + ARCHIVED 2026-06-24.**
`/review-task` ✅ (both stages) → `/build-task` ✅: Phases 1–2 green on real infra; **Phase 3 RESOLVED** — the
codegen/Container `it.skip`s DELETED in favor of top-down coverage (→ **zero `it.skip` in `apps/nebula`**).
① (single-origin serving, model A) is ✅ done + archived; ③ (the deploy task,
[`nebula-release-process.md`](../nebula-release-process.md)) follows. This task stood up the **first real
UI-level test of the Studio** (Playwright drives the rendered Studio under the model-A dev setup) — Phases 1–2 — and
**reconciled the env-gated codegen/Container `it.skip`s** (empty placeholders) by deleting them in favor of
higher-level coverage — both via one shared `wrangler dev`(+Docker) harness.

## Build results (2026-06-24, `/build-task`)

- **Phase 1 ✅ GREEN** — new `ui-smoke` vitest project (`apps/nebula/test/ui-smoke/{gates,global-setup,smoke}.ts`).
  `global-setup.ts` boots `wrangler dev` on **`apps/nebula/wrangler.jsonc`** (M2 pin — has DEV_STUDIO/DEV_CONTAINER/
  AI/`containers`) + **programmatic vite** serving the real Studio (`createViteServer`, `strictPort:false` so a
  manual `:5174` isn't a hard collision; Playwright navigates the **resolved** vite URL). `describe.runIf(HAS_DOCKER
  && HAS_CF_CREDS)` auto-skips (validated: poisoned `DOCKER_HOST` → 1 skipped, no boot). Excluded from the `unit`
  catch-all.
- **Phase 2 ✅ GREEN** (3/3, ~14 s warm) — narrative smoke: shell-renders-pre-login → **real-email login** (Node-side
  `waitForEmail`/`extractMagicLink`, then `ctx.request.get(viteOrigin + magicLinkPath)` so the cookie lands in
  Playwright's context) → connected → **prompt → `DevStudio.chat` codegen → container preview updates** (`env.AI` +
  Docker) → **wipe teardown** (`resetDevData`). Confirms the full UI loop end-to-end.
- **Phase 3 → DISSOLVED (2026-06-24, with Larry).** Re-thought: those `it.skip`s were empty placeholders written
  low-level (in-process `stub.__executeOperation`) *only* because pool-workers can't construct a `Container`/`env.AI`
  — not because the worry is low-level. Now that the lane drives the real stack top-down, the worries are covered
  there or already deterministic, so the skips were **deleted, not ported** (the `__executeOperation` network-driving
  spike dissolved entirely). Outcome — **zero `it.skip` in all of `apps/nebula`** (verified):
  - **happy-path round-trip + non-blank render** → the smoke's prompt→preview now also asserts the regenerated app
    renders **non-blank** in the container-served preview (folds the old SFC-mount + proves the push reached the container).
  - **request-scope / command-port decoy** (security) → a **new focused test** in the lane (`?activeScope=evil` ignored;
    `cf-container-target-port:9000` can't reach the command server).
  - **self-correction + TurnRecord** → already deterministic in `codegen-loop.test.ts`; the live confirmation is the smoke.
  - **`json_schema` probe** → deleted (a one-off capability investigation, not a regression).
  - Residual hardening worries (cold-boot resilience; `applyOntologyChange` ordering; dev-data **reset generation-counter**
    [from `dev-star-data-lifecycle.test.ts`]; version-contract "ops succeed" = **Wave-2**) → `tasks/backlog.md`
    § Testing & Quality (small/optional unit tests, not lane e2es). The two extra non-Phase-3 skips (`dev-star-data-lifecycle`,
    `conflict-outcome`) were swept too — the latter's worry stays tracked under the §5.3.8 for-docs probes.

### Enabling changes made during the build (beyond the harness)
- **Studio scope configurable** (`apps/nebula-studio-ui/src/App.vue`) via `?scope=` (default `acme.app.dev`) — the
  smoke drives `test-u0.test-g0.dev`.
- **Auto-connect on mount** (`App.vue` `onMounted`) — the Studio establishes the session when a refresh cookie is
  already present (the out-of-band-login enabler + a returning-user UX win); falls back to the login button otherwise.
- **⚠️ Slug bug (review miss):** `test--u0` is valid for `dag-ops` SLUG_REGEX but the stricter `nebula-auth`
  `parse-id.isValidSlug` **rejects consecutive hyphens** → auth 400. Corrected to single-hyphen `test-u0.test-g0.dev`
  (a two-validator single-source-of-truth smell → backlog).
- **Email sender wired into prod (Option C, Larry 2026-06-24)** — `apps/nebula` had **no** email binding, so real
  magic-link mail silently dropped. Added `services[AUTH_EMAIL_SENDER→NebulaEmailSender]` + `send_email[EMAIL,
  remote:true]` to `apps/nebula/wrangler.jsonc`, re-exported `NebulaEmailSender` from `src/worker.ts`, and made
  `NebulaEmailSender.from` env-configurable (`AUTH_EMAIL_FROM`, default the branded domain; the lane overrides to the
  verified `test@lumenize.io`). **This shrinks ③'s scope** — prod email sending is now wired (③ still owns the real
  login UI + the `.dev.vars` test-mode removal). Regression-checked: nebula-auth 283/283, apps/nebula unit+baseline
  262 pass.

## Objective

Two deliverables sharing one harness:
1. **A UI-level smoke (primary)** — Playwright drives the **rendered Studio** (vite `:5174` → proxy → `wrangler dev`
   `:8787` + Docker DevContainer, the proven model-A setup): log in via the **real email magic-link loop** (never
   test-mode — so the *same suite runs identically local + prod*), assert the Studio shell renders, and (richer)
   drive one chat turn → assert the preview updates. This is the confidence check that the Studio actually works
   end-to-end **before F&F invites** — the layer above ①'s routing test and the existing *API-level*
   `smoke.test.ts`.
2. **Env-gated test authoring (secondary — rides the same harness)** — the **deterministic** codegen/Container
   behaviors exist today only as empty `it.skip` placeholders in the pool-workers projects (they can't run there).
   Author them as `it.runIf(<gate>)` tests in the `wrangler dev`(+Docker) lane, so they execute when the env is present.

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

## Phase 1: Stand up the `wrangler dev`(+Docker) UI harness — *(EXPLORATORY)* — ✅ DONE 2026-06-24

**Goal**: a harness that boots the model-A Studio setup headlessly and lets a Playwright browser drive the
rendered Studio. Mechanism is empirical (like the §5.3.7 v4 WS-disconnect tooling) — discover it by running.

**Approach** (candidate, not pinned — the spike settles it):
- **Boot the `apps/nebula/wrangler.jsonc` config** (the only one with `DEV_STUDIO` / `DEV_CONTAINER` / `containers`
  + the `AI` binding — `wrangler.jsonc:24,31-32,41`), **NOT** the `test/browser/worker/wrangler.jsonc` that the
  existing `browser`/`chromium` globalSetups spawn (it binds `STAR→StarTest` + `BenchAgent`, has **no**
  DevStudio/DevContainer/AI, and carries a stale `DevStar` migration — it can't drive the preview or any Phase-3
  container test). Re-derive the `spawnWranglerDev` `--var` args for it (bootstrap email, `PRIMARY_JWT_KEY`,
  `NEBULA_AUTH_REDIRECT`) from `test/browser/global-setup.ts`. *(Note: that config's `.dev.vars` symlink carries
  `NEBULA_AUTH_TEST_MODE=true` for manual `dev:studio`; the lane inherits it like the existing browser harness — see
  the Gating bullet for why that's harmless here.)*
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
  is settled. **Why the in-browser auth POSTs pass without the `dynamic-env-proxy`'s Origin-rewrite:** `apps/nebula`
  runs `LUMENIZE_APPROVED_ORIGINS:""` (`wrangler.jsonc:74`) → `buildCorsOptions` returns `false` → `applyCorsPolicy`
  short-circuits with **no** server-side Origin check (`entrypoint.ts:28-38`, `route-do-request.ts:200-203`), so the
  refresh-token POST's `Origin: http://localhost:5174` (the proxy's `changeOrigin:true` rewrites Host, not Origin) is
  never rejected. The `dynamic-env-proxy`'s Origin-rewrite exists only because the `chromium` *test* worker runs a
  **non-empty** allow-list; this lane's empty list is exactly why it isn't needed. **So do NOT "fix" a phantom 403 by
  adding `:5174` to an allow-list, and do NOT bypass the proxy with a direct-to-Worker Playwright setup** — either
  would break this.
- **Gating — AUTO-DETECT, no new config** (don't add things to configure). `it.runIf`/`describe.runIf` on
  **auto-probed** capabilities: `HAS_DOCKER` = a Docker daemon ping (e.g. `docker info` exits 0); `HAS_CF_CREDS` =
  the `CLOUDFLARE_*` creds already in `.dev.vars` are present. No new flag, no `HAS_*` env var the dev must set.
  Never a hard dependency in the default `npm test`; mirrors `describe.runIf(BENCH_BASE_URL)`.
- **Test-mode is inherited but irrelevant — do NOT assert it off.** The lane's `wrangler dev` auto-loads the
  symlinked root `.dev.vars`, which carries `NEBULA_AUTH_TEST_MODE=true` (set for manual `dev:studio`) — the same as
  the existing `browser` harness. That is **harmless** here because the smoke is prod-portable by *never sending*
  `?_test=true` (it drives the real magic-link), **not** by the flag being absent. So **don't** add a "`?_test` is not
  honored" assertion (it would red — the flag IS present in local dev); the portability guarantee is "the suite never
  uses test-mode," which `.dev.vars`-removal (③) later makes structural.
- **Vitest wiring (if the lane is a vitest project).** If the harness is a new vitest project (vs. raw Playwright
  outside vitest), add its path to the `exclude` of every catch-all project (the `unit` project's `test/**/*.test.ts`,
  `vitest.config.js:180`) and verify with **both** a single-project run (`--project <lane>`) and a full `npm test` —
  the recurring `testing.md` "catch-all also runs it under the wrong bindings" footgun.

**Deliverable (exploratory bar):** the harness boots + one trivial green check (Playwright loads the Studio
shell at `:5174`), **plus a findings note** capturing the mechanism that worked *and the alternatives that
failed* (harvest into a `reference_*` memory or `testing.md`).

**Success criteria**:
- [x] `<lane> run` boots vite-Studio + `wrangler dev` (on the **`apps/nebula`** config) + Docker and a Playwright test
  loads the Studio shell (the **resolved** vite URL, not hardcoded `:5174`); skips cleanly (no failure) when Docker/creds
  are absent (validated by poisoning `DOCKER_HOST` → 1 skipped, no boot).
- [x] The in-browser auth POST (refresh-token, `credentials: include`) **succeeds — no CORS 403** — confirming the
  lane's Worker runs `LUMENIZE_APPROVED_ORIGINS=""` (the proxy-bridge model holds).
- [x] A findings note records the working harness mechanism (+ the dead ends) → memory `reference_studio_ui_smoke_harness`.

## Phase 2: The UI-level smoke (≤5 tests) — ✅ DONE 2026-06-24

**Goal**: confirm the Studio works end-to-end through the UI.

**Design principle — the suite runs IDENTICALLY local + prod, so it must use the REAL email login, never
test-mode.** `NEBULA_AUTH_TEST_MODE` lives only in `.dev.vars` and never deploys, so the Studio's `?_test=true`
"Log in (dev)" button is **inert in prod** — a smoke that drives it can't run against a deployed Studio. The real
magic-link loop is environment-agnostic (`smoke.test.ts` already runs it under local `wrangler dev` via the
deployed `email-test` Worker, ~1–3 s). One test body, parameterized base URL (vite `:5174` local; a deployed URL
later).

**Approach**:
- **Login = the real email magic-link loop** (PINNED — not the test-mode button; keeps the suite prod-portable).
  Reuse only the **Node-side** helpers `waitForEmail` / `extractMagicLink` (via the `email-test` Worker) to obtain
  the magic-link URL, then **Playwright itself navigates that URL** so the `Secure; SameSite=Strict; Path=/auth/{scope}`
  refresh cookie lands natively in Playwright's `BrowserContext`. *(Note the seam this avoids: `bootstrapAdmin`'s full
  loop sets the cookie in `@lumenize/testing`'s **Node `Browser` jar**, NOT a Playwright context — reusing it whole
  would force a cross-jar transfer (extract the cookie → `context.addCookies`). Letting Playwright follow the link
  sidesteps that and is the Phase-1 spike's first thing to confirm.)* The real-login-UI alternative (Playwright drives
  an in-Studio email-field login) is **deferred to ③**, which builds that UI — until then the smoke drives the link directly.
- **`.dev.vars` test-mode removal + dev-login button drop is DEFERRED to ③** (review gate 2026-06-24). The
  `?_test=true` "Log in (dev)" button is the Studio's **only** manual-login path today (`App.vue` `devLogin()`), so
  dropping it requires a replacement — the **real-email login UI**, which lands in ③'s Phase 0 alongside prod
  Workers-Assets serving. ③ does the atomic swap there (build the real login UI → drop the `?_test=true` button →
  remove `NEBULA_AUTH_TEST_MODE` from `.dev.vars`, after enumerating `#isTestMode`'s consumers to confirm each stays
  reachable via `?_test`/`miniflare.bindings`). ② keeps the button + flag and does **not** touch `.dev.vars` — it logs
  the **smoke** in via the real magic-link loop regardless (above), so the suite is already prod-portable. (The
  `.dev.vars` test-mode flag is a known `packaging.md` deviation that slipped in during the demo; ③ owns retiring it.
  `checkTurnstile` skips on the no-secret path too — `packages/nebula-auth/src/router.ts:281-285` — so the removal
  won't re-enable Turnstile in dev.)
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
  `ctx.deleteAll()` is the zero-it-completely tool for a disposable scope (the random-scope model below). Use the
  **dedicated test scope `test-u0.test-g0.dev`** — **not** Larry's manual `acme.app.dev` — so the smoke never
  collides with (or wipes) a manual session, and the `test-` prefix is the future reaper's auto-reap marker.
  **⚠️ Build discovery — TWO slug validators with different rules:** the marker must satisfy BOTH `dag-ops.ts:68`
  `SLUG_REGEX` (no leading/trailing hyphen — allows internal `--`) **AND the stricter `nebula-auth`
  `parse-id.ts isValidSlug` which ALSO rejects consecutive hyphens** (`slug.includes('--')`). The review's pinned
  `test--u0` passes dag-ops but the **auth layer 400s it** (`invalid_instance`), so a **single** hyphen — `test-u0`.
  The same `test-` marker is named in `backlog.md`'s reaper + soft-delete items, and reserving it from real
  `claimUniverse` is backlog. This needs the **Studio scope to be configurable** (it's hardcoded to `acme.app.dev`
  at 6 sites in `App.vue`; make it a config/env/query input — needed anyway for scope-parameterization + the prod
  test scope). **Isolation note:** this fixed shared scope deliberately deviates from `smoke.test.ts`'s per-run
  `uniqueStar()` (`smoke.test.ts:38`, which avoids cross-run DO-state pollution — `testing.md` "isolation flips the
  result"); acceptable here because a chat turn regenerates the source + preview over any stale `.dev` state, and
  the Deferred random-scope upgrade below is what restores true per-run isolation. **Scope the fixed shared scope
  strictly to login + shell + overwrite-style preview checks:** `resetDevData` is Star-only — it does **not** reset
  the DevStudio `Workspace` git history (HEAD oids, turn log) or the DevContainer tree (Open questions), which persist
  in `.wrangler/state` across runs. So any test that asserts on **accumulated** DevStudio source / DevContainer tree
  must use a **per-test unique scope** (`uniqueDevScope()`, as the existing pool-workers `dev-studio.test.ts` does),
  never the fixed smoke scope.
- Keep it ≤5 focused tests.

**Success criteria**:
- [x] The smoke logs in via the **real email loop** (no test-mode — zero `?_test` in the suite), and the **same test
  body** is base-URL-parameterized to run against both a local vite origin and a deployed base URL (the prod run lands when ③ serves the Studio).
- [x] Authenticated-shell-renders smoke passes under the harness (capable-of-failing: it reds if the Studio shell
  fails to render or the `/gateway` connect never completes).
- [x] The prompt → preview-updates test passes (gated on Docker + `env.AI`; asserts the iframe `?t=` cache-buster +
  zero error bubbles). *(Plus a teardown that wipes `.dev` via `resetDevData` last.)*

## Phase 3: ~~Author the env-gated codegen/Container tests in the lane~~ — ✅ RESOLVED DIFFERENTLY 2026-06-24 (skips DELETED, not authored)

**→ DISSOLVED (2026-06-24, with Larry).** The premise here — "author the empty `it.skip` placeholders into a lane" —
was reconsidered and dropped. Those skips were written low-level (in-process `stub.__executeOperation`) *only* because
pool-workers can't construct a `Container`/`env.AI`; the worries themselves aren't low-level. Now that the `ui-smoke`
lane drives the real stack top-down, each worry is covered there or already deterministic, so the skips were
**deleted, not ported** — and the `__executeOperation` network-driving spike described below is **moot** (never
needed). **Outcome: zero `it.skip` in all of `apps/nebula`.** What landed (see Build results, top):
- happy-path round-trip + **non-blank render** → folded into the smoke's prompt→preview test;
- request-scope / command-port **security** decoy → a new focused test in the lane;
- self-correction + TurnRecord → already deterministic (`codegen-loop.test.ts`); the `json_schema` probe → deleted;
- residual hardening (cold-boot, ordering, reset generation-counter, Wave-2 version-contract) → `backlog.md` § Testing & Quality.

*The original "author 6 lane tests + the network-driving spike" plan below is **SUPERSEDED** — kept only as a record
of the design that was reconsidered.*

**Exploratory — mechanism TBD.** The cited `it.skip`s are **empty placeholders** (TODO comments, zero `expect()`),
**not** movable assertions — so this is **net-new authoring of capable-of-failing tests against live Docker/`env.AI`**,
not a relocation. Per `tasks/README.md`, authoring-against-real-infra is exploratory; the deliverable is
capable-of-failing tests + the harness findings note (shared with Phase 1). Prior-art template: `smoke.test.ts`'s
pattern of network-driving an auto-spawned `wrangler dev`.

**Goal**: the env-gated codegen/Container behaviors are covered by `it.runIf(<gate>)` tests that actually run under
the `wrangler dev`(+Docker) lane, instead of perpetually-skipped placeholders.

**Approach**: author each as an `it.runIf(HAS_DOCKER && HAS_CF_CREDS)` test that **network-drives the auto-spawned
`wrangler dev`** (not in-process DO construction — `extends Container` can't construct under pool-workers). Files
live under `apps/nebula/test/test-apps/{container-node,dev-studio}/`; cite each target by its `it`-name (below), not
`:line` (line numbers drift). **Receive arm — pin per test:** these codegen/Container/`env.AI` *behavioral* tests use
the cheaper `__executeOperation`-with-synthetic-claims arm (the existing pool-workers isolation rung — `dev-studio.test.ts`
`envelope()` injects `{ aud, access:{admin:true} }`; correct *inside* the trust boundary), **not** the real
Gateway/JWT path — Phase 2's real-magic-link UI smoke already exercises the live JWT→`originAuth` boundary, so a
Phase-3 test need not re-drive it. State explicitly if any test does. Two cases:
- **(a) Author from scratch** (empty placeholders today):
  - `dev-container.test.ts` — *"fetch() 3-way branch + applyChanges round-trip + request-scope decoy"*, *"version
    contract: fetch() injects the REAL version → preview ops succeed → ontology change reloads"*, *"cold boot
    re-push: ensureUp boot-race retry + applyChanges(full tree)"*.
  - `dev-studio.test.ts` — *"ensureUp/syncToDevContainer push source to DevContainer"*, *"applyOntologyChange orders
    the propagation: setAppVersion + source push BEFORE the Star install"*.
  - `codegen-loop.test.ts` — *"response_format: json_schema is supported by Workers AI/Kimi"* (`env.AI`-gated,
    deterministic-ish — the typia-post-validate fallback already ships, so this only probes the *up-front* constraint).
- **(b) Leave as-is**: the **live `chat()` turn** tests in `dev-studio.test.ts` (*"a chat turn drives the loop and
  self-corrects…"*, *"the live chat turn records a TurnRecord…"*) **stay `it.skip` by default** (non-deterministic
  live LLM, costs money); *"SFC mount confidence (m3)…"* is homed in the **`chromium`** project (real-browser mount),
  or noted if deferred.
- **Classify at build time**: `dev-studio.test.ts`'s *"applyOntologyChange ordering"* carries no env note — decide
  Container-gated vs pool-workers-able when authored.

**Split gate**: if any single test needs more than ~30 lines of new live-infra driving (or the set balloons past a
quick afternoon), **split Phase 3 into its own task file** at the build gate — the parent's one-task-file-at-a-time
discipline — so it never blocks the primary Phase 1+2 UI smoke.

**Success criteria** *(re-cast at dissolution — the original "author the tests" criteria below were superseded)*:
- [x] **Zero `it.skip` in `apps/nebula`** (verified) — the codegen/Container skips (and the 2 unrelated ones) were
  deleted, their worries re-homed.
- [x] The happy-path container round-trip + **non-blank render** is covered by the smoke; the **security decoy**
  (`?activeScope=` ignored + command-port unreachable) by a focused lane test.
- [x] Residual hardening worries (cold-boot, ordering, reset generation-counter, Wave-2 version-contract) captured in
  `tasks/backlog.md` § Testing & Quality.

*↓ Superseded original criteria (record only): the case-(a) tests would have been authored + capable-of-failing under
the lane; the live-`chat()` tests stay skip-by-default; the SFC-mount → `chromium`.*

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
    at check time — the bypass can key on the **automation email / `test-` scope** (no separate header secret).
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
  **DevContainer** (separate DOs). So the fixed shared smoke scope (Phase 2) is safe **only** for login + shell +
  overwrite-style preview assertions (a chat turn regenerates source + preview over stale `.dev` state); any test
  asserting on **accumulated** DevStudio source / DevContainer tree uses a per-test unique scope instead (Phase 2
  "Test state"; Phase 3 lane tests follow the existing `uniqueDevScope()` pattern). The **full** scope teardown
  (a uniform gated `teardown()`/`deleteAll()` across `NebulaDO` — covers Universe/Galaxy/Star/DevStudio — **and**
  `NebulaContainer`/`LumenizeContainer` — covers DevContainer, which must also *stop the container* — plus the
  `NebulaAuth` DO + the registry deprovision endpoint) is the **next-week random-scope work** → `tasks/backlog.md`
  § Testing & Quality.
- **Test scope — RESOLVED (corrected in build):** use `test-u0.test-g0.dev` via a **configurable Studio scope**
  (Phase 2), separate from manual `acme.app.dev` both locally and in prod; the `test-` prefix (SINGLE hyphen — the
  auth-layer `parse-id` forbids `--`, see the Phase-2 build discovery) is slug-valid in both validators and is the
  reaper's auto-reap marker, reconciled with `backlog.md`'s reaper + soft-delete items. The random-scope upgrade
  later gives each run its own throwaway scope.
- **Harness mechanism — mostly RESOLVED:** raw Playwright + the Studio's own vite proxy as the same-origin bridge
  (no `dynamic-env-proxy`), per Phase 1. Residual spike = the **boot orchestration** (vite + `wrangler dev` +
  Docker in `globalSetup`) + the two-DevContainer Docker-coexistence check.
- **Gate detection — RESOLVED:** auto-probe (`docker info` for Docker; `CLOUDFLARE_*` presence for creds), no new
  config (Phase 1).
- **Phase 3 sizing** — the case-(a) tests are net-new authoring against live infra (placeholders, not movable
  assertions), so Phase 3 may be larger than it looks; the **split gate** in Phase 3 (>~30 lines of live driving →
  own task file) is the explicit pressure valve so it can't block the primary UI smoke.

## Notes / links

- ① contract (frozen): `tasks/archive/nebula-studio-vite-proxy.md`. Launcher: `scripts/dev-studio.sh`
  (`npm run dev:studio`) — the manual version of what Phase 1 automates.
- Existing API-level smoke: `apps/nebula/test/browser/smoke.test.ts`. Harness patterns: the `chromium` project +
  `globalSetup` in `apps/nebula/vitest.config.js` / `test/browser/global-setup.ts`; `dynamic-env-proxy` +
  `testing.md` § Real-browser tests. Studio SPA: `apps/nebula-studio-ui/src/App.vue`.
- Backlog origin: `tasks/backlog.md` § Testing & Quality ("a `wrangler dev`(+Docker) / prod e2e + smoke lane").
- After this: ③ `nebula-release-process.md` (deploy) extends ①'s `entrypoint-routing-contract.test.ts` with the
  model-B SPA-fallback assertions and adds the *prod* UI smoke.
