# Studio UI — Single-Origin Local Serving (Vite Proxy + Endpoint Prefixes)

**Status**: ✅ **DONE 2026-06-24** — first deterministic build of [`nebula-pre-alpha.md`](../nebula-pre-alpha.md)
Wave 1's resequenced trio (① this → ② Playwright smoke + `it.skip` cleanup [master-plan bullet] → ③ the deploy
task [`nebula-release-process.md`](../nebula-release-process.md)). `/review-task` (both stages) → `/build-task`:
**model A** (`vite dev` + proxy) settled by a live spike — the proxy carries vite-HMR + `/gateway` mesh +
`/dev-container` preview WS together (the "Pages-WS-flaky" worry disproven); **model B not needed.** Landed: the
`npm run dev:studio` `ttab` launcher (confirmed working) + a mutation-validated `entrypoint-routing-contract.test.ts`
(5 green). **Frozen on archive — this file IS the contract the deploy task ③ transcribes** (the prefix split +
`/app` SPA-owned + the prod-Assets mechanism, below; ③ extends the routing test with the model-B SPA-fallback
assertions). A first prod deploy isn't F&F-usable until the Studio UI is served from the Worker; this task settled
the dev/prod-shared API-vs-SPA path split.

## Objective

The two-process local dev setup already works (Studio SPA on vite, same-origin with the `wrangler dev` Worker via
a proxy), and the **API** split is already clean (the proxy forwards exactly `/auth /gateway /dev-container`, which
the Worker entrypoint serves). The value of writing it down is that the *full* contract surfaces the easy-to-miss
backend-issued paths a casual read drops — notably the **`/app` post-login redirect** the SPA must own (found
during review) — plus the prod Workers-Assets routing mechanism. So this task is:

1. **Write the split as a documented contract** — the exact API-prefix set + the SPA-owned space + the prod
   `index.html` fallback rule — so the deploy task's Workers-Assets routing is a transcription, not a redesign.
2. **Settle the dev serving model** (a Phase-1 spike — model A vs B, below).
3. **Add a one-command dev launcher** (ergonomics — *secondary* to 1–2).

Get the prefixes right once; both the dev proxy and prod serving inherit them.

## Background

**The two-terminal setup is correct, not a smell — keep it.** A vite dev server + an API Worker joined by a
same-origin proxy is the standard SPA-on-an-API pattern.
- **Terminal A** — `cd apps/nebula && npm run dev` (`wrangler dev`, `:8787`): the API Worker + the DevContainer
  (Docker Desktop). The container is why we keep real `wrangler dev`.
