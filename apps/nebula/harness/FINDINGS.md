# Harness findings (mechanisms that worked + alternatives that failed)

Empirical notes from building the live self-verification harness (`tasks/archive/claude-live-verification.md`).
Phases 1–2 are exploratory in places; this records what actually worked so the next person doesn't
re-discover it.

## Prod drive (3b/3d) — autonomous, no boot, past Turnstile

`harness/prod.ts` drives the **deployed** Nebula (`nebula.lumenize.com`) with no local boot:

- **Turnstile bypass (forward-looking — a no-op today)** — the `nebula-auth` `checkTurnstile` bypass
  (a secret token in the `x-lumenize-turnstile-bypass` header = `NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN`,
  constant-time compared) skips ONLY the anti-bot gate; Turnstile stays ON for everyone else. The
  harness sends it on the one-time login (`refresh-token` / `my-scopes` / resource reads are already
  Turnstile-free). ⚠️ **Turnstile is currently OFF in prod** (`TURNSTILE_SECRET_KEY` unset — the
  pre-alpha deferral, confirmed via `wrangler secret list` 2026-07-06), and `checkTurnstile`
  short-circuits on the no-secret skip *before* the bypass check — so the live prod drive currently
  clears via that skip and the bypass header is a **no-op today**. The bypass is verified by unit
  tests (`packages/nebula-auth/test/turnstile-bypass.test.ts`, mutation-checked) and becomes
  load-bearing the moment `TURNSTILE_SECRET_KEY` is set at alpha (backlog § Nebula Auth).
- **claude@ routing** — the harness identity's magic-link must reach the email-test Worker. This needs
  an Email Routing **Routing rule** `claude@lumenize.io → email-test Worker` (a *Destination Worker*
  target). It does NOT need a verified **Destination Address** (that's only for forward-to-a-real-inbox
  rules) — the "Pending" destination-address entry is irrelevant and can be deleted.
- **Stored refresh (3d)** — the login seeds `harness/.prod-session.json` (gitignored) with the
  refresh-token cookie; subsequent runs refresh **headlessly** (~2.5s, no email) → a platform-scoped
  token →
  `my-scopes`. Verified live 2026-07-06: enumerated the real prod scope tree (`larry` universe +
  `nebula-platform`).
- **M1 — the stored platform-admin credential, honest about the threat model:** the real protections are
  (1) **behavioral** — prod writes/deploys/secret-changes stay deliberate (a rogue harness could mint
  any scope or ship a guard-less deploy, so per-scope/per-command ceremony in a harness we control is
  NOT a boundary — the reliance on asking-permission is the actual control, and it has to be), and
  (2) **external-leak hygiene** — the token lives in a gitignored file only, is NEVER logged (redacted
  everywhere), **kill-switch = delete `.prod-session.json`** and/or logout revokes it server-side
  (no rotation → slides until TTL/logout). Narrowest `activeScope` per op (enumerate uses
  `nebula-platform`) is blast-radius hygiene on accidental over-reach / a leaked single token, not a
  control. (A read-only admin *principal* would be a real control but is too big a cross-cutting guard
  change to be worth it — Larry, 2026-07-06.)

## Turnstile canary — bypass verified end-to-end + blocker catalog (2026-07-06)

`drive.ts turnstile-canary` boots a real local worker with Turnstile genuinely ON (an always-passes
Turnstile *test* secret injected for one boot via `HARNESS_TURNSTILE_SECRET` → `--var
TURNSTILE_SECRET_KEY`; no `.dev.vars` mutation, auto-reverts) and probes the gate 5 ways, all
side-effect-free (`discover` sends no email; the one `email-magic-link` probe 403s at the gate before
any send). All 5 passed:

1. plain request (no token/bypass — what the SPA sends today) → **403 BLOCKED** (gate on).
2. authorized `x-lumenize-turnstile-bypass` header → **200 PASSES** — the bypass, previously only
   unit-tested, now **verified end-to-end on a real worker with Turnstile genuinely on**. So the prod
   harness (`prod.ts`) will keep working the moment prod Turnstile flips on (today it's a no-op since
   prod Turnstile is off — this canary is how we prove the path without touching prod).
3. wrong bypass token → **403 BLOCKED** (constant-time validated, not mere header-presence).
4. request carrying a `cf-turnstile-response` token → **200 PASSES** — the SPA fix will clear the gate.
5. `email-magic-link` with no token → **403 BLOCKED** — the login path breaks as-is.

**Blocker catalog for turning prod Turnstile ON (all confirmed here):**
- **B0 — no widget is provisioned.** No `TURNSTILE_SECRET_KEY` in `.dev.vars`, no site key anywhere.
  Create a Turnstile widget in the CF dashboard first (→ site key for the SPA + secret key for
  `wrangler secret put`).
