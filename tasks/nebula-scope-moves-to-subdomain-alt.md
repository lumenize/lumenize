# The scope moves from a URL segment to a subdomain

**Status:** An -alt restart begun 2026-09-19 (`/write-task` § *When to start OVER instead — the -alt route*). It is a fresh Pass 1 for the half of [nebula-scope-moves-to-subdomain.md](nebula-scope-moves-to-subdomain.md) that the rewrite of [ADR-022](../docs/adr/022-every-session-lives-on-the-platform-host.md) reshaped: sessions and access tokens, Home and where each action lives, logging out, the as-you dev tab, and the persona host before the personas build. It is written blind to the old file's arguments. The half that comes from [ADR-021](../docs/adr/021-every-scope-has-its-own-host.md), from the origin parse to the test zone, is mined from the old file at the end, together with the Stage 1 findings still open against it. This file then replaces the old one at its path. Everything from § *Relationships* down was drafted on 2026-09-19 from the code, the two ADRs and [docs/vision/auth.md](../docs/vision/auth.md), and every decision they left to the build is settled in § *Decisions*.

**Objective — every universe, galaxy, Star and persona is served from a host of its own, and every session lives on the platform host, in production, in the local stack and in the `/live` harness alike.**

Today one host serves everything, with the scope in the path. Take a user-developer who claimed the universe `acme` and then created the galaxy `crm`. Creating a galaxy adds no membership, so theirs is at `acme`. Their Studio for the galaxy is `https://nebula.lumenize.com/acme.crm`, and its preview is `/app/acme.crm.dev/` on that same host. Studio gets its token with `POST /auth/acme/refresh-token` and the body `{"activeScope":"acme.crm"}`, so the path names the membership and the body names the page. Their Home is `/auth/acme/home`. After this build Studio is `https://crm.acme.lumenize.dev/` and the preview is `https://dev.crm.acme.lumenize.dev/`. A page on either gets its access token from `POST https://platform.lumenize.dev/auth/refresh-token` with no body, and login and Home live on that host too.

Today a login sets one cookie per membership on `nebula.lumenize.com`, told apart only by `Path`, so any page there can get a token for any scope the person holds, in any universe. The preview runs the user-developer's generated code on Studio's own origin, in a frame with no `sandbox`, so that code can read and rewrite Studio's page and its `localStorage` through `window.parent`. After this build it reaches neither, and what it can do stops at the dev Star (§ *Passage and dominion read the page's scope*).

**The ADRs carry the design and its reasons, and this file carries what building them in this repo takes.** Its goal is to close the gaps between the code and those ADRs: the gaps named by the "Today's code differs" notes in those ADRs and in `docs/vision/auth.md`, the rest those gaps imply for the local stack, the test venues, the harness and the docs, and the choices the ADRs leave to the build.

## Relationships

- **[nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*** lists this build ahead of the wipe, with ② Personas waiting on it.
- **[nebula-pre-alpha.md](nebula-pre-alpha.md) § *Shared pages*** owns the signup page's fields and wording. This build owns what the page's claim writes and where it lands (§ *Signing up lands in Studio*).
- **[nebula-testing-with-personas.md](nebula-testing-with-personas.md)** stays unedited until this build is complete, because a persona tab needs a host of its own. Its rewrite inherits the refresh's persona branch (§ *Decisions*). [nebula-persona-sessions.md](nebula-persona-sessions.md) is mined into it then, and removed.
- **[nebula-pre-alpha.md](nebula-pre-alpha.md) § *The superuser join scenario*** chains login, Home, a user's host and an impersonation there. This build moves every one of those steps (§ *Decisions*).
- **The ADR-021 half's gating facts**, among them DNS and certificates on `lumenize.dev` and on the test zone, join this list with that half.

## Context and current state

This inventory covers the half that ADR-022's rewrite reshaped; the host parse, the slug rules, the Worker's routing by host, the local stack and the test zone arrive with the ADR-021 half. Each part below ends in its fate: carried over, adapted, rewritten or left behind.

### Built already

**The login and its cookies**, in `packages/nebula-auth/src/worker-token.ts`:

- **`consumeAndLogin`** sets one cookie per membership through `refreshCookie`: named `refresh-token`, at `Path=/auth/{scope}`, `SameSite=Strict`, on whichever host served the link. `selectSessionsToMint` ranks them with the link's own scope first and caps them at 24, because anyone can add to an address's memberships by inviting it or by claiming a Star with it. The 302 goes to `homePath`, which is `/auth/{scope}/home`. *Adapted:* each cookie becomes `__Host-refresh-token.{scope}` at `Path=/`, `SameSite=Lax`, on the platform host, and the redirect goes to `return_to` or to Home. The ranking and the cap carry over, since the cap's reason holds unchanged.
- **`signupTicketCookie`** carries a proved address with no memberships to the claim screen, at `Path=/auth`. *Adapted* to a `__Host-` name at `Path=/`.
- **The refresh record** is one Workers KV entry per refresh token, `refresh:{tokenHash}`, read at the edge, with one fallback to the Registry on a miss. *Carried over unchanged*; ADR-022 § *The cookie rules* already describes it.
- **`handleRefreshToken`** reads the one `refresh-token` cookie the path selected, requires a JSON body naming `activeScope`, and mints when that scope sits at or below the cookie's membership. *Rewritten* to ADR-022 § *Getting an access token*: no body, the page's scope from `Origin`, a choice among every cookie that arrives, and a CORS answer naming that origin.
- **Four more routes pick their cookie by `Path`**: `/auth/{scope}/accept-membership`, `pending-membership`, `logout` and `logout-all`. *Adapted:* every request to the platform host carries every cookie, so each request names the membership whose cookie it reads. `logout` and `logout-all` collapse into the one route of § *Decisions*, and `revokeAllForAddress` goes with `logout-all`.

**The checks**, in `packages/nebula-auth/src/parse-id.ts` and `verify.ts`:

- **`hasDominionOver` and `hasPassageInto`** read `access.authScope` and `access.scopeAdmin`, and every site that decides passage or dominion passes them `claims.access`. *Adapted:* they take the verified claims and read `aud` in `authScope`'s place (§ *Passage and dominion read the page's scope*). The facade's invite eligibility compares `access.authScope === targetScope` itself, and adapts the same way.
- **`verifyNebulaAccessToken`** refuses a token whose `aud` is not at or below its `authScope`, with no condition on `scopeAdmin`. *Adapted:* a plain membership's token verifies only when the two are equal.

