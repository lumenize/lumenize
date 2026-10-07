---
status: accepted
status_dated: 2026-08-07
working_agreement: |
  Written for TOMORROW. The prose describes the TARGET state in present tense,
  including mechanisms that are not built yet, so nothing here has to be
  unlearned when a gap closes.

  Anything true only of TODAY'S CODE goes in a blockquote opening with
  "**Today's code differs.**" — never in the prose, and never as a hedge inside
  a sentence. That keeps the narrative stable and makes every remaining gap
  enumerable in one command:

      grep -n '^> \*\*Today' docs/vision/auth.md

  A blockquote opening any other way is an ordinary aside, not a gap.

  Note, these blocks will go stale as we close the gaps. Confirm any claims
  in them before relying upon them and when you discover one that has gone
  stale suggest that this document be altered (despite its "accepted" status)
---

# Authentication and Access Control

## Lumenize Nebula mesh

Nebula is made up of a highly distributed mesh of nodes. Communication between them goes through `lmz.call()`, an RPC system that sits on top of two transports: (1) Cloudflare's Workers RPC within Cloudflare, and (2) WebSockets to and from clients, usually in browsers but possible anywhere that has JavaScript and WebSockets.

Two things named throughout this document are not mesh nodes at all, so neither is an exception to that. The auth Registry sits outside the mesh, reached over HTTP and through one mesh-speaking facade. See § *The Registry*. A client's server-side half is not a node by itself; with its client it makes one (below). The Profile is a third case — it *is* a node, but it is best not thought of as a full one. See § *Profiles* for how it behaves differently and why.

**A client is a full peer node**, which surprises people. A server-side node calls one exactly the way it calls anything else — a binding, an instance name, a continuation — so a subscription update travelling out to a browser is an ordinary mesh call, not a separate delivery mechanism. Two things do differ: the last-mile **transport** is a WebSocket rather than Workers RPC, and the client is the one node we do not trust.

**A client and its server-side half together are the equivalent of a server-side node, with its responsibilities split between two execution environments.** The client runs in the browser and does what a node's own code does. Its server-side half runs inside the node its page's host spells, its *host node*: a page on `tenant1.crm.acme.lumenize.dev` connects to the Star `acme.crm.tenant1`. The half bridges both differences: it terminates the socket, establishes a client's claims on the way in, and on the way out checks that the tab has passage into the scope of whatever node is sending to it (§ *How the claims travel*). It also does for its client what a node's own framework does inside a node: it acks a call, keeps the call's result handler continuation, and fires the answer back. So a client's mesh address is its host node's name plus its own id, `STAR/acme.crm.tenant1/alice.9f2c41aa`, and anything that must not depend on the browser's honesty lives in that half.

**The host node stays a node in its own right.** Its own calls pass its own guard. A message addressed to one of its clients goes to that client's half instead, and runs nothing on the node.

## The layers a call passes

We use **defense in depth** and **zero trust** throughout.

You enter by authenticating, which sets a long-lived refresh cookie. That cookie mints short-lived access tokens in the form of signed JWTs. You then open a connection by presenting one, and its contents ride along with everything you do inside the mesh — through long chains of `lmz.call()`s — and can be a factor in every permission decision below.

One design decision runs underneath several of the layers below: **Nebula addresses Durable Objects (DOs) by name** (never using the 64-character hex id), and for a scoped node, **the name *is* its scope**. That is what turns an address from a routing fact into something authorization can base decisions upon.

After authentication, a call passes a fixed sequence of layers. Two verdicts decide the coarse-grained access control: **passage** (may this caller arrive at this scope?) and **dominion** (may this caller override what the node decides?). Both are computed from the call's `activeScope`, the `scopeAdmin` bit, and the `targetScope` it addresses. `activeScope` is *where the call is acting from*: the scope its host spells, never its path, so a call from `https://tenant1.crm.acme.lumenize.dev/orders?page=2` carries the `activeScope` `acme.crm.tenant1`, and a chain a node started acts from that node's name. § *Coarse-grained access control* defines both verdicts, and § *`activeScope`* says how the value is set.

**There are two sequences, because a call to a mesh node and a request to a Registry route arrive by different routes.** Only the mesh sequence computes the two verdicts. The Registry's HTTP routes are used for calls that don't have an access token — logging in, the refresh, acceptance, logging out. What a session does once it holds a token is a mesh call.

**Mesh nodes.** Every layer runs in order, even where a given call makes one a no-op:

- **M1 — Cloudflare's addressing.** A call can only arrive at the node it named, and that node's storage is reachable from nowhere else. This is real protection and we get it before any of our own code runs — but it decides *where* a call lands, never *who* may make it.
- **M2 — The name stamp.** When a node is created, it records the name it was reached by, and any later mismatch throws: a node can never change its name. That is what makes the scope in the name trustworthy rather than merely conventional. The layer below reads a pinned input rather than a convention.
- **M3 — `onBeforeCall()`.** Grants or refuses **passage** into this node, by calling `hasPassageInto` on the call's `activeScope` and `scopeAdmin` (§ *`activeScope`*) and its `targetScope`. `targetScope` is this node's own name, pinned by M2. Our coarse-grained access control. A message addressed to a Client the node hosts does not meet M3: the client's server-side half checks it instead (§ *How the claims travel*).
- **M4 — `@mesh()` decorators.** Only methods and getters decorated with `@mesh()` (TC39 stage 3 decorators) are reachable over `lmz.call()`; nothing else on the node can be called or read by a caller, and a field or `accessor` fails to compile under it. A `@mesh()`-decorated method or getter may hand back an object whose members the caller can then use, which is how a node hands out a capability (below).
  - **A result coming back is the one leg where `@mesh()` is not required.** That chain is one this node authored and sent out, so it runs against members this node chose, which are deliberately left without `@mesh()`: decorating one would also make a result handler callable as an ordinary request, with arguments of the caller's choosing. M3 still grants or refuses passage on the result leg, as on the request; a client's result leg comes back through its server-side half, and its passage was decided on the request. And no client can name code for anyone else to run on this leg. A result handler continuation goes out with its call and comes back filled to whoever wrote it, and when the call went to a client, that client's server-side half keeps the continuation and fills it with the client's answer, so the client supplies only a value.
- **M5 — The guard function.** `@mesh()` can have a guard function that runs before the method. Read-only operations often have none, because passage (§ *Coarse-grained access control*) is enough. Almost anything that changes state has one.
- **M6 — Checks at the top of the method.** A guard's only output is a binary allowed or refused. So, a decision that resolves into something other than *yes* or *no* runs inside the method instead, where it can explain itself over the `lmz.call()` response. That explanation is often a thrown error, which travels back over the mesh whole — its type and custom properties included — and is thrown again at the caller.
- **M7 — The Data-plane DAG (ReBAC).** The most common such error is `PermissionDeniedError`, thrown when an operation is attempted on a Resource the caller lacks permission for. The data plane keeps its own `admin`, `write`, and `read` grants on an orgTree shaped as a directed acyclic graph (DAG), so it can model the real-world messiness of organizations (people on loan to another department, teams reporting into two business units, etc.). This is a specific form of relationship-based access control (ReBAC).

