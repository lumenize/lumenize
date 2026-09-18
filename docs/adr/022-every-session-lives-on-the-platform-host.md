# ADR-022: Every Session Lives on the Platform Host

**Date**: 2026-09-14
**Status**: Proposed
**Deciders**: Larry
**Evidence**: [A 2026-09-14 browser run](../../experiments/wildcard-host-routing/RESULTS.md) confirmed the cookie and header behaviour, and that every `lumenize.dev` host is one site. [The sessions record](../../tasks/archive/decision-sessions-per-origin.md) holds the browser facts, and the per-host design this ADR rejects. [The confine-admin-bypass record](../../tasks/archive/nebula-confine-admin-bypass.md) shows why dominion reads the admin's scope, never the admin bit alone.

## Context

[ADR-021](021-every-scope-has-its-own-host.md) gives every scope its own host, and one sitting can touch many of them. A user-developer opens Studio at `crm.acme.lumenize.dev`. Its as-you dev tab shows the app at `dev.crm.acme.lumenize.dev`, persona tabs run at `manny--dev.crm.acme.lumenize.dev`, and a tenant link opens `tenant1.crm.acme.lumenize.dev`.

Each of those pages needs an access token for its own host, and **no page may get an access token for another host**. Otherwise one persona's tab could act as another persona, or as the person running Studio.

**A page needs no session to load.** The Worker serves any page's HTML to anyone, an app's `index.html` and the platform host's pages alike. What sits behind it needs a credential: an access token on a scope host, a refresh cookie on the platform host. So the client, not the page request, discovers a missing session.

Three browser facts shape the answer:

1. **A browser picks the cookies for a request by the URL the request goes to, not by the page that sends it.** A `fetch` from `crm.acme.lumenize.dev` to `platform.lumenize.dev` carries the platform host's cookies, as long as the two are one site.
2. **Every `lumenize.dev` host is one site, so no such `fetch` is cross-site.** A site is a registrable domain, and `SameSite` and third-party cookie blocking compare sites, not hosts. They bite only across sites: from a page on a customer's own domain, that same `fetch` carries a third-party cookie, which Safari blocks and Firefox partitions.
3. **Page JavaScript cannot set `Origin`.** A server can trust it to name the page that sent the request.

The rest of this ADR covers where sessions live, getting an access token, logging in, the cookie rules, what an access token carries, persona hosts and customer domains.

> **Today's code differs.** None of this is built. One host, `nebula.lumenize.com`, serves every scope, with one `refresh-token` cookie per membership at `Path=/auth/{scope}`, and the client names both scopes on every refresh, learning `authScope` from a localStorage hint. `.claude/rules/security.md` still describes today's cookie.

## Decision

### All sessions live on the platform host

**Every cookie of ours is stored on `platform.lumenize.dev` and nowhere else.** It holds one refresh cookie per membership, named for the membership's scope: `__Host-refresh-token.acme.crm`.

- **Logging in sets them.** The magic-link consume sets a refresh cookie for each of the address's memberships.
- **Logging out ends them**, so no page on any host gets another access token.

### Getting an access token: a fetch to the platform host

1. **`NebulaClient` asks the platform host.** On `tenant1.crm.acme.lumenize.dev` it sends `POST https://platform.lumenize.dev/auth/refresh-token` with `credentials: 'include'` and no body, which keeps it a simple request with no preflight.
2. **The platform host turns `Origin` into the page's scope.** `https://tenant1.crm.acme.lumenize.dev` becomes `acme.crm.tenant1`, through the lookup that also checks `return_to`. `platform.lumenize.dev` itself is no scope, so a page there gets no access token.
3. **It picks the refresh cookie whose membership has the broadest dominion.** Among accepted memberships, the highest scopeAdmin one at or above the page's scope wins, and without one, the membership at the page's scope itself. A scopeAdmin at `acme.crm` who is only a member of `acme` gets the `acme.crm` membership on every host in that app. A cookie's name says its scope, so the refresh reads Workers KV only for cookies at or above the page's scope.
4. **It answers with the access token and CORS headers naming exactly that origin**, with `Access-Control-Allow-Credentials: true`. The browser hands a cross-origin response to a page's code only when those headers name that page, so they also keep a page on any other site from reading one.

