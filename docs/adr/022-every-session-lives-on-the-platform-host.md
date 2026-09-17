# ADR-022: Every Session Lives on the Platform Host

**Date**: 2026-09-14
**Status**: Proposed
**Deciders**: Larry
**Evidence**: [A 2026-09-14 browser run](../../experiments/wildcard-host-routing/RESULTS.md) confirmed that every `lumenize.dev` host is one site to the browser, that a `__Host-` cookie stays host-only, and that a sibling host can plant only unprefixed cookies. [The sessions record](../../tasks/archive/decision-sessions-per-origin.md) holds the browser facts, and the per-host design this ADR rejects. [The confine-admin-bypass record](../../tasks/archive/nebula-confine-admin-bypass.md) shows why `authScope` narrows, not just `aud`: a token narrowed to one galaxy by `aud` alone kept a universe admin's dominion.

## Context

[ADR-021](021-every-scope-has-its-own-host.md) gives every scope its own host, and one sitting touches many of them. A user-developer opens Studio at `crm.acme.lumenize.dev`. Its as-you dev tab shows the app at `dev.crm.acme.lumenize.dev`, persona tabs run at `manny--dev.crm.acme.lumenize.dev`, and a tenant link opens `tenant1.crm.acme.lumenize.dev`.

Each of those pages needs an access token for its own scope, and **no page may get a token for another host**. A token shared across tabs is what lets one persona's login overwrite another's, and lets code on one host act as whoever is signed in on another.

**A page needs no session to load.** The Worker serves an app's `index.html` to anyone, and `NebulaClient` fetches everything behind it with an access token. So the client, not the page request, discovers a missing session.

Four browser facts shape the answer:

1. **A browser picks the cookies for a request by the URL it goes to, not by the page that sends it.** A `fetch` from `crm.acme.lumenize.dev` to `platform.lumenize.dev` carries the platform host's cookies, as long as the two are one site.
2. **Every `lumenize.dev` host is one site.** A site is a registrable domain, and `SameSite` and third-party cookie blocking compare sites, not hosts. Across sites they apply: from a page on a customer's own domain, the same `fetch` carries a third-party cookie, which Safari blocks and Firefox partitions.
3. **Page JavaScript cannot set `Origin`.** A server can trust it to name the page that sent the request.
4. **Only its own host can set a `__Host-` cookie, and never with a `Domain`.** No page on another host can plant or overwrite one.

The rest of this ADR says where sessions live, how a page gets a token, the cookie rules, what a token carries, and how a customer's own domain fits.

> **Today's code differs.** None of this is built. One host, `nebula.lumenize.com`, serves every scope. A login deposits one `refresh-token` cookie per membership at `Path=/auth/{scope}`. The client refreshes at `POST /auth/{authScope}/refresh-token` with `activeScope` in the body, and learns `authScope` from a localStorage hint. No cookie carries the `__Host-` prefix, no endpoint reads a `Sec-Fetch-*` header or mints by `Origin`, and the preview runs generated code on Studio's origin. `.claude/rules/security.md` still describes today's cookie. [The sessions record](../../tasks/archive/decision-sessions-per-origin.md) § *What changes in today's code* lists the sites.

## Decision

### Sessions live on the platform host

- **`platform.lumenize.dev` holds one refresh cookie per membership**, named for its scope — `__Host-refresh-token.acme.crm` — and serves login, the magic-link consume, Home, acceptance and logout.
- **No scope host holds a session.** Its pages get their tokens from the platform host, and no cookie of ours is set on it.
- **Logging out happens on the platform host.** Once a login cookie ends there, no page on any host can get another token from it.

### Getting a token: a fetch to the platform host

1. **`NebulaClient` asks the platform host.** On `tenant1.crm.acme.lumenize.dev` it sends `POST https://platform.lumenize.dev/auth/refresh-token` with `credentials: 'include'` and no body, which keeps it a simple request with no preflight.
2. **The platform host turns `Origin` into a scope.** `https://tenant1.crm.acme.lumenize.dev` becomes `acme.crm.tenant1`, through the lookup that also checks `return_to`. `platform.lumenize.dev` itself is no scope, so a page there gets no token.
3. **It picks a login cookie that reaches that scope.** A cookie's name says its scope, so it reads Workers KV only for cookies at that scope or above it. Among accepted memberships, one holding dominion over the scope wins, nearest first — for `acme.crm.tenant1`, an admin at `acme.crm` beats an admin at `acme` — and otherwise the membership at the scope itself. It answers with a token and CORS headers naming exactly that origin, with `Access-Control-Allow-Credentials: true`.
4. **With no cookie that reaches, it answers 401.** The client navigates the tab to `/auth/login?return_to=${encodeURIComponent(location.href)}` on the platform host. The login stores `return_to` with the magic link, and the consume sets its cookies and redirects there, in whichever browser opened the link. The page loads again, and its fetch succeeds.

**A frame gets its token the same way.** Studio shows the app in a strip of tabs, each a frame on its own host. Every frame is on `lumenize.dev`, so its `fetch` to the platform host is same-site, carries the same cookies, and gets a token for the frame's own host.

**Checking `return_to` is most of the login's security story.** It must be HTTPS and name a host on the platform host's site that the lookup turns into a scope. Because the client builds it from `location.href`, it keeps the fragment after `#` that a server redirect never sees.

### The cookie rules

