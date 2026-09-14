# ADR-022: Each Host Holds Its Own Session

**Date**: 2026-09-14
**Status**: Proposed — pending Larry's read
**Deciders**: Larry
**Evidence**: [`tasks/sessions-per-origin.md`](../../tasks/sessions-per-origin.md) — the flows as sequence diagrams, which cookie must ride which request, and the designs rejected while deciding. Today's refresh cookie and `handleRefreshToken` in `packages/nebula-auth/src/worker-token.ts`. `access-claims.ts`'s JSDoc on why `authScope` and `aud` answer different questions, and [`tasks/archive/nebula-confine-admin-bypass.md`](../../tasks/archive/nebula-confine-admin-bypass.md), where confusing them shipped as an escalation.

## Context

[ADR-021](021-every-scope-has-its-own-host.md) gives every scope its own host. A browser keeps cookies and storage per host, so a session made on one host is invisible to every other.

One sitting touches many hosts. A user-developer opens Studio at `crm.acme.lumenize.dev`. Its first tab shows the app at `dev.crm.acme.lumenize.dev`, persona tabs run at `manny--dev.crm.acme.lumenize.dev`, and a tenant link opens `tenant1.crm.acme.lumenize.dev`. Each needs a session, and **no credential may cross from one host to another** — a token shared across tabs is what lets one persona's login overwrite another's.

Three browser facts shape the answer:

1. **Only a top-level navigation reliably carries a cookie to another site.** Inside a frame, or on a background `fetch`, that cookie is third-party: Safari blocks it and Firefox partitions it.
2. **A navigation cannot carry a custom header**, and `Referer` arrives cut down to an origin. So a return path has to ride the URL.
3. **Until a Public Suffix List entry lands, every `lumenize.dev` host is one site**, and the list will not accept one before launch. So `SameSite` separates no customer from another yet, and a generated app can set a cookie for all of `lumenize.dev`.

The rest of this ADR walks the redirect that establishes a session, then the rules each cookie follows, then what a session may carry.

> **Today's code differs.** None of this is built. One host, `nebula.lumenize.com`, serves every scope. A login deposits one `refresh-token` cookie per membership at `Path=/auth/{scope}`. The client picks one by calling `POST /auth/{authScope}/refresh-token` with `activeScope` in the body, and learns `authScope` from a localStorage hint. A lapsed session remembers its page in localStorage. No cookie carries the `__Host-` prefix, no endpoint reads a `Sec-Fetch-*` header, and the preview runs generated code on Studio's origin. `.claude/rules/security.md`'s refresh-token rule describes today's cookie. [`tasks/sessions-per-origin.md`](../../tasks/sessions-per-origin.md) § *What changes in today's code* lists the sites.

## Decision

### Two kinds of host

- **`platform.lumenize.dev` holds one refresh cookie per membership**, named for its scope — `__Host-refresh-token.acme.crm` — and serves login, the magic-link consume and `authorize`.
- **Every scope host holds exactly one refresh cookie, for its own scope**, and serves its own `/auth/refresh-token` and `/auth/callback`.

### Getting a session: a top-level redirect through the platform host

The endpoint names are OAuth's. A **code** is a short-lived value in the redirect's URL, bound to one person, one host and one `state` value: `https://tenant1.crm.acme.lumenize.dev/auth/callback?code={signedValue}`.

1. **A page request reaches a host with no session.** `tenant1.crm.acme.lumenize.dev` puts a random value in a short-lived `state` cookie. It redirects to `platform.lumenize.dev/auth/authorize` with that `state` and `return_to` — the full URL, query string included.
2. **`authorize` picks a membership.** The redirect is a top-level navigation, so the platform host's cookies ride it. It looks for an accepted membership, or dominion through an accepted scopeAdmin membership, that reaches `acme.crm.tenant1`, and redirects to that host's callback with a code. When nothing reaches, it refuses. When the person is not signed in, it shows login and stores `return_to` with the magic link. The consume then sends them to `return_to`, so step 1 runs again in whichever browser opened the link.
3. **The callback redeems the code** when its signature, expiry and host check out and its `state` matches the cookie. It writes a refresh record bound to its own host, sets its refresh cookie, and redirects to `return_to`.
4. **From then on the host refreshes on its own.** `POST /auth/refresh-token` sends one cookie and no body.

**Checking `return_to` is most of the security story**, as it is in any OAuth flow. It must be HTTPS, on `lumenize.dev`, and parse to a scope the person may be issued a session at.

### The cookie rules