- **B1 — the SPA has no widget.** `apps/nebula-studio-ui/src/App.vue` sends no token on its 3 gated
  calls (`discover` L88, `email-magic-link` L123, `claim-universe` L144) → all 403 with Turnstile on.
  Fix: load the Turnstile script, render/execute a widget, thread `cf-turnstile-response` into the 3
  POST bodies. Wrinkle: `sendMagicLink()` fires TWO gated calls back-to-back (`discover` then
  `email-magic-link`) and Turnstile tokens are single-use → execute the widget twice (or restructure).
- **Latent — `claim-star`** is Turnstile-gated but not wired in the SPA (only `claim-universe` is);
  it'll need the widget when it gets a UI.
- **Latent — any test lane pointed at prod** (ui-smoke `BENCH_BASE_URL` → prod) would 403 on login
  once prod Turnstile is on unless it sends the bypass header.

## Boot — NO `--local` (the big one)

`bootDevStack` must boot like `npm run dev` — **plain `wrangler dev`, no `--local`**.

- **Worked:** plain `wrangler dev` reaching `Ready on http://…`, using the `wrangler login` OAuth
  session for the remote `AI` / `send_email` bindings. Verified live: `message-roundtrip` PASSED.
- **Failed:** forcing `--local` (an earlier `!process.env.CLOUDFLARE_API_TOKEN` auto-detect — wrong
  locally, since a `wrangler login` session is not a token env var) made apps/nebula **hang after the
  DevContainer image build**: workerd listens but never becomes ready, no `Ready on` is ever logged,
  reproduced with a bare `wrangler dev`. Not a code bug — a `--local`+container interaction.
- **Latent:** the ui-smoke lane's `hostedLocalBoot` uses the identical detect → likely hangs the same
  way on a local run. Flagged as product feedback.
- **Recovery from a killed boot:** `pkill -9 -f workerd` (a wrangler stuck mid-boot doesn't propagate
  SIGINT to its workerd child — also fixed in `spawnWranglerDev`'s ready-timeout path) and
  `rm -rf apps/nebula/.wrangler` (stale/locked state; the Docker image cache is separate).

## Identity — local mint (API) vs real login (browser)

- **API driver (Phase 1):** `createNebulaTestToken` mints the correct `access:{authScope,admin}`
  shape with the `.dev.vars` key — no email. Verified: the correct-shape token connects + round-trips;
  a base flat-`isAdmin` token and a nebula-shaped-but-no-`access` token both `403` at the gateway.
- **Browser driver (Phase 2):** the SPA drives its own **cookie-based** refresh (App.vue →
  `createNebulaClient`), so there is **no client-side `accessToken` injection point** — a locally-minted
  access token is not a server-issued refresh cookie, so cookie/token injection to skip login
  **resists** without editing the SPA. → Fall back to the **real magic-link login** (ui-smoke's proven
  loop). The email-test Worker filters by **scope**, not recipient, so any `@lumenize.io` address CF
  Email Routing forwards works; `test@lumenize.io` is proven-routed, `claude@lumenize.io` needs a
  routing check (`HARNESS_LOGIN_EMAIL` overrides).

## Browser login is flaky on the email leg (external dependency)

The magic-link login rides the real CF Email Sending → Email Routing → deployed email-test Worker
loop, whose delivery latency **varies run to run** — one run's email arrived in ~20s, a later run
timed out at 60s (`No email received within 60000ms`). That's the external-service flake
(testing.md), not a harness defect. Mitigations: a generous `waitForEmail` timeout (120s), and
capture BEFORE the reload so a partial run still yields the pre-reload proof. If a reliable, fast,
email-free browser login is wanted later, it needs an SPA-side accessToken injection point (see the
cookie-injection note above) — currently absent.

## Capture BEFORE the transition, not just the end state

The first browser scenario asserted only "a screenshot exists" and captured only the POST-reload
state — so "empty after reload" was ambiguous (turn never posted vs. posted-then-lost), and the
capture over-claimed. Fix: capture **before** the reload (proving the turn actually rendered) AND
after, and don't swallow the echo-wait. This is the testing.md self-healing-end-state trap applied
to exploratory capture: snapshot the transient state the behavior governs, not only the healed end.

## Browser capture primitives (Playwright 1.58)

- **a11y snapshot:** `page.accessibility.snapshot()` was **removed** in Playwright 1.49+ — use
  `Locator.ariaSnapshot()` (a YAML-ish role/name tree).
- **Console/network capture:** attach `page.on('console'|'pageerror'|'requestfailed'|'response')`
  **before** navigation (listeners only see later events). Screenshot: `fullPage: true`.
- Artifacts land under `harness/.artifacts/<label>/` (gitignored): `screenshot.png`, `a11y.yaml`,
  `console-errors.json`, `failed-requests.json`.

## Chromium executable

Lifted from ui-smoke: prefer Playwright's pinned build; fall back to a `PLAYWRIGHT_BROWSERS_PATH`
`chromium-*` build (the hosted image ships one that may not match the pin).
