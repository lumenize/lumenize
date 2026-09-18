# ADR-022: Every Session Lives on the Platform Host

**Date**: 2026-09-14
**Status**: Proposed
**Deciders**: Larry
**Evidence**: [A 2026-09-14 browser run](../../experiments/wildcard-host-routing/RESULTS.md) confirmed the cookie and header behaviour, and that every `lumenize.dev` host is one site. [The sessions record](../../tasks/archive/decision-sessions-per-origin.md) holds the browser facts, and the per-host design this ADR rejects. [The confine-admin-bypass record](../../tasks/archive/nebula-confine-admin-bypass.md) shows why `authScope` narrows, not just `aud`: a token narrowed to one galaxy by `aud` alone kept a universe admin's dominion.

## Context

[ADR-021](021-every-scope-has-its-own-host.md) gives every scope its own host, and one sitting can touch many of them. A user-developer opens Studio at `crm.acme.lumenize.dev`. Its as-you dev tab shows the app at `dev.crm.acme.lumenize.dev`, persona tabs run at `manny--dev.crm.acme.lumenize.dev`, and a tenant link opens `tenant1.crm.acme.lumenize.dev`.

Each of those pages needs an access token for its own scope, and **no page may get an access token for another host**. Otherwise code on one host acts as whoever is signed in on another, and one persona's tab acts as another persona.

**A page needs no session to load.** The Worker serves any page's HTML to anyone, an app's `index.html` and the platform host's pages alike. What sits behind it needs a credential: an access token on a scope host, a login cookie on the platform host. So the client, not the page request, discovers a missing session.

Three browser facts shape the answer:

1. **A browser picks the cookies for a request by the URL the request goes to, not by the page that sends it.** A `fetch` from `crm.acme.lumenize.dev` to `platform.lumenize.dev` carries the platform host's cookies, as long as the two are one site.
2. **Every `lumenize.dev` host is one site, so no such `fetch` is cross-site.** A site is a registrable domain, and `SameSite` and third-party cookie blocking compare sites, not hosts. They bite only across sites: from a page on a customer's own domain, that same `fetch` carries a third-party cookie, which Safari blocks and Firefox partitions.
3. **Page JavaScript cannot set `Origin`.** A server can trust it to name the page that sent the request.

The rest of this ADR says where sessions live, how a page gets a token, the cookie rules, what a token carries, and how persona hosts and customer domains fit.

> **Today's code differs.** None of this is built. One host, `nebula.lumenize.com`, serves every scope. A login deposits one `refresh-token` cookie per membership at `Path=/auth/{scope}`. The client refreshes at `POST /auth/{authScope}/refresh-token` with `activeScope` in the body, and learns `authScope` from a localStorage hint. No cookie carries the `__Host-` prefix, no endpoint reads a `Sec-Fetch-*` header or mints by `Origin`, and the preview runs generated code on Studio's origin. `.claude/rules/security.md` still describes today's cookie.

## Decision

### [Should this say "All sessions"?]Sessions live on the platform host [This entire section really boils down to the title. Most of the rest is uncessary elaboration or repetition.]

