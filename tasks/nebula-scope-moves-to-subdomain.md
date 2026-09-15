# The scope moves from a URL segment to a subdomain

**Status:** Pass 1, 2026-09-15 — design intent only, no phases. [ADR-021](../docs/adr/021-every-scope-has-its-own-host.md) and [ADR-022](../docs/adr/022-each-host-holds-its-own-session.md) carry the decisions. This file carries what building them in this repo needs, and cites the ADRs rather than restating them. ② Testing with personas waits on it.

**Objective — every scope is served from a host of its own, and every host holds its own session, in production, in the local stack and in the `/live` harness alike.**

Today one host serves everything, with the scope in the path. Studio for the galaxy `acme.crm` is `https://nebula.lumenize.com/acme.crm`, its preview is `/app/acme.crm.dev/` on that same host, and its refresh is `POST /auth/acme.crm/refresh-token`. After this build they are `https://crm.acme.lumenize.dev/`, `https://dev.crm.acme.lumenize.dev/`, and `POST /auth/refresh-token` on each host.

**Four goals, in the order they matter:**

1. **No credential crosses hosts, and generated code leaves Studio's origin.** Today a login sets one cookie per membership on `nebula.lumenize.com`, told apart only by `Path`. The preview runs the user-developer's generated code on Studio's own origin, where it shares Studio's `localStorage` and can call Studio's auth endpoints with the user-developer's cookies.
2. **A shared link opens the same scope and view, even across a login** ([ADR-017](../docs/adr/017-the-url-is-the-view-state.md)). Today a signed-out visitor's destination waits in `localStorage['nebula.returnTo']`, which a magic link opened in another browser never sees.
3. **The client names neither `authScope` nor `activeScope`.** A scope host supplies both from its host, and the platform host's server picks among its own cookies. A call's target scope still rides its parameters, as `invite(targetScope, …)` does. Today Studio reads `authScope` from a `localStorage` hint keyed `nebula.authScope:{activeScope}`, and every refresh names `activeScope` in its body.
4. **The local stack and `/live` serve the same hosts production does.** A scenario may not bridge a difference between the local stack and production (`.claude/rules/live.md` § *A `/live` scenario MUST NOT compensate for its environment*), so the local stack has to answer for many hosts too. Today it answers on one `http://localhost:{port}`; intent 1 below gives it a host per scope under `lumenize.localhost`.

## Relationships

- **Gates ② Testing with personas, [nebula-testing-with-personas.md](nebula-testing-with-personas.md).** A persona tab needs a host of its own. This build already parses a persona's host and builds the `/auth/handoff` its tab will use. The personas build adds `mayIssueLink` and the link from a persona's session to the Studio session that issued it.
- **Lands before ⑥ the wipe.** `PLATFORM_SCOPE`'s rename and the reserved slug sets are stored data, which is why the master plan gates this build `data`.
- **Answers [nebula-same-origin-guard.md](nebula-same-origin-guard.md)'s question.** ADR-022's `Sec-Fetch-*` checks are the origin check that file weighs, and its premise — hostile tenant content on a different registrable domain from Studio — no longer holds.

## Context and current state

**Built already**, grouped by what it serves.

### Serving

- **One route, `nebula.lumenize.com` as a `custom_domain` in `apps/nebula/wrangler.jsonc`.** *Replaced* by a proxied `*.lumenize.dev` DNS record, a record for the apex, and one `*.lumenize.dev/*` Worker route, which served every depth in [the 2026-09-14 run](../experiments/wildcard-host-routing/RESULTS.md).
- **`apps/nebula/scripts/local-config.mjs` strips `routes` before `wrangler dev`**, so the Worker sees the `Host` a caller used. *Carried unchanged:* it is what lets one local `wrangler dev` answer for many hosts.
- **`entrypoint.ts`'s `router` dispatches on the path alone.** `/app/:scope/*` goes to the Galaxy through `serveAppForward`, `/auth/*` to nebula-auth, `/gateway/*` to the Gateway, and anything unmatched to Studio's single-page app through `assets.not_found_handling`. *Adapted:* it dispatches on the host first (§ *Design intent, constraints, and future state*).
- **The preview is served at a path, and its scope rides a `<meta>` tag the Galaxy injects.** `Galaxy.#serveBuiltApp` answers `/app/{u}.{g}.{s}/*`, takes the Star from the path, and serves only the `dev` Star. Into each HTML page it injects `nebula-scope`: `activeScope` is the Star, `authScope` the parent galaxy, and `ontologyVersion` the installed ontology. The scaffold's `apps/nebula/container/app/src/nebula.ts` hands all three to `createNebulaClient`, and navigates to `/login` when the client fails to get ready. *Adapted:* at `dev.crm.acme.lumenize.dev` the host is the scope, so the two scope fields go and only `ontologyVersion` still needs the server (ADR-022 § *What a session carries*). The `/login` navigation becomes the frame's `needs-session` post (ADR-022 § *Frames*).