**A frame gets its access token the same way**, because Studio, its frames and the platform host are one site. Safari would withhold the cookies from a frame on another site.

### Logging in

**With no qualifying refresh cookie, the refresh answers 401**, and the client navigates the browser tab to `/auth/login?return_to=${encodeURIComponent(location.href)}` on the platform host. The magic link proves the person owns their address. The login keeps `return_to` with it, and the consume sets the refresh cookies and redirects there, in whichever browser opened the link.

**`return_to` is checked so a login link cannot send anyone to another site.** It must be HTTPS and name a host on the platform host's site that the lookup turns into a scope. Built from `location.href`, it keeps the fragment after `#` that a server redirect never sees.

### The cookie rules

- **Every cookie we set is named `__Host-…`.** A browser keeps one only if it is `Secure`, has `Path=/` and no `Domain`, so no other host can plant or overwrite it. Generated code can plant a `refresh-token` cookie across all of `lumenize.dev`, never a `__Host-refresh-token.acme.crm`, and the server reads only prefixed names.
- **Refresh cookies are `SameSite=Lax`**, so a person arriving at Home from an email or another site is recognised.
- **Every `POST` to `/auth/` requires `Sec-Fetch-Site: same-origin`, except the refresh.** The refresh serves every page on the site, so it also accepts `same-site`, and requires an `Origin` the lookup turns into a scope. A request without `Sec-Fetch-*` headers is allowed, unless it is a `POST` whose `Origin` the route would refuse.
- **Each refresh cookie is backed by a Workers KV record.** On a KV hit a refresh reads nothing else, so refreshes run on the edge and put no load on the singleton Registry Durable Object ([ADR-018](018-singleton-is-the-scarce-resource.md)).
- **No cookie reaches a Durable Object.** A request forwarded to one carries the access token as `Authorization: Bearer`, as the WebSocket upgrade already does.

### What an access token carries

- **`authScope` is the chosen membership's scope, and `aud` is the page's.** A universe scopeAdmin on `tenant1.crm.acme.lumenize.dev` carries `authScope: acme` and `aud: acme.crm.tenant1`. The client names neither.
- **Dominion and passage read `authScope`** ([ADR-015](015-passage-and-dominion.md)), so that admin can `lmz.call()` the Universe from the Star's page with generous permissions. `aud` only fences the Gateway's outbound leg [Is this inconsistency worth investigating to see if it's vestigial or load bearing? At the least, I would want to confirm that we have JSDoc explaining the inconsistency. Actually, see if that's already there and still holds water.].
- **Lateral movement stays refused.** `aud` must sit at or below `authScope`, so no page carries a membership from another branch of the scope tree, and dominion runs only downward from the membership.
- **Every call carries an access token, and passage upward comes from its `authScope`.** A member of `acme.crm.tenant1` can call its galaxy and its universe from the Star's page.
- **An access token is minted only on an accepted membership** ([ADR-012](012-global-profile-visibility.md)).

### A persona's host

**A page on a persona's host gets an access token as that persona, and nothing else can.** Studio frames `manny--dev.crm.acme.lumenize.dev` to show the app exactly as Manny sees it, so the access token is plain: Manny's `sub` and `profileId`, his membership's `acme.crm.dev` as `authScope` and `aud`, and no `act` or `scopeAdmin`. The refresh mints it only when all four hold, and otherwise answers 401:

1. **The host alone gives the address.** `manny--dev.crm.acme` composes `acme.crm.dev~manny@personas.lumenize.io`.
2. **The address is a persona's.** It has exactly one `@`, its domain is `personas.lumenize.io`, and the part before `~` names a Star with no real users, today only `dev`.
3. **The browser holds a refresh cookie whose membership has dominion over that Star.**
4. **The persona exists.** The refresh reads the persona's Workers KV record, written when the Registry provisions it, and never the Registry itself, so an invented slug costs the singleton nothing.

**What keeps this to personas is that no human can ever hold a persona address:**