**Emailed links**, in `packages/nebula-auth/src/nebula-auth-registry.ts` and `nebula-auth-facade.ts`:

- **Every magic link and invite link takes its host from whatever caused it.** The Registry's `#magicLinkUrl` uses the origin of the request it is serving, and `NebulaAuthFacade` uses the origin the inviter's socket arrived on, `callContext.originRequest.origin`. The facade's own JSDoc flags that a socket arriving on a scope host will need more than this. *Adapted:* every such link points at the platform host of that origin's site, because the consume it leads to sets the cookies, and cookies live only there.

**The client**, in `apps/nebula/src/nebula-client.ts` and `apps/nebula-studio-ui/src/`:

- **`NebulaClient`'s refresh** posts to `/auth/{authScope}/refresh-token` on its own origin with `{ activeScope }`. Then it writes `nebula.authScope:{activeScope}` to `localStorage`, the hint that tells a later load which membership's path to call. Studio's `authHint` reads it, and Home's `authHintFor` seeds it before navigating. *Adapted:* the refresh goes to the platform host with no body. The hint is *left behind*, with every reader and writer.
- **The generated app's `src/nebula.ts`** passes `createNebulaClient` the `authScope` that the Galaxy's `/app/*` serve injects in `<meta name="nebula-scope">`, which is always the galaxy. Only a galaxy member holds a cookie at that path, so a universe owner's preview refreshes at a path their cookie does not match. The injected `authScope` is *left behind*. The same file sends its own frame to `/login` when `ready` rejects, which is *left behind* too: the client owns a 401 (§ *Decisions*).
- **`leaveTo('/auth/login', { returnHere: true })`** stores the page under `nebula.returnTo` in `localStorage`, and Home's `takeReturnTo` reads it after the login. *Left behind:* `return_to` rides the login instead, which also works when the emailed link opens in another browser (ADR-022 § *Logging in*).
- **`NebulaClient.scopes`** — `summary`, `expand`, `createGalaxy`, `createDevWorkspace`, `deletePlan`, `delete` — sends `Bearer` POSTs to `/auth/…` on its own origin. Studio's Manage view is one tree of every scope the person reaches, with Develop, "+ App" and Delete on its rows, and Studio's universe page lists that universe's apps; both read `summary`, which calls `scope-summary`. *Adapted:* `createGalaxy`, `deletePlan` and `delete` become facade calls, and `createDevWorkspace` goes with `create-star` (§ *Decisions*). The tree moves to Home, and Studio keeps a list of its own tenants. `UniverseView`'s list of apps is *left behind*.
- **`NebulaClient.impersonate(sub, activeScope)`** builds a child client inside the admin's own page, minted through `/auth/mint-narrower-token` and renewed through the parent. No Studio screen calls it; harness scenarios do. *Adapted:* the mint becomes a facade method and `activeScope` is *left behind*, since the child's `aud` is the page's, which the two bounds put at the subject's own scope (§ *Decisions*). Renewal through the parent carries over.
- **`NebulaClient.logout`** spends the cookie at its own `authScope`'s path, through `logout`, or through `logout-all` with `everywhere`. An impersonation child only tears itself down, per `.claude/rules/security.md`'s rule on derived sessions. *Adapted:* **Log out** on a scope page navigates to the platform host, which ends every session this browser's cookies name (§ *Decisions*). The `everywhere` option goes. The child's teardown carries over, and a framed page's `logout()` becomes the same teardown.