**Why relationships rather than roles?** We believe relationships are far more flexible than the roles you see in most systems, and [AuthZed, who sell a ReBAC service, make that case in detail](https://authzed.com/learn/rbac-vs-rebac-when-to-use-which). The failure they name is *role explosion*: getting fine-grained with roles takes roughly one role per resource per action, and nested groups, resource hierarchies, and delegated access all fit badly — which are precisely the shapes an org tree is made of. Their own conclusion is not that ReBAC replaces RBAC, though. Most B2B SaaS ends up running both: roles for coarse policy, relationships at the resource level. That is already what we do. The `scopeAdmin` bit that dominion reads is the coarse, role-like half, and the DAG is the fine-grained half.

**A `@mesh()`-decorated getter can hand back a capability.** A Galaxy's `@mesh() get resources()` returns the request surface of its Resources plane, and a caller then calls `ctn<Galaxy>().resources.transaction(…)`: whatever the gate returns is exactly what the caller may use. That is the idea of the [object-capability model](https://en.wikipedia.org/wiki/Object-capability_model), with two differences:

- **The caller never holds a reference.** The link above assumes a programming language context where a holder keeps an unforgeable reference to an object. In  our case, the caller sends a continuation instead, a description of work to do, as data ([ADR-003](../adr/003-continuation-messaging.md)). It names a path from the gate — read `resources`, then call `transaction` with these arguments — and the callee replays that path on every call, so the gate's own checks run every time.
- **The replay closes JavaScript's loopholes.** The model is secure only where an object exposes nothing beyond what its author chose, and the page lists the [loopholes](https://en.wikipedia.org/wiki/Object-capability_model#Loopholes_in_object-oriented_programming_languages) that break that in languages like JavaScript: assigning to an object's fields, inspecting it by reflection, and reaching for authority no one handed you. A continuation can only read a property or call a function, so it assigns nothing. It walks only from the gate, so it reaches nothing else. And a path naming one of the doors every JavaScript object opens — `constructor`, `__proto__`, `__lookupGetter__`, `__lookupSetter__`, `__defineGetter__` or `__defineSetter__` — or reaching a `Function.prototype` member is refused, which closes reflection.

What a gate hands back is its author's choice, and nothing past the gate checks it, so hand back an object whose only members are methods and getters. A data property hands its value over as it is, with no code in between to narrow it, which is how `this`, `this.ctx` or `this.svc` leaks by accident.

**The facade is a mesh node that serves every scope.** It is a stateless Worker entrypoint with no name, so M2 pins nothing and M3 has no scope of its own to compare. Its `targetScope` arrives as a parameter instead — `createGalaxy('acme.crm')` — and each method decides passage or dominion against that parameter at the top of the method (M6), before its one Workers RPC to the Registry, which checks again. The verdicts and the claims are the same as on any node; only where the target comes from differs (§ *Grants in both planes*).

**Registry routes.** HTTP routes answered by the edge Worker in front of the Registry DO. A route is a URL pattern and an ordered list of steps, ending in the handler. Here is an example for two routes:

```
/auth/refresh-token   [connectionRateLimitGuard, handleRefreshToken]
/auth/claim-universe  [connectionRateLimitGuard, turnstileGuard, forwardRaw]
```

The first caller presents refresh cookies and the second presents nothing, because claiming is how a person comes to hold a session at all. Every layer runs in order, though not every route uses all of them:

- **R1 — The route table.** The table above is the registration: a path with no entry reaches no handler and 404s, and a known path with no entry for the verb answers **405**, listing the verbs it does accept.
- **R2 — The same-site check.** Every `POST` to `/auth/` requires `Sec-Fetch-Site: same-origin`, so a page on another host cannot post a login or a logout ([ADR-022](../adr/022-every-session-lives-on-the-platform-host.md) § *The cookie rules*). The access token refresh from a cookie is the exception. It serves every page on the site, so it also accepts `same-site`, and requires an `Origin` that names a scope.
- **R3 — Rate limiting.** ONE connection-keyed limiter per route (`connectionRateLimitGuard`), ahead of the first expensive thing: the cookie resolution's Workers KV read, or `turnstileGuard`'s `siteverify` round trip. No route here holds a verified `sub` to key on.
- **R4 — The route's own credential.** Turnstile for a claim or a magic-link request, the emailed link for the page it opens and that page's consume and Accept, refresh cookies for the refresh, an Accept on Home, Home's summary and logging out, and the signup ticket for a signup. § *The Registry* says why each route takes the one it does.
- **R5 — Checks in the handler.** Same role as M6: decisions resolving into something other than yes or no. For example: a claim on a taken slug resolves three ways in the handler — a fresh slug proceeds, the same unverified claimer gets their link re-sent, and anyone else gets a conflict (§ *Founding a Star*).

Every step refuses the same way: return a `Response` with an appropriate HTTP code. Explicit throwing is discouraged because that surfaces to the caller as an ambiguous 500. The mesh does the opposite: a refusal there travels back over `lmz.call()`, which preserves a thrown Error whole — custom properties included — so throwing carries what a status code cannot.

Home's summary is the one route that answers for a person rather than a scope. Home sits on the platform host, and no page there holds an access token, since the platform host is no scope (§ *Home*). So it reads its list with the refresh cookies themselves: every accepted one the request carries, grouped by each cookie's `profileId`. It names no target, so there is nothing for passage or dominion to decide.

A few routes answer outside both sequences, and one of them reads an access token; § *Routes outside both sequences* covers them.

The sections that follow expand on the model above.

## Scopes

Scope is the driver for coarse-grained access control.

A host spells one. `https://tenant1.crm.acme.lumenize.dev/` is the scope `acme.crm.tenant1`: the host lists the slugs innermost first and the scope outermost first, so the same three slugs appear in opposite orders, and a reader comparing the two should expect it ([ADR-021](../adr/021-every-scope-has-its-own-host.md)). A scope can also be a parameter of a mesh call.

Braces stand in for a value here and throughout: `{u}.{g}.{s}` names a Star.

In the mesh domain, scope serves an additional purpose. It is the instanceName half of a node address.

Examples:

- `{universe}.{galaxy}.{star}`, often abbreviated as `u.g.s`. Indicates a Star.
- `u.g`. Indicates a Galaxy, which contains `u.g.s` and many other Stars.
- `u`. Indicates a Universe, which contains `u.g` and other Galaxies.

The Profile and the Registry are named by something other than a scope — the Profile by its `profileId`, the Registry as a singleton with a fixed name. They are also some cases where scope is not needed.

Notice how **scopes are hierarchical**. The `this-universe.milky-way.sol` Star is a part of the `this-universe.milky-way` Galaxy, etc. This matters for § *Coarse-grained access control* below.

### The three roles a scope plays

The same kind of value appears in three distinct roles.

| | Answers | Where it lives |
|---|---|---|
| **`authScope`** | *who you are* — the membership this session was established under | `access.authScope` in the token, and the refresh cookie's name |
| **`activeScope`** | *where you are acting right now* — the scope your host spells, within `authScope` | the token's `aud`, taken from the host; for a chain a node started, that node's name |
| **`targetScope`** | *what you are acting on* | a mesh node's name, or a call parameter |

**The first two are properties of the caller; the third is a property of the call.** On a call from a person, `authScope` and `activeScope` ride the token and change only at login or refresh; `targetScope` differs for every call the same token makes. The two sections below cover the first two — `targetScope` needs no section of its own, because it is simply whatever is being addressed.

**The coarse-grained verdicts read `activeScope` and `targetScope`, with `scopeAdmin` from the membership** (§ *Coarse-grained access control*). The code a host serves is what makes a call, and on a Star's host that code is the user-developer's, so the host a call came from bounds what it may do. `authScope` says which membership the token rests on, and so whose `scopeAdmin` bit it carries.

## `authScope` (sessions)

A session has one `authScope`, represented by a refresh cookie. A login sets one for each membership the email address holds. A session outlives any particular access token, tab, or client and has a long TTL. Every one of them lives on `platform.lumenize.dev` and nowhere else, named for its membership's scope — `__Host-refresh-token.acme.crm` — so one login opens them all and one logout ends them all ([ADR-022](../adr/022-every-session-lives-on-the-platform-host.md)).

The refresh cookie is `HttpOnly` so no script can read it, `Secure` so it only travels over HTTPS, and `SameSite=Lax` so someone who follows a link in their email to Home (§ *Home*) is recognised: that navigation comes from another site, the mail client's, and a `Strict` cookie would stay behind. Its `__Host-` prefix makes a browser keep it only with `Path=/` and no `Domain`, so no other host can plant or overwrite it.

A page on any `lumenize.dev` host but `platform` gets its access token from the platform host's refresh. It calls `fetch` with `credentials: 'include'`, so the browser sends the platform host's cookies along. The page can read the answer only because the refresh names that page's origin in its CORS headers, and every other `POST` to `/auth/` refuses a request from another origin ([ADR-022](../adr/022-every-session-lives-on-the-platform-host.md) § *The cookie rules*). Among the memberships whose cookies arrive, the refresh picks the one with the broadest dominion at or above the host's scope, and that membership's scope is the token's `authScope`. So a universe admin on a tenant's page carries `authScope: acme`. From that page they hold dominion over the tenant, and to act on the Galaxy, `acme.crm`, they go to its host (§ *Coarse-grained access control*).

## `activeScope`

An access token is a signed JWT. It has one `activeScope` — *where the person is acting right now*, the scope their host spells — carried as the `aud` claim. On `https://tenant1.crm.acme.lumenize.dev` it is `acme.crm.tenant1`. One session can back many tokens at once, one per tab, on the same host or on different hosts, each carrying its own host's `activeScope`.

The refresh takes it from the request's `Origin`, which no script can set, and mints only where it sits at `authScope` for a plain membership, or at or below it for a `scopeAdmin` one, so it can only ever name somewhere `authScope` allows.

It is what the coarse-grained checks read, so a call acts within its `activeScope` and below ([ADR-022](../adr/022-every-session-lives-on-the-platform-host.md) § *What an access token carries*). Reading it only ever narrows what `authScope` alone would allow, because it already sits at or below `authScope`.

**A call chain a node started has an `activeScope` too, though it carries no token.** It is the name of the node that started the chain, when that name is a scope. An alarm on the Star `acme.crm.bigco`, or an update it broadcasts, acts from `acme.crm.bigco` with no `scopeAdmin`: passage into that Star and up through `acme.crm` and `acme`, and dominion over nothing. A node named by an id rather than a scope, such as a Profile, gives its chains no `activeScope`, so a scoped node refuses them.

Moving between active scopes is moving between hosts, which a person does from Home (§ *Home*). A tab on the new host gets a token of its own, and a connection carries for its life the one `aud` it presented.

The contrast, at a glance:

| | `authScope` | `activeScope` |
|---|---|---|
| Belongs to | the session | each access token |
| What it is | where you authenticated | where you are acting: the scope your host spells |
| Where it lives | the refresh cookie's name, and the JWT's `access` claim | the JWT `aud` |
| Who sets it | fixed at login; the refresh picks the session | the refresh, from the request's `Origin`, confined at or below `authScope` |
| What it decides | whose `scopeAdmin` bit the token carries | what a call from this host may do, through passage and dominion |

## The access token

A whole token, annotated — a Galaxy admin on a page at one of their tenants' hosts. Each comment names the section that expands it:

```jsonc
{
  "sub": "8f3c…",              // the membership — see § Identity and membership
  "aud": "acme.crm.bigco",     // activeScope — the scope my host spells; passage and dominion read it
  "access": {
    "authScope": "acme.crm",   // where I am a member — the membership this token rests on
    "scopeAdmin": true         // see § Coarse-grained access control
  },
  "profileId": "1a9d…",        // my public profile — see § Profiles
  // "act": { "sub": "…" },    // present only when impersonating — see § Impersonation
  // the standard JWT claims
  "iss": "…", "exp": 1754400000, "iat": 1754399100, "jti": "…"
}
```

## How the claims travel

The verified claims do not stop at the boundary they were checked on. The edge Worker verifies the JWT at the socket's upgrade, and the client's server-side half builds the claims once, when it accepts the connection. Every `lmz.call()` from there inherits them **unchanged** — so a node five hops deep reads the same `sub`, the same `aud`, the same `access`, and the same `act` chain the first node saw, without a lookup and without any caller threading them by hand. That is what makes the decision in § *Coarse-grained access control* local, and what lets a Resource write record its author from context alone.

**A call can also start a fresh chain, carrying no claims at all.** `lmz.call()` does this when asked, with `newChain: true`, and whenever there is no incoming call to inherit from, as in an alarm handler. The fresh chain names only the calling node, so it is that node speaking for itself rather than for whoever caused it. A subscription update works this way, since `lmz.broadcast` starts a fresh chain by default: the identity of whoever made the change reaches no subscriber. A client can start neither a fresh chain nor a forged result: its server-side half builds every call the client makes from the connection's verified token, and sends it only to a node's request door, where `@mesh()` is required.

So every node's M3 has to decide safely when the claims are absent, and each kind of node asks its own question there:

- **A scoped node asks for passage, which needs an `activeScope`**: the claims' `aud`, or on a fresh chain the name of the node that started it, when that name is a scope (§ *`activeScope`*). A call with neither is refused at its boundary. Every scoped node gets that check from `NebulaDO`, the base class a new scoped node type extends.
- **A node with no scope of its own**, such as the facade or the Profile, checks the claims at the top of each method that needs them instead.
- **A client and its server-side half split the question between them**, as they split everything a node does (§ *Lumenize Nebula mesh*). The half decides passage. The client does everything after it, dominion's override included if a Client ever has such need, and it refuses any call whose last hop is another client (below). So a subscription update, sent by a node, arrives with no claims and passes.

**Before a call reaches a client, its server-side half checks the tab's passage into the sender's scope.** The tab's `activeScope` is its host's, and the sender's scope is the name of the node that made the last hop, when that name is a scope. A Galaxy `acme.crm` sending to a tab on `acme.crm.bigco`'s host passes, since upward is free, and a sibling Star `acme.crm.other` sending to that tab is refused as lateral. A sender whose name is no scope, such as the Profile, passes, so a node not named by a scope must hold no tenant's data. The check reads the sender's address rather than claims, so a fresh chain passes it. It is there because a server-side node can address any client whose name it holds, and that half is the last place a lateral push to it can be stopped.

**A client refuses any call whose last hop is another client.** A feature such as a two-person chat goes through a server-side node instead.

## Coarse-grained access control

> **Today's code differs.** **A call to a node named `_platform` is refused outright**, so the universal passage described here does not yet hold at the root. That is a **name reservation** — nothing is deployed at that name, and refusing it stops an arbitrary class occupying the one name every caller has passage into — so it closes when the name goes from **rejected to bound**, never by being opened.

**This layer exists to make lateral movement impossible while allowing certain kinds of vertical movement.**

The `onBeforeCall()` guard sits at the node's outer boundary, and the one question it asks is whether the `lmz.call()` gets **passage** past it — decided from scope information alone. The design of the access token makes it so **this decision is completely local**. No network hop is needed.

**Lateral movement is not allowed**: If you are a member of one Star, there is nothing you can do with another. You cannot see it, read it, or write it — the call is refused at the boundary, before anything at the target runs. That is the first row of the table below.

**Vertical passage is allowed in only two specific forms** described below.

It compares the call's `activeScope` (the token's `aud`, or the name of the node that started a fresh chain) against the scope being acted on (`targetScope`), and there are two ways passage is granted:

- **Passage upward is free.** `targetScope` can be your `activeScope`, or an ancestor of it. No `scopeAdmin` needed.
- **Passage downward takes dominion.** `targetScope` is a descendant of your `activeScope` *and* `scopeAdmin` is set — the pair, never the bit on its own.

In one line: **`activeScope` and `targetScope` must be on the same vertical line, upward is free, and downward needs dominion** (`scopeAdmin`).

*Passage* and *dominion* mean one thing each, everywhere in this repo, and are never borrowed for anything else — which is why two uncommon words were picked ([ADR-015](../adr/015-passage-and-dominion.md) defines them). However, the analogy below should help you remember them.

Think of `scopeAdmin` as a feudal lord's title over some land (scope) — King of a Universe, Duke of a Galaxy, Count of a Star. A Duke does whatever they want in every County of their Duchy. In the Kingdom above, they may use what the Kingdom's rules leave open — the wood, the road — but decide nothing there and change nothing. Dominion is the combination of the title (`scopeAdmin`) *and* the land (scope), never the bare `scopeAdmin` bit, and it runs only downward. Passage is the right of way, and it runs both ways: the Duke rides down into their own Counties because they hold them, and up to the King's wood because the Kingdom's rules say that it stands open to everyone in the Kingdom — while the neighbouring Duchy's border is closed to them. And a lord rules from the hall they stand in: in one of their Counties the Duke rules that County, and to decide something for the whole Duchy they ride back to its seat. God sits above the Kings — the root of the realm rather than an exception to it — and may stand in any hall, ruling each by the same downward rule every lord holds. § *Superuser seed*.