- **Nothing can receive its mail.** `personas.lumenize.io` has no MX, A or AAAA record, and a check against real DNS goes red if one appears.
- **A persona address holds a membership only at the Star it names.** The one mint every membership passes through refuses it anywhere else.
- **Nothing moves an address into that domain.** Changing an address, or adding one, refuses a persona address.
- **Only a persona's membership is born accepted** ([ADR-012](012-global-profile-visibility.md)).

### A customer's own domain

**An app on its own domain gets a platform host of its own.** Its Stars, such as `tenant1.northwindcrm.com`, are a different site from `platform.lumenize.dev`. So a host on `northwindcrm.com` gives those Stars' members login, the consume, logout and the refresh, with cookies of its own, and the lookup that turns a host into its scope also names its site's platform host.

**Studio and every tab it frames stay on `lumenize.dev`**, because Safari withholds cookies from a frame on another site.

## Alternatives considered

- **Each host holding its own session, set by a top-level redirect through the platform host.** It would survive a Public Suffix List entry, which we do not plan ([ADR-021](021-every-scope-has-its-own-host.md)), but costs every host a cookie, a callback, a signed code and a `state` cookie. A frame needs its code passed in by `postMessage`, and logging out reaches every host only if each session is tied to the login that issued it.
- **Narrowing `authScope` to the page's host, or picking the nearest scopeAdmin membership.** Either takes a universe admin's dominion away on a galaxy's page, so they could not `lmz.call()` the Universe from there. The coarse-grained layer stops lateral movement, not vertical (Larry, 2026-09-18).
- **A persona tab through impersonation, with `act` naming the user-developer.** Every check that reads `act` would treat the tab unlike a real Manny; on a Star with no real users, testing fidelity outweighs attribution (Larry, 2026-09-17).
- **Cookies cascading down the scope tree by `Domain`, for scopeAdmins.** Every persona host would receive its owner's cookie, and `__Host-` forbids a `Domain` anyway.
- **Every cookie at `Domain=lumenize.dev`.** It gives up `__Host-`, so a generated app on any host could overwrite a person's refresh cookie with one of its own.
- **One address-level session on the platform host.** Not proposed. An earlier rejection of it rests partly on a ground that no longer holds, so proposing it owes a re-derivation.

## Consequences

### Positive

- **Moving between hosts costs no redirect.** A page on a host the person has never visited gets its access token on its first refresh.
- **Generated preview code leaves Studio's origin.**

### Negative / mitigations

- **Code on a page acts with the visiting person's whole membership.** A universe admin previewing an app hands its code universe-wide dominion, as the preview on Studio's origin does today, and dominion is total by design ([ADR-015](015-passage-and-dominion.md)).
- **The refresh is the one cross-origin route**, so its `Origin` check and CORS are what keep a page from getting another host's access token.
- **This design needs `lumenize.dev` to stay one site.** A Public Suffix List entry would make the refresh's cookies third-party, so we do not plan one ([ADR-021](021-every-scope-has-its-own-host.md)).
- **All of `lumenize.dev` shares one cookie jar.** A generated app can fill it and push refresh cookies out, signing people out — a nuisance, never a takeover.
- **Requests to the platform host carry every refresh cookie**, because `__Host-` fixes `Path=/`. They are `HttpOnly` and never logged.
- **A person signs in once per site**, so an app's own domain asks its Star members to sign in there.
- **A brand-new persona's first tab can wait**, usually under a minute, if it looks before its KV record arrives there; Studio opens a persona's tab only after provisioning returns, which keeps it rare.
- **`security.md`'s case against refresh-token rotation loses a leg**, because refresh cookies are `Lax`. Rotation stays forbidden, and its rationale needs re-deriving.

### Deliberately open

- **How a navigation or an `<img>` on a scope host authenticates to a Durable Object's HTTP route**, after pre-alpha. No cookie of ours reaches that host.
- **Single sign-on from `lumenize.dev` into an app's own domain.** A top-level redirect through `platform.lumenize.dev`, carrying a short-lived signed code, would cover that one cross-site step.