- **Every cookie we set is named `__Host-…`.** A browser accepts one only if it is `Secure`, has `Path=/` and no `Domain`, and came from its own host. A generated app can set `refresh-token` for all of `lumenize.dev`, but never `__Host-refresh-token.acme.crm`, and the server reads only prefixed names.
- **Login cookies are `SameSite=Lax`**, so a person arriving at Home from an email or another site is recognised.
- **Every `POST` to `/auth/` requires `Sec-Fetch-Site: same-origin`, except the refresh.** The refresh serves every page on the site, so it also accepts `same-site`, and requires an `Origin` the lookup turns into a scope. CORS naming exactly that origin keeps any other page from reading the answer. A request without `Sec-Fetch-*` headers is allowed, unless it is a `POST` whose `Origin` the route would refuse.
- **Each login cookie is backed by a Workers KV record.** On a KV hit a refresh reads nothing else, so refreshes put no load on the singleton Registry ([ADR-018](018-singleton-is-the-scarce-resource.md)).
- **No cookie reaches a Durable Object.** A request forwarded to a Durable Object carries a token as `Authorization: Bearer`, as the WebSocket upgrade does, and the Worker drops `Cookie` first.

### What a token carries

- **`activeScope` is the page's host.** The server derives it from `Origin`, and the client names neither `authScope` nor `activeScope`.
- **A token narrows `authScope` to that scope, never just `aud`.** A universe admin on `tenant1.crm.acme.lumenize.dev` carries `authScope: acme.crm.tenant1`. `hasDominionOver` reads `authScope` ([ADR-015](015-passage-and-dominion.md)), so pinning only `aud` would leave universe-wide dominion in the token.
- **A token is minted only on an accepted membership, or on dominion held through an accepted scopeAdmin membership** ([ADR-012](012-global-profile-visibility.md)).
- **No token is needed for passage.** Passage upward comes from the token's own `authScope`.

### A customer's own domain

**An app on its own domain gets a platform host of its own.** The domain serves the app's Stars, such as `tenant1.northwindcrm.com`, to their members. Those pages are on a different site from `platform.lumenize.dev`, so a `fetch` there would carry a third-party cookie. A host on `northwindcrm.com` therefore does for them what `platform.lumenize.dev` does for `lumenize.dev`'s pages: login, the consume, logout and the refresh, with cookies of its own. The lookup that turns a host into its scope also names its site's platform host.

**Studio and every tab it frames stay on `lumenize.dev`**, because Safari withholds cookies from a frame on another site.

## Alternatives considered

- **Each host holding its own session, set by a top-level redirect through the platform host.** A cookie on each scope host would survive a Public Suffix List entry for `lumenize.dev`, which we do not plan to submit ([ADR-021](021-every-scope-has-its-own-host.md)). It costs every host a cookie, a callback, a signed code and a `state` cookie. A frame cannot make the redirect, so Studio has to pass it a code by `postMessage`, and logging out reaches every host only if each host's session is tied to the login that issued it.
- **Cookies cascading down the scope tree by `Domain`, for scopeAdmins.** Every persona host would receive its owner's cookie, and `__Host-` forbids a `Domain` anyway.
- **Every cookie at `Domain=lumenize.dev`.** It gives up `__Host-`, so a generated app on any host could overwrite a person's login cookie with one of its own.
- **Pinning `aud` to the host instead of narrowing `authScope`.** `hasDominionOver` reads `authScope`.
- **One address-level session on the platform host.** Not proposed. An earlier rejection of it rests partly on a ground that no longer holds, so proposing it owes a re-derivation.

## Consequences

### Positive

- **A page gets a token only for its own host, whichever page asks.** Generated code on a tenant host gets the token that host's page would get, and nothing else.
- **Lateral movement is refused at the refresh.** A membership in another branch of the scope tree reaches no host there, so reaching a host takes a membership or dominion there ([ADR-015](015-passage-and-dominion.md)).
- **Moving between hosts costs no redirect.** A page on a host the person has never visited gets its token on its first refresh.
- **Logging out ends every host at once**, since no host holds a session of its own.
- **A shared link survives login**, fragment included, even when the magic link opens in another browser.
- **The client stops naming its session's scope**, and the localStorage hint and return-to go away.
- **Generated preview code leaves Studio's origin.**

### Negative / mitigations

- **The refresh is the one cross-origin route.** It accepts `Sec-Fetch-Site: same-site`, so its `Origin` check, and CORS naming exactly the page's origin, are what keep a page from getting another host's token.
- **This design needs every `lumenize.dev` host to stay one site.** A Public Suffix List entry would make each universe a site of its own and the refresh's cookies third-party, so we do not plan to submit one ([ADR-021](021-every-scope-has-its-own-host.md)).
- **All of `lumenize.dev` shares one cookie jar.** A generated app can fill it and push login cookies out, signing people out — a nuisance, never a takeover.
- **Requests to the platform host carry every login cookie**, because `__Host-` fixes `Path=/`. They are `HttpOnly` and never logged.
- **A person signs in once per site**, so an app on its own domain asks its users to sign in there.
- **`security.md`'s case against refresh-token rotation loses a leg**, because login cookies are `Lax`. Rotation stays forbidden, and its rationale needs re-deriving.

### Deliberately open

- **How a persona tab gets a token that names the persona** rather than the person running Studio. The personas build decides it, and until then the refresh mints nothing for a persona host.
- **How a navigation or an `<img>` on a scope host authenticates to a Durable Object's HTTP route**, after pre-alpha. No cookie of ours reaches that host.
- **Single sign-on from `lumenize.dev` into an app's own domain.** A top-level redirect through `platform.lumenize.dev`, carrying a short-lived signed code, would cover that one cross-site step.
