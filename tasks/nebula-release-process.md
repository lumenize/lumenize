# Nebula Release Process

**Status**: Wave 1 of [`nebula-pre-alpha.md`](nebula-pre-alpha.md) — **`/review-task` ✅ DONE 2026-06-24 (both stages), build-ready; not started.** **Resequenced 2026-06-24 BEHIND** ② the local smoke + `it.skip` cleanup (master-plan bullet) — ① `archive/nebula-studio-vite-proxy.md` (single-origin local serving) is ✅ **done** (model A; the frozen prefix contract this task transcribes). A deploy isn't F&F-usable until the Studio UI is served from the Worker. **On return, Phase 0 GAINS** two readiness items not in the current review: **Decision-3 Workers-Assets serving of the Studio UI** (`vite build` `nebula-studio-ui` → `assets` binding → entrypoint fallthrough; **EXTEND** `apps/nebula/test/test-apps/baseline/entrypoint-routing-contract.test.ts` with the model-B SPA-fallback assertions — `/` + `/app` → `index.html` via `env.ASSETS.fetch`, `/_version` + API keep precedence — rather than a new test) **+ the real magic-link login UI** (the dev `NEBULA_AUTH_TEST_MODE` button never deploys) — both get reviewed when added. This is **the first-prod-deploy task** (the pre-alpha "first prod deploy" bullet folded in as Phase 0) AND the reusable deploy/release process. **Scoped to Phases 0–3** for pre-alpha (first-deploy readiness + SHA-stamp/`/_version` + bench-staleness guard + `deploy.sh`); the heavier release-discipline pieces (registry-tarball reproducibility, CI, rollback) are **deferred to [`on-hold/nebula-release-hardening.md`](on-hold/nebula-release-hardening.md)**. Short-term mitigations are in place (the `.benchmark.ts` files carry the "deploy first or you're measuring stale code" warning).

## Objective

Build a release process for Nebula that fits its actual nature — an **app** that gets `wrangler deploy`d (which also builds + pushes the DevContainer Docker image), not a package that gets `npm publish`d — and that prevents the "tested locally, deployed something else" failure mode.

## Background

The repo's existing release flow (`scripts/release.sh` + Lerna `version` / `publish from-package`) treats every workspace as a publishable **package**. Nebula is `private: true` so Lerna already skips it — `release.sh` never touches Nebula at all. Nebula's real release — `wrangler deploy` — happens (today) entirely outside any script, by hand.

**Lerna's only role is the npm *package* publish** (synchronized version + `publish from-package`). It does nothing for a Nebula deploy; `wrangler deploy` does the real work (worker bundle + container image). So this task does not extend Lerna — it adds a *separate* Nebula deploy path beside the existing package path.

Three concrete symptoms of the missing deploy discipline surfaced during the parse-validate release pre-flight (2026-04-30):

1. **`apps/nebula/test/browser/{transactions.benchmark.ts, throughput.benchmark.ts}`** target the deployed `nebula-browser-test.transformation.workers.dev` worker. There is no version-stamp on that worker and no check that it matches local `HEAD`. The benchmark numbers in `RESULTS.md` / `THROUGHPUT-RESULTS.md` could have been measured against any prior commit. **Phase 2 is the permanent fix for this.**
2. **Smoke tests** (`smoke.test.ts`) hit local `wrangler dev` for the code under test — fine — but the email-magic-link path bounces through deployed Email Routing → the deployed `email-test` worker (`tooling/email-test/`) → WS callback. A drift between local Nebula (HEAD) and the deployed `email-test` worker (whenever) is invisible until something changes the wire format.
3. **Deploy is manual.** `wrangler deploy` is run by hand, after-the-fact, with no enforced ordering against package publishes Nebula consumes. **Phase 3 is the permanent fix for this.**

The short-term mitigation already landed (2026-04-30): warning headers in the `.benchmark.ts` files reminding the operator to deploy first, and those files run on demand only (`npm run bench`, `npm run bench:throughput`), not on the default `npm test` path. That's a reader-visible reminder, not a guarantee — this task replaces it.

## Goals

A robust process that answers, with no human discipline required:

- **Did the deployed Nebula match the local commit when bench/throughput were measured?** (Phases 1–2)
- **Are package publishes and Nebula deploys ordered correctly, and is the deploy a single repeatable command?** (Phase 3)