Two predicates express all of it, and no guard re-derives either ([ADR-007](../adr/007-shared-node-security-core.md)). [ADR-015](../adr/015-passage-and-dominion.md) is the definition home; where it and this section disagree, it wins:

```
isAtOrAbove(myScope, targetScope)  — my scope covers the target: the same scope, or an
                                     ancestor of it. The reserved platform scope is the ROOT
                                     of the tree, so it is at or above every scope.
isAtOrBelow(myScope, targetScope)  — my scope sits at or beneath the target: the same scope,
                                     or a descendant of it. Every scope is at or below the
                                     platform root. Exactly isAtOrAbove with the arguments
                                     flipped: isAtOrAbove(A, B) === isAtOrBelow(B, A).

dominion(aud, scopeAdmin, targetScope) = scopeAdmin ∧ isAtOrAbove(aud, targetScope)

passage(aud, scopeAdmin, targetScope)  = isAtOrBelow(aud, targetScope)
                                         ∨ dominion(aud, scopeAdmin, targetScope)

   aud is the PAGE's scope, taken server-side from its Origin and never named by the
   client; scopeAdmin still comes from the membership the token rests on.
```

Passage is only getting past the outer border. What you can then do is decided by the rules of whatever you reached — on the mesh path (M5–M7):

-  `@mesh()` guards on the methods the node exposes;
- the checks at the top of those methods, and;
- for anything touching Resources, by the Data-plane's own grants.

A Registry endpoint is the same shape one layer shorter (R6–R7): its own guard functions, then the checks in its handler. It touches no Resources, so there is no third.

So the last column below is what a caller of that shape *usually* ends up able to do. It characterizes the common case; it is not a rule.

Seven example calls, all in the same Universe:

| Case | `activeScope` | `scopeAdmin` | `targetScope` | Usually can |
|---|---|---|---|---|
| **Lateral** | `u.g.s1` | no | `u.g.s2` | **nothing** — lateral movement, refused; the case this layer exists for |
| Ordinary | `u.g.s` | no | `u.g.s` | most of the app's methods, and the Resources their orgTree grants cover |
| Upward | `u.g` | no | `u` | read the organizational-level agentic coding standing guidance |
| Upward, `scopeAdmin` below the target | `u.g` | **yes** | `u` | the same as the row above — the bit sits beneath `u`, so it buys nothing |
| Upward, `scopeAdmin` at the target | `u` | **yes** | `u` | everything at the Universe, including editing the standing guidance |
| Downward | `u.g` | **yes** | `u.g.s` | everything in that Star, via the bypass |
| Downward, no `scopeAdmin` | `u.g` | no | `u.g.s` | **nothing** — no method ever runs |

**Lateral** needs no rule of its own: `u.g.s2` is neither an ancestor of `u.g.s1` nor a descendant of it, so both comparisons simply fail. A sibling Galaxy or another Universe fails identically.

The four rows between it and **Downward** are one rule against different target scopes, and none of them needs `scopeAdmin` to get in — passage is doing all the work. Dominion is then asked a second time *inside*, against the scope being acted on, which is why passing the boundary settles nothing about what you may do once there (§ *The data plane*).

The last row is the invited collaborator on one app: they have passage into no Star at all, not even the `.dev` one, so testing there is a second membership and a second session.