### Sessions

- **`buildAuthRouteTable` in `packages/nebula-auth/src/router.ts` puts the scope in the path** for every route a cookie authenticates — `refresh-token`, `logout`, `logout-all`, `accept-membership`, `pending-membership`, `home` — and for the emailed `magic-link` and `accept-invite`. *Adapted:* a scope host reads its scope from the host, and the routes split across hosts by the credential each reads (intent 2 below).
- **`refreshCookie` in `worker-token.ts` writes `refresh-token=…; Path=/auth/{scope}; HttpOnly; Secure; SameSite=Strict`**, and `consumeAndLogin` sets one per membership, capped at `MINT_ALL_COOKIE_CAP`. *Adapted:* the consume still sets one per membership, now on the platform host as `__Host-refresh-token.{scope}` at `Path=/`, `Lax`. A scope host holds exactly one `__Host-refresh-token`, `Strict`.
- **`handleRefreshToken` reads Workers KV, falls back once to the Registry's `getRefreshRecord`, and requires `activeScope` in the body.** *Adapted:* the body is empty on every host. A scope host's refresh takes its scope from the host, and a record answers only on the host it was issued for. The fallback is carried unchanged.
- **Emailed links take their host from the request.** `#magicLinkUrl` builds `${origin}/auth/{scope}/…` from the inbound `url.origin`, and `NebulaAuthFacade` uses `callContext.originRequest?.origin`, falling back to `NEBULA_AUTH_ISSUER`. *Adapted:* every emailed link lands on the platform host.
- **Nothing tests that an emailed link follows the request's host.** `describe('Outbound URL host-awareness (Phase 0 guard)')` did, until `4cb069e` deleted it on 2026-07-13. [The sessions record](archive/decision-sessions-per-origin.md) § *What changes in today's code* still describes it as present. *Missing:* this build owes a successor (§ *Criteria to carry into the phases*).
- **`NEBULA_AUTH_ISSUER` is `https://nebula.lumenize.com`**, set in `access-claims.ts` and checked in `verify.ts`. *Adapted:* it names the platform host.

### Client

- **`NebulaClient` refreshes at `/auth/{authScope}/refresh-token` with `{ activeScope }`, then writes the `nebula.authScope:{activeScope}` hint.** A 401 or 403 throws mesh's `LoginRequiredError` and fires `onLoginRequired`. *Adapted:* the refresh is `POST /auth/refresh-token` with no body. A 401 starts the round trip through the platform host at top level, or posts `needs-session` from a frame (ADR-022 § *Getting a session: a round trip through the platform host*). The hint goes, with its readers in `App.vue` and `auth/HomeScreen.vue`.
- **Home, `HomeScreen.vue`, is reached only at `/auth/{scope}/home`.** Its `bootstrap` refreshes at that scope, `pending-membership` and `accept-membership` pick their cookie by the same segment, and `scope-summary` is the one route it calls with a token. A visit that names no scope lands on Studio's signed-out page, even with live cookies. *Adapted:* Home lives on the platform host, its refresh takes no body (intent 4 below), and acceptance names the membership it accepts.
- **Studio's `App.vue` reads the scope from the first path segment, and `enterScope` moves between scopes with `leaveTo('/{scope}')`.** Its preview frame's `src` is the relative `/app/{u}.{g}.dev/`. *Adapted:* the scope comes from the host, moving to another scope navigates to its host, and the frame's `src` is the dev Star's host. `view-state.ts` stays the one place the URL is read (`.claude/rules/ui-routing.md`).
- **`view-state.ts`'s `rememberReturnTo`, `takeReturnTo` and `validReturnTo` keep a signed-out visitor's destination in `localStorage`.** *Left behind:* `return_to` and the magic-link record replace them.
- **The Gateway's WebSocket URL carries no scope** — `/gateway/NEBULA_CLIENT_GATEWAY/{sub}.{tabId}` — and `onBeforeConnect` verifies the token and forwards it as `Authorization: Bearer`. *Carried unchanged:* each client connects to its own host's `/gateway/`.

