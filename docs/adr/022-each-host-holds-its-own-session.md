# ADR-022: Each Host Holds Its Own Session

**Date**: 2026-09-14
**Status**: Proposed
**Deciders**: Larry
**Evidence**: [the sessions record](../../tasks/archive/decision-sessions-per-origin.md) — the flows as sequence diagrams, which cookie must ride which request, and the designs rejected while deciding. [A 2026-09-14 browser run](../../experiments/wildcard-host-routing/RESULTS.md) confirmed the cookie and header behaviour. [The confine-admin-bypass record](../../tasks/archive/nebula-confine-admin-bypass.md) shows why `authScope` narrows, not just `aud`: a token narrowed to one galaxy by `aud` alone kept a universe admin's dominion.

## Context

[ADR-021](021-every-scope-has-its-own-host.md) gives every scope its own host. A browser keeps cookies and storage per host, so a session on one host can be neither read nor overwritten from another — and each host needs a session of its own.

One sitting touches many hosts. A user-developer opens Studio at `crm.acme.lumenize.dev`. Its as-you dev tab shows the app at `dev.crm.acme.lumenize.dev` with the user-developer's own permissions, persona tabs run at `manny--dev.crm.acme.lumenize.dev`, and a tenant link opens `tenant1.crm.acme.lumenize.dev`. Each needs a session, and **no credential may cross from one host to another** — a token shared across tabs is what lets one persona's login overwrite another's, and lets code on one host act as whoever is signed in on another.

**A page needs no session to load.** The Worker serves an app's `index.html` to anyone, and `NebulaClient` fetches everything behind it with an access token. So the client, not the page request, discovers a missing session.

Three browser facts shape the answer:

1. **Only a top-level navigation reliably carries a cookie to another site.** Inside a frame, or on a background `fetch`, that cookie is third-party: Safari blocks it and Firefox partitions it.
2. **A navigation cannot carry a custom header**, and `Referer` arrives cut down to an origin. So a return path has to ride the URL.
3. **Until a Public Suffix List (PSL) entry lands, every `lumenize.dev` host is one site**, and the list will not accept one before launch. So `SameSite` separates no customer from another yet, and a generated app can set a cookie for all of `lumenize.dev`.

The rest of this ADR walks the round trip, then the cookie rules, what a session carries, and how Studio's frames get theirs.

> **Today's code differs.** None of this is built. One host, `nebula.lumenize.com`, serves every scope. A login deposits one `refresh-token` cookie per membership at `Path=/auth/{scope}`. The client picks one by calling `POST /auth/{authScope}/refresh-token` with `activeScope` in the body, and learns `authScope` from a localStorage hint. No cookie carries the `__Host-` prefix, no endpoint reads a `Sec-Fetch-*` header, and the preview runs generated code on Studio's origin. `.claude/rules/security.md` still describes today's cookie. [The sessions record](../../tasks/archive/decision-sessions-per-origin.md) § *What changes in today's code* lists the sites.

## Decision

### Two kinds of host

- **`platform.lumenize.dev` holds one refresh cookie per membership**, named for its scope — `__Host-refresh-token.acme.crm` — and serves login, the magic-link consume and `authorize`.
- **Every scope host holds exactly one refresh cookie, for its own scope**, and serves its own `/auth/login`, `/auth/callback`, `/auth/handoff` and `/auth/refresh-token`. `/auth/` is reserved on every host.

### Getting a session: a round trip through the platform host

The endpoint names are OAuth's. A **code** is a signed value in the redirect's URL — `https://tenant1.crm.acme.lumenize.dev/auth/callback?code={signedValue}` — that expires in about a minute and carries its own bindings: one person, one host, and one `state` value or a handoff mark. A key used for nothing else signs it, so a code can never pass as an access token (Larry, 2026-09-15).