`_platform` is **not** an exception. It is the **root of the scope tree** — at or above every scope, and every scope at or below it — so a superuser's membership there gets them a token on every host by the ordinary rule, and no separate arm is needed. Declaring the root once, inside `isAtOrAbove`, is what keeps it out of every call site. The two verdicts land differently there, and the asymmetry is the whole point: **passage to the platform scope is universal**, because the upward arm asks `isAtOrAbove('_platform', anything)`, which the root satisfies for everyone. **Dominion over it is nobody's**, because that asks the reverse, `isAtOrAbove(page, '_platform')`, which holds only for a page at the root, and no page sits there.

One thing sits outside all of this: the Profile, deliberately — § *Profiles*. 

### Why upward exists

Upward passage exists primarily so a caller can read what the scope above them offers. For example, there is one app definition and many tenant Stars, so anything belonging to the app rather than to a tenant has to be readable from below.

Another example is the **guidance hierarchy**. Standing guidance — `AGENTS.md`, skills, rules — lives at three levels, each owned by different people and serving a different purpose: we own the platform layer, a Universe's admins own what holds across that organization's apps, a Galaxy's admins own what holds for one app. Anyone designing an app needs the whole stack upward.

Reading the whole stack is free; **a layer's write floor is the write floor of the thing it describes.** The Galaxy layer is a file in the app's source tree — `AGENTS.md` beside `src/App.vue` — so it takes source's floor: DAG `write` at the chat node, the door a message passes to land in the thread. A collaborator who can change `App.vue` can change the guidance beside it, and the agent's own edit of that file on their turn runs under that same floor. The Universe layer describes an organisation's practices, so **editing it takes dominion over the Universe**. When a retro turns up something that would help every app in the organization, lifting it to the Universe layer is a Universe admin's edit. That is the product improving itself recursively — the same loop we run on this repo.

At the Universe layer that is a limit on who *writes*, not on who *proposes*. Nothing here would stop a feature that lets a Galaxy admin suggest a Universe-level change and routes it for attention over email.

> **Today's code differs.** The platform and Galaxy layers are built and read on every Studio turn; the Universe layer is not. Upward passage works, but no Universe DO holds a Workspace yet, so nothing stores, reads, or writes that layer, and the guidance hierarchy has no consumer of upward passage in the running system.

### Why downward is generous for admins

Downward dominion is total ([ADR-015](../adr/015-passage-and-dominion.md), which defines the term: dominion is the `scopeAdmin` bit *and* a scope that covers the target, never the bit alone). It covers every scope beneath the admin's scope, including ones created later, and nothing down there is closed to them.

That totality is the point, not an overreach. A Universe or Galaxy admin stands to their tenancy roughly as we stand to our own Cloudflare account: anyone holding broad access can do very nearly anything, and the discipline lives in *who you hand it to* — never in what the platform will permit once they hold it. These admins have their own clients to serve, and they cannot administer that relationship through a platform that second-guesses them. So who gets `scopeAdmin` is their call, made as carefully as we make ours; where an action is destructive we may warn, but we never refuse ([ADR-015](../adr/015-passage-and-dominion.md)).

What that totality means for user data — a bypass over a Star's whole permission tree, with no grant ever written — is discussed more in § *The data plane*.

## Inside the node

Passage means the call is accepted at the node's outer boundary. Three things still stand between it and any state.

First, only methods decorated with `@mesh` are callable over `lmz.call()` at all. Everything else on the node — its storage, its helpers, its private methods — is unreachable from outside, so the node's callable surface is exactly what it chose to publish and nothing more.

Second, a decorated method may also carry a guard, which runs before the method body. Read-only operations usually carry none, because passing the boundary was already enough. Almost anything that changes state carries one — a check that the caller is an admin of this node, say.

Third, sometimes it's preferable to not use a guard method. A guard's only output is *yes* or *no* for the whole call. So, a decision that resolves into something other than a *yes* or *no*, belongs in the method instead. Resource permission is a good example. A transaction reports *which* resources were refused and at what tier, which is what lets a client climb the orgTree to find someone to ask who can help them get past the restriction. Also, deciding that in a guard would double the required reads: once to judge it and again to act on it. Those checks therefore run at the top of the method, and what comes back depends on the shape of the call. A single read throws `PermissionDeniedError`, and it travels over the `lmz.call()` response. A transaction catches that same error per operation and returns normally instead — `ok: false`, carrying one typed entry per refused resource. That is the finer answer a guard could not have given, and the reason the client hears about every refusal rather than only the first.

## The data plane and fine-grained access control

The data plane usually lives in a Star and holds all user-generated data. Access to it is fine-grained, decided against an orgTree — think of an access control list in a file system, right down to the folder structure being a DAG, because file systems have links.

Resources, which store all user-generated data except Profiles and some internal data, are always attached to a node in that orgTree. Permissions are granted on those nodes, in three tiers, each including the one below it:

| Tier | Includes | Adds |
|---|---|---|
| `read` | — | read |
| `write` | `read` | create and modify |
| `admin` | `write` | widening access |

Widening access covers granting permissions to others, and it also covers the structural edits that grant access implicitly. Adding a parent edge, or re-parenting a node, hands everyone above the new parent access to that node's subtree, so both require `admin` on the child rather than just `write`.

Permissions trickle down the orgTree. To alter a Resource's value, or create one, a user needs `write` or `admin` on the node it is attached to, or on any one of that node's ancestors. Because the orgTree is a DAG, a node can have several parents and therefore several ancestor paths. A grant on any one path is enough, and where paths disagree the highest permission wins.

The two admins meet here, and the direction is one-way. A data-plane `admin` is a grant on an orgTree node; `scopeAdmin` is a bit on a membership, carried on the token. `scopeAdmin` overrides the data plane's grants, never the reverse. Someone whose dominion covers the node hosting a data plane gets a bypass over that entity's whole orgTree — full read, write and admin, with no data-plane-level grant ever written. Dominion over *that host* is the whole test, never the bare bit, so an admin of a child scope whom passage legitimately lets into the parent holds no bypass once there. That is § *Why downward is generous for admins* arriving where user data lives.

A Star's own admin acts through that bypass too, and holds no grant in its orgTree. The bypass is nowhere in the orgTree, so a client climbing it for someone who can grant what it needs (§ *Inside the node*) cannot see a bypass-only admin, and where such a climb ends is the request-access design's question ([`tasks/on-hold/nebula-request-access.md`](../../tasks/on-hold/nebula-request-access.md)). A Resources-level admin added later likely holds no `scopeAdmin` at all. Independence runs that way too, though not to zero: a data-plane `admin` on **any** node of the orgTree, holding `scopeAdmin` nowhere, grants and revokes freely inside that orgTree — and has a little authority in the Registry as well. They may invite a peer into their own scope (§ *Grants*), including one who will hold data-plane `admin` themselves. What they cannot do is make anyone a `scopeAdmin`, create a sibling scope, or delete this one.

