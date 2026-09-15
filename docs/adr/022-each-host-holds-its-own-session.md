# ADR-022: Each Host Holds Its Own Session

**Date**: 2026-09-14
**Status**: Proposed — pending Larry's read
**Deciders**: Larry
**Evidence**: [`tasks/sessions-per-origin.md`](../../tasks/sessions-per-origin.md) — the flows as sequence diagrams, which cookie must ride which request, and the designs rejected while deciding. [A 2026-09-14 browser run](../../experiments/wildcard-host-routing/RESULTS.md) confirmed the cookie and header behaviour. Today's refresh cookie and `handleRefreshToken` in `packages/nebula-auth/src/worker-token.ts`. `access-claims.ts`'s JSDoc on why `authScope` and `aud` answer different questions, and [`tasks/archive/nebula-confine-admin-bypass.md`](../../tasks/archive/nebula-confine-admin-bypass.md), where confusing them shipped as an escalation.

## Context

[ADR-021](021-every-scope-has-its-own-host.md) gives every scope its own host. A browser keeps cookies and storage per host, so a session made on one host is invisible to every other.

One sitting touches many hosts. A user-developer opens Studio at `crm.acme.lumenize.dev`. Its as-you dev tab shows the app at `dev.crm.acme.lumenize.dev` with the user-developer's own permissions, persona tabs run at `manny--dev.crm.acme.lumenize.dev`, and a tenant link opens `tenant1.crm.acme.lumenize.dev`. Each needs a session, and **no credential may cross from one host to another** — a token shared across tabs is what lets one persona's login overwrite another's.

**A page needs no session to load.** The Worker serves an app's `index.html` to anyone, and `NebulaClient` fetches everything behind it with an access token. So the client, not the page request, discovers a missing session.

Three browser facts shape the answer:

1. **Only a top-level navigation reliably carries a cookie to another site.** Inside a frame, or on a background `fetch`, that cookie is third-party: Safari blocks it and Firefox partitions it.
2. **A navigation cannot carry a custom header**, and `Referer` arrives cut down to an origin. So a return path has to ride the URL.
3. **Until a Public Suffix List entry lands, every `lumenize.dev` host is one site**, and the list will not accept one before launch. So `SameSite` separates no customer from another yet, and a generated app can set a cookie for all of `lumenize.dev`.

The rest of this ADR walks the round trip that establishes a session, then the rules each cookie follows, what a session may carry, and how the frames in Studio get theirs.

> **Today's code differs.** None of this is built. One host, `nebula.lumenize.com`, serves every scope. A login deposits one `refresh-token` cookie per membership at `Path=/auth/{scope}`. The client picks one by calling `POST /auth/{authScope}/refresh-token` with `activeScope` in the body, and learns `authScope` from a localStorage hint. A lapsed session remembers its page in localStorage. No cookie carries the `__Host-` prefix, no endpoint reads a `Sec-Fetch-*` header, and the preview runs generated code on Studio's origin. [`tasks/sessions-per-origin.md`](../../tasks/sessions-per-origin.md) § *What changes in today's code* lists the sites.

## Decision

### Two kinds of host

- **`platform.lumenize.dev` holds one refresh cookie per membership**, named for its scope — `__Host-refresh-token.acme.crm` — and serves login, the magic-link consume and `authorize`.
- **Every scope host holds exactly one refresh cookie, for its own scope**, and serves its own `/auth/login`, `/auth/callback` and `/auth/refresh-token`. `/auth/` is reserved on every host.

### Getting a session: a round trip through the platform host

The endpoint names are OAuth's. A **code** is a short-lived value in the redirect's URL, bound to one person, one host and one `state` value: `https://tenant1.crm.acme.lumenize.dev/auth/callback?code={signedValue}`.

1. **`NebulaClient`'s first refresh finds no session.** On `tenant1.crm.acme.lumenize.dev`, `POST /auth/refresh-token` gets a 401, so the client navigates the tab to `/auth/login?return_to=${encodeURIComponent(location.href)}`. That route puts a random value in a short-lived `state` cookie and redirects to `platform.lumenize.dev/auth/authorize`, with `state` and `return_to` as query parameters.
2. **`authorize` picks a membership.** The redirect is a top-level navigation, so the platform host's cookies ride it. It looks for an accepted membership, or dominion through an accepted scopeAdmin membership, that reaches `acme.crm.tenant1`, and redirects to that host's callback with a code. When nothing reaches, it refuses. When the person is not signed in, it shows login and stores `return_to` with the magic link. The consume then sends them to that host's `/auth/login`, so the round trip runs again in whichever browser opened the link.
3. **The callback redeems the code** when its signature, expiry and host check out and its `state` matches the cookie. It writes a refresh record bound to its own host, then answers with a small page rather than a redirect: the page sets the refresh cookie and replaces the address with `return_to`, keeping any value in the fragment (§ *Frames*).
4. **The page loads again and refreshes on its own.** `POST /auth/refresh-token` sends one cookie and no body.

**Checking `return_to` is most of the security story.** It must be HTTPS, on `lumenize.dev`, and parse to a scope the person may be issued a session at. Because the client builds it from `location.href`, it keeps the fragment after `#` that a server redirect never sees.

### The cookie rules