- **Every cookie we set is named `__Host-…`.** A browser accepts such a cookie only if it is `Secure`, has `Path=/` and has no `Domain`, and never from another host. A generated app can set `refresh-token` for all of `lumenize.dev`, but never `__Host-refresh-token`, and the server reads only prefixed names. So nothing cascades down the scope tree, and no host can place a session on another.
- **`SameSite` follows what must carry the cookie.** The platform host's refresh cookies, a scope host's `state` cookie and its `session-present` marker are `Lax`, because each must ride a navigation arriving from elsewhere. A scope host's refresh cookie is `Strict`, because only its own pages send it.
- **Two header checks do what `SameSite` cannot before the entry lands.** Every `POST` requires `Sec-Fetch-Site: same-origin`. `authorize`, the `GET` callback and the magic-link consume require a top-level navigation — `Sec-Fetch-Mode: navigate` with `Sec-Fetch-Dest: document` — so a background `fetch` carrying the platform host's `Lax` cookies is refused.
- **Each refresh cookie is backed by a Workers KV record bound to the host it was issued for.** A refresh arriving at any other host is refused. On a KV hit, refreshing reads nothing else and never waits on the singleton Registry ([ADR-018](018-singleton-is-the-scarce-resource.md)).

### What a session carries

- **`activeScope` is the host.** The server derives it, and the client names no scope anywhere.
- **A session on a scope host narrows `authScope` to that host's scope, never just `aud`.** A universe admin on `tenant1.crm.acme.lumenize.dev` carries `authScope: acme.crm.tenant1`. `hasDominionOver` reads `authScope` ([ADR-015](015-passage-and-dominion.md)), so pinning only `aud` would leave universe-wide dominion in the token.
- **A session is issued only on an accepted membership, or on dominion held through an accepted scopeAdmin membership** ([ADR-012](012-global-profile-visibility.md)).
- **No session is needed for passage.** Passage upward comes from the token's own `authScope`.

### Frames

**Studio shows the app in a strip of tabs, each a frame on its own host, and a frame cannot bounce**, because its navigation is not top-level. So `authorize` issues the first tab's code during Studio's own redirect, in the URL fragment after `#`, which no server sees. Studio passes it to the frame with `postMessage`, naming the frame's exact origin. The frame checks `event.origin` and redeems the code by `POST` to its own `/auth/callback`. That code carries no `state`, so it redeems only by that same-origin `POST`. A persona tab gets its session from its invite link, consumed on its own host.

## Alternatives considered

- **Cookies cascading down the scope tree by `Domain`, for scopeAdmins.** Every persona host would receive its owner's cookie, and `__Host-` forbids a `Domain` anyway.
- **Every cookie at `Domain=lumenize.dev`, the server choosing.** It gives up `__Host-`, shares one cookie jar across every customer, puts a superuser's cookie on every tenant host, and turns choosing a token into choosing an identity.
- **A central auth host, refreshed by background `fetch`.** It breaks the day the Public Suffix List entry lands, when that `fetch` becomes third-party. Its top-level half survived as step 2.
- **Pinning `aud` to the host instead of narrowing `authScope`.** `hasDominionOver` reads `authScope`.
- **Carrying the return target in a header, or reading `Referer`.** A navigation carries no custom header, and `Referer` loses the path.
- **Keeping today's localStorage return-to.** localStorage belongs to one origin.
- **The preview frame bouncing, or chaining bounces through each child host.** A frame is not top-level, and a chain breaks for a host added mid-session, such as a persona's.
- **Moving persona hosts out of the universe subtree.** It cuts every slug to about 24 characters, and host-only cookies already keep a persona host clear.
- **One address-level session on the platform host.** Not proposed. An earlier rejection of a scope-less refresh rests partly on a ground that no longer holds, so proposing it owes a re-derivation rather than an assumption either way.

## Consequences

### Positive

- **A persona's identity cannot be swapped.** Only that persona's cookie exists on its host, and nothing else can reach it.
- **A shared link survives login**, even when the magic link opens in another browser.
- **The client stops naming scopes**, and the localStorage hint and return-to go away.
- **Generated preview code leaves Studio's origin.**

### Negative / mitigations

- **The first visit to each host costs a visible bounce** — two 302s, a few hundred milliseconds — and again at the cookie's fixed 30-day expiry. The hops stay out of history, and a loop breaker stops after one failed bounce.
- **Each host visited writes a logout-index entry to the Registry.** That is new load on the singleton, bounded by the 30-day lifetime.
- **Page and asset requests carry the refresh cookie**, because `__Host-` fixes `Path=/`. It is `HttpOnly`, and a `Cookie` header is never logged on any route.
- **Until the entry lands, all of `lumenize.dev` shares one cookie jar.** A generated app can fill it and sign people out of other hosts — a nuisance, never a takeover.
- **`security.md`'s case against refresh-token rotation loses a leg**, because the platform host's cookies are `Lax`. Rotation stays forbidden, and its rationale needs re-deriving.

### Deliberately open

- **Whether the code is a signed value or an opaque id.** A signed value keeps the flow on the edge; an opaque id is single-use but needs a strongly consistent store.
- **What a request without `Sec-Fetch-*` headers gets** — refused, or let through for old browsers and the `/live` harness's Node client.
- **Custom domains, at Beta.** A customer's hostname needs its own place in the `return_to` check.