### Names that assume a scope is a path segment

- **`PLATFORM_SCOPE` is `'nebula-platform'`** in `packages/nebula-auth/src/types.ts`. *Adapted:* it becomes `'platform'`, a stored scope id.
- **`RESERVED_STAR_SLUGS` is `{'dev'}`**, and `apps/nebula/test/test-helpers.ts` declares a second copy. *Adapted:* it holds the eight environment names ADR-021 reserves, and the copy folds into the import.
- **`RESERVED_UNIVERSE_SLUGS` exists because a universe slug is the first path segment.** *Re-derived:* that reason dies, and platform labels such as `platform`, `email` and `www` become the reason instead (`.claude/rules/calibration.md` §4).
- **`isValidSlug` in `packages/nebula-auth/src/parse-id.ts` checks every universe, galaxy and Star slug, and caps no length.** It allows lowercase letters, digits and hyphens, and refuses a leading or trailing hyphen or a `--`. *Adapted:* it gains ADR-021's 30-character cap, so `northwind-traders-international`, at 31, is refused at signup. The persona floor of 3 is the personas build's: a label with `--` as its third and fourth characters is reserved for punycode, and certificate authorities refuse to name one (ADR-021 § *How a host spells a scope*).
- **`validateSlug` in `apps/nebula/src/dag-ops.ts` checks an org-tree node's slug with a grammar of its own**, allowing 100 characters and a `--`. *Adapted:* it calls `isValidSlug`, so a node slug gets the same grammar and the same 30-character cap.
- **Three JSDoc comments plan a split between `lumenize.dev` and `nebula.lumenize.com`**, in `nebula-auth-facade.ts`, `profile-pictures.ts` and `home-logic.ts`. *Re-derived:* each guards something, and the new grammar decides whether it still needs guarding.
- **Every other `nebula.lumenize.com`** — `grep -rl 'nebula\.lumenize\.com' --exclude-dir=node_modules --exclude-dir=archive` finds deploy scripts, the harness's `prod.ts` and `mintDegradedToken`, tests and docs. *Adapted* at each site. A generated file such as `platform-embed.ts` changes at its source.

### Venues

- **`bootDevStack` runs `wrangler dev` at `http://localhost:{port}` on a free port, and `bootStudioVite` serves Studio on 5174, proxying `/auth`, `/gateway`, `/app` and `/pictures` to it.** Scenarios name scopes in paths, and `loginViaEmail` fetches an emailed link as sent. *Adapted:* hosts become `{scope}.lumenize.localhost:{port}`. Following a link as sent is carried unchanged.
- **`deploy-test.sh` deploys `test-nebula` with `routes` deleted, so it answers on `workers.dev`**, whose hosts are one label deep. *Adapted:* it deploys with `lumenize-test.dev`'s routes in place of production's, and with that domain's origin (intent 1 below).

## Design intent, constraints, and future state

The decisions are ADR-021's and ADR-022's. What follows is what building them here commits to, where the ADRs leave the choice to the build.

