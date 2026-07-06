# Harness findings (mechanisms that worked + alternatives that failed)

Empirical notes from building the live self-verification harness (`tasks/archive/claude-live-verification.md`).
Phases 1–2 are exploratory in places; this records what actually worked so the next person doesn't
re-discover it.

## Prod drive (3b/3d) — autonomous, no boot, past Turnstile

`harness/prod.ts` drives the **deployed** Nebula (`nebula.lumenize.com`) with no local boot:

- **Turnstile bypass** — prod's `email-magic-link` / `discover` are Turnstile-gated (403 without a
  browser token). The `nebula-auth` `checkTurnstile` bypass (a secret token in the
  `x-lumenize-turnstile-bypass` header = `NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN`) skips ONLY Turnstile;
  Turnstile stays ON for everyone else. Used ONLY for the one-time login (`refresh-token` /
  `my-scopes` / resource reads are already Turnstile-free).
- **claude@ routing** — the harness identity's magic-link must reach the email-test Worker. This needs
  an Email Routing **Routing rule** `claude@lumenize.io → email-test Worker` (a *Destination Worker*
  target). It does NOT need a verified **Destination Address** (that's only for forward-to-a-real-inbox
  rules) — the "Pending" destination-address entry is irrelevant and can be deleted.
- **Stored refresh (3d)** — the login seeds `harness/.prod-session.json` (gitignored) with the
  refresh-token cookie; subsequent runs refresh **headlessly** (~2.5s, no email) → a `*` token →
  `my-scopes`. Verified live 2026-07-06: enumerated the real prod scope tree (`larry` universe +
  `nebula-platform`).
- **M1 controls (the stored `*`-admin credential):** kept in a gitignored file only; NEVER logged
  (redacted everywhere); request the narrowest `activeScope` per op (enumerate uses `nebula-platform`
  for the `*` reach — narrow it for data reads); **kill-switch = delete `.prod-session.json`** (forces
  a fresh login) and/or logout revokes the refresh token server-side; refresh tokens don't rotate so
  they slide until the TTL lapses or logout.

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

- **API driver (Phase 1):** `createNebulaTestToken` mints the correct `access:{authScopePattern,admin}`
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