> **Today's code differs.** The climb is not built, so nothing walks the orgTree looking for someone to ask.

## Identity and membership

Access is anchored to the mailbox and managed by the Registry. Identity is anchored to the person and captured in the Profile.

A membership is one address in one scope. It is what a token's `sub` names, and it is what "member" means everywhere in this document. Someone who belongs to three scopes holds three memberships and all of that is recorded in the Registry.

A Profile is the person. Name, nickname and picture follow them across every scope, Star and Universe, and one Profile can span several of their addresses. A Profile survives its last membership, so work stays attributed to a real person long after they have left.

> **Today's code differs.** The data model already lets one Profile span several addresses, but the flow for adding a second one is not built.

That split is a deliberate bet against how GitHub does it. There, your account determines access, so email is a contact detail and organization membership outlives your leaving. Removing you takes an admin action, and if nobody takes it, access persists indefinitely. We keep the half worth keeping, which is the portable identity, and reject the half that leaks. Here, deactivating a company mailbox offboards the person automatically. There is no admin action to forget and no revocation feature to remember to build.

Two consequences we accept.

A live session outlives the mailbox by up to the refresh token's lifetime. Losing the mailbox stops new logins immediately, but a session already issued keeps working until its refresh token expires. That is bounded where GitHub's is indefinite, and in practice a company wiping a laptop takes the cookie with it — but that is their capability, not our guarantee.

The same mechanism can lock out an owner. A user-developer who claims a Universe with an employer address and later loses it is locked out of work they own, and none of the rules above bend to help. The answer is a warning at signup: use an address you will keep, and invite the work address afterwards. If it happens anyway and they can establish the work is theirs, a support ticket will allow them to retake possession.

Changing an email address is possible and takes proof of both. Proof of the new one, and fresh proof of the old one at the time of the change — a live session is not proof, because sessions outlive mailbox control. That one rule separates every case with no special handling:

| Case | Old address still reachable | Outcome |
|---|---|---|
| Name change | yes — the new one is provisioned while the old still delivers | allowed, memberships preserved |
| Moving providers | yes | allowed |
| Departing employee | no — the company killed it | refused; access dies with the mailbox |

The last row is the point, not a gap.

## Home

**Home, at `platform.lumenize.dev`, is where a person decides which scope to work in.** That deciding is called "discovery". It can happen whenever we are uncertain where to send someone, like after a fresh login. It can also be chosen by hand, when someone wants to change the scope they are working in, and the people who do that most are admins and coaches.

Not every type of scope is a place to work and thus not a reasonable active scope, but for those that are, choosing a scope in discovery takes you to the page for that type of active scope. Galaxy active scopes take you to Nebula Studio. Star active scopes serve up that app. Someone working in `u.g1` who wants to do some work in `u.g2` picks it from the list, and the tab goes to that scope's host, because the scope you are working in is view state ([ADR-017](../adr/017-the-url-is-the-view-state.md)).

The list is over memberships rather than over what the current token covers, so it can span sessions. Because one person can hold memberships at several addresses, it is keyed on the **person** — their `profileId` — rather than on any one address (§ *Identity and membership*). Home reads it by the refresh cookies the browser holds, since a page on the platform host gets no token, and when those cookies belong to more than one Profile it shows each as a group of its own.

**Home is a picker.** Every action it offers is a link to the host whose token can perform it: an account's "+ App" opens the universe's page, and an app's Delete opens that app's Studio. Someone who can work in only one place skips the list and lands there. Every session's cookie lives there too, so whichever membership the destination needs, the new page's refresh finds it. Those cookies are long-lived and coexist, so an already-open session just works, and only an expired or absent one puts a login in front of the user's desire to work somewhere else.

The login itself names no scope, only an email address. Once someone is authenticated, discovery lists where they can work and they pick.

**Skipping the picker when a page sent you.** A page whose refresh finds no session sends the tab to log in with `return_to`, and the login returns there, in whichever browser opened the link ([ADR-022](../adr/022-every-session-lives-on-the-platform-host.md) § *Logging in*). ⚠️ **The destination is remembered by the login, never carried in the emailed link.**

## The Registry

The Registry is the one thing in this document that sits entirely outside the mesh, and it is the single source of truth for who exists, what scopes exist, and who is a member where: the records the rest of this document reads have to be written somewhere no token is yet required. How it is reached splits along one line — **HTTP carries the session lifecycle; the mesh carries what a session does** (the mechanism: § *Grants in both planes*).

None of its HTTP routes reads an access token, so none computes passage or dominion. What a session does reaches the Registry through the facade, where the verdicts are the ones a mesh node computes (§ *Grants in both planes*), so there is one model, not one per surface.

#### What authenticates each route

**Cookie or token, never both.** Each route authenticates one way: a credential under `/auth/` is an emailed link, a refresh cookie or a signup ticket, and an access token authenticates a mesh call. The trade is stated so it need not be rediscovered: a cookie costs a Workers KV read per request where a token verifies statelessly, and buys revocation that does not wait out an access token. Every route takes R1 to R3, then whatever steps it needs.

**Getting a session.** Claiming a scope, requesting a magic link, consuming one. These cannot verify a token because they are how a person comes to hold one. Two things stand in: `turnstileGuard` proves a human is present, running after rate limiting because it costs a `siteverify` round trip; and the credential itself arrives out of band, because access is anchored to the mailbox (§ *Identity and membership*).

**Presenting the refresh cookie.** `refresh-token` exchanges refresh cookies for an access token, Home's summary and acceptance read them, and `logout` ends them (§ *`authScope` (sessions)*). A signup that proved its address before choosing a slug presents a signup ticket instead, a `__Host-` cookie of its own. The caller is authenticated here by cookie rather than by JWT. A cookie's name only says which membership it holds: what the cookie is worth, and the scope that decides anything, are read from the stored refresh record.

The seam stays clean, and it is worth being precise about what kind of clean. **No authorization decision ever consults the Registry mid-session** — once a client presents a valid signed JWT at connect, the coarse-grained gate, the `@mesh()` guards, the checks at the top of methods and the data plane's whole DAG all decide locally, off the claims. What does come to the Registry mid-session goes through the facade (§ *Grants in both planes*): writes, and the universe page's read of its own apps. The deciding path is finished by the time the connection is open; everything else goes through one door.

The one exception is a Profile write, where the scoped-admin branch reads the Registry to confirm an accepted membership; the owner branch reads nothing (§ *Profiles*). That borderline exception is one reason why we say that it is best not to think of Profile as a full mesh node.

Scope existence is independent of membership. Creating a Galaxy writes its scope row and its `.dev` Star's, and nothing else, so a real, working scope can have zero members — the creator's own dominion already covers it. Of the operations that *create a scope*, only the claim paths also mint an identity — because until one exists nobody holds a token for the new scope. A universe's claim also writes its first galaxy and that galaxy's `.dev` Star, so a new account lands in Studio. Invites mint identities too, but into a scope that already exists (§ *Grants*).