1. **The deployment names its origin once, and every host parses against it.** Production's is `https://lumenize.dev`, the deployed test target's is `https://lumenize-test.dev`, and the local stack's is `http://lumenize.localhost`, with the port taken from the request. It is one `wrangler.jsonc` var, which `local-config.mjs` rewrites for the local stack as it already strips `routes`, and `deploy-test.sh` rewrites for the test target. Stripping that suffix and reading the rest right to left makes `tenant1.crm.acme.lumenize.localhost:54321` the scope `acme.crm.tenant1`, exactly as `tenant1.crm.acme.lumenize.dev` is. The parse reads ADR-021's whole grammar, persona labels such as `manny--dev` included. One function does it. It backs the `return_to` check and every URL the platform mints — a magic link, an invite link, a frame's `src` — so a Star's custom domain later joins in one place (ADR-021 § *Deliberately open*).
   - **`http` is enough locally, because Chromium counts `*.localhost` as a secure context.** Measured 2026-09-15 by a scratch probe on macOS, with Node 24.19 and Playwright's Chromium 145. Chromium stores `Secure` and `__Host-` cookies over plain `http` there, and keeps them host-only. Node's `fetch` and `WebSocket` and Chromium all resolve `*.lumenize.localhost` at any depth to loopback, with no `/etc/hosts` entry. Every `*.lumenize.localhost` host is one site, so Chromium sends the `Sec-Fetch-Site` values `lumenize.dev` gets. Linux was not measured.
   - **Bare `*.localhost` would make the local stack stricter than production.** Chromium treats `localhost` as a suffix of its own, so `platform.localhost` and `crm.acme.localhost` are different sites, and a `Strict` cookie drops on the redirect back from the platform.
   - **`wrangler dev` passes the caller's `Host` through once `routes` is stripped.** That was read from wrangler's source, not run, so the first local boot on these hosts confirms it.
   - **The deployed test target has a domain of its own, `lumenize-test.dev`** (Larry registered it 2026-09-15). It is `.dev` so tests see production's browser rules: HSTS preloading covers the whole TLD, and `.dev` is a public suffix, so `lumenize-test.dev` is one site the way `lumenize.dev` is. Its zone sits in the same Cloudflare account and gets Advanced Certificate Manager before the build's first deployed pass. It shares nothing with production's zone, so none of its routes can catch a production host, and its certificates never churn production's.
2. **The Worker dispatches on the host, then on the path.** A page loads without a session (ADR-022 § *Context*), so the Worker never asks the Registry whether a host's scope exists, and no page load touches the singleton ([ADR-018](../docs/adr/018-singleton-is-the-scarce-resource.md)). `authorize` refuses a scope that does not exist the same way it refuses one the person does not reach.

   ```
   lumenize.dev                     the landing page
   platform.lumenize.dev            login and signup, Home, the consume, acceptance, authorize
   acme.lumenize.dev                the universe page
   crm.acme.lumenize.dev            Studio
   dev.crm.acme.lumenize.dev        the built app, from the Galaxy's /dist
   tenant1.crm.acme.lumenize.dev    404 until a published build exists, as today
   ```

   **What one host serves under `/auth/` today splits by the credential each route reads:**

   - **The platform host** answers every route that reads or sets its per-membership cookies — the login and signup pages, the magic-link consume, `accept-invite`, acceptance, `authorize`, and Home with its `refresh-token`. The Turnstile-guarded requests those pages send — `claim-universe`, `claim-star` and `email-magic-link` — go there too.
   - **Each scope host** answers the routes for its one cookie: `login`, `callback`, `handoff`, `refresh-token`, `logout` and `logout-all`.
   - **Every host** answers the routes a Bearer token authenticates — `scope-summary`, `expand-scope`, `create-galaxy`, `create-star`, `delete-scope` and `mint-narrower-token`. No cookie decides them, so a page calls its own host and never makes a cross-origin request.
   - **`/gateway/` stays on every host too.** Its URL carries no scope, since the token's `aud` does, so any host could serve it. Serving it on the page's own host keeps the socket same-origin, so a page never needs another host's name.
3. **Acceptance happens on the platform host, before any scope host sees the person.** A scope host issues a session only on an accepted membership (ADR-022 § *What a session carries*), so an invite link lands on `platform.lumenize.dev`. The consume sets that membership's named cookie, and the accept screen posts there. Then `return_to` takes the person to the scope's host, where the round trip issues its session. `authorize`, finding only a pending membership that reaches the target, sends the person to accept rather than refusing.
4. **The platform host's refresh names no scope, and its server picks the membership** (Larry, 2026-09-15). Home needs a token for `scope-summary`, and the platform host holds a cookie per membership, whose names a page cannot read because they are `HttpOnly`. So `POST /auth/refresh-token` there takes no body. The server uses any accepted membership cookie the request carries and mints a token for that membership's own scope. A visit to `platform.lumenize.dev` that names nothing therefore reaches Home without asking the person anything.
   - **Which membership the server picks changes nothing Home shows.** `getScopeSummary` reads the token's `profileId` and `sub`, never its `authScope`.
   - **That token serves the platform host's reads, and nothing that decides on `authScope`.** A page that acts on a scope — creating a galaxy, deleting a Star, impersonating someone there — runs on that scope's host, under the session that host issued. A superuser impersonates from the customer's host, where `authorize` gives them a session by dominion.