- **`platform.lumenize.dev` holds one refresh cookie per membership**, named for its scope — `__Host-refresh-token.acme.crm` — and serves login, the magic-link consume [Why is the cookie involved in the magic-link consume or are you saying that it's set after that? If so, then make that another sentence.], Home, acceptance and logout.
- **No scope-named host holds a session [This reads ambiguous to me. Do you mean that no cookie is stored under a scope subdomain? If so, wouldn't a wording like, "Cookies are stored no where but platform.lumenize.dev" be more clear and this should be the first  bullet, or maybe the first sentence in an intro paragraph saving the bullets for implications.]** Its pages get their tokens from the platform host, and no cookie of ours is set on it. [The mention of the token seems like it could wait until the next section.]
- **Logging out happens on the platform host.** Once a login cookie ends there, no page on any host can get another token from it. [Everything after the comma reads funny now too.]

### Getting a token: a fetch to the platform host

1. **`NebulaClient` asks the platform host.** On `tenant1.crm.acme.lumenize.dev` it sends `POST https://platform.lumenize.dev/auth/refresh-token` with `credentials: 'include'` and no body, which keeps it a simple request with no preflight.
2. **The platform host turns `Origin` into a scope.** `https://tenant1.crm.acme.lumenize.dev` becomes `acme.crm.tenant1`, through the lookup that also checks `return_to`. `platform.lumenize.dev` itself is no scope, so a page there gets no token.
3. **It picks a login cookie that reaches that scope.** A cookie's name says its scope, so it reads Workers KV only for cookies at that scope or above it. Among accepted memberships, one holding dominion over the scope wins, nearest first — for `acme.crm.tenant1`, a scopeAdmin at `acme.crm` beats a scopeAdmin at `acme` — and otherwise the membership at the scope itself. It answers with a token and CORS headers naming exactly that origin, with `Access-Control-Allow-Credentials: true` [How does the CORS header  come into play here? The token is stored in memory. Is it so the browser doesn't reject the response?].
4. **With no cookie that reaches [Let's stay away from the word "reaches". Please reword more precisely.], it answers 401.** The client navigates the browser tab to `/auth/login?return_to=${encodeURIComponent(location.href)}` on the platform host. The login stores `return_to` with the magic link, and the consume sets its cookies and redirects there, in whichever browser opened the link.

**A frame gets its token the same way.** Each tab in Studio's strip is a frame on its own `lumenize.dev` host, so its `fetch` to the platform host is same-site [Does same-site come into play?] and carries the same cookies.

[Should login be a separate section?  You mention it above briefly also.]

**Checking `return_to` is most of the login's security story [This seems over stated. The ownership of the email address is all of the story in my mind. Checking return_to is an extra layer.].** It must be HTTPS and name a host on the platform host's site that the lookup turns into a scope. Built from `location.href`, it keeps the fragment after `#` that a server redirect never sees. [Does this help for malicious clients (browser or non-browser)? I'm guessing the answer is "no" but neither does other cookie schemes.]

### The cookie rules

- **Every cookie we set is named `__Host-…`.** A browser accepts one only if it is `Secure`, has `Path=/` and no `Domain`, and came from its own host [Will it come from its own host though? It'll come from platform.lumenize.dev. Maybe you meant to say when the current page's origin matches?]. A generated app can set `refresh-token` [We usually say refresh cookie, but you put this one in backtick quotes so I assume that's an identifier in code. That said, I'm not sure what this adds? You would need to describe more ofthe flow if you are trying to explain an attack. Maybe you are trying to say that `__Host-...` can't be set by a generated app.] for all of `lumenize.dev`, but never `__Host-refresh-token.acme.crm`, and the server reads only prefixed names.
- **Login cookies [What's a login cookie?] are `SameSite=Lax`**, so a person arriving at Home from an email or another site is recognised.
- **Every `POST` to `/auth/` requires `Sec-Fetch-Site: same-origin`, except the refresh.** The refresh serves every page on the site, so it also accepts `same-site`, and requires an `Origin` the lookup turns into a scope. CORS naming exactly that origin keeps any other page from reading the answer. A request without `Sec-Fetch-*` headers is allowed, unless it is a `POST` whose `Origin` the route would refuse.
- **Each login cookie is backed by a Workers KV record.** On a KV hit a refresh reads nothing else, so refreshes run on the edge and put no load on the singleton Registry Durable Object ([ADR-018](018-singleton-is-the-scarce-resource.md)).
- **No cookie reaches a Durable Object.** The edge Worker, swaps out the cookie for an `Authorization: Bearer` header containing the token before forwarding the Request to the Durable Object, the same pattern we use elsewhere (e.g. WebSocket upgrade Requests going to LumenizeGateway).

### What a token carries

- **`activeScope` is the page's host.** The server derives it from `Origin`, and the client names neither `authScope` nor `activeScope`.
- **A token narrows `authScope` to that scope, never just `aud`.** A universe admin on `tenant1.crm.acme.lumenize.dev` carries `authScope: acme.crm.tenant1`. `hasDominionOver` reads `authScope` ([ADR-015](015-passage-and-dominion.md)), so pinning only `aud` would leave universe-wide dominion in the token. [Hmmm, this could be a big problem. I think we want Universe-wide dominion in the token. Do we do this now? Dominion is defined downward. If I'm the scopeAdmin for a Universe, and I'm working in a Galaxy beneith it but I need to make an `lmz.call()` to the Universe, I should be allowed to do so without minting another cookie. Think of activeScope as an annotation almost. At one point, we keyed dominion-like calculations (we called it reach back then, but it was confusing because we had to kinds of reach upward and downward) off of activeScope, but we later switched it all to authScope to enable `lmz.call()` upward. This interacts with the decision above to always pick the narrowest cookie to use. However, in both cases, I think we actually want the broadest scope. Broadest is harder to define though. What if I'm scopeAdmin at the Galaxy level and only a member at the Universe level. In that case, we would prefer the Galaxy scope because it has more dominion. This is going to require some thought. Let's start with analysis of how it's commonly done in the current code. I think we specify both scopes when we get an access token and we use localStorage to keep track of the last authScope. That's a bit of a hack that didn't always work out but the user could work around it. I think what's going on in both cases, is that your training encourages you towards least privledge. We either already have a calibration.md entry for this or we need one. We must more judiciously apply least privledge with the system we've designed. Dominion and passage are coarse grained and their primary goal is to prevent lateral movement while allowing certain kinds of vertical movement. Remember, we have several more layers of fine-grained access control below this coarse-grained one. If we make the coarse-grained one too restrictive, we don't allow the system to work as designed. You've been editing auth.md as you've been editing this ADR so it may also have been poluted with some of this problem as well but I'm guessing the motivating prose is still pretty good. I should review auth.md after we settle this here, but you may want to read it now to see how it stacks up against what I'm writing here.]
- **A token is minted only on an accepted membership, or on dominion held through an accepted scopeAdmin membership** ([ADR-012](012-global-profile-visibility.md)).
- **No token is needed for passage. ** Passage upward comes from the token's own `authScope`. [That's not true. Passage upward is always allowed even for non-scopeAdmins, but you'd still need a token, because all lateral movement is always forbidden.]

### A persona's host

**A page on a persona's host gets a token as that persona, and nothing else can.** Studio frames `manny--dev.crm.acme.lumenize.dev` to show the app exactly as Manny sees it, so the token is plain: Manny's `sub` and `profileId`, `acme.crm.dev` as `authScope` and `aud`, and no `act` or `scopeAdmin`. The refresh mints it only when all four hold, and otherwise answers 401:

1. **The host alone gives the address.** `manny--dev.crm.acme` composes `acme.crm.dev~manny@personas.lumenize.io`.
2. **The address is a persona's.** It has exactly one `@`, its domain is `personas.lumenize.io`, and the part before `~` names a Star with no real users, today only `dev`.
3. **The browser's login holds dominion over that Star**, picked as in step 3 above.
4. **The persona exists.** The refresh reads the persona's Workers KV record, written when the Registry provisions it, and never the Registry itself, so an invented slug costs the singleton nothing.

**What keeps this to personas is that no human can ever hold a persona address:**

- **Nothing can receive its mail.** `personas.lumenize.io` has no MX, A or AAAA record, so no magic link sent there can be clicked, and a check against real DNS goes red if one appears.
- **A persona address holds a membership only at the Star it names.** The one mint every membership passes through refuses it anywhere else.
- **Nothing moves an address into that domain.** Changing an address, or adding one, refuses a persona address.
- **Only a persona's membership is born accepted** ([ADR-012](012-global-profile-visibility.md)).

### A customer's own domain

**An app on its own domain gets a platform host of its own.** Its Stars, such as `tenant1.northwindcrm.com`, are a different site from `platform.lumenize.dev`. So a host on `northwindcrm.com` gives those Stars' members login, the consume, logout and the refresh, with cookies of its own, and the lookup that turns a host into its scope also names its site's platform host.

**Studio and every tab it frames stay on `lumenize.dev`**, because Safari withholds cookies from a frame on another site.

## Alternatives considered

- **Each host holding its own session, set by a top-level redirect through the platform host.** It would survive a Public Suffix List entry, which we do not plan ([ADR-021](021-every-scope-has-its-own-host.md)). It costs every host a cookie, a callback, a signed code and a `state` cookie. A frame needs its code passed in by `postMessage`, and logging out reaches every host only if each session is tied to the login that issued it.
- **A persona tab through impersonation, with `act` naming the user-developer.** Every check that reads `act` would treat the tab unlike a real Manny, and on a Star with no real users, testing fidelity outweighs recording who drove it (Larry, 2026-09-17).
- **Cookies cascading down the scope tree by `Domain`, for scopeAdmins.** Every persona host would receive its owner's cookie, and `__Host-` forbids a `Domain` anyway.
- **Every cookie at `Domain=lumenize.dev`.** It gives up `__Host-`, so a generated app on any host could overwrite a person's login cookie with one of its own.
- **Pinning `aud` to the host instead of narrowing `authScope`.** `hasDominionOver` reads `authScope`.
- **One address-level session on the platform host.** Not proposed. An earlier rejection of it rests partly on a ground that no longer holds, so proposing it owes a re-derivation.

## Consequences

### Positive

- **A page gets a token only for its own host, whichever page asks.** Generated code on a tenant host gets that host's token and nothing else.
- **Lateral movement is refused at the refresh.** A membership in another branch of the scope tree reaches no host there, so reaching a host takes a membership or dominion there ([ADR-015](015-passage-and-dominion.md)).
- **Moving between hosts costs no redirect.** A page on a host the person has never visited gets its token on its first refresh.
- **A shared link survives login**, fragment included, even when the magic link opens in another browser.
- **The client stops naming its session's scope**, and the localStorage hint goes away.
- **Generated preview code leaves Studio's origin.**

### Negative / mitigations

- **The refresh is the one cross-origin route**, so its `Origin` check and CORS are what keep a page from getting another host's token.
- **This design needs `lumenize.dev` to stay one site.** A Public Suffix List entry would make the refresh's cookies third-party, so we do not plan one ([ADR-021](021-every-scope-has-its-own-host.md)).
- **All of `lumenize.dev` shares one cookie jar.** A generated app can fill it and push login cookies out, signing people out — a nuisance, never a takeover.
- **Requests to the platform host carry every login cookie**, because `__Host-` fixes `Path=/`. They are `HttpOnly` and never logged.
- **A person signs in once per site**, so an app's own domain asks its Star members to sign in there.
- **A brand-new persona's first tab can wait**, usually under a minute, if it looks before its KV record arrives there; Studio opens a persona's tab only after provisioning returns, which keeps it rare.
- **`security.md`'s case against refresh-token rotation loses a leg**, because login cookies are `Lax`. Rotation stays forbidden, and its rationale needs re-deriving.

### Deliberately open

- **How a navigation or an `<img>` on a scope host authenticates to a Durable Object's HTTP route**, after pre-alpha. No cookie of ours reaches that host.
- **Single sign-on from `lumenize.dev` into an app's own domain.** A top-level redirect through `platform.lumenize.dev`, carrying a short-lived signed code, would cover that one cross-site step.