**Home**, in `apps/nebula-studio-ui/src/auth/HomeScreen.vue` and `home-logic.ts`:

- **Home** is served at `/auth/{scope}/home`. It refreshes at the scope its URL names and reads `scope-summary` with that token: the person's addresses, their memberships, and the tree beneath each accepted admin membership, up to the 50-node `SCOPE_TREE_NODE_BUDGET`. With no session it falls back to `pending-membership` for a first arrival's consent card. It accepts through `accept-membership`, and it enters a scope by seeding the hint and navigating. *Adapted:* Home moves to `platform.lumenize.dev`, where a page holds no token, and becomes the picker of § *The platform host handles the session lifecycle and the picker*. It reads the same tree by the refresh cookies (auth.md § *Home*), grouped by Profile (§ *Decisions*). `home-logic.ts`'s decisions carry over, except the fast-forward, which changes as § *Signing up lands in Studio* says.

**The preview**, in `apps/nebula-studio-ui/src/App.vue`:

- **Studio frames `/app/{galaxy}.dev/`** with no `sandbox`, and reloads it by bumping a `?t=` parameter. *Adapted:* Studio frames `https://dev.crm.acme.lumenize.dev/`, the as-you dev tab of ADR-022 § *Context*, and draws a frame's auth state in its own UI around it (§ *Decisions*).

**The Gateway**, in `apps/nebula/src/nebula-client-gateway.ts`:

- **`NebulaClientGateway.onBeforeCallToClient`** refuses a push unless the call behind it carried the same `aud` as the receiving connection. The Profile's pushes are exempt. *Left behind*, exemption included (§ *Decisions*).

**The harness**, in `apps/nebula/test/lib/email-login.ts`:

- **`EmailSession.authScope`** is the scope a cookie's `Path` names. `refreshTokenForScope` reads it back from `Path`, `acceptMembership` sends the one cookie, and `refreshAccessToken` names `activeScope` in a body. *Adapted:* the scope comes from the cookie's name, and a refresh names its page by `Origin`, which a browser sends by itself and a Node driver sets.

**CORS**, in `apps/nebula/src/entrypoint.ts`:

- **One `LUMENIZE_APPROVED_ORIGINS` allowlist** is threaded through `/auth/*` and `/gateway/*`. Production sets it empty, which turns the server-side `Origin` check off. *Adapted on `/auth/`:* the refresh answers CORS for exactly the origin its lookup accepts, and every other `POST` requires `Sec-Fetch-Site: same-origin` (ADR-022 § *The cookie rules*). The gateway's side belongs to the ADR-021 half.

**Standing guidance and docs:**

- **`.claude/rules/security.md`** describes today's cookie, with a note that ADR-022 replaces it. The "Today's code differs" notes in ADR-021, ADR-022 and `docs/vision/auth.md` name the gaps. The pages under `website/docs/nebula/` that describe the per-scope cookie reach Studio's model through the platform embed, and `grep -rlE 'refresh-token|authScope' website/docs/nebula` lists them. *Adapted:* each is conformed to what lands, and each note closes with its gap.

### Missing

These have no counterpart above:

1. **The refresh's choice among cookies**, ADR-022 § *Getting an access token* step 3, which stands as written (§ *Decisions*).
2. **The refresh's persona branch**, ADR-022 § *A persona's host*, with a `/live` scenario that opens a persona host and a negative for a caller holding no dominion over its Star.
3. **`return_to`, kept by the login and checked by the lookup**, ADR-022 § *Logging in*.
4. **The `Sec-Fetch-Site` check** on every `POST` to `/auth/`, ADR-022 § *The cookie rules*.
5. **Home's read by cookie**, auth.md § *Home*.
6. **The claim that creates the first app with the account**, and the landing in Studio after consent (§ *Signing up lands in Studio*), with the read the waiting page polls for its certificates' state.
7. **Studio's list of the galaxy's tenants**, with Delete.
8. **Five `NebulaAuthFacade` methods**: the four § *Decisions* moves off HTTP, and the read of a page's children that Studio's list needs.
9. **The three page defences** of § *Passage and dominion read the page's scope*: framing, navigation to the platform host, and `postMessage`.
10. **The client's 401 and sign-out handling** (§ *Decisions*): a navigation to the login at the top level, one message to the parent in a frame, and a `logout()` that tears a framed client down rather than ending the parent's session. The parent origin the serving layer injects comes with it, and so do the three reasons the refresh must tell apart — no session, no membership for this host, and consent pending.

## Design intent, constraints, and future state

**ADR-021 and ADR-022 are the design, and `docs/vision/auth.md` § *`authScope` (sessions)*, § *`activeScope`* and § *Home* are the accepted model around them.** This build conforms the code to them. Where they leave a choice to the build, § *Decisions* records it beside the alternative it beat.