5. **Studio's preview, which shows the app as the user-developer, becomes the as-you dev tab.** Its frame moves to the dev Star's host, `dev.crm.acme.lumenize.dev`, and gets its session through `/auth/handoff` from an endpoint on Studio's host (ADR-022 § *Frames*). The strip holds only this tab until [nebula-testing-with-personas.md](nebula-testing-with-personas.md) adds persona tabs, so the handoff ships with a real consumer and the personas build reuses it.
   - ⚠️ Design consideration: with its own origin, Reset data can clear the tab's `localStorage`, IndexedDB and cookies without touching Studio's.
6. **Creating a universe or a galaxy orders its wildcard certificate and shows the wait, and deleting one deletes its certificate.** Ordering or deleting is an API call that can fail transiently. So neither runs inside a Registry request (ADR-018), and a failure is retried rather than leaving a scope with no certificate.
   - **The page that created the scope shows the wait** (Larry, 2026-09-11). A name never validated before spent about 145 seconds in validation on 2026-09-14, and the host answered the moment its certificate went active ([the 2026-09-14 run](../experiments/wildcard-host-routing/RESULTS.md)). So a new universe or galaxy waits two and a half to four minutes. A seconds count-up, or a countdown to the next poll, is enough: what matters is that the person expects the wait rather than discovers it. Universe Signup and Galaxy create are the pages, the same two that gain a name field in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *Scope full names*.
   - **The wait ends when the certificate is active, not when the scope exists.** A new galaxy's Studio at `crm.acme.lumenize.dev` rides the universe's wildcard and loads at once. Its as-you dev tab at `dev.crm.acme.lumenize.dev` needs the galaxy's own, and `.dev` is HTTPS-only, so the tab does not load until that certificate is active. A page creating a universe and its first galaxy orders both wildcards at once, so they validate together, and waits for both (ADR-021 § *Negative / mitigations*).
   - **A deletion keeps every other host answering.** When the 2026-09-14 run deleted its two test certificates, the zone's Universal SSL certificate — the one covering `platform.lumenize.dev` and every universe host — sat in `pending_deployment` for about a minute. Nobody checked whether hosts kept answering then, so whatever deletes a certificate gets a check that hosts on other certificates answer throughout.
   - **A deployment orders certificates only when its origin is `https`.** A certificate is what `https` needs, so the local stack's `http` origin orders none. An `https` deployment missing its API token fails loudly rather than skipping. So only a deployed pass can verify ordering — the deploy-only class `live.md` § *Two venues, one registry* describes.
7. **`nebula.lumenize.com` retires without a redirect.** Nothing a user holds points at it once the wipe has run: every account is re-created, and the published docs and blog live on `lumenize.com`.

### Constraints

- **ADR-021 and ADR-022 are the design.** Each carries one "Today's code differs" note, which this build shrinks as it lands and deletes when it is done.
- **[ADR-015](../docs/adr/015-passage-and-dominion.md) and [ADR-012](../docs/adr/012-global-profile-visibility.md), through ADR-022:** a session narrows `authScope` to its host, and is issued only on an accepted membership.
- **ADR-018:** a host's callback writes the Registry's logout index once per person per host, and a first refresh inside KV's propagation window falls back to the Registry once. ADR-022 § *Negative / mitigations* accepts both, bounded by the 30-day cookie. Nothing else on a session's path reads the singleton.
- **[ADR-009](../docs/adr/009-real-auth-path.md) and `live.md`:** every scenario logs in through real email and follows a link as sent. The login helpers change here, so `drive.ts all` sweeps the whole registry.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md)** lists establishing a session, so the callback and the handoff each record who caused it.
- **`critical.md`'s ban on logging `request.url` now also covers a code.** The callback's URL is `/auth/callback?code={signedValue}`, so a log line carrying the URL carries a code that is still valid for about a minute. Log `url.pathname` and identifiers.
- **Standing guidance describes today's cookie** — `.claude/rules/security.md`'s refresh-token rule, `docs/vision/auth.md` § *`authScope` (sessions)*, and `website/docs/nebula/auth-flows.md`. Each is conformed in the last phase that changes what it describes. `security.md`'s case against rotation is re-derived, never dropped, and counts the platform host's refresh as a second reader of its `Lax` cookies beside `authorize` (ADR-022 § *Negative / mitigations*).

