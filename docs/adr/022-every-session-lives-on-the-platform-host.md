# ADR-022: Every Session Lives on the Platform Host

**Date**: 2026-09-14
**Status**: Proposed
**Deciders**: Larry
**Evidence**: [A 2026-09-14 browser run](../../experiments/wildcard-host-routing/RESULTS.md) confirmed the cookie and header behaviour, and that every `lumenize.dev` host is one site. [The sessions record](../../tasks/archive/decision-sessions-per-origin.md) holds the browser facts, and the per-host design this ADR rejects. [The confine-admin-bypass record](../../tasks/archive/nebula-confine-admin-bypass.md) shows why dominion reads the admin's scope, never the admin bit alone.

## Context

[ADR-021](021-every-scope-has-its-own-host.md) gives every scope its own host, and one sitting can touch many of them. A user-developer opens Studio at `crm.acme.lumenize.dev`. Its as-you dev tab shows the app at `dev.crm.acme.lumenize.dev`, persona tabs run at `manny--dev.crm.acme.lumenize.dev`, and a tenant link opens `tenant1.crm.acme.lumenize.dev`.

Each of those pages needs an access token for its own host, and **no page may get an access token for another host**. Otherwise one persona's tab could act as another persona, or as the person running Studio.

**A page needs no session to load.** The Worker serves any page's HTML to anyone, and only what sits behind it needs a credential, so the client, not the page request, discovers a missing session.

Three browser facts shape the answer:

1. **A browser picks the cookies for a request by the URL the request goes to, not by the page that sends it.** A `fetch` from `crm.acme.lumenize.dev` to `platform.lumenize.dev` carries the platform host's cookies.
2. **Every `lumenize.dev` host is one site, so no such `fetch` is cross-site.** A site is a registrable domain, and `SameSite` and third-party cookie blocking compare sites, not hosts. They bite only across sites: from a page on a customer's own domain, that same `fetch` carries a third-party cookie, which Safari blocks and Firefox partitions.
3. **Page JavaScript cannot set `Origin`.** A server can trust it to name the host the request came from.

The rest of this ADR covers where sessions live, how a page gets and uses an access token, the cookie rules, and persona and customer hosts.

## Decision

### All sessions live on the platform host

**Every cookie of ours is stored on `platform.lumenize.dev` and nowhere else.** It holds one refresh cookie per membership, named for the membership's scope: `__Host-refresh-token.acme.crm`.

- **Logging in sets them.** The magic-link consume sets a refresh cookie for each of the address's memberships.
- **Logging out ends them**, so no page on any host gets another access token.

### Getting an access token: a fetch to the platform host

1. **`NebulaClient` asks the platform host.** On `tenant1.crm.acme.lumenize.dev` it sends `POST https://platform.lumenize.dev/auth/refresh-token` with `credentials: 'include'` and no body, so it needs no preflight.
2. **The platform host turns `Origin` into the host's scope.** `https://tenant1.crm.acme.lumenize.dev` becomes `acme.crm.tenant1`. `platform.lumenize.dev` itself is no scope, so a page there gets no access token.
3. **It picks the refresh cookie whose membership has the broadest dominion.** Among accepted memberships, the highest scopeAdmin one at or above the host's scope wins, and without one, the membership at the host's scope itself. The refresh reads Workers KV only for cookies named at or above the host's scope, and keeps those whose record agrees.
4. **It answers with the access token and CORS headers naming exactly that origin**, with `Access-Control-Allow-Credentials: true`.

**A frame gets its access token the same way**, because Studio, its frames and the platform host are one site; Safari would withhold cookies from a frame on another. A framed page never navigates the tab on a 401. It tells its parent, which owns the tab; from the frame, `return_to` would name the frame.

### Logging in

**With no qualifying refresh cookie, the refresh answers 401**, and the client navigates the browser tab to `/auth/login?return_to=${encodeURIComponent(location.href)}` on the platform host. The login keeps `return_to` on the magic-link record, so the emailed link names no destination. The link opens a page whose same-origin `POST` sets the refresh cookies and redirects there, in whichever browser opened it.