### The platform host handles the session lifecycle and the picker

**Scope pages handle everything a session does.** Cookies live only on the platform host, so every step that reads or writes one happens there: signing up and logging in, which end in the consume that sets the cookies, consent, and logging out. A page there holds no token (ADR-022 § *Getting an access token*), so it can do nothing a session does, and Home is a picker. A page on a scope host holds a token and a socket, and reaches the Registry through `NebulaAuthFacade`. It is auth.md § *The Registry*'s own line, that HTTP carries the session lifecycle and the mesh carries what a session does, applied to pages.

Consent sits on the platform host because a scope page gets no token for a membership nobody has accepted. It fits a picker: picking a pending row is how a person accepts it.

**Which scope page an action lives on:**

- **Signup creates what a person signs up for**: a universe with its first app, or a tenant Star through `claim-star`. Any other scope is created on its parent's page.
- **Every other action on a scope happens on its parent's page, its own page, or both, and who acts decides which.** A page's token comes only from a membership at or above its scope (ADR-022 § *Getting an access token*), so the parent's page serves the parent's admins, and the scope's own page serves everyone who belongs to the scope. A Star's founder gets no token on Studio, while a galaxy admin gets one on both.
- **Home is the only list a person picks from.** A parent's page may list its children to manage them.

**Where each action happens:**

| Action | Where |
|---|---|
| Choose where to work | Home |
| Accept a membership | Home, by picking its pending row |
| Sign up, naming the account and its first app | The signup page on the platform host |
| Log in | The platform host |
| Go Home, log out | **Home** and **Log out** in the avatar menu on the universe page and in Studio, each a navigation to the platform host |
| Create another app | The universe page, `acme.lumenize.dev`, through the facade |
| Delete an app | That app's Studio, through the facade |
| Delete a tenant Star | Studio's list of the galaxy's tenants, through the facade |
| A tenant founder's own actions | A Nebula page on an origin the app's code cannot script, once tenants are real (§ *Decisions*) |
| Edit your profile | A scope page, since the Profile is reached over the mesh |
| Invite someone | Unchanged: through the facade, from the page it happens on today |
| Impersonate someone | Their own scope's page, through the facade |

Nothing moves to Home. Home links to the page where a thing gets done, one click away.

### Signing up lands in Studio

A person signs up to build an app, so the signup names the first app, and the first page after the emailed link is Studio. Walked through for `acme` and `crm`:

1. **The signup page on `platform.lumenize.dev` asks for the account's slug and the first app's name and slug.** The host spells both slugs, as `crm.acme.lumenize.dev`.
2. **The claim writes the universe, its first galaxy with that galaxy's `.dev` Star, and the unaccepted admin membership at `acme`.** Then it sends the link.
3. **The click runs the consume on the platform host**, which sets the cookie.
4. **Consent takes one click, on the platform host.** The claim's membership mints nothing until it is accepted, so a mail scanner's click accepts nothing.
5. **The tab goes to Studio at `https://crm.acme.lumenize.dev/`** once that host's certificate is active (§ *Decisions*).

Guiding a new user is Studio's first-run job, so the universe page begins at the second app: creating another app, the organisation's admins, and later its guidance layer. Home fast-forwards to the one place a person can work. For someone whose one membership is a universe holding one app, that place is the app's Studio, where today's fast-forward opens the universe page.

### Passage and dominion read the page's scope

**A page's code acts with its visitor's token, and on a Star's host that code is the user-developer's.** Under ADR-022 as written, the token carries the visitor's broadest membership, and ADR-022 § *Negative / mitigations* accepts what follows. Opening someone's Studio is enough: Studio loads their app in the as-you dev tab, and that frame's token carries the visitor's whole dominion, which for a superuser is the platform. The code can also outlive the visit, for instance by inviting its author as an admin.

**So the page a call came from sets how far it reaches.** The two checks are ADR-015's, with the page's scope, the token's `aud`, in `authScope`'s place. `scopeAdmin` still comes from the membership:

```
dominion = scopeAdmin ∧ isAtOrAbove(activeScope, targetScope)
passage  = isAtOrBelow(activeScope, targetScope) ∨ dominion
```

A token then reaches its page's subtree, plus the passage upward that any member has. Every action that § *The platform host handles the session lifecycle and the picker* places still passes, because each runs on the page of the scope it acts on, or on its parent's page. The checks keep their two inputs, the token and the target: `hasDominionOver` and `hasPassageInto` receive the verified claims rather than the `access` claim alone, because `aud` sits outside `access`. `access` keeps `authScope` and `scopeAdmin`, and names what the token rests on rather than how far it reaches.

