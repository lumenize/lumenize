# Bring `apps/nebula` into the CI / cloud-test lanes

**Status**: BUILD IN PROGRESS (2026-06-28). Reviewed via two Stage-1 framing passes + a Stage-2 conformance pass + a scope-expansion pass; pinned with Larry. Prerequisite [`tasks/lumenize-email.md`](archive/lumenize-email.md) ✅ DONE 2026-06-26.

**Build progress (2026-06-28, spike-independent work done locally; runner/token work staged for a push):**
- ✅ **Resend switch (Phase 3 blocker B1)** — `browser`/`chromium` worker config off CF `send_email remote:true` → `EMAIL_PROVIDER: resend`, `from` → `auth@test.lumenize.com`. **Verified**: `browser` lane green (5 passed incl. magic-link auth via Resend, no CF creds); full apps/nebula always-on suite green (**524 passed**).
- ✅ **CI wiring (Phase 3)** — `.github/workflows/ci.yml` test job now `--scope "packages apps"`. Proves out on push.
- ✅ **Container spike harness (Phase 1)** — `.github/workflows/container-spike.yml` (workflow_dispatch). **Empirical boot result needs a push/dispatch on a GHA runner** (+ separately, the hosted sandbox).
- ⏸ **Phase 2 (callModel REST swap + ui-smoke prod-config Resend + gate split)** — held: gated on the spike result + Larry minting the `WORKERS_AI_TOKEN`.
- Build order note: spike-first was pinned because the spike gates *ui-smoke-in-hosted*; the Resend switch + CI wiring don't touch that gate, so they were done first without jumping the dependency.

## Goal
Run **ALL** of `apps/nebula`'s test lanes in CI — **both** GitHub Actions **and** the Claude-hosted lane (plaintext env vars only, no hidden secrets) — without reintroducing a broad `CLOUDFLARE_API_TOKEN` into the plaintext hosted env. (`apps/nebula` is excluded today: CI invokes [`test-code.sh`](../scripts/test-code.sh), which runs each workspace's `test` script — and `apps/*` is out of `--scope packages`.)

**The key realization (Larry, 2026-06-28):** the hosted lane can run *everything* — the only capability it genuinely lacks is **Cloudflare Email Sending** (which needs the broad token in plaintext). And **no `apps/nebula` test requires it**: every email use is an *incidental* magic-link login (verified — `browser`/`chromium` test Gateway/bench/auth-JWT, not email), and the CF-email canary lives in `packages/auth/e2e-email` (already gated). So with **Resend** for email + a **local Docker** container + a **Workers-AI token** for AI, the whole `apps/nebula` suite runs in the hosted lane. There is no "hosted-omitted" group.