- **Every cookie we set is named `__Host-…`.** A browser accepts such a cookie only if it is `Secure`, has `Path=/` and has no `Domain`, and never from another host. A generated app can set `refresh-token` for all of `lumenize.dev`, but never `__Host-refresh-token`, and the server reads only prefixed names. So nothing cascades down the scope tree, and no host can place a session on another.
- **`SameSite` follows what must carry the cookie.** The platform host's refresh cookies and a scope host's `state` cookie are `Lax`, because each must ride a navigation arriving from elsewhere. A scope host's refresh cookie is `Strict`, because only its own pages send it.
- **Two header checks do what `SameSite` cannot before the entry lands.** Every `POST` to `/auth/`, and every `POST` a cookie authenticates, requires `Sec-Fetch-Site: same-origin`. `/auth/login`, `authorize`, the `GET` callback and the magic-link consume require a top-level navigation — `Sec-Fetch-Mode: navigate` with `Sec-Fetch-Dest: document` — so a background `fetch` carrying the platform host's `Lax` cookies is refused.
- **Each refresh cookie is backed by a Workers KV record bound to the host it was issued for.** A refresh arriving at any other host is refused. On a KV hit, refreshing reads nothing else and never waits on the singleton Registry ([ADR-018](018-singleton-is-the-scarce-resource.md)).

### What a session carries

- **`activeScope` is the host.** The server derives it, and the client names no scope anywhere.
- **A session on a scope host narrows `authScope` to that host's scope, never just `aud`.** A universe admin on `tenant1.crm.acme.lumenize.dev` carries `authScope: acme.crm.tenant1`. `hasDominionOver` reads `authScope` ([ADR-015](015-passage-and-dominion.md)), so pinning only `aud` would leave universe-wide dominion in the token.
- **A session is issued only on an accepted membership, or on dominion held through an accepted scopeAdmin membership** ([ADR-012](012-global-profile-visibility.md)).
- **No session is needed for passage.** Passage upward comes from the token's own `authScope`.

### Frames

**Studio shows the app in a strip of tabs, each a frame on its own host, and a frame never makes the round trip**, because its navigation is not top-level. A frame whose refresh gets a 401 posts `needs-session` to Studio instead, and Studio gets it a credential:

- **The as-you dev tab gets a code from `authorize` during Studio's own round trip**, carried in the URL fragment, which no server sees. The callback's page keeps it in `sessionStorage`. Studio passes it to the frame with `postMessage`, naming the frame's exact origin, and the frame checks `event.origin` and redeems it by `POST` to its own `/auth/callback`. That code carries no `state`, so it redeems only by that same-origin `POST`. If the tab's cookie lapses while Studio's has not, Studio makes its round trip again.
- **A persona tab gets an invite link**, which Studio obtains on the user-developer's Studio session when `mayIssueLink` allows it. The link is consumed on the persona's own host. A persona never signs in on `platform.lumenize.dev`, and its host is always in an environment Star.

While a tab's cookie lasts, reloading Studio refreshes it silently.

## Alternatives considered

- **Cookies cascading down the scope tree by `Domain`, for scopeAdmins.** Every persona host would receive its owner's cookie, and `__Host-` forbids a `Domain` anyway.
- **Every cookie at `Domain=lumenize.dev`, the server choosing.** It gives up `__Host-`, shares one cookie jar across every customer, puts a superuser's cookie on every tenant host, and turns choosing a token into choosing an identity.
- **A central auth host, refreshed by background `fetch`.** It breaks the day the Public Suffix List entry lands, when that `fetch` becomes third-party. Its top-level half survived as step 2.
- **Pinning `aud` to the host instead of narrowing `authScope`.** `hasDominionOver` reads `authScope`.
- **Carrying the return target in a header, or reading `Referer`.** A navigation carries no custom header, and `Referer` loses the path.
- **The preview frame bouncing, or chaining bounces through each child host.** A frame is not top-level, and a chain breaks for a host added mid-session, such as a persona's.
- **Moving persona hosts out of the universe subtree.** It cuts every slug to about 24 characters, and host-only cookies already keep a persona host clear.
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
- **Each host visited writes a logout-index entry to the Registry.** That is new load on the singleton, bounded by the 30-day lifetime.
- **Page and asset requests carry the refresh cookie**, because `__Host-` fixes `Path=/`. It is `HttpOnly`, and a `Cookie` header is never logged on any route.
- **Until the entry lands, all of `lumenize.dev` shares one cookie jar.** A generated app can fill it and sign people out of other hosts — a nuisance, never a takeover.
- **`security.md`'s case against refresh-token rotation loses a leg**, because the platform host's cookies are `Lax`. Rotation stays forbidden, and its rationale needs re-deriving.

### Deliberately open

- **Whether the code is a signed value or an opaque id.** A signed value keeps the flow on the edge; an opaque id is single-use but needs a strongly consistent store.
- **What a request without `Sec-Fetch-*` headers gets** — refused, or let through for old browsers and the `/live` harness's Node client.
- **How a persona's invite consume, loaded in a frame, meets the top-level-navigation check.**
- **Whether signing out ends the persona tabs.** A persona is a different address, so its cookie outlives the user-developer's sign-out.
- **HTTP requests to a scope's Durable Objects**, after pre-alpha. The Worker checks the session before a request reaches a DO's `fetch` handler, as the Gateway does for mesh calls, and passes verified claims, never a cookie. A page request needing a session makes the Worker start the round trip, with a `Lax` marker cookie for arrivals from an email link; a webhook brings its own credential.
- **Custom domains, at Beta.** A customer's hostname needs its own place in the `return_to` check.