**`return_to` is checked so a login link cannot send anyone to another site.** It must carry the deployment's own scheme and name a host that the lookup turns into a scope; anything else is refused at the login and never reaches the record. Built from `location.href`, it keeps the fragment after `#` that a server redirect never sees.

### The cookie rules

- **Every cookie we set is named `__Host-…`.** A browser keeps one only if it is `Secure`, has `Path=/` and no `Domain`, so no other host can plant or overwrite it. Generated code can plant a `refresh-token` cookie across all of `lumenize.dev`, never a `__Host-refresh-token.acme.crm`, and the server reads only prefixed names. Nor can it load someone's emailed link to have one set: the link opens a page, and only that page's same-origin `POST` signs in.
- **Refresh cookies are `SameSite=Lax`**, so a person arriving at Home from an email or another site is recognised.
- **Every `POST` to `/auth/` requires `Sec-Fetch-Site: same-origin`, except the refresh.** The refresh serves every page on the site, so it also accepts `same-site`, and requires an `Origin` the lookup turns into a scope. A request without `Sec-Fetch-*` headers is allowed, unless it is a `POST` whose `Origin` the route would refuse.
- **Each refresh cookie is backed by a Workers KV record.** On a KV hit a refresh reads nothing else from the Registry, so refreshes run on the edge and put no load on the singleton Registry Durable Object ([ADR-018](018-singleton-is-the-scarce-resource.md)). A persona's host is the exception, below.
- **No cookie reaches a Durable Object.** A request forwarded to one carries the access token as `Authorization: Bearer`, as the WebSocket upgrade already does.

### What an access token carries

- **`authScope` is the chosen membership's scope, and `aud` is the host's, its `activeScope`.** A universe scopeAdmin on `tenant1.crm.acme.lumenize.dev` carries `authScope: acme` and `aud: acme.crm.tenant1`. The client names neither.
- **Dominion and passage read `aud`, with `scopeAdmin` from the membership** ([ADR-015](015-passage-and-dominion.md)). The code a host serves acts with its visitor's token, and on a Star's host that code is the user-developer's, so the host bounds what a call may do: from a Star's host, that universe admin holds dominion over the Star and passage upward.
- **Lateral movement stays refused.** `aud` must sit at or below `authScope`, and for a plain membership equal to it, so no page carries a membership from another branch of the scope tree.
- **No token carries dominion over the whole platform.** A superuser's membership sits at the root, but no page does.
- **Every call from a browser carries an access token, and passage upward comes from its `aud`.** A member of `acme.crm.tenant1` can call its galaxy and its universe from the Star's host. A call chain a node started carries none, and [ADR-015](015-passage-and-dominion.md) says where it may go.
- **Every access token rests on an accepted membership** ([ADR-012](012-global-profile-visibility.md)): the person's own, or for a persona's tab the persona's own, minted for whoever opened it.

### A persona's host

**A page on a persona's host gets an access token as that persona.** Studio frames `manny--dev.crm.acme.lumenize.dev` to show the app exactly as Manny sees it. Manny is a member of `acme.crm.dev` like any other. What sets him apart is his address, `manny--dev.crm.acme@lumenize.dev`, his host's own labels. Nobody sits behind that mailbox, so the Worker's mail handler accepts his invite ([auth.md](../vision/auth.md) § *A Galaxy's `.dev` Star*).

Manny holds no cookie, so his tab refreshes off its opener's. The refresh finds the accepted member under the address the host spells, and mints through the impersonation mint: Manny's own `sub`, `profileId`, `authScope` and admin bit, his Star as `aud`, and the opener in `act`. Both steps read the Registry on every refresh. It answers 401, or 403 for the first, unless all of these hold:

1. **The host names a persona in a Star with no real users**, today only `dev`: `manny--dev.crm.acme` names `manny` in `acme.crm.dev`.
2. **An accepted member of that Star holds the address the host spells.**
3. **The browser holds a refresh cookie with dominion over that Star**, which the mint asks of every impersonation.