- **`aud` can decide now, which it could not before.** [archive/nebula-passage-dominion-from-scope.md](archive/nebula-passage-dominion-from-scope.md) moved these checks off `aud` because the client chose it, and because the refresh confined it inside `authScope`, so it added nothing. ADR-022 derives it from `Origin`, which page script cannot set, and it now carries what `authScope` cannot: which page, and so whose code, made the call.
- **`aud` rather than the call chain.** A `callChain` entry names a node, not a scope, and `callChain.at(-1)` is only the last hop, so a chain from a page through its Star to the Galaxy looks like the Star. `aud` is signed, and rides every hop unchanged.
- **A plain membership's token verifies only when its `aud` equals its `authScope`.** Reading `aud` then only ever narrows, since `aud` already sits at or below `authScope`. The check belongs in `verifyNebulaAccessToken`, because two mint paths let a plain membership's `aud` sit below its scope today: the refresh, and the impersonation mint's subject bound. Without it, a plain member of `acme.crm` holding a token for `acme.crm.tenant1` would have passage into the tenant.
- **The cookie routes need nothing new.** The one platform-host route a Star's page can call is the refresh, which mints only for that page's own `Origin`. Every other `POST` to `/auth/` needs `Sec-Fetch-Site: same-origin`, a header page script cannot set.
- **Three defences sit with the pages rather than the checks.** Lumenize's own pages refuse to be framed, and a Star's host lets only its galaxy's Studio frame it, so no page can trick a click out of Home or Studio. Nothing on the platform host changes state on a `GET` or on load, so a page that sends the tab there causes nothing, logging out included. And Studio takes no privileged action because of a `postMessage` from a frame, which is the dev tab's one channel into it.
- **What the rule leaves.** Inside the page's own scope, its code acts for its visitor, which is the web's same-origin model and what ADR-022 set out to give every host. And any page's code can read and write its visitor's own Profile, as its owner ([ADR-012](../docs/adr/012-global-profile-visibility.md)).

### Claims the build rests on

1. **Reading the page's scope only ever narrows.** Verification already holds `aud` at or below `authScope`, and will hold a plain membership's equal to it (§ *Built already*, the checks). So every verdict read from `aud` is one that reading `authScope` also grants.
2. **Every passage and dominion verdict goes through `hasDominionOver` or `hasPassageInto`** ([ADR-007](../docs/adr/007-shared-node-security-core.md)), so changing what they read changes every site. `grep -rn 'hasDominionOver\|hasPassageInto' apps packages` lists them. The facade's invite eligibility makes one comparison of its own, `access.authScope === targetScope`, which reads `aud` the same way.
3. **The server picks the membership behind a token, where today the client names it through the hint.** After the move the refresh picks the broadest dominion at or above the page, so a person holding two qualifying memberships can carry a different `sub` on a page than they do today. § *Decisions* keeps ADR-022's pick, the highest of them.
4. **No session migrates.** `nebula.lumenize.com` retires (ADR-021 § *What each domain is for*), and a browser sends a cookie only to the host that set it, so every person logs in again on the platform host.

### Constraints

- [ADR-015](../docs/adr/015-passage-and-dominion.md): its two checks decide passage and dominion. This build reads them with the page's scope in `authScope`'s place, which amends the ADR (§ *Draft criteria*).
- [ADR-012](../docs/adr/012-global-profile-visibility.md): every token rests on an accepted membership.
- [ADR-018](../docs/adr/018-singleton-is-the-scarce-resource.md): the refresh stays a KV read, with no Registry round trip on a hit.
- [ADR-017](../docs/adr/017-the-url-is-the-view-state.md): moving between scopes is moving between hosts, and `.claude/rules/ui-routing.md` sends every such move through `leaveTo`.
- [ADR-009](../docs/adr/009-real-auth-path.md): the harness logs in for real, through the platform host.
- `.claude/rules/live.md`: every emailed link is followed as sent in every venue, and a `/live` scenario is the default witness for each flow.
- `.claude/rules/critical.md`: no cookie, token or full request URL is logged, at any level.

### Future state