1. **`NebulaClient`'s first refresh finds no session.** On `tenant1.crm.acme.lumenize.dev`, `POST /auth/refresh-token` gets a 401, so the client navigates the tab to `/auth/login?return_to=${encodeURIComponent(location.href)}`. That route puts a random value in a short-lived `state` cookie and redirects to `platform.lumenize.dev/auth/authorize`, with `state` and `return_to` as query parameters.
2. **`authorize` picks a membership.** The redirect is a top-level navigation, so the platform host's cookies ride it. It looks for an accepted membership, or dominion through an accepted scopeAdmin membership, that reaches `acme.crm.tenant1`, and redirects to that host's callback with a code. When nothing reaches, it refuses. When the person is not signed in, it shows login and stores `return_to` with the magic link. The consume then sends them to that host's `/auth/login`, so the round trip runs again in whichever browser opened the link.
3. **The callback redeems the code** when its signature, expiry and host check out and its `state` matches the cookie. It writes a refresh record bound to its own host, sets the refresh cookie and redirects to `return_to`, whose fragment rides the redirect. Only that response sends `Referrer-Policy: no-referrer`.
4. **The page loads again and refreshes on its own.** `POST /auth/refresh-token` sends one cookie and no body.

**Checking `return_to` is most of the security story.** It must be HTTPS, on `lumenize.dev`, and parse to a scope the person may be issued a session at. Because the client builds it from `location.href`, it keeps the fragment after `#` that a server redirect never sees.

### The cookie rules

- **Every cookie we set is named `__Host-…`.** A browser accepts such a cookie only if it is `Secure`, has `Path=/` and has no `Domain`, and never from another host. A generated app can set `refresh-token` for all of `lumenize.dev`, but never `__Host-refresh-token`, and the server reads only prefixed names. So nothing cascades down the scope tree, and no host can place a session on another.
- **`SameSite` follows what must carry the cookie.** The platform host's refresh cookies and a scope host's `state` cookie are `Lax`, because each must ride a navigation arriving from elsewhere. A scope host's refresh cookie is `Strict`, because only its own pages send it.
- **Two header checks do what `SameSite` cannot before the PSL entry lands.** Every `POST` to `/auth/`, and every `POST` a cookie authenticates, requires `Sec-Fetch-Site: same-origin`. `/auth/login`, `authorize`, the `GET` callback and the magic-link consume require a top-level navigation — `Sec-Fetch-Mode: navigate` with `Sec-Fetch-Dest: document` — so a background `fetch` carrying the platform host's `Lax` cookies is refused. Without the headers a request is allowed, unless it is a `POST` whose `Origin` names another host (Larry, 2026-09-15).
- **Each refresh cookie is backed by a Workers KV record bound to the host it was issued for.** A refresh arriving at any other host is refused. On a KV hit, refreshing reads nothing else, apart from a persona's issuing session, so refreshes put no load on the singleton Registry ([ADR-018](018-singleton-is-the-scarce-resource.md)).
- **No cookie reaches a Durable Object.** HTTP to a scope's DO passes through the Worker, which checks the session, drops `Cookie` and forwards to the DO's `fetch` with `Authorization: Bearer`, as the WebSocket upgrade does — never translated into RPC (Larry, 2026-09-15).

### What a session carries

- **`activeScope` is the host.** The server derives it, and the client names no scope anywhere. One lookup turns a host into its scope and also backs the `return_to` check, so a Star's custom domain can join it later.
- **A session on a scope host narrows `authScope` to that host's scope, never just `aud`.** A universe admin on `tenant1.crm.acme.lumenize.dev` carries `authScope: acme.crm.tenant1`. `hasDominionOver` reads `authScope` ([ADR-015](015-passage-and-dominion.md)), so pinning only `aud` would leave universe-wide dominion in the token.
- **A session is issued only on an accepted membership, or on dominion held through an accepted scopeAdmin membership** ([ADR-012](012-global-profile-visibility.md)).
- **No session is needed for passage.** Passage upward comes from the token's own `authScope`.

### Frames