Deferred to [`on-hold/nebula-release-hardening.md`](on-hold/nebula-release-hardening.md) (un-park at alpha — do **not** build here):
- *Did the deployed Nebula resolve to the **published** `@lumenize/*` npm versions, not workspace symlinks?* — Phase A (reproducibility). Doesn't apply while `apps/nebula` is `private` and `wrangler` bundles workspace `src/` directly (which is exactly what the tests run).
- *What's the rollback story?* — Phase B (rollback + CI).

Non-goal: solving every monorepo "apps vs packages" pattern. Just Nebula and `email-test` for now; future apps inherit the pattern.

**Out of scope here (a separate release vehicle, not a Worker deploy):** updating the platform-owned prompt tree (`NEBULA.md` + `skills/*.md` + `rules/*.md`). Per [`nebula-pre-alpha.md`](nebula-pre-alpha.md) that ships as a **git commit into the registry DO's `Workspace` over mesh — no redeploy** (Wave-2 substrate). `deploy.sh` must **not** fold in prompt-tree updates; when the Wave-2 substrate lands, the prompt-tree push gets its **own** `apps/nebula/package.json` script (e.g. `npm run push:prompt`) for Larry to run, distinct from `npm run deploy`.

## Phase 0: First-deploy readiness

**Goal**: the one-time things that must be true before `apps/nebula` can serve ~5 external pre-alpha users on a real Cloudflare deploy. (These ride the deploy machinery in Phases 1/3; the recurring deploy itself is Phase 3.)

**Approach**:
- **Audit + freeze the `migrations` block** in `apps/nebula/wrangler.jsonc`. The block **already exists** (tag `v1`, 8 classes under `new_sqlite_classes` — `NebulaClientGateway, Universe, Galaxy, Star, DevStudio, DevContainer, NebulaAuth, NebulaAuthRegistry`). In **local dev it stays freely editable** (every vitest / `wrangler dev` run behaves like a fresh deploy). The first prod deploy is a **one-way door**: from then on the list is **append-only** (DO-class add/rename/delete = a migration forever; old rows may not be trimmable — assume not). So the Phase-0 work is a *verification*, not creation:
  - Confirm `migrations` `new_sqlite_classes` **exactly matches** `durable_objects.bindings` (and `src/worker.ts` re-exports) — same set, nothing extra, nothing missing.
  - Confirm **every** class is `new_sqlite_classes`, **never** `new_classes` (sync storage throws on a non-SQLite DO — hard deploy failure). See `.claude/rules/durable-objects.md` § DO class registration.
  - This is the last thing checked before cutting the first deploy.