Everything else the Registry owns has its own section: sessions and their cookies, memberships and the addresses they hang off, and the scope and admin bit that the coarse-grained gate reads out of every token.

## Profiles

**It is best not to think of a Profile as a full mesh node.** It participates in the mesh and uses its code and conventions, but its coarse-grained access control is intentionally different: it is the one place where lateral passage is the *point*. The same person works in several applications in one Universe; coaches and contract workers are invited into different organizations entirely. Some will want a distinct persona in each, but most do not want to re-type their name and upload their picture again for every one. So a Profile is readable sideways, by design, and the rules above do not apply to it.

A Profile holds two categories of data, public and private, and nothing in between. There is no orgTree inside a Profile and no acl structure of its own.

Public data includes name, nickname, and picture. It is open to every Nebula client. Reading it takes an authenticated connection and the `profileId`, and nothing else — no scope, no membership, and no relationship between reader and subject is consulted. The read touches no Registry data.

A Profile is not a web resource. There is no HTTPS endpoint for one — no route and no `fetch()` handler — so it cannot be curled, crawled, or linked to from outside. The only way in is a mesh call on an already-authenticated connection.

The `profileId` being random and unguessable stops enumeration, not access. Any authenticated client who obtains an id, by whatever means, can read that profile's public fields. There will never be more gating than that. If a user doesn't want their real name or picture readable that way, they are free to obfuscate themselves.

Private data can be read and written only by the owner of the profile, or by an admin whose page holds dominion over a scope where that person holds an **accepted** membership. A superuser qualifies the same way, from the page they are on. The system's own Profile belongs to no scope, so it is the one a superuser's membership alone opens.

Accepted is load-bearing, not bookkeeping. An invitation creates a membership before the invitee has done anything, so counting unaccepted ones would let anyone claim a Universe, invite an address they guessed, and become an admin over a scope that stranger's profile touches. A membership is taken up only by an Accept the person clicks behind a consent screen, on the emailed link's page or on Home, and both go through one Registry acceptance method. The link's page is authenticated by the link, and Home by the refresh cookie a click on mail to that address put in the browser, so either way the mailbox is proved. Proving it is not enough on its own — that is a different act from agreeing to hold the membership.

The owner is whoever's `profileId` is on the token. An admin impersonating someone is that person here, exactly as they are everywhere else — the token names the subject, and nothing about the actor changes what it may do. What keeps that safe is that the token cannot exist over a membership nobody accepted: the mint refuses to issue one, so an admin arrives only at the profiles their own dominion already covers.

Access to a Profile is therefore decided by the token, plus Registry data for the admin case. The owner case reads nothing from the Registry, because the token already carries the `profileId`.

## Superuser seed

An environment variable holds an array of superuser email addresses. Logging in with one of these gives that login a membership at `_platform`, the root of the scope tree — the equivalent of Registry scopeAdmin over every Universe. That needs no special arm: `isAtOrAbove` already places the root at or above every scope, so a superuser gets a token on every host and passage everywhere. Dominion, though, reads `activeScope`, and no host spells the root ([ADR-022](../adr/022-every-session-lives-on-the-platform-host.md)) — so in any one call they hold that host's scope and below. They administer every scope there is, one host at a time.

## Impersonation

An admin can act as someone they administer. The token names both people: the top-level `sub` is the person being acted as, and `act.sub` is the admin doing it. The token format allows nesting, but impersonation does not chain — to act as someone else you go back to your original session.

`act` in an **access token** means impersonation and nothing else, and that is an invariant rather than a coincidence. One refusal keys on the chain merely being there: the mint, which will not impersonate from a token that already carries one. Prepend an actor into somebody's own session token and they lose their ability to act as anyone, for a reason nobody intended. Chains grow on the **record** instead — § *Attribution* — where an actor is legitimately not an impersonator at all, since Nebula adds itself to every turn it writes.

It produces a token but not a session. There is no refresh cookie behind it, which is why ending it means tearing down the client and never calling the logout endpoint — that would spend the cookie of the session that minted it, ending the admin's own.

Authorization is decided by the subject and never the actor. Otherwise the admin carries their own power into the user's seat and never experiences the system the way a user does, which defeats the motivating use case for impersonation — debugging.

It is never an escalation. You can only act as someone whose scope your dominion already covers, and only from that person's own page: the mint takes the new token's `aud` from the page that asked, so the token mirrors that person's own access with `act` added, rather than your own.

Here is that mirroring, in the same shape as the token in § *The access token* above. The admin from that example — `8f3c…`, with profile `1a9d…` — is now acting as a member of one of their Stars:

```jsonc
{
  "sub": "7b2e…",              // the SUBJECT — authz reads this, always
  "aud": "acme.crm.bigco",     // the subject's own scope, which is the page the admin asked from
  "access": {
    "authScope": "acme.crm.bigco"  // the subject's scope, not the admin's
  },
  "profileId": "4c8a…",        // the SUBJECT's profile
  "act": {
    "sub": "8f3c…",            // the ADMIN — recorded, never read for authz
    "profileId": "1a9d…"       // display only
  },
  "iss": "…", "exp": 1754400000, "iat": 1754399100, "jti": "…"
}
```

Every identity claim names the subject, `scopeAdmin` included — the subject does not hold it, so the token does not. The admin's own bit is not blended in. It is what permitted the impersonation at all, which is a separate rule checked somewhere else. The only trace of who is really driving is `act`, and nothing that decides access is allowed to look at it.

One test governs when a check may look at `act` at all: only where impersonation would otherwise grant the actor something they could not already do themselves. Everywhere else it buys nothing, since an admin can already do anything to anyone beneath them. No read a token can make answers beyond its own `activeScope`, where the admin already holds dominion, so nothing passes that test now. A check that ever does may look at whether `act` is present, never at who the actor is.

There is no consent step, deliberately. An admin can already read and write anything in their scope under their own name, so impersonation grants them nothing new. It only changes attribution, and it improves it by naming both parties — gating it would push an admin toward the less traceable path. This changes if a customer requires consent during a security review and the deal is worth it.

### When Nebula is the actor

Studio's agent writes Resources on a user-developer's behalf, and it holds **no authority of its own** — no membership, no access token, no login. The write runs inside the triggering person's own call, carrying their `sub` and their permissions, and the platform adds itself as an **actor on the record**, never on the token. So the record reads *this human, via Nebula*, and authorization is unchanged: the agent can do exactly what that person could and nothing more, because it is that person's authority doing it.

The actor id is `agent:nebula` — self-describing and syntactically not a human, so a server-composed actor stays distinguishable from a token-attested one at a glance ([ADR-016](../adr/016-record-the-acting-principal.md)). It is only ever an actor, never a subject; `sub` names the person who prompted the turn. Nebula does hold a Profile, so it renders like any other participant (§ *Profiles*), but it has no membership and the Registry knows nothing about it.