- ⚠️ Design consideration: a customer's own domain brings a platform host of its own (ADR-022 § *A customer's own domain*). The client should therefore learn which platform host to call, rather than holding `platform.lumenize.dev` as a constant.
- ⚠️ Design consideration: how a navigation or an `<img>` on a scope host authenticates to a Durable Object's HTTP route stays open until after pre-alpha (ADR-022 § *Deliberately open*). Nothing built here should depend on a cookie reaching a scope host.
- ⚠️ Design consideration: once `createGalaxy` orders a certificate, it spends a budget every customer shares (ADR-021 § *What certificates may cost*). auth.md § *Grants in both planes* leaves the facade unthrottled because a caller could only overwhelm their own Star or Galaxy, which no longer holds. A cap on galaxies per universe inside the method answers it, and can land whenever the certificate orders do.
- ⚠️ Design consideration: Home is where a second Profile becomes visible, so it is where an offer to merge two belongs. Several Profiles in one browser are usually one human, and a coach may keep them apart on purpose: one picture for their clients, another for the apps they build themselves. So it stays an offer, and the flow that adds an address to a Profile is unbuilt (auth.md § *Identity and membership*).
- ⚠️ Design consideration: until a tenant's own side lands (§ *Decisions*), a tenant member sets their display name only at consent. Studio's `?profile` overlay is the one place that edits a Profile afterwards, and a tenant member gets no token on Studio.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **The platform host handles the session lifecycle and the picker, and scope pages handle everything a session does** (Larry, 2026-09-19). | **Home as a second place to act**, holding some of the universe page's features or a wizard for them. A page on the platform host holds no token, so every action there would need a cookie route beside its facade method. |
| **`create-galaxy`, `delete-scope-plan`, `delete-scope` and `mint-narrower-token` become `NebulaAuthFacade` methods**, called from scope pages. After this no Registry route carries a token. | **Leaving them as `Bearer` routes on the platform host.** ADR-022 refuses a `POST` there from a scope host, and a page on the platform host has no token. **Serving them on each scope host** keeps a second place for what a session does, which auth.md § *The Registry* sends over the mesh. |
| **`create-star` is deleted, not moved**, with `NebulaClient.scopes.createDevWorkspace` and `develop()`'s repair. Its test callers move to `createGalaxy` or go with it. | **Moving it to the facade.** Its one production caller repairs apps made before galaxies came with a `.dev` Star. [nebula-pre-alpha.md](nebula-pre-alpha.md) § *⑥ The wipe* already deletes it, and this build ships in the wipe's deploy. |
| **Home lists the tree within its 50-node budget, and `expand-scope` becomes Home's cookie read for opening a node past it, deferred to a backlog row until a list outgrows the budget** (Larry, 2026-09-19). The superuser's Home spans every universe, so it will likely reach the budget first. | **Building it now**: no pre-alpha user's tree comes near 50 nodes. **Confining it beneath its own host on scope pages**, as auth.md § *Impersonation*'s note has it: browsing the tree is picking, which is Home's. |
| **Signup names the account and its first app, and lands in Studio after one consent click** (Larry, 2026-09-19). | **Landing on the universe page to create the first app**: a new user should reach Studio without learning universe, galaxy and Star first. **Treating the click as consent**: a mail scanner's click would then accept a membership on its owner's behalf. |
| **Signup creates what a person signs up for, and any other scope is created on its parent's page. Every other action on a scope happens on its parent's page for the parent's admins, on its own page for everyone in the scope, or on both** (Larry, 2026-09-19). Home stays the only list a person picks from, and a parent's page may list its children to manage them. | **Every action on the scope's own page**, the rule this file first had: a tenant Star's page is the user-developer's app, so a galaxy's admins would have nowhere in Lumenize to manage its tenants. |
| **Each action is built once for now, on the page that serves everyone who can take it today.** Deleting an app happens in Studio, where galaxy and universe admins both get a token. Deleting a tenant happens in Studio's list of the galaxy's tenants, read through a facade method that lists a page's children and pages by `#childLevel`'s cursor. The universe page lists nothing yet. | **Building both sides of each action now**: the universe page's list would repeat Studio's delete for the same admins. **Dropping tenant deletes with the Manage view**: a galaxy admin could not remove a stranger's `claim-star`. |
| **A tenant's own side waits for real tenants, with a backlog row**: a Nebula page on an origin the app's code cannot script, opened from an entry point in the app, holding the founder's actions and every member's Profile. | **Nebula controls drawn inside the generated app**: ADR-020 decision 3 makes the app the user-developer's surface. **A Nebula page on the Star's own host**: it shares the app's origin, so the app's code can drive it. **Building it now**: pre-alpha has no real tenants, since its plan excludes real third-party end-user signup. |
| **Home and Log out sit in the avatar menu on the universe page and in Studio, each a navigation to the platform host.** | **A logout `POST` from the scope page**: ADR-022 refuses a `POST` to the platform host from a scope host. |
| **When a 401 sends the tab to the platform host and a pending membership's cookie covers `return_to`, the platform host shows that membership's consent** rather than the login. | **Sending the person to log in**: they would come back to the same 401, because an unaccepted membership mints nothing. |
| **Passage and dominion read the page's scope, the token's `aud`, in `authScope`'s place, and a plain membership's token verifies only when its `aud` equals its `authScope`** (Larry, 2026-09-19). | **Reading `authScope`, as ADR-022 has it**: a page's code acts with its visitor's broadest membership, a superuser's platform membership included. **Refusing facade calls, and calls above the Star, whenever `aud` names a Star**: sibling Stars stay reachable, and a member's peer invite and reads upward are refused. **Keying on `callChain.at(-1)`**: it names only the last hop. |
| **The checks read `aud` from the verified claims, and `access` keeps `{ authScope, scopeAdmin }`, redefined as what the token rests on.** `authScope` is the membership's scope, or a persona's Star, and bounds `aud`. `scopeAdmin` is the bit the checks apply at the page (Larry, 2026-09-19). | **Adding `access.activeScope`**: a second copy of `aud`, which verification would have to hold equal and every reader would have to tell apart. **Renaming `access` to `membership`**: a persona token rests on no membership, and the `scopeAdmin` inside `access` still decides dominion. |
| **The Gateway's `aud` fence is deleted, with its Profile exemption. What a tab receives is gated only by the passage check it met when it subscribed** (Larry, 2026-09-19). The fence was kept so that one admin's two tabs on sibling Stars would not receive each other's updates. Those tabs are now two origins with two Gateways, neither can subscribe to the other's Star, and neither can subscribe for the other, because the Gateway overwrites `callChain[0]` with the verified origin. | **Delivering when the receiving page sits at or below the page that caused the push**: a guard with no job left, which still refuses every push from a chain no page started. **Keeping it, with Studio reloading each frame after its own writes**: the reloads grow with every persona tab. |
| **A framed page never navigates the tab.** On a terminal auth failure it posts once to its parent, and Studio draws that state in its own UI around the frame and rechecks its own session, clearing the state on the frame's next `load` (Larry, 2026-09-19). | **ADR-022's navigation, in a frame**: a browser blocks it without sticky activation, `return_to` would be the frame's URL, so the person would return to the dev tab as a full page, and for a host this person cannot use it loops. **A sign-in button in the frame**: the same wrong `return_to`. **A popup or a second tab**: blocked without a click, and it splits the login off from the work. |
| **`NebulaClient` posts its terminal auth failure to `window.parent` from every page, at the origin the serving layer injects beside `nebula-scope`.** The message carries a kind, a status and a reason, never a token, and a page with no injected origin posts nothing (Larry, 2026-09-19). | **`'*'` as the target origin**: it makes the notice a login-status signal for any site that frames the app, should the `frame-ancestors` rule ever be wrong. **Deriving the parent from the page's own host**: it couples the client to ADR-021's grammar, where the serving layer already knows the answer. |
| **Home groups by Profile.** It lists every Profile the browser's cookies resolve to, each with its addresses, memberships and tree, and marks the rows this browser can enter without a fresh login (Larry, 2026-09-19). Each cookie's KV record already carries the `profileId`, and each group's summary comes back on that group's own cookie. | **One Profile at a time, with a switcher to the others**: the browser holds both credentials whatever Home draws, so showing one hides what is there — the shape that made a second login at a scope read as a silent identity swap. **The cookies alone, with no summary**: it drops the tree Home lists and the addresses that tell someone where to sign in next. |
| **An impersonation token is the token the subject's own login would mint on that page, with `act` added and nothing else changed** (Larry, 2026-09-19). Its `aud` is the page's, as every token's is, and two bounds then put the page at the subject's own scope: eligibility needs dominion over that scope from the page, and the mirror rule keeps `aud` inside it. So `impersonate` takes only the subject, and you act as someone where they work. It is a persona tab's shape: a page whose token names someone else, minted only for a caller holding dominion there. | **An `aud` of the subject's scope whatever page asked**: a page would hold a token whose `aud` is not its own, which is the one thing every check now reads. **Keeping `activeScope` as a parameter**: the page names it. |
| **Of the persona host, this build adds the refresh's branch and one `/live` scenario, and nothing else** (Larry, 2026-09-19). The cast, the Galaxy's provisioning and its records, Studio's tab strip, seeding and reaping stay with the personas build, which revisits the line when it is rewritten. | **Leaving the branch to that build**: ADR-022 settles the token and both conditions, the branch lands in the function this build rewrites, and a persona needs no record to exist, so that build would open by re-deriving this. **Adding Studio's tab strip here**: it belongs with the build that decides the cast. |
| **Logging out ends every session the browser's cookies name.** One route on the platform host expires each cookie and revokes the record behind it, reached from a page that first says what is about to end (Larry, 2026-09-19). In a frame, `logout()` tears the client down and tells the parent instead, since the session it would end is the parent's. | **Narrowing it to one Profile**: nothing asks for that until Home shows two groups, and it is a parameter on a route that already resolves each cookie. **Keeping today's "everywhere", which revokes an address's sessions in every browser**: its one caller is Studio's menu, auth.md already declines to guarantee a session's end on a device you no longer hold, and `revokeAllForAddress` has no other caller. **Today's per-membership logout**: named cookies leave it nothing to select. |
| **The refresh keeps ADR-022's pick: the highest accepted admin membership at or above the page, and otherwise the membership at the page's own scope** (Larry, 2026-09-19). The vertical pair the choice turns on is rare, since it takes a promotion or an invite into a scope its holder already owns from above, and capability is identical either way under § *Passage and dominion read the page's scope*. So `sub` stability decides it: a person keeps one id across every page their top membership covers, which is what DAG grants and anything keyed on `client.claims.sub` see. | **The nearest admin membership instead**: a person's id would change as they walk down into a scope where they hold a nearer one, and it edits a settled ADR for a capability-neutral difference. ADR-022 rejected it for a reason the page rule removes, which makes it valid rather than better. |
| **The certificates are ordered at the claim, and the new user waits on the platform host after consent** until Studio's host answers (Larry, 2026-09-19). Studio needs only the universe's wildcard, so the dev tab can still be waiting when Studio opens, and Studio draws that frame's state. Mining reconciles this with the wait the old file designed for Galaxy create. | **Ordering at the consume**: nothing is spent until the mailbox is proved, but the whole two and a half to four minutes then follows the click, which is what landing in Studio exists to avoid. **Waiting on the universe page**: it is live from the start, and its purpose moved to the second app. |