- **Super-admin seed** — set `NEBULA_AUTH_BOOTSTRAP_EMAIL=larry@lumenize.com` as a deployed Worker **secret** (`wrangler secret put`, never committed). It auto-admins the first subject registering that email.
- **Turnstile OFF for pre-alpha** (decided 2026-06-24) — do **not** set `TURNSTILE_SECRET_KEY` in the prod deploy (F&F-only, no public signup → low bot-risk; `checkTurnstile` skips when the secret is unset). Turn it on + add an automation bypass at alpha → `tasks/backlog.md` § Nebula Auth.
- **Real-email login UI + retire the dev test-mode (transferred from ② at its 2026-06-24 review gate; reviewed when built).** The `?_test=true` "Log in (dev)" button (`apps/nebula-studio-ui/src/App.vue` `devLogin()`) is the Studio's only manual-login path, and it's inert in prod (`NEBULA_AUTH_TEST_MODE` never deploys) — so prod needs a **real-email login UI** (email field → "send magic link" → land authenticated). Do the atomic swap here, in order: (1) build the real-email login UI; (2) drop the `?_test=true` button + `devLogin()`; (3) remove `NEBULA_AUTH_TEST_MODE` from the root `.dev.vars` (a known `packaging.md` deviation — test-mode flags belong in vitest `miniflare.bindings`, where it stays). **Before step 3**, enumerate all `#isTestMode` consumers (`packages/nebula-auth/src/nebula-auth.ts:98` — currently the in-body magic/invite links at 241/805/855/879, the test-only `#handleTestSetSubjectData` at ~1016, and the real-email-send skip at ~1089) and confirm each stays reachable in tests via `?_test`/`miniflare.bindings`. The Turnstile-skip is **not** lost by the removal — `checkTurnstile` also skips on the no-secret path (`router.ts:282`), and pre-alpha prod keeps `TURNSTILE_SECRET_KEY` unset (above). **Success criterion to add**: no source references `?_test=true` or reads `body.magic_link`, and a `.dev.vars` grep shows `NEBULA_AUTH_TEST_MODE` absent.
  - **✅ Prod email SENDING already wired (Task ② build, 2026-06-24) — this Phase-0 item shrinks accordingly.** `apps/nebula/wrangler.jsonc` now carries `services[AUTH_EMAIL_SENDER→NebulaEmailSender]` + `send_email[EMAIL, remote:true]`, `src/worker.ts` re-exports `NebulaEmailSender`, and `NebulaEmailSender.from` is env-configurable (`AUTH_EMAIL_FROM`, default `auth@nebula.lumenize.com`). So ③ no longer needs to wire email; it must, on the FIRST PROD DEPLOY, (a) **verify the prod from-domain** (`nebula.lumenize.com`, or whatever `AUTH_EMAIL_FROM`/default resolves to) is onboarded for Cloudflare Email Sending — CF silently drops mail from an unverified sender, so unverified = no invite emails — and (b) confirm `remote:true` is inert on the deployed worker (it's a `wrangler dev`-only proxy directive; the browser-test worker has shipped it). The real-email *login UI* + the `.dev.vars` test-mode removal above remain ③'s.
- **Secure-by-default guard against a committed bootstrap-email backdoor** — a bootstrap email in a committed `wrangler.jsonc` `vars` block is a *standing admin backdoor* (`.claude/rules/packaging.md`: committed vars are world-readable and deploy with the worker). Confirming the *secret* is set does nothing to stop someone (or an LLM) **also** putting it in `vars`. Add a guard to `scripts/audit-test-mode.sh` (already gating `*_TEST_MODE`, wired into `test-code.sh` + `prepare-for-publish.sh`) that **fails** if `NEBULA_AUTH_BOOTSTRAP_EMAIL` / `LUMENIZE_AUTH_BOOTSTRAP_EMAIL` appears in a committed `wrangler.jsonc`. **Not** a widening of the shared `$PATTERN` — that also scans `package.json` / `*.sh` / `.dev.vars`, so it would false-flag this task's own `deploy.sh` (which names the var) and the committed `.dev.vars.example`. Make it a **separate scan scoped to the wrangler-config include-glob**, with a per-file allow-comment skip for the sanctioned deployed-test-harness exception packaging.md permits. (The var legitimately lives in `vitest.config.js` bindings — never flag those.)
- **Concurrency sanity** for ~5 external users (no per-tenant limits tripped; DO/Gateway defaults fine — a confirm, not a build).
- **DevStudio source-of-truth durability** — confirm the shell `Workspace` (git over `ctx.storage.sql`) survives a real deploy + DO restart (it's the dev-user's app source; losing it loses their work).
- Deploy is **laptop + WARP** for pre-alpha (`cf-container-deploy-proxy`, which also pushes the DevContainer image); the headless/CI deploy is deferred → `on-hold/nebula-release-hardening.md`.

**Success criteria**:
- [ ] In `apps/nebula/wrangler.jsonc` (the prod config only — the bench worker legitimately diverges with its own chain), the set of **`class_name`** values in `durable_objects.bindings` exactly matches `migrations` `new_sqlite_classes` and the `src/worker.ts` re-export set — compared on **class name, not binding name** (`NEBULA_CLIENT_GATEWAY` → `NebulaClientGateway`); all `new_sqlite_classes`, no `new_classes`. Frozen as the last step before first deploy.
- [ ] The Phase-0 audit guard **fails** if a `*_BOOTSTRAP_EMAIL` is found in a committed `wrangler.jsonc`, and **passes on the current tree** (does not flag `deploy.sh`, `.dev.vars.example`, or `vitest.config.*`).
- [ ] First prod deploy succeeds from laptop+WARP, the DevContainer image builds + pushes, the worker boots; super-admin can log in at the reserved `nebula-platform` instance with the seeded email. *(The deploy smoke check for THIS task = `deploy.sh`'s `/_version?sha=` byte-check (curl from bash, not vitest) + this manual super-admin login — distinct from the codegen-skip check below. A richer **automated UI-level smoke** (Playwright drives the rendered Studio: log in through the UI, assert key elements, then a multi-step journey) is net-new, NOT this task, and is **blocked on the Studio UI being served from the deploy** (see Open questions) → `tasks/backlog.md` § Testing & Quality.)*
- [ ] The codegen loop's live `it.skip`s are exercised under `wrangler dev` + Docker — their existing pre-deploy home. They construct the DevStudio/DevContainer DOs **in-process** (needing a real `env.AI` + a **constructible** `Container`, which vitest-pool-workers can't build), so there's no URL to redirect them at — a **pre-deploy gate**, not a deploy check. **A manual `wrangler dev` + Docker pass suffices for the first deploy**; promoting the deterministic ones to a durable `runIf` lane (and keeping the live-`chat()` turns skip-by-default) is a separate test-infra task → `tasks/backlog.md` § Testing & Quality. *(Deployed-target vitest does exist — the bench suite's browser project hits a deployed worker over the network — these skips just aren't among them.)*
- [ ] DevStudio Workspace source survives a redeploy — by construction it lives in `ctx.storage.sql` (survives code deploys like all DO storage); confirm once by hand (write source → second `wrangler deploy` → `getSourceTree` shows the same HEAD oid).

## Phase 1: Version-stamp deployed Workers

**Goal**: every deployed Worker exposes the git SHA it was built from, and tests can assert against it. The **SHA is the identity** (precise); the `package.json` `version` rides alongside as a coarse human label (`0.24.0` today), **not** locked to the Lerna package stream (see Open questions).

**Approach**:
- **Inject the stamp at deploy time; read it through a dev-safe guard.** `deploy.sh` (Phase 3) computes the values into shell vars **first, before any build step touches the tree** (so a clean checkout never stamps dirty), then passes them as Wrangler `--define`:
  ```sh
  GIT_SHA=$(git rev-parse HEAD)
  DIRTY=$([ -z "$(git status --porcelain)" ] && echo clean || echo dirty)
  wrangler deploy --define __GIT_SHA__:"\"$GIT_SHA\"" --define __DIRTY__:"\"$DIRTY\"" --define __BUILD_TIME__:"\"$(date -u +%FT%TZ)\""
  ```
  *(Illustrative only — `deploy.sh` is the single canonical home for this nested escaping; never re-type it inline elsewhere.)*
- **`--define` globals are absent everywhere except a real deploy** (vitest-pool-workers, `wrangler dev`, the bench worker's local-spawn mode inject none). `entrypoint.ts` is imported by the baseline app, the bench worker, and **every** test app — so a handler reading bare `__GIT_SHA__` would fail type-check (TS2304) and throw `ReferenceError` at request time, breaking the **whole suite + dev loop**, not just deploy. Therefore: `declare const __GIT_SHA__: string` (etc.) and read through a guarded helper returning a **dev sentinel** when undefined — `typeof __GIT_SHA__ !== 'undefined' ? __GIT_SHA__ : 'dev'` (and `dirty: true` in dev).
- **`/_version` is a Worker `fetch` endpoint that COMPARES, never DISCLOSES — one uniform public route, no gating, no mesh.** Add it as an early literal `url.pathname === '/_version'` branch at the **top of `entrypoint.fetch`** — the **Worker** HTTP boundary, before any DO dispatch (it reads the bundle-baked `--define` globals; no DO, no storage, no mesh — putting it in a DO would force a mesh method or a raw DO fetch, both heavier and both entangling a bundle fact with DO machinery). It does **not return the SHA**: the caller **submits** its expected SHA (`GET /_version?sha=<local HEAD>`) and the endpoint replies `{ match, dirty }` after a **constant-time** compare against `__GIT_SHA__` — never echoing the deployed SHA (nor `buildTime`, nor a dependency list) in the body or in any error. Because nothing sensitive leaves the worker, the route is **public and identical on prod and the bench worker** (no Bearer gate, no public-vs-gated split — *that* is what idea-3 buys: the disclosure surface, and with it the whole gating problem, simply disappears). Both real callers fit it — the Phase-2 guard and the Phase-3 self-check each already know the SHA they expect and only want yes/no; `{match:true}` doubles as the liveness signal. *(The coarse `package.json` version label, if ever wanted, lives in the deploy log / git tag — not worth its own surface.)*
- **Per-worker deploy of the stamp.** `nebula-browser-test` is a SEPARATE worker (own `apps/nebula/test/browser/worker/wrangler.jsonc`, own `index.ts` wrapping the prod entrypoint, `StarTest`/`BenchAgent`/`BenchFanoutTier`/EMAIL/rate-limiter, own 7-tag migrations chain) — deploy via `wrangler deploy --config test/browser/worker/wrangler.jsonc` with its **own** `--define`, **never `--name`**. The compare route lives in the shared prod `entrypoint.fetch`, so the bench worker gets it via passthrough for free (it's harmless either way — it discloses nothing). `email-test` (`tooling/email-test/`) is a *standalone* worker (own `fetch`, `EmailTestDO`, no Nebula entrypoint import) — it does **not** get `/_version` for free; stamping it needs a ~4-line compare route in its own `index.ts` **plus** the `--define` in its own `--config` deploy (see the email-test open question — pinned to defer for pre-alpha).

**Success criteria**:
- [ ] vitest + `wrangler dev` still boot `entrypoint`; `/_version` is dev-safe (`declare const` + sentinel — never throws). In dev (no `--define`) a compare returns `{ match: false, dirty: true }`, and the Phase-2 guard is `BENCH_BASE_URL`-gated so it never calls it locally anyway.
- [ ] `GET <bench URL>/_version?sha=<the SHA it was deployed at>` → `{ match: true }`; a wrong SHA → `{ match: false }`. The deployed SHA never appears in any response body, on either worker.
- [ ] Prod `/_version` behaves identically (public, leaks nothing) — confirm by inspecting the response shape, no auth needed.
- [ ] A `wrangler deploy` from a dirty tree makes the compare report `dirty: true`.

## Phase 2: Bench-staleness guard (the permanent fix for symptom #1)

**In scope** — this is the no-human-discipline fix for the originating symptom (benches measured against stale deploys). It is **not invite-blocking** (we don't benchmark for pre-alpha users), so it **sequences after Phase 1** and off the invite path — but it is cheap once Phase 1's stamp exists and it permanently closes the footgun, so it is built here, not deferred.

**Goal**: bench and throughput tests refuse to run against a stale **deployed** bench worker.

**Approach**:
- Helper in `apps/nebula/test/browser/` (e.g. `assert-deployed-version.ts`) that — **only in deployed mode** — calls `GET <BENCH_BASE_URL>/_version?sha=$(git rev-parse HEAD)` and reads the `{ match, dirty }` reply: fail fast on `match:false` with a clear "deployed != local HEAD; run `npm run deploy:test-worker` first", and warn on `match:true, dirty:true` ("deployed from a dirty tree — numbers not reproducible"). The helper never needs to *see* the deployed SHA — it only submits its own.
- **Gate the guard on `BENCH_BASE_URL`.** With no `BENCH_BASE_URL` the bench auto-spawns a local `wrangler dev` against workspace `src/` (which IS `HEAD` by construction and injects no `--define`) — an unconditional check would fetch an unsubstituted `__GIT_SHA__` literal (or the dev sentinel) and spuriously fail. The deployed-mode gate (`!!process.env.BENCH_BASE_URL`) already exists at `benchmark.ts:239`; the guard must use the same gate.
- Wire into the `.benchmark.ts` entrypoints (or a vitest `globalSetup` for the `browser-bench` project).
- New script: `npm run deploy:test-worker` runs `wrangler deploy --config test/browser/worker/wrangler.jsonc` with the SHA define from Phase 1. The bench README points at it.

**Success criteria**:
- [ ] Capable-of-failing: deploy at SHA A, advance `HEAD` to B, run with `BENCH_BASE_URL` set → the guard fails fast with the SHA-mismatch message.
- [ ] `npm run bench` with **no** `BENCH_BASE_URL` (local mode) still passes — the guard short-circuits.
- [ ] `npm run deploy:test-worker && BENCH_BASE_URL=… npm run bench` succeeds end-to-end.
- [ ] The numbers in `RESULTS.md` / `THROUGHPUT-RESULTS.md` cite the SHA they were measured against — **written programmatically** from local `HEAD` *after* the guard confirms `match:true` (so deployed == HEAD == the cited SHA, no drift), not a hand-typed footnote.

## Phase 3: A first-class Nebula deploy flow, separate from the package release

**Goal**: a single repeatable Nebula deploy command, distinct from the package publish. (`scripts/release.sh` **already** only publishes packages and never touches Nebula — Lerna skips it as `private`. So this phase is purely *additive*: a new `deploy.sh`, not a refactor of `release.sh`.)

**Approach**:
- **PINNED (2026-06-23): all deploy logic lives in `apps/nebula/scripts/deploy.sh`.** Two thin wrappers invoke it: the root `package.json` exposes `npm run deploy:nebula`; `apps/nebula/package.json` exposes `npm run deploy` (local, unprefixed). The script:
  1. Computes `GIT_SHA` + `DIRTY` into shell vars **first** (before any build/bundle step mutates the tree — see Phase 1).
  2. Confirms the super-admin secret is set — **name-only** via `wrangler secret list` (there is no value-retrieving command; never echo a secret). Refuse if absent. (The committed-`vars` backdoor check is the separate Phase-0 audit guard.)
  3. Runs `wrangler deploy` (which also builds + pushes the DevContainer image) with the `--define` stamp from step 1.
  4. **Self-checks** the new build is live by calling `GET <prod URL>/_version?sha=$GIT_SHA` and asserting `{ match: true }` — this is the *same* public compare endpoint (Phase 1), which doubles as the liveness signal (a reply at all = serving; `match:true` = the bytes we just built). It discloses nothing, needs **no admin token**, and surfaces a failure if the worker doesn't answer or reports `match:false` (stale cache / failed deploy).
  - **No Lerna, no version-lock, no registry-tarball reinstall.** For pre-alpha `apps/nebula` is `private` and `wrangler` bundles workspace `src/` directly — which is what the tests run — so a workspace-symlink deploy is correct, not the divergence trap. (Reproducibility-from-npm + auto-rollback → `on-hold/nebula-release-hardening.md`.)
  - Any secret `deploy.sh` reads comes from env / `.dev.vars` (never a literal), with no `set -x` around lines that touch it.
- Document when to run each flow (package publish vs Nebula deploy) in a new top-level `RELEASING.md`.

**Success criteria**:
- [ ] `scripts/release.sh` still only publishes packages; never deploys Nebula. (Confirm — already true.)
- [ ] `apps/nebula/scripts/deploy.sh` holds the deploy logic; `npm run deploy:nebula` (root) and `npm run deploy` (apps/nebula) both invoke it.
- [ ] Post-deploy, the `/_version?sha=` self-check returns `{ match: true }` (confirms the freshly-built worker is serving the bytes just deployed); `deploy.sh` holds no admin token and emits no secret in its output.
- [ ] `RELEASING.md` exists and says which flow to run when.

## Deferred (post-pre-alpha) → `on-hold/nebula-release-hardening.md`

Un-park at the **alpha** milestone: **Phase A — reproducibility from npm** (deploy from registry tarballs vs workspace symlinks — doesn't apply while `apps/nebula` is `private` and `wrangler` bundles `src/`); **Phase B — CI wiring + rollback** (the headless/CI container deploy that replaces laptop+WARP; `wrangler rollback`; the repo has no CI today).

## Open questions

- **App vs package versioning — RESOLVED for pre-alpha: do NOT version-lock.** Nebula deploys are identified by **SHA** (precise) + `apps/nebula`'s own `package.json` `version` (coarse label). Lerna is not involved in deploys. (Re-evaluate a lock only once CI deploys packages-first.)
  - *Open sub-threads (noted, not decided here):* (a) a **compatibility-date-style** scheme like Cloudflare's — note the thing that already behaves like a compat-date for Nebula is the **append-only migrations tag chain**, not semver; (b) whether to eventually **drop Lerna** for plain npm workspaces now that workspaces cover more (Lerna's remaining value is synchronized versioning of the published packages). Both are separate discussions.
- **`email-test`** (`tooling/email-test/`) is a deployed Worker with the same staleness problem (symptom #2). It is a *standalone* worker (own `fetch`, no Nebula entrypoint), so it does **not** get `/_version` for free — stamping it costs a ~4-line route in its own `index.ts` + the `--define` in its own `--config` deploy. **Pre-alpha call (pinned): accept the gap, don't build a third stamp+guard.** Unlike the opt-in benches, the magic-link smoke path runs in the default `npm test`, so a wire-format drift between `HEAD` and the deployed email-test worker **breaks the smoke test loudly** (not silently) — caught, just not pre-empted. Revisit (ride the Phase-1 pattern) at alpha if it bites.
- **Dirty-tree deploys** — block, warn-and-allow, or stamp `dirty:true`? Current pin: **stamp** (surfaced as `dirty:true` in the `/_version` compare reply), don't block. Revisit if it bites.
- **Future apps in `apps/`** — assume the Nebula pattern generalizes; refactor if a second app breaks the assumptions.

## Notes

- Short-term mitigation already in place (2026-04-30): warning headers in the `.benchmark.ts` files, plus they run on demand only (`npm run bench`, `npm run bench:throughput`), not in `npm test`. This task supersedes those once Phase 2 lands.
- Memory entry referencing the deployed test worker subdomain and configured secrets lives in `MEMORY.md` under the parse-validate-release notes — keep that in sync if the test worker name or config changes.
