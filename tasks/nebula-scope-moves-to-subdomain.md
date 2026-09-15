# The scope moves from a URL segment to a subdomain

**Status:** Pass 1, 2026-09-15 — design intent only, no phases. [ADR-021](../docs/adr/021-every-scope-has-its-own-host.md) and [ADR-022](../docs/adr/022-each-host-holds-its-own-session.md) carry the decisions. This file carries what building them in this repo needs, and cites the ADRs rather than restating them. ② Personas waits on it. [Maybe this should say "testing with personas waits..." because there is some accomodation for personas in this task, right?]

**Objective — every scope is served from a host of its own, and every host holds its own session, in production, in the local stack and in the `/live` harness alike.** [Interesting, have we figured out how to do this in the `/live` harness?]

Today one host serves everything, with the scope in the path. Studio for the galaxy `acme.crm` is `https://nebula.lumenize.com/acme.crm`, its preview is `/app/acme.crm.dev/` on that same host, and its refresh is `POST /auth/acme.crm/refresh-token`. After this build they are `https://crm.acme.lumenize.dev/`, `https://dev.crm.acme.lumenize.dev/`, and `POST /auth/refresh-token` on each host.

**Four goals, in the order they matter:**

1. **No credential crosses hosts, and generated code leaves Studio's origin.** Today a login sets one cookie per membership on `nebula.lumenize.com`, told apart only by `Path`. The preview runs the user-developer's generated code on Studio's own origin, where it shares Studio's `localStorage` and can call Studio's auth endpoints with the user-developer's cookies.
2. **A shared link opens the same scope and view, even across a login** ([ADR-017](../docs/adr/017-the-url-is-the-view-state.md)). Today a signed-out visitor's destination waits in `localStorage['nebula.returnTo']`, which a magic link opened in another browser never sees.
3. **The client names no scope [This might be a little overstated. I can imagine a time when we need to put a target scope in a body].** Today Studio reads `authScope` from a `localStorage` hint keyed `nebula.authScope:{activeScope}`, and every refresh names `activeScope` in its body.
4. **The local stack and `/live` serve the same hosts production does.** A scenario may not bridge a difference between the local stack and production (`.claude/rules/live.md` § *A `/live` scenario MUST NOT compensate for its environment*), so the local stack has to answer for many hosts too. Today it answers on one `http://localhost:{port}`.

## Relationships

- **Gates ② Personas, [nebula-testing-with-personas.md](nebula-testing-with-personas.md).** A persona tab needs a host of its own, and its session reuses this build's `/auth/handoff`. The personas build adds `mayIssueLink` and the link from a persona's session to the Studio session that issued it.
- **Gates the signup progress indicator** in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *The certificate wait*, which shows the wait for the certificate this build orders.
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

- **`buildAuthRouteTable` in `packages/nebula-auth/src/router.ts` puts the scope in the path** for every route a cookie authenticates — `refresh-token`, `logout`, `logout-all`, `accept-membership`, `pending-membership`, `home` — and for the emailed `magic-link` and `accept-invite`. *Adapted:* a scope host reads its scope from the host, and the platform host serves login, Home, `authorize`, the magic-link consume and acceptance (ADR-022 § *Two kinds of host*).
- **`refreshCookie` in `worker-token.ts` writes `refresh-token=…; Path=/auth/{scope}; HttpOnly; Secure; SameSite=Strict`**, and `consumeAndLogin` sets one per membership, capped at `MINT_ALL_COOKIE_CAP`. *Adapted:* the consume still sets one per membership, now on the platform host as `__Host-refresh-token.{scope}` at `Path=/`, `Lax`. A scope host holds exactly one `__Host-refresh-token`, `Strict`.
- **`handleRefreshToken` reads Workers KV, falls back once to the Registry's `getRefreshRecord`, and requires `activeScope` in the body.** *Adapted:* the scope comes from the host, the body is empty, and a record answers only on the host it was issued for. The fallback is carried unchanged.
- **Emailed links take their host from the request.** `#magicLinkUrl` builds `${origin}/auth/{scope}/…` from the inbound `url.origin`, and `NebulaAuthFacade` uses `callContext.originRequest?.origin`, falling back to `NEBULA_AUTH_ISSUER`. *Adapted:* every emailed link lands on the platform host.
- **Nothing tests that an emailed link follows the request's host.** `describe('Outbound URL host-awareness (Phase 0 guard)')` did, until `4cb069e` deleted it on 2026-07-13. [The sessions record](archive/decision-sessions-per-origin.md) § *What changes in today's code* still describes it as present. *Missing:* this build owes a successor (§ *Criteria to carry into the phases*).
- **`NEBULA_AUTH_ISSUER` is `https://nebula.lumenize.com`**, set in `access-claims.ts` and checked in `verify.ts`. *Adapted:* it names the platform host.