## Open questions

None. Each one worked here moved to § *Decisions* with the alternative it beat, and its number is not reused. The ADR-021 half arrives with its own.

## Draft criteria

Settled points the phases must turn into criteria. No phase is written yet.

- **No row of the Registry's route table carries `verifyJwtGuard`**, and `NebulaAuthFacade` answers the four operations § *Decisions* moves to it.
- **`create-star`, `createDevWorkspace` and `develop()`'s repair are gone**, and `grep -rn 'create-star'` finds nothing outside archived files.
- **A `/live` scenario signs up as `acme` and `crm` with a real email**, follows the link as sent, accepts, and lands in Studio at `crm.acme` once the universe's wildcard is active, with the dev tab showing its own wait until the galaxy's is.
- **A `/live` scenario asserts that Home sends nothing but its cookie read, consent and logout**, so an action that lands on Home reds it.
- **A universe admin's token from a tenant's page is refused dominion over a sibling tenant, the galaxy and the universe**, while the same person's token from the universe page holds all three.
- **A plain membership's token whose `aud` sits below its `authScope` fails verification**, whichever path minted it.
- **A change Studio makes to the dev Star reaches the dev tab as a push, with no reload.** It fails while the Gateway's `aud` fence stands.
- **A frame that cannot get a token posts once and leaves the tab where it is**, and Studio ignores a message from any origin but the frames it created.
- **A browser holding cookies for two Profiles sees both groups on Home**, with the rows that need a fresh login marked.
- **A derived token differs from the subject's own by `act` and nothing else.** Impersonating a tenant member happens on that tenant's page, and the same mint asked from the galaxy's page is refused.
- **A persona host mints a plain token as the persona** for a caller whose cookie holds dominion over that Star, and answers 401 for one that does not.
- **Someone holding admin memberships at a universe and at one of its galaxies carries the universe membership's `sub` on both pages.**
- **Logging out expires every cookie the browser presented and revokes each record behind it**, and a sign-out inside the dev tab leaves Studio's session alive. No route names a scope, and `grep -rn 'logout-all'` finds nothing outside archived files.
- **Lumenize's own pages refuse to be framed, a Star's host admits only its galaxy's Studio as a frame parent**, and a navigation to the platform host changes nothing.
- **Standing guidance is conformed.** In auth.md: § *The layers a call passes*, where no Registry route presents a token any more, so R4, R5 and the `create-star` example go; the note on `/mint-narrower-token` in § *Grants in both planes*, with its row in [backlog.md](backlog.md) § *Nebula Auth*; § *Home*, which names no universe page and keys its list on the person rather than the Profile; § *Identity and membership*, whose "A Profile is the person" the coach case qualifies, since one human may keep several on purpose; § *Superuser seed*, whose "selecting the superuser scope" names a step that no longer happens; § *Impersonation*, whose "whose scope your dominion already covers" now means from where you stand, and whose annotated token says `aud` is "where the admin chose to act"; and its note on `scope-summary` and `expand-scope`. [on-hold/nebula-registry-scope-in-url.md](on-hold/nebula-registry-scope-in-url.md) loses its subject.
- **The page rule is carried outside this file.** ADR-015 § *Predicate pair*, with its paragraph on the two-argument signatures. ADR-022 § *What an access token carries*, whose Galaxy example the rule reverses, and the first bullet of its § *Negative / mitigations*. In auth.md: § *The three roles a scope plays*, § *`activeScope`*, the predicates in § *Coarse-grained access control*, and the annotated token in § *The access token*, whose comment says passage and dominion read `authScope`. The notes on the Gateway's `aud` fence in auth.md § *`activeScope`* and in ADR-022's "Today's code differs", both of which close with its deletion. The scope rule in `.claude/rules/security.md`. And `calibration.md` §14, whose example the rule reverses for a reason §14 does not cover: the page's code, not the person.
- **Studio lists the galaxy's tenant Stars through the facade and deletes one**, and a caller without dominion over the galaxy is refused.
- **`expand-scope`'s deferral and a tenant's own side each have a row** in [backlog.md](backlog.md).