## Pinned decisions
| Decision | Choice | Rationale |
|---|---|---|
| **Email everywhere = Resend** | Switch `apps/nebula`'s email-using lanes (`browser`, `chromium`, `ui-smoke`) to **Resend-by-env permanently** — **drop the `send_email remote:true` binding** from their worker configs. They then need only `RESEND_API_KEY` + `TEST_TOKEN` (present in all lanes). | The email is incidental (magic-link login → JWT), not the thing under test, so the transport is free to change. Removes the only CF-account dependency in `apps/nebula` besides container + AI; no `remote:true` binding to trap at pool-load. Loses nothing — `packages/auth/e2e-email` owns the CF Email Sending canary. The receive side (deployed `email-test` Worker + `TEST_TOKEN`) is unchanged and already works from hosted (the `e2e-email-resend` round-trip proves Resend → Email Routing → `email-test`). |
| **Build order** | Container spike (Phase 1) → make ui-smoke hosted-capable (Phase 2) → all lanes into CI (Phase 3). | The container-on-headless-Linux question is the only true unknown; it gates whether ui-smoke can be a CI lane at all. Larry. |
| **CI control point** | Drive CI off **`apps/nebula`'s `package.json` `test` enumeration**, *then* add `apps` to `--scope`. | `test-code.sh` runs each workspace's `test` script; the project set is fixed by that hard-coded `--project …` list, not by `--scope`. |
| **ui-smoke AI in hosted** | **Real AI via a Workers-AI REST call** (through an AI Gateway), not a mock. Swap `DevStudio.callModel` ([dev-studio.ts:380](../apps/nebula/src/dev-studio.ts), a `protected` non-`@mesh` seam) off the `env.AI` binding. | The hosted lane has no CF creds, so `env.AI`-via-`wrangler dev` can't authenticate. REST + a scoped plaintext token works everywhere. Real AI (not mock) enables a nightly **replay-and-tune** loop ([`nebula-nightly-loop`](nebula-nightly-loop.md) + [`nebula-studio-eval-suite`](on-hold/nebula-studio-eval-suite.md)). A per-env AI mock is the **fallback only**. |
| **REST path: target or interim?** | **The target.** A mesh `this.svc.ai` capability could later *wrap* it (ADR-007) — an ergonomic refactor, not a different decision. | Avoids "the contortion is the plan." Per `mesh.md`, file the wrap as Mesh feedback; ship REST as the path. |
| **AI key scope** | A CF API token scoped to **Workers AI (Account · Read)** and nothing else. **NOT** an `AI Gateway: Run` token. Plus the **account ID** (non-secret) alongside it. | Kimi is `@cf/moonshotai/kimi-k2.7-code` (Workers AI catalog, NOT BYOK) → blast radius = Workers AI Neuron spend only. `AI Gateway Read/Run/Edit` **can't** be restricted to one gateway. The REST URL is `/accounts/{account_id}/ai/run/…`, so the account ID rides along (non-secret identifier, not a new credential). |
| **AI abuse containment** (load-bearing: the token enters the hosted **plaintext** lane) | **Defense-in-depth, NO hard enforcement — accepted.** (1) Workers-AI-only token caps blast radius; (2) AI Gateway **rate limit** throttles spend-per-window (`429`); (3) Cloudflare **Budget Alert** *notifies* on a threshold. Leak recovery = rotate + raise. | Confirmed: **no hard spend cap** exists — the Budget Alert is a notification, the gateway lever is a rate *throttle*. Worst case = bounded DoS-of-budget until the alert fires + rotate. Acceptable given AI-only scope. *(recipe → Phase 2 prereq.)* |

## The landscape — the lanes
`apps/nebula/vitest.config.js` defines **11 named vitest projects**; what runs in `npm test` is the `package.json` `test` enumeration (a `--project …` list). Group by what each needs to run in the hosted lane (a rule, not a frozen list — re-derive if it drifts):

- **Pure account-free** (no email / container / AI): `unit`, `frontend`, `baseline`, `container` (prototype harness), `dev-studio`. Run everywhere **as-is**. (`dev-studio` binds **no `env.AI`** — the test DevStudio replays a synthetic `callModel` script, [test-apps/dev-studio/index.ts:26-42](../apps/nebula/test/test-apps/dev-studio/index.ts).) → **Phase 3**.
- **Email-using, no container/AI**: `browser`, `chromium`. Run everywhere once switched to **Resend-by-env** (drop the `send_email remote:true` binding). `browser` is in `npm test`; `chromium` is currently `--project`-only (real-browser) — promote to CI if wanted, no CF blocker after the switch. → **Phase 3**.
- **`ui-smoke` — the hard one** (email + real Docker container + real AI). Boots the production [`apps/nebula/wrangler.jsonc`](../apps/nebula/wrangler.jsonc) under `wrangler dev` + vite + Playwright. Needs all three hosted-enablers: Resend email + local container (Phase 1) + Workers-AI REST (Phase 2). → **Phases 1 + 2**.
- **On-demand by nature** (perf/spike, `--project`-only): `secrets-facet`, `egress-choke`, `browser-bench`. Stay manual — also hosted-capable, but not added to the always-on run.

## Phase 1 — Container spike: real CF Container under `wrangler dev` on headless Linux
**Exploratory — mechanism TBD** — empirically discoverable, not pinnable. Prior-art template: the existing [`ui-smoke/global-setup.ts`](../apps/nebula/test/ui-smoke/global-setup.ts) (`spawnWranglerDev` + Docker + vite) and the deployed-e2e exemplars ([`packages/auth/test/e2e-email`](../packages/auth/test/e2e-email/), [`packages/fetch/test/proxy-fetch.test.ts`](../packages/fetch/test/proxy-fetch.test.ts)).