### Client

- **`NebulaClient` refreshes at `/auth/{authScope}/refresh-token` with `{ activeScope }`, then writes the `nebula.authScope:{activeScope}` hint.** A 401 or 403 throws mesh's `LoginRequiredError` and fires `onLoginRequired`. *Adapted:* the refresh is `POST /auth/refresh-token` with no body. A 401 starts the round trip through the platform host at top level, or posts `needs-session` from a frame (ADR-022 § *Getting a session: a round trip through the platform host*). The hint goes, with its readers in `App.vue` and `auth/HomeScreen.vue`.
- **Studio's `App.vue` reads the scope from the first path segment, and `enterScope` moves between scopes with `leaveTo('/{scope}')`.** Its preview frame's `src` is the relative `/app/{u}.{g}.dev/`. *Adapted:* the scope comes from the host, moving to another scope navigates to its host, and the frame's `src` is the dev Star's host. `view-state.ts` stays the one place the URL is read (`.claude/rules/ui-routing.md`).
- **`view-state.ts`'s `rememberReturnTo`, `takeReturnTo` and `validReturnTo` keep a signed-out visitor's destination in `localStorage`.** *Left behind:* `return_to` and the magic-link record replace them.
- **The Gateway's WebSocket URL carries no scope** — `/gateway/NEBULA_CLIENT_GATEWAY/{sub}.{tabId}` — and `onBeforeConnect` verifies the token and forwards it as `Authorization: Bearer`. *Carried unchanged:* each client connects to its own host's `/gateway/`.

### Names that assume a scope is a path segment

- **`PLATFORM_SCOPE` is `'nebula-platform'`** in `packages/nebula-auth/src/types.ts`. *Adapted:* it becomes `'platform'`, a stored scope id.
- **`RESERVED_STAR_SLUGS` is `{'dev'}`**, and `apps/nebula/test/test-helpers.ts` declares a second copy. *Adapted:* it holds the eight environment names ADR-021 reserves, and the copy folds into the import.
- **`RESERVED_UNIVERSE_SLUGS` exists because a universe slug is the first path segment.** *Re-derived:* that reason dies, and platform labels such as `platform`, `email` and `www` become the reason instead (`.claude/rules/calibration.md` §4).
- **`isValidSlug` in `packages/nebula-auth/src/parse-id.ts` checks every universe, galaxy and Star slug, and caps no length.** It allows lowercase letters, digits and hyphens, and refuses a leading or trailing hyphen or a `--`. *Adapted:* it gains ADR-021's 30-character cap, so `northwind-traders-international`, at 31, is refused at signup. The persona floor of 3 is the personas build's.[Should we state the reason for the 3 character minimum for persona?]
- **`validateSlug` in `apps/nebula/src/dag-ops.ts` checks a different kind of slug, and is left behind unchanged.** It names an org-tree node, unique only among its parent's children and never part of a host, so its 100-character cap and its tolerance of `--` stay right for it.[Meh, I don't see anything wrong with using the same slug validator function. In fact, the30 character limit is probably good here too. It will end up being in the URL segment or search param eventually also and 100 characters adds up quickly.]
- **Three JSDoc comments plan a split between `lumenize.dev` and `nebula.lumenize.com`**, in `nebula-auth-facade.ts`, `profile-pictures.ts` and `home-logic.ts`. *Re-derived:* each guards something, and the new grammar decides whether it still needs guarding.
- **Every other `nebula.lumenize.com`** — `grep -rl 'nebula\.lumenize\.com' --exclude-dir=node_modules --exclude-dir=archive` finds deploy scripts, the harness's `prod.ts` and `mintDegradedToken`, tests and docs. *Adapted* at each site. A generated file such as `platform-embed.ts` changes at its source.

### Venues

- **`bootDevStack` runs `wrangler dev` at `http://localhost:{port}` on a free port, and `bootStudioVite` serves Studio on 5174, proxying `/auth`, `/gateway`, `/app` and `/pictures` to it.** Scenarios name scopes in paths, and `loginViaEmail` fetches an emailed link as sent. *Adapted:* hosts become `{scope}.lumenize.localhost:{port}`. Following a link as sent is carried unchanged.
- **`deploy-test.sh` deploys `test-nebula` with `routes` deleted, so it answers on `workers.dev`**, whose hosts are one label deep. *Cannot carry:* no scope host fits there (§ *Open questions*).