- **Terminal B** — the Studio-UI process (`:5174`), same-origin with the Worker (**required** for the
  `SameSite=Strict` refresh cookie + the mesh/preview WebSockets). **The dev serving model is a Phase-1 spike —
  two viable models:**
  - **(A) `vite dev` + proxy (true HMR)** — vite serves the SPA with HMR and proxies
    `/auth /gateway /dev-container` → `:8787` (`ws:true` on the WS ones). *Pro:* fastest iteration. *Con/risk:* dev ≠
    prod (vite serves the SPA in dev, Workers Assets in prod), and Workers Assets is "a similar beast to Pages" —
    HMR/WS-through-the-stack coexistence may be flaky (the same class of problem that pushed blueprint off vite-dev).
  - **(B) `vite build --watch` + the Worker serves the built SPA via Workers Assets locally** — *Pro:* dev/prod
    parity (the real Assets serving + the prefix split validated locally → the deploy de-risked). *Con:* no HMR
    (full reload on rebuild), but build-watch is fast on modern hardware (M4). **Different topology:** Terminal B
    is a *headless* `vite build --watch` (not a server, **no proxy** — the `vite.config.ts` proxy is model-A-only);
    the **browser points at the Worker `:8787`**, which serves SPA + Assets + API as one origin. So under (B) the
    cookie/WS land on `:8787`, not `:5174`.
  - **The one consequence to record (stated here, once):** model (B) pulls the **minimal** `assets` binding +
    entrypoint serve **up into this task** (you can't run local Assets without it); model (A) leaves all Assets
    work in the deploy task. Either way, prod Assets **deployment** + the real login UI stay in the deploy task
    (Decision 3, below).
  - **Lean:** try (A) for the HMR; adopt (B) if (A) fights — or for the parity/validation bonus.

**Why NOT the Cloudflare Vite plugin** (avoid it): it runs the Worker as **workerd-inside-vite**, which may share
the limitation that makes us skip tests under vitest-pool-workers — **it can't construct a `Container`**
(`container-no-construct-pool-workers`) → would break the DevContainer preview. (Larry hit problems with it
twice, ~9 months ago.) The vite-proxy-to-**real**-`wrangler dev` keeps Docker/Containers working.

**One-command launcher (secondary ergonomics deliverable).** Replace the by-hand two-terminal start with a single
`npm run dev:studio` that spawns both titled tabs via **`ttab`** — `npx ttab -t '<title>' -d <dir> npm run <script>`
(needs macOS Accessibility permission; runs via `npx`, no global install). Prior art:
`lumenize-monolith` `package.json` `"dev"` (2 tabs) + `~/Projects/blueprint/scripts/dev.sh` (4 tabs).
**Structural secret boundary (by construction, not a vigilance ask):** the launcher injects **only** a closed
allowlist of *non-secret* switches (`NEBULA_WORKER_URL` when wrangler picks a non-8787 port, `DEBUG`); the
secret/test-mode flags `NEBULA_AUTH_TEST_MODE` / `NEBULA_AUTH_BOOTSTRAP_EMAIL` have **no launcher codepath at
all** — they flow solely via the gitignored `.dev.vars` (their one legitimate channel per `packaging.md`). So the
committed launcher *cannot* carry a secret.

**Prod serving (Decision 3) is the deploy task's.** Prod = `vite build` → **Workers Assets** (same-origin), pinned
in the frozen `tasks/archive/nebula-studio.md` (read-only). The `assets` binding + the `vite build` step + the
real magic-link login UI land in the **deploy task's Phase 0** — *this* task just writes the contract that wiring
transcribes (and, under model B, stands up the minimal local Assets serve it inherits).

## Current paths (verified 2026-06-24)

- **Worker (`apps/nebula/src/entrypoint.ts`)**: `/auth/*` (nebula-auth), `/gateway/*` (mesh WS), GET/HEAD
  `/dev-container/*` (preview shell + vite assets + HMR WS), else **404**. `/_version` is a root literal carve-out
  **already pinned + owned by the deploy task** (matched before fallthrough; curl/bench-only, never the SPA — so
  it needs no vite proxy rule and can't collide with the fallback).
- **SPA (`apps/nebula-studio-ui`)**: single-view, **no client-side router** (verified — no `vue-router`); owns
  `/` **and `/app`** + its built assets. `/app` is the **post-login landing**: `apps/nebula/wrangler.jsonc` sets
  `NEBULA_AUTH_REDIRECT: "/app"` and the prod magic-link/verify/approve handlers issue `302 Location: /app` — so
  in prod the browser IS redirected there (dev hides this: `App.vue` follows the magic link with
  `redirect: "manual"`). The current entrypoint `else → 404` would **404 `/app` in prod** — it must be SPA-served.
  The SPA calls only `/auth /gateway /dev-container` same-origin (dev login
  `POST /auth/${scope}/email-magic-link?_test=true`, then `createNebulaClient` over `/gateway`, preview iframe
  over `/dev-container`).
- **Vite proxy (`vite.config.ts`)**: forwards exactly `/auth /gateway /dev-container`.

→ The API split (`/auth /gateway /dev-container`) is exhaustive + collision-free; the **SPA-owned set is `/` +
`/app`** (the `NEBULA_AUTH_REDIRECT` landing — easy to miss, and the reason this contract is worth writing). Phase
1 *confirms + documents* the full split; re-prefixing of the API side is a contingency only if the audit surfaces
a gap (none expected).

## Phase 1: Confirm + document the split, settle the serving model (the deciding step)

**Goal**: (1) the written **prefix contract** — API-prefix set + SPA-owned space + the prod `index.html` fallback
rule, confirmed exhaustive/collision-free; (2) the **serving model** (A/B) decided via a quick spike.

**Approach**:
- **Confirm the split + cross-check the redirect.** It already agrees across the proxy / entrypoint / SPA (see
  Current paths). Crucially, **cross-check `NEBULA_AUTH_REDIRECT`** (`apps/nebula/wrangler.jsonc`) against the
  SPA-owned set — its value (`/app`) is a backend-issued landing path the prefix audit otherwise misses. Write the
  result as the contract the deploy task transcribes. Don't rename `/auth /gateway /dev-container` without cause;
  don't invent an `/api/*` umbrella ([[feedback_naming_judgment]]). Re-prefix only if the audit surfaces a gap.
- **The prod fallback rule — pin the CF Workers-Assets MECHANISM, not just the abstract rule** (this is the
  load-bearing thing the deploy task transcribes). In CF the SPA fallback is *declarative*
  (`assets: { not_found_handling: "single-page-application", run_worker_first: true }`) and static assets are matched
  **before** the Worker unless `run_worker_first` is set — and `apps/nebula` has a real `main` whose entrypoint
  ends in `return new Response('Not Found', {status:404})`. So the contract must specify: **Worker runs first** →
  matches the API prefixes + the `/_version` literal (these keep precedence) → the terminal `else` returns
  **`env.ASSETS.fetch(request)` instead of `404`** → Assets serve `index.html` for unmatched paths (`/`, `/app`,
  hard-refresh). State the exact keys (`{ directory, binding, not_found_handling, run_worker_first }`) so it's a
  transcription. (A bare `assets` binding with default precedence is an active footgun — it shadows the API.)
- **Decide the serving model (A vs B) — a quick spike with a real exit bar, not paper.** Try (A): do `vite dev`
  HMR + the proxy + the mesh/preview WS coexist? The exit bar is NOT a single happy turn — force a **live source
  edit** (HMR for A / rebuild for B) AND confirm **both** WebSockets (mesh `/gateway` + preview `/dev-container`)
  survive/reconnect across it (the exact coexistence failure that pushed blueprint off vite-dev). Keep (A) if it
  holds; else adopt (B). If (B) is chosen, **stand up its minimal local Assets serve once** here so the parity
  claim is real, not paper. (The Assets-wiring consequence of each is single-sourced in Background.)

**Success criteria**:
- [ ] The written contract exists: API prefixes (`/auth /gateway /dev-container`) + the `/_version` literal
  carve-out + the **SPA-owned set `/` + `/app`** + the prod-Assets mechanism (the exact `assets` keys +
  Worker-first precedence + terminal-`404`→`env.ASSETS.fetch`). Confirmed **exhaustive** (every backend-issued
  path — including the `NEBULA_AUTH_REDIRECT` landing — is accounted for) and **collision-free**.
- [ ] The serving model (A or B) is decided + recorded — with the exit bar met (live edit + both WebSockets
  surviving across it; if B, the minimal local Assets serve stood up once).
- [ ] Any needed re-prefixing is listed; otherwise stated explicitly that none was needed.

## Phase 2: Implement — proxy/endpoint match + the launcher

**Goal**: the Worker, SPA, and vite proxy match the Phase-1 contract; the dev launcher exists.

**Approach**:
- Apply any Phase-1 endpoint-prefix changes to `entrypoint.ts` (and the SPA's calls if a prefix moved); update
  the 3-entry vite proxy to match (keep `ws:true` for `/gateway` + `/dev-container`) — by hand, **not** a proxy
  config-generator.
- **Capable-of-failing routing check** (the contract's "exhaustive/collision-free" claim must be testable here,
  not only in Task ②'s unwritten smoke). Add a small pool-workers (or curl-matrix) test against `entrypoint.fetch`:
  `/auth /gateway /dev-container` route to the backend; a **mistyped API path (`/gatewayX`) is NOT silently served
  as SPA**; and (model B) `/` + `/app` + a hard-refresh path serve `index.html` while `/_version` keeps its
  carve-out. Pick a discriminator the wrong split would carry. (Under model A there's no Worker-side SPA fallback,
  so the test asserts non-prefixed → `404` instead.)
- **If model (B)**: add the *minimal* local `assets` config the deploy task will inherit — the exact keys
  (`assets: { directory, binding, not_found_handling: "single-page-application", run_worker_first: true }`) **and**
  the `entrypoint.ts` terminal-`404`→`env.ASSETS.fetch(request)` rework (Phase 1 / Background). **If model (A)**:
  no Assets work here.
- **Launcher (secondary):** `npm run dev:studio` (e.g. `scripts/dev-studio.sh`) spawns both `ttab` tabs
  (`apps/nebula` `wrangler dev` :8787; the Studio-UI process — model A: `vite` serving `:5174`; model B: headless
  `vite build --watch`), injecting **only** the non-secret allowlist (`NEBULA_WORKER_URL`, `DEBUG`). Document the
  macOS Accessibility-permission prereq.

**Success criteria**:
- [ ] The routing-matrix test passes AND is capable-of-failing: a mistyped `/gatewayX` is **not** served as SPA;
  `/auth /gateway /dev-container` route to the backend; (model B) `/` + `/app` serve `index.html` and `/_version`
  keeps its carve-out.
- [ ] The vite proxy forwards exactly the contract's API prefixes; all other paths fall through to the SPA.
- [ ] `npm run dev:studio` launches both tabs; the committed launcher **names no secret/test-mode var** (a
  structural property, not a vigilance ask).

## Phase 3: Validate the local loop end-to-end

**Goal**: the full local loop works against the contract — leaving the setup ready for Task ②'s Playwright smoke
(the smoke itself is Task ②, not here).

**Prerequisites**: Docker Desktop (`docker context use desktop-linux`) + `NEBULA_AUTH_TEST_MODE=true` /
`NEBULA_AUTH_BOOTSTRAP_EMAIL=dev@example.com` in the gitignored root `.dev.vars` — see
`apps/nebula-studio-ui/README.md` (update it for `dev:studio` + the Accessibility prereq as part of Phase 2).
*(The refresh cookie is `Secure; SameSite=Strict`; dev login works over `http://localhost` only because browsers
treat `localhost` as a secure context — don't move the dev origin to a LAN IP / non-localhost host over http
without switching to https, or the cookie silently drops.)*

**Approach**:
- `npm run dev:studio`; open the browser at the **model's origin** — `:5174` for model A (vite), **`:8787` for
  model B** (the Worker serves the SPA, no proxy). Dev login (test-mode magic-link) → a chat turn → the preview
  iframe renders. Confirm live-update works (HMR for A; fast rebuild-reload for B) and the mesh + preview
  WebSockets connect (through the proxy under A; same-origin to `:8787` under B).

**Success criteria**:
- [ ] Manual pass: login → chat → preview renders; live-update works; no console/proxy errors.
- [ ] `apps/nebula-studio-ui/README.md` updated to the `npm run dev:studio` flow (+ Accessibility prereq).
- [ ] The setup is confirmed ready for a Playwright UI smoke to drive it (Task ②).

## Phase-1 spike result (2026-06-24)

**Model (A) chosen — `vite dev` + proxy.** The spike held: the vite proxy carries **three** WS-channels
simultaneously — vite's own HMR WS, the **`/gateway` mesh WS** (the Studio SPA's `NebulaClient` →
`NebulaClientGateway`; the chat `client.lmz.callRaw("DEV_STUDIO", …)` rides it), and the **`/dev-container`**
preview connection — proven by a working login → chat → preview loop **plus a post-login HMR source edit with
both WS surviving**. The "Workers-Assets-is-like-Pages → WS-through-the-proxy is flaky" worry is **disproven**.
So **model B is NOT needed**: no local `assets` binding here, no `entrypoint.ts` terminal-`404` rework — prod
Assets serving stays wholly in the deploy task (Decision 3). *(Key realization: the two WS to validate are the
Studio's OWN, not the generated app's — the generated app needn't use Resources for this.)*

## Open questions

- *(none — the serving-model spike is resolved above.)*

## Notes / links

- Existing proxy: `apps/nebula-studio-ui/vite.config.ts`. Worker routing: `apps/nebula/src/entrypoint.ts`.
  Studio SPA: `apps/nebula-studio-ui/src/{App.vue,main.ts}` + `README.md` (gathers the Docker + `.dev.vars`
  prereqs). Dev login: the `?_test=true` param returns the magic link in-body **only when
  `NEBULA_AUTH_TEST_MODE=true`** (env, `.dev.vars`-only — also skips Turnstile); the param is **inert in any
  deployed Worker** because that flag is never deployed. The boundary is the flag, not the param.
- **Decision 3** (prod Workers-Assets serving, same-origin): `tasks/archive/nebula-studio.md` (frozen — read only).
- Reference proxy pattern: the existing `nebula-studio-ui` config; `~/Projects/blueprint/vite.config.js`.
- **Launcher prior art (`ttab`):** `lumenize-monolith/package.json` `"dev"` (2 tabs) + `~/Projects/blueprint/scripts/dev.sh`
  (4 tabs, `npx ttab -t '<title>' -d <dir> npm run <script>`); needs macOS Accessibility permission; not yet used here.
- **Sequenced before**: Task ② (Playwright smoke — ≥1 Resources hit + ≥1 UI-level test, incl. fully exercising the
  **real magic-link login** under `wrangler dev`, all-Cloudflare ~1–3 s for `@lumenize.io`; + the `it.skip`
  relocation; master-plan bullet only) → the deploy task ([`nebula-release-process.md`](../nebula-release-process.md),
  whose Phase 0 gains Decision-3 Assets serving + the real prod login on return, reviewed then). Captured in
  `tasks/backlog.md` § Testing & Quality.