**The unknown**: `extends Container` can't construct under pool-workers ([`precheck.test.ts`](../packages/mesh/test/container/precheck.test.ts) proves it); real containers run only manually today (Docker Desktop on macOS via [`dev-studio.sh`](../scripts/dev-studio.sh)). Whether a CF Container boots under `wrangler dev` on **headless Linux** — a GHA `ubuntu-latest` runner **and** the Claude hosted sandbox (both have Docker, neither verified) — is open. Need it on both, since `ui-smoke` is wanted in both lanes.

**Decision gate**:
- **YES (either/both targets) → path (2):** the `ui-smoke` lane runs in CI on the target(s) where it works (with the Phase-2 enablers).
- **NO → path (1) fallback:** real-container *coverage* moves to a **deployed-e2e** (deploy Worker+Container, hit it like the email/fetch e2e), run in **GHA/local only** (where the broad `CLOUDFLARE_API_TOKEN` already lives) — **never** the hosted plaintext lane. `ui-smoke` then stays manual and the **ui-smoke-in-hosted goal is dropped** (accepted: we do *not* relocate the broad token to keep it). Its skip comment uses plain terms (`testing.md`): "needs a deploy to Cloudflare".

**Trust boundary** (the spike boots untrusted LLM-generated code in Docker on the hosted sandbox, co-located with the plaintext token): the `DevContainer` receives only the inputs it needs — **no `WORKERS_AI_TOKEN` / CF creds passed in** (`callModel` runs in the **DO**, not the container; [`dev-container.ts`](../apps/nebula/src/dev-container.ts) `envVars` carries only `PREVIEW_BASE`) — confirm the container can't reach the host env.