## Design intent, constraints, and future state

The decisions are ADR-021's and ADR-022's. What follows is what building them here commits to, where the ADRs leave the choice to the build.

1. **The deployment names its origin once, and every host parses against it.** Production is `https://lumenize.dev`, and the local stack is `http://lumenize.localhost` [Will the lack of https be a problem here with cookies?], with the port taken from the request. Stripping that suffix and reading the rest right to left makes `tenant1.crm.acme.lumenize.localhost:54321`  [I just now googled and learned how `*.localhost` works so my question about testing above is answered by this. Right?] the scope `acme.crm.tenant1`, exactly as `tenant1.crm.acme.lumenize.dev` is. One function does the parse. It backs the `return_to` check and every URL the platform mints — a magic link, an invite link, a frame's `src` — so a Star's custom domain later joins in one place (ADR-021 § *Deliberately open*).
   
   - **Measured 2026-09-15 by a scratch probe on macOS**, with Node 24.19 and Playwright's Chromium 145. Node's `fetch` and `WebSocket` and Chromium all resolve `*.lumenize.localhost` at any depth to loopback. Chromium stores `__Host-` cookies over plain `http` there [This seems to answer my question about if not being https is going to be a problem, right?], keeps them host-only, reports a secure context, and sends the `Sec-Fetch-Site` values `lumenize.dev` gets, because every `*.lumenize.localhost` host is one site. Linux was not measured.
   - **Bare `*.localhost` would make the local stack stricter than production.** Chromium treats `localhost` as a suffix of its own, so `platform.localhost` and `crm.acme.localhost` are different sites, and a `Strict` cookie drops on the redirect back from the platform.
   - **`wrangler dev` passes the caller's `Host` through once `routes` is stripped.** That was read from wrangler's source, not run, so the first local boot on these hosts confirms it.
2. **The Worker dispatches on the host, then on the path.** A page loads without a session (ADR-022 § *Context*), so the Worker never asks the Registry whether a host's scope exists, and no page load touches the singleton ([ADR-018](../docs/adr/018-singleton-is-the-scarce-resource.md)). `authorize` refuses a scope that does not exist the same way it refuses one the person does not reach.

   ```
   lumenize.dev                     the landing page
   platform.lumenize.dev            login, Home, authorize, the consume, acceptance [This is split of what was is at `/auth` today, right? If so, should we say that (maybe outside of this code block)?]
   acme.lumenize.dev                the universe page
   crm.acme.lumenize.dev            Studio
   dev.crm.acme.lumenize.dev        the built app, from the Galaxy's /dist
   tenant1.crm.acme.lumenize.dev    404 until a published build exists, as today
   ```

   Every host also answers its own `/auth/` [Interesting, so this makes my question above more pointed. `/auth/refresh-token` stays on the per-scope host rather than moves to platform.] endpoints and `/gateway/` [Would it make sense to move to `gateway.lumenize.dev` or maybe just `platform.lumenize.dev/gateway`? The decision seems to rest on whether or not calls to `/gateway/` today include a scope in the URL].
3. **Acceptance happens on the platform host, before any scope host sees the person.** A scope host issues a session only on an accepted membership (ADR-022 § *What a session carries*), so an invite link lands on `platform.lumenize.dev`. The consume sets that membership's named cookie, and the accept screen posts there. Then `return_to` takes the person to the scope's host, where the round trip issues its session. `authorize`, finding only a pending membership that reaches the target, sends the person to accept rather than refusing.
4. **Studio's non-persona preview becomes the as-you dev tab.** Its frame moves to the dev Star's host, `dev.crm.acme.lumenize.dev`, and gets its session through `/auth/handoff` from an endpoint on Studio's host (ADR-022 § *Frames*). The strip holds only this tab until personas land [So, this happens in the next task file, `nebula-testing-with-personas.md` , right?], so the handoff ships with a real consumer and the personas build reuses it.
   
   - ⚠️ Design consideration: with its own origin, Reset data can clear the tab's `localStorage`, IndexedDB and cookies without touching Studio's. [Nice!]