### Future state

- ⚠️ Design consideration: **HTTP to a scope's Durable Objects comes after pre-alpha** (ADR-022 § *Deliberately open*). Keep `/auth/` reserved on every host and the Worker the only place a session is checked, so that route can drop `Cookie` and forward `Authorization: Bearer` without moving anything.
- ⚠️ Design consideration: **a Star's custom domain joins through the parse in intent 1**, so no other code compares a host against `lumenize.dev`.
- ⚠️ Design consideration: **`/pictures` and `/_version` need a host.** Today they share the one host with everything else.

## Decisions

Settled during the Pass 1 review, recorded while the reasons are fresh.

| Decision | Rejected alternative — why |
|---|---|
| **The platform host's refresh names no scope; its server picks the membership** (Larry, 2026-09-15) | **A body naming the membership** — a visit that names no scope has nothing to put there, and a page cannot read `HttpOnly` cookie names. **`scope-summary` authenticated by cookie on the platform host** — that route would authenticate two ways. **The 2026-06-12 rule against a scope-less refresh** ([archive/nebula-frontend.md](archive/nebula-frontend.md)) — its three reasons were a refresh record with no scope, a `Path` the cookie would not match, and confining a client-requested `activeScope`, and ADR-022 removes all three. |
| **`validateSlug` calls `isValidSlug`** (Larry, 2026-09-15) | **A node-slug grammar of its own** — a node slug will ride a URL segment or query parameter too, where 100 characters adds up quickly, and two grammars drift. |
| **`/gateway/` answers on every host** | **One host for it, `gateway.lumenize.dev` or `platform.lumenize.dev/gateway`** — its URL carries no scope, so nothing is gained, and the socket would become cross-origin. |
| **The certificate wait's progress indicator ships in this build** (Larry, 2026-09-15) | **A separate master-plan row** — this build already reports when a certificate goes active, so a separate row would ship that report with no page reading it. |
| **The local stack answers on `*.lumenize.localhost`** | **Bare `*.localhost`** — Chromium treats each such host as its own site, so the local stack would be stricter than production. |
| **The deployed test target lives on `lumenize-test.dev`** (Larry, 2026-09-15) | **`*.test.lumenize.dev` in production's zone** — its route also caught `contest.lumenize.dev` and every host beneath it, because a route's `*.` matches any host ending in the rest ([the 2026-09-15 run](../experiments/wildcard-host-routing/RESULTS.md) § *Route precedence*). **A base label containing `--`, such as `test--lmz.lumenize.dev`** — the slug grammar closes that capture, but test certificates would still churn production's zone. **`test.lumenize.io`** — `.io` is not HSTS-preloaded, so tests would see different browser rules. |

## Criteria to carry into the phases

A draft of settled obligations only. Pass 2 places each in a phase.

- **A minted link follows the request it was minted from.** A magic link and an invite link minted from requests on two different ports each land on the platform host at that port. Mutation: build the link from a constant origin, and one of the two goes red.
- **No host reads a cookie another host could plant.** A `/live` browser scenario sets an unprefixed `refresh-token` for all of `lumenize.localhost` from one host, and the next host's refresh ignores it. Mutation: read the unprefixed name, and the planted cookie is honoured.
- **A shared link survives a signed-out login in another browser.** A link carrying a fragment, opened signed out, logs in through a magic link followed in a second browser context and lands on the same URL, fragment included.
- **Home opens from a visit that names no scope.** A `/live` browser scenario logs in, then opens `platform.lumenize.dev` in a fresh tab and sees its summary without signing in again. Mutation: make the platform host's refresh require a named membership, and the fresh tab lands signed out.
- **Certificate ordering and deletion are driven on the deployed target**, including a deletion while hosts on other certificates keep answering.
- **Each ADR's "Today's code differs" note is deleted in the change that makes it false**, never as a follow-up.
- **`drive.ts all` is green** after the login helpers change.