**Spike findings (2026-06-28, GHA `ubuntu-latest`, [`container-spike.yml`](../.github/workflows/container-spike.yml), 6 iterations):**
1. **✅ CORE QUESTION ANSWERED — path (2) works.** A real CF Container **builds, boots, and serves** under `wrangler dev` on a headless GHA `ubuntu-latest` runner: the Dockerfile builds (`#14 naming to docker.io/cloudflare-dev/devcontainer:… done`), wrangler is `Ready`, and `GET /dev-container/{scope}/ → 200 OK (1231ms)` — the container responded. **2 of 4 ui-smoke tests pass** (shell-render + a container-touching security test). So real-container CI via the `ui-smoke` lane is viable; no need for the path-(1) deployed-e2e fallback. *(Hosted-sandbox target still to confirm separately.)*
2. **Tooling (SOLVED).** Running `ui-smoke` on headless Linux needs the full **vite** native-binding set re-added after `npm ci --no-optional` — `rollup` + `swc` + **`lightningcss`** (nebula-studio-ui's vite CSS pipeline; the packages job never runs vite so it only re-adds rollup+swc) — **in ONE `npm install`**: separate sequential `npm install --no-save` lines **prune each other's optionals** (lightningcss's install silently wiped the swc binding). `lightningcss`'s `exports` blocks `require()` of its `package.json` → read its version off disk.
3. **✅ Auth `503` ROOT-CAUSED + FIXED.** The 2 login tests were failing on `POST /auth/{scope}/email-magic-link` (and `refresh-token`) → fast `503 Service Unavailable`. Worker log (DEBUG-forwarded): `Uncaught TypeError: Can't read from request stream after response has been sent`. Cause: the custom auth router ([`nebula-auth/src/router.ts`](../packages/nebula-auth/src/router.ts)) forwarded the **live** request stream to the `NEBULA_AUTH`/registry DOs (`stub.fetch(request)`) and returned the DO's response directly — the body stream shared across the Worker→DO boundary tears down racily under `wrangler dev` on **Linux** (prod + pool-workers + macOS tolerate it). NOT rate-limiting, email, or the container. **Fix:** `forwardToDo()` materializes the body (GET/HEAD pass through) at all 3 live-forward sites, making the custom router consistently *always-consume* (the field-injecting handlers already reconstruct). Verified: tsc clean, nebula-auth 311 passed, browser lane green.
4. **✅✅ ui-smoke 4/4 GREEN on GHA** — full loop on the headless runner: container builds+boots+serves the generated Vue app (`GET /dev-container/.../App.vue 200`, vite deps served) + Resend login + `env.AI` codegen turn (`DevContainer.applyChanges`). **Path (2) confirmed; the entire Phase-1 unknown is resolved.**
5. **Next:** productionize the spike into a proper `ui-smoke` CI lane (or fold into `ci.yml`) + strip the DEBUG diagnostic; confirm the hosted-sandbox target; then Phase-2 hosted-capability (Resend boot + AI REST swap — token now in place). The `--no-optional` whack-a-mole **belongs to ui-smoke's harness only** (no always-on lane runs vite).

**Success criteria**:
- [ ] Spike executed on a GHA runner **and** the hosted sandbox; per-target result recorded: boots? cold-boot within the 120s budget? smoke passes? *(harness ready; dispatch pending)*
- [ ] Path (1) vs (2) chosen with evidence, captured as a findings note (here or a reference memory).
- [ ] Container-injected inputs audited: no AI token / CF cred crosses into `DevContainer`.
- Spike hygiene (`workflow.md` § Experiments): expect it to break after it runs; capture the result, don't keep it runnable.

*Separate beneficiary (not this task's deliverable):* the mesh real-container skip in [`packages/mesh/test/container/container-seam.test.ts`](../packages/mesh/test/container/container-seam.test.ts) (a **packages** test already in CI) is also unblocked by a working real-container-in-CI mechanism — un-skipping it is a follow-on owned by the mesh package.

## Phase 2 — Make `ui-smoke` hosted-capable: Resend email + AI-via-REST + gate
**Goal**: `ui-smoke`'s full flow (magic-link login → container → AI turn → preview) runs in the **hosted** lane (no CF account creds), and still in GHA.
**Presupposes Phase 1 = YES** (a container boots on headless Linux). If Phase 1 = NO, ui-smoke stays manual and this phase is moot — re-scope (the AI-REST swap may still be wanted **solely** for the nightly replay loop).
**Prereq — Larry mints the key** (dashboard; never the agent):
> **My Profile → API Tokens → Create Token → Custom Token.** Permission: **Account · Workers AI · Read**. Account-scoped, nothing else. Value → `.dev.vars` as `WORKERS_AI_TOKEN=…` **and** the hosted-lane plaintext env. Also ensure `CLOUDFLARE_ACCOUNT_ID` (non-secret) is in both. Create an AI Gateway; set a low **rate limit** + a **Budget Alert**.

**Success criteria**:
- [ ] **Email via Resend**: ui-smoke's boot config drops the `send_email remote:true` binding so provider-by-env uses Resend (the shared "email everywhere = Resend" decision); the receive side (deployed `email-test` Worker + `TEST_TOKEN`) is unchanged.
- [ ] **AI swap**: `callModel` calls Workers AI over REST (run endpoint via the gateway URL, `…/accounts/{account_id}/ai/run/@cf/moonshotai/kimi-k2.7-code` shape), authed with `WORKERS_AI_TOKEN`. Model id stays isolated to `STUDIO_MODEL`, model-agnostic naming preserved ([[studio-model-agnostic-naming]]). Label the seam `target = REST-through-gateway` (not interim).
- [ ] **Response-envelope adapted**: the REST `/ai/run` shape wraps the payload one level deeper (`{ result, success, errors, messages }`) vs. the binding's unwrapped return; the seam unwraps `.result` (and asserts `success`) so [`parseModelTurn`](../apps/nebula/src/codegen-loop.ts)'s `.choices`/`.response` reads still work. **Tool-loop *logic* untouched; envelope adaptation added at the seam.** (Through the gateway the exact shape may differ — verify at build.)
- [ ] **Cheap shape probe** added to the `dev-studio` lane (return a REST-wrapped envelope, assert a tool_call still parses) so the contract is covered **outside** ui-smoke.
- [ ] **Gate**: replace the `.dev.vars`-grep `HAS_CF_CREDS` ([gates.ts](../apps/nebula/test/ui-smoke/gates.ts)) with explicit capability flags — `HAS_DOCKER` + `HAS_AI_PATH` (token-or-binding) + `HAS_EMAIL_LOOP` (`TEST_TOKEN`) — gating `describe.runIf` on the combination. Express via an explicit lane-set flag (the `LUMENIZE_NO_CF_REMOTE` family), **not** a secret-name grep (`testing.md` § E2E prefers opt-out).
- [ ] **Capable-of-failing**: the hosted ui-smoke turn must **fail** if `WORKERS_AI_TOKEN` is unset (proving it went through REST, not a silent fall-back to the `env.AI` binding). Mutation-cite it.
- [ ] **No secret leak** (`security.md`): read `WORKERS_AI_TOKEN` only at the fetch call site; log only `url.pathname` / model-id — never the full gateway URL or the `Authorization` header; any error wrapper scrubs headers before logging.
- [ ] A mesh `this.svc.ai` backlog item filed as Mesh product feedback (`mesh.md`) — not built here.
- [ ] (Side-effect, not a deliverable) per-call analytics visible in the AI Gateway — useful to the not-yet-written `nebula-tenant-ai-billing` work, **not** gated here.

## Phase 3 — All lanes into CI
**Goal**: every `apps/nebula` lane runs in CI — GHA + hosted.
**Success criteria**:
- [x] **Resend switch landed** for `browser` (+ `chromium`, shared config): `send_email remote:true` dropped, `EMAIL_PROVIDER: resend` set, `from` → `auth@test.lumenize.com`. Verified `browser` green on `RESEND_API_KEY` + `TEST_TOKEN` alone. *(`chromium` shares the config — inherits the fix; on-demand Playwright lane, not yet spot-run.)*
- [~] CI runs `apps/nebula` — `ci.yml` test job is now `--scope "packages apps"` (single quoted value — `test-code.sh` parses one `$2`). Local full always-on suite green (524 passed). **Confirm-green-in-CI proves out on push** (both GHA + the hosted lane).
- [x] `ui-smoke` and the spike's live turn stay **out of `npm test`** (the `package.json` enumeration omits them; the spike runs in `container-spike.yml`).
- [x] On-demand lanes (`secrets-facet`, `egress-choke`, `browser-bench`, `chromium`) stay manual (`--project`), not in the always-on run.
- [x] No `remote:true` binding remains in any always-on `apps/nebula` lane — `grep`-confirmed clean.
- [x] `apps/nebula`'s own `CLOUDFLARE_API_TOKEN` **not** needed by any always-on lane (browser now Resend; no `remote:true` to authenticate). Only the Phase-1 path-(1) deploy fallback would touch it.

## Deferred / later (pointers, not built here)
- **Mesh `this.svc.ai` capability** — wraps the Phase-2 REST path per ADR-007; the wrap should not merely relocate the call but **move the blocking AI fetch off the DO's wall-clock** (two-one-way to a Worker), so it isn't mistaken for a pure refactor. Mesh feedback item filed in Phase 2.
- **Mesh real-container `#1a` un-skip** ([`packages/mesh/test/container/container-seam.test.ts`](../packages/mesh/test/container/container-seam.test.ts)) — a packages-package follow-on enabled by Phase 1's mechanism.
- **Per-tenant AI cost attribution** — a future `nebula-tenant-ai-billing` task (memory pointer; **file not yet written**); Phase 2 just lights up the gateway analytics it would build on.
- **Nightly replay-and-tune loop** — the motivating use case for real AI in hosted; owned by [`nebula-nightly-loop`](nebula-nightly-loop.md) + [`nebula-studio-eval-suite`](on-hold/nebula-studio-eval-suite.md).

## Related
- [`tasks/lumenize-email.md`](archive/lumenize-email.md) — prerequisite ✅; established provider-by-env (Resend as the non-CF send path), `LUMENIZE_NO_CF_REMOTE`, and the "no broad CF token in the hosted plaintext lane" principle.
- Memory `project_ci_cloud_tests` (CI-green recipe); `project_nebula_pre_alpha` (downstream of the first deploy, not a blocker).
- [[vitest-remote-binding-load-time]] — `remote:true` bindings establish their proxy at pool-load; absent creds fail the whole project, hence the permanent drop rather than `it.skipIf`.
- ADR-007 — `callModel` is a per-node seam composed in; a future `this.svc.ai` follows the capability pattern.