Two inversions are tempting and both are wrong. Giving the agent its own login would **grant** it authority that then has to be confined, where this design has nothing to confine. And the actor is composed server-side: a client able to name its own actor would defeat the record entirely.

### Attribution

An attribution record answers two questions.

- **Identity** — *who acted* — is the acting principal: the subject, the `access` that token asserted, and the **actor chain** (`act` in the JWT) when an admin and/or Nebula acts on the subject's behalf. The chain is not decoration. Authorization keys off the subject alone (§ *Impersonation*), so a record carrying only the subject names the person acted *upon* as the person who acted — worse than no record, because it will be believed.
- **Topology** — *through what path* — is `callChain`, the `[origin, …, caller]` list of mesh nodes a call travelled, extended automatically at each hop so provenance is never something a caller threads by hand. Naming who acted without what authorized them is half an answer, so both belong in what gets written.

Two kinds of action write an attribution record, and **the same function builds both** — no site assembles its own fields — so the two cannot drift apart ([ADR-016](../adr/016-record-the-acting-principal.md)).

- **A Resource write** adds what changed and when. A Resource is a sequence of snapshots and the record rides every one of them: a write **closes the current snapshot and opens a new one** rather than overwriting, committed history is immutable, and even a delete is itself a snapshot transition ([ADR-004](../adr/004-snodgrass-temporal-resources.md)). No later write can erase it, because none of them destroys anything.
- **An action that changes who can do what, removes state, or establishes a session** writes its record to a durable sink of its own.

APIs and UIs allow the querying and inspection of both. These records are access controlled so they only show each person what their scope and authAdmin status entitles them to see.

> **Today's code differs.** Neither half is readable as history. Resource snapshots are durable, but every read path returns the current one only — prior versions accumulate with no way to retrieve them and no query surface over them. The acting-token records go to the debug log — retained for a window rather than forever, and readable by nobody filtered to their own scope. And topology is written down nowhere at all; `callChain` survives only for the duration of a call. So identity already rides both records and most of the remaining work is the sink, the reader and the viewer — but the path is a genuine addition. We do not yet meet the full vision of [`_ai-security.md`](_ai-security.md) § *Attribution*.

## Grants

**Grants are made with as little friction as possible and growth is why**. Our success is a function of how many people are on our platform, so friction in the path to getting someone *onto* it is not caution — it is failure. It is why a stranger may claim a Universe or an unclaimed Star and become its `scopeAdmin` with nobody's approval, and it is the same reason a member may bring in a peer.

So, anyone may invite a non-admin at their own scope. Dominion additionally permits inviting downward, and is the only thing that permits conferring `scopeAdmin`.

**Registry-only grants**. Only `scopeAdmin` grants are made in the Registry alone, by a claim or through the facade.

Ordering is important. A data-plane grant names a `sub`, and a `sub` only exists once a membership does. So the Registry step always comes first.

### Grants in both planes

An operation whose outcome spans both planes — an invite that mints a membership *and* lands an orgTree grant is the canonical case — follows one recipe:

1. **It initiates on the data-plane side** — the node hosting the orgTree — because the grants that authorize it live there and the Registry cannot see them. The data-plane guard stands at this door.
2. **It reaches the Registry through the facade** — a mesh-speaking entrypoint the Registry's package owns, where the Registry-side guards live: claims-level verdicts only, the acting principal recorded from the same verified claims (ADR-016), the one raw Workers RPC call from a node that accepts `lmz.call()`s. The Registry never learns what a Star is.
3. **Both planes are written in one operation — which no transaction spans.** There is no cross-plane transactional support, so inconsistency is the implementor's to consider. The Registry writes first and both halves are idempotent, so the one reachable inconsistency — a membership without its grant — heals on a re-attempted invite.

The facade is not reserved for two-plane operations: it is how *anything* an authenticated session does reaches the Registry (§ *The Registry*), pure-Registry invites included. It also rate-limits nothing, deliberately, and neither does any other mesh call. Every mesh caller holds a token naming them, so one calling in a loop can be found and cut off, and what the loop costs the Registry is load, which is recoverable. The one facade method that spends something shared and scarce, creating a galaxy, orders a certificate from the zone's pool, so it is capped per owner instead. We add a limit when there is a problem, and a per-`sub` limit at a client's host node would cover every mesh call at once. The HTTP surface keeps its limiter (R3 in § *The layers a call passes*).


### Founding a Star

Sometimes, a `scopeAdmin` grant is made for a Star before anything has addressed the Star itself.

**The flow keeps everyone else off the Star until its founder accepts,** so that the founder's own request is the first to touch it and places it near them. `.claude/rules/durable-objects.md` § *A named object is placed by the first code that touches it* says why that matters and what would move it. Three steps make this happen:

1. **The claim writes to the Registry, never to the Star.** A single unauthenticated call, fronted by Turnstile — anyone may claim an unclaimed Star, with no invitation and no approval step, and that openness is the product rather than an oversight. It validates and then writes atomically: the scope row, an *unaccepted* admin membership at the full three-segment id, and a magic link. The parent Galaxy must already exist, under a Universe whose claim someone has accepted, but that is an integrity check rather than an admin gate; nobody is authenticated at this point in the flow.
2. **The mailbox proves the person.** The emailed link opens a consent screen that changes nothing until the person clicks Accept, which proves the address, places a session cookie and accepts the membership in one act. Re-claiming from the same address re-sends the link; a different address gets a conflict, so a pending claim cannot be taken over.
3. **The founder's Accept creates it.** The first call to reach the Star is the Accept's own teardown, which starts it empty, from the Worker serving the founder's request.

**Placement is not enforced.** Nothing refuses a call from anyone whose dominion covers the Star, so whoever touches it first places it. It is a bet rather than a check, and the one realistic way to lose it is a support visit landing in the window before the founder accepts.

## Routes outside both sequences

Two paths answer on every `lumenize.dev` host, outside the mesh and outside the Registry: `/pictures` and `/_version`. The Worker matches them by path before it looks at the host at all.

- **`PUT /pictures` is the one HTTP route that reads an access token.** A page uploads a profile picture's bytes with its access token as `Authorization: Bearer`. The Worker verifies the token, stores the bytes in the platform's blob bucket in R2 under a random key tagged with the token's `profileId`, and answers the path `/pictures/{key}`. Whose picture it is comes from the verified token, never from the request, and any valid access token will do, since all it buys is one stored image. The page then writes the path into its own Profile over the mesh, as its owner (§ *Profiles*). It is an HTTP route so the bytes go straight from the Worker to the bucket rather than through a socket and a Durable Object; the browser uploading to R2 through a short-lived signed URL would retire it.
- **`GET /pictures/{key}` needs nothing.** An `<img>` carries no access token, and holding the key is the capability, as holding a `profileId` is for a Profile's public fields.
- **`/_version` answers which build is deployed**, for the deploy scripts to check.