**No check reads `act`** ([ADR-016](016-record-the-acting-principal.md)), so Manny's tab behaves as his own page would, except that an admin persona's tab cannot impersonate in turn.

**Only the address is particular to a persona.** His ids are random, like any member's. A login link mailed to his address is dropped, so nobody signs in as him. An admin of the Star can impersonate him too. A real address invited in a persona's place signs in as its owner, and no persona's host opens as them.

### A customer's own domain

**An app on its own domain gets a platform host of its own, such as `platform.northwindcrm.com`.** Its Stars, such as `tenant1.northwindcrm.com`, are a different site from `platform.lumenize.dev`, so that host serves every step of their members' sessions, with cookies of its own. The lookup that turns a host into its scope also names its site's platform host.

**Studio and every tab it frames stay on `lumenize.dev`**, because development happens on our hosts (Larry, 2026-09-18).

## Alternatives considered

- **Each host holding its own session, set by a top-level redirect through the platform host.** It would survive a Public Suffix List entry, which we do not plan, but costs every host a cookie, a callback, a signed code and a `state` cookie, and a frame its code passed in by `postMessage`.
- **Dominion and passage reading `authScope`, as this ADR first said.** A page's code would act with its visitor's broadest membership, a superuser's platform membership included, and could outlive the visit by inviting its author as an admin (Larry, 2026-09-19).
- **Narrowing `authScope` to the page's host, or picking the nearest scopeAdmin membership.** The checks read the page either way, so only the membership the token rests on changes, and with it a person's `sub` as they walk down into a scope where they hold a nearer one.
- **A persona with no address and no membership,** its id computed from its host, which this ADR first decided. Each shortcut then needed a rule to contain it: a second place to refuse a persona's admin bit, and seeding that could not put a resource where a member's app looks (Larry, 2026-11-13). ADR-016 closes the objection it answered: no check may read `act`.
- **Cookies with a `Domain`, cascading down a scopeAdmin's subtree or set on all of `lumenize.dev`.** Either gives up `__Host-`, so a generated app could overwrite a person's refresh cookie with its own.
- **One cookie per person rather than per membership.** Fewer cookies, but the refresh would have to find the person's memberships, in the singleton Registry or in a KV list every invite and removal keeps current.

## Consequences

### Positive

- **Moving between hosts costs no redirect.** A page on a host the person has never visited gets its access token on its first refresh, where a session per host would first bounce through the platform host.
- **Generated code cannot script Studio's page.** On `dev.crm.acme.lumenize.dev` the browser walls Studio off, leaving the app only `postMessage`.

### Negative / mitigations

- **Code on a page acts with its visitor's membership, within its host's scope.** For a member, grants bound it; for an admin, dominion skips grants by design ([ADR-015](015-passage-and-dominion.md)). So a universe admin previewing an app hands its code dominion over the dev Star, and goes to the universe's host to act on the universe.
- **Keeping each page to its own host's token is our code's job, not the browser's.** A bug in the refresh's `Origin` lookup hands a page another host's token. It is the lookup `return_to` uses, so there is one thing to get right.
- **Every universe shares one site**, since a Public Suffix List entry would make the refresh's cookies third-party ([ADR-021](021-every-scope-has-its-own-host.md)). Our rules keep universes apart instead: `__Host-` names for cookies, and the `Sec-Fetch-Site` check for posts.
- **All of `lumenize.dev` shares one cookie jar.** A generated app can fill it until the browser evicts refresh cookies, signing people out. `HttpOnly` and `__Host-` stop a script replacing or planting ours, not that eviction. The cost is a new login, never a takeover.
- **Requests to the platform host carry every refresh cookie**, because `__Host-` fixes `Path=/`. They are `HttpOnly` and never logged.
- **A persona's tab first opens once its invite's mail has arrived,** about two seconds after it is sent. Until then the host answers 401.

### Deliberately open

- **How a navigation or an `<img>` on a scope host authenticates to a Durable Object's HTTP route**, after pre-alpha. Neither carries an `Authorization` header, and no cookie of ours reaches that host. The candidates: a blob URL from a `fetch` with the token, a short-lived signed URL, or a service worker adding the header.