**Studio shows the app in a strip of tabs, each a frame on its own host, and a frame never makes the round trip**, because its navigation is not top-level. Every tab gets its session the same way, from Studio's own host (Larry, 2026-09-15). When a frame's refresh gets a 401, it posts `needs-session` to Studio, and:

1. **Studio points the frame at that host's `/auth/handoff`**, a waiting page that never redirects, and the frame posts `ready`.
2. **Studio asks its own host for the tab's code**, on the user-developer's Studio session. For a persona tab, `mayIssueLink` decides. For the as-you dev tab, the person needs an accepted membership at the dev Star or dominion over it, which may take a Registry read.
3. **Studio passes the code with `postMessage`**, naming the frame's exact origin. The frame checks `event.origin` and redeems it by `POST` to its own `/auth/callback`. The code carries a handoff mark instead of `state`, so it redeems only by that same-origin `POST`.

While a tab's cookie lasts, reloading Studio refreshes it silently. A persona never signs in on `platform.lumenize.dev`, and its host is always in an environment Star.

**A persona's session lives under the Studio session that issued it** (Larry, 2026-09-15). Its refresh record names that Studio session's record, and a persona refresh fails once that record is gone. Signing out, or the Studio session expiring, therefore ends every persona tab it opened, while the persona's own logout ends only its own record.

## Alternatives considered

- **Cookies cascading down the scope tree by `Domain`, for scopeAdmins.** Every persona host would receive its owner's cookie, and `__Host-` forbids a `Domain` anyway.
- **Every cookie at `Domain=lumenize.dev`, the server choosing.** It gives up `__Host-`, shares one cookie jar across every customer, puts a superuser's cookie on every tenant host, and turns choosing a token into choosing an identity.
- **A central auth host, refreshed by background `fetch`.** It breaks the day the PSL entry lands, when that `fetch` becomes third-party.- **Pinning `aud` to the host instead of narrowing `authScope`.** `hasDominionOver` reads `authScope`.
- **The preview frame bouncing, or chaining bounces through each child host.** A frame is not top-level, and a chain breaks for a host added mid-session, such as a persona's.
- **An opaque, single-use code.** Single use needs an atomic store: the Registry, adding a singleton write per round trip, or a Durable Object per code. The bindings already confine a replay to the same person, host and browser.
- **One address-level session on the platform host.** Not proposed. An earlier rejection of it rests partly on a ground that no longer holds, so proposing it owes a re-derivation.

## Consequences

### Positive

- **Lateral movement is refused at `authorize`.** A membership in another branch of the scope tree yields no code, so reaching a host takes a membership or dominion there ([ADR-015](015-passage-and-dominion.md)).
- **A persona's identity cannot be swapped.** Only that persona's cookie exists on its host, and nothing else can reach it.
- **A shared link survives login**, fragment included, even when the magic link opens in another browser.
- **The client stops naming scopes**, and the localStorage hint and return-to go away.
- **Generated preview code leaves Studio's origin.**

### Negative / mitigations

- **The first visit to each host costs a visible round trip.** The refresh gets a 401 and the tab goes to the platform and back, a few hundred milliseconds, before the page reloads mostly from cache. It recurs at the cookie's fixed 30-day expiry. The hops stay out of history, and `NebulaClient` stops after one failed round trip.
- **Each host visited writes a logout-index entry to the Registry**, and an as-you dev tab without a session may read a membership from it. That is new load on the singleton, bounded by the 30-day lifetime.
- **Page and asset requests carry the refresh cookie**, because `__Host-` fixes `Path=/`. It is `HttpOnly` and never logged.
- **Until the PSL entry lands, all of `lumenize.dev` shares one cookie jar.** A generated app can fill it and sign people out of other hosts — a nuisance, never a takeover.
- **`security.md`'s case against refresh-token rotation loses a leg**, because the platform host's cookies are `Lax`. Rotation stays forbidden, and its rationale needs re-deriving.

### Deliberately open

- **Which cookie a navigation to a DO's HTTP route brings, and whether each request reads Workers KV**, after pre-alpha.