5. **Creating a universe or a galaxy orders its wildcard certificate, and deleting one deletes it, off the singleton and retried until it lands.** Each is a call to Cloudflare's API that takes seconds [to minutes, right?] and can fail transiently. [Should we discuss the need for some way to let the user know that it is still working during this delay?] So neither runs inside a Registry request (ADR-018), and a failure is retried rather than leaving a scope with no certificate. A page creating a universe and its first galaxy orders both at once, so they validate together (ADR-021 § *Negative / mitigations*). A deletion keeps other hosts answering while it runs ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *The certificate wait*).
   
   - **Only a deployed pass can verify this.** The local domain needs no certificate, so the local stack orders none [How do we sense the environment?] — the deploy-only class `live.md` § *Two venues, one registry* describes.
6. **`nebula.lumenize.com` retires without a redirect.** Nothing a user holds points at it once the wipe has run: every account is re-created, and the published docs and blog live on `lumenize.com`.

### Constraints

- **ADR-021 and ADR-022 are the design.** Each carries one "Today's code differs" note, which this build shrinks as it lands and deletes when it is done.
- **[ADR-015](../docs/adr/015-passage-and-dominion.md) and [ADR-012](../docs/adr/012-global-profile-visibility.md), through ADR-022:** a session narrows `authScope` to its host, and is issued only on an accepted membership.
- **ADR-018:** a host's callback writes the Registry's logout index once per person per host, and a first refresh inside KV's propagation window falls back to the Registry once. ADR-022 § *Negative / mitigations* accepts both, bounded by the 30-day cookie. Nothing else on a session's path reads the singleton.
- **[ADR-009](../docs/adr/009-real-auth-path.md) and `live.md`:** every scenario logs in through real email and follows a link as sent. The login helpers change here, so `drive.ts all` sweeps the whole registry.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md)** lists establishing a session, so the callback and the handoff each record who caused it.
- **`critical.md`'s ban on logging `request.url` now also covers a code.** The callback's URL is `/auth/callback?code={signedValue}`, so a log line carrying the URL carries a code that is still valid for about a minute. Log `url.pathname` and identifiers.
- **Standing guidance describes today's cookie** — `.claude/rules/security.md`'s refresh-token rule, `docs/vision/auth.md` § *`authScope` (sessions)*, and `website/docs/nebula/auth-flows.md`. Each is conformed in the last phase that changes what it describes. `security.md`'s case against rotation is re-derived, never dropped (ADR-022 § *Negative / mitigations*).

### Future state

- ⚠️ Design consideration: **HTTP to a scope's Durable Objects comes after pre-alpha** (ADR-022 § *Deliberately open*). Keep `/auth/` reserved on every host and the Worker the only place a session is checked, so that route can drop `Cookie` and forward `Authorization: Bearer` without moving anything.
- ⚠️ Design consideration: **a Star's custom domain joins through the parse in intent 1**, so no other code compares a host against `lumenize.dev`.
- ⚠️ Design consideration: **`/pictures` and `/_version` need a host.** Today they share the one host with everything else.

## Open questions

1. **Where the deployed test target lives.** `test-nebula` answers on `workers.dev`, which gives one label, so it cannot serve `tenant1.crm.acme…` — and `live.md` requires a deployed pass. One shape is `https://test.lumenize.dev` as that deployment's origin, with its own route and `test` reserved as a platform label. It rests on a claim to check: Cloudflare sends a request matching both `*.test.lumenize.dev/*` and production's `*.lumenize.dev/*` to the more specific route. It also costs an advanced certificate for `*.test.lumenize.dev`, which Universal SSL does not cover.

## Criteria to carry into the phases

A draft of settled obligations only. Pass 2 places each in a phase.

- **A minted link follows the request it was minted from.** A magic link and an invite link minted from requests on two different ports each land on the platform host at that port. Mutation: build the link from a constant origin, and one of the two goes red.
- **No host reads a cookie another host could plant.** A `/live` browser scenario sets an unprefixed `refresh-token` for all of `lumenize.localhost` from one host, and the next host's refresh ignores it. Mutation: read the unprefixed name, and the planted cookie is honoured.
- **A shared link survives a signed-out login in another browser.** A link carrying a fragment, opened signed out, logs in through a magic link followed in a second browser context and lands on the same URL, fragment included.
- **Certificate ordering and deletion are driven on the deployed target**, including a deletion while hosts on other certificates keep answering.
- **Each ADR's "Today's code differs" note is deleted in the change that makes it false**, never as a follow-up.
- **`drive.ts all` is green** after the login helpers change.
