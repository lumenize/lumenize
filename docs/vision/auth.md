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

Two things named throughout this document are not mesh nodes at all, so neither is an exception to that. The auth Registry sits outside the mesh and is reached over HTTP. See § *The Registry*. The Gateway is mesh mechanics, not a mesh node. The Profile is a third case — it *is* a node, but it is best not thought of as a full one. See § *Profiles* for how it behaves differently and why.

**A client is a full peer node**, which surprises people. A server-side node calls one exactly the way it calls anything else — a binding, an instance name, a continuation — so a subscription update travelling out to a browser is an ordinary `lmz.call()`, not a separate delivery mechanism. Two things do differ: the **transport** is a WebSocket rather than Workers RPC, and the client is the one node we do not trust. **The Gateway bridges both.** It terminates the socket, and it is where a client's claims are established on the way in and checked on the way out, which is why it appears throughout this document without ever being a node itself.

## The layers a call passes

We use **defense in depth** and **zero trust** throughout.

You enter by authenticating, which sets a long-lived refresh cookie. That cookie mints short-lived access tokens in the form of signed JWTs. You then open a connection by presenting one, and its contents ride along with everything you do inside the mesh — through long chains of `lmz.call()`s — and can be a factor in every permission decision below.

One design decision runs underneath several of the layers below: **Nebula addresses Durable Objects (DOs) by name** (never using the 64-character hex id), and for a scoped node, **the name *is* its scope**. That is what turns an address from a routing fact into something authorization can base decisions upon.

After authentication, a call passes a fixed sequence of layers — but **there are two sequences**, because a call to a mesh node and a call to a Registry endpoint arrive by different routes. Both compute the same two verdicts from the same claims: **passage** (may this caller arrive at this scope?) and **dominion** (may this caller override what the node decides?), from `authScope` and `scopeAdmin` against the scope being addressed. § *Coarse-grained access control* defines both. Some Registry endpoints present no access token — those that get you one, and those that present a refresh cookie instead — and § *The Registry* covers what stands in for the steps they skip.

⚠️ **The two sequences differ in where the addressed scope comes from.** On the mesh path the node's name *is* its scope, pinned at creation, so M3 compares against something the caller cannot influence. On the Registry path one DO serves every scope and the scope arrives as a URL segment. R2 is the step that checks it, and the mesh path has no equivalent because M1 and M2 already did that work.

**Mesh nodes.** Every layer runs in order, even where a given call makes one a no-op:

- **M1 — Cloudflare's addressing.** A call can only arrive at the node it named, and that node's storage is reachable from nowhere else. This is real protection and we get it before any of our own code runs — but it decides *where* a call lands, never *who* may make it.
- **M2 — The name stamp.** When a node is created, it records the name it was reached by, and any later mismatch throws: a node can never change its name. That is what makes the scope in the name trustworthy rather than merely conventional. The layer below reads a pinned input rather than a convention.
- **M3 — `onBeforeCall()`.** Grants or refuses **passage** into this node, by calling `hasPassageInto(access, targetScope)`. `targetScope` is this node's own name, pinned by M2. Our coarse-grained access control.
- **M4 — `@mesh()` decorators.** Only methods decorated with `@mesh` (TC39 stage 3 decorators) are callable over `lmz.call()`. Everything else on the node is uncallable.
- **M5 — The guard function.** `@mesh()` can carry a guard that runs before the method. Read-only operations usually have none, because passing the boundary is enough. Almost anything that changes state carries one.
- **M6 — Checks at the top of the method.** A guard's only output is a binary allowed or refused. So, a decision that resolves into something other than *yes* or *no* runs inside the method instead, where it can explain itself over the `lmz.call()` response.
- **M7 — The Data-plane DAG (ReBAC).** The most common such error is `PermissionDeniedError`, thrown when an operation is attempted on a Resource the caller lacks permission for. The data plane keeps its own `admin`, `write`, and `read` grants on an orgTree shaped as a directed acyclic graph (DAG), so it can model the real-world messiness of organizations (people on loan to another department, teams reporting into two business units, etc.). This is a specific form of relationship-based access control (ReBAC).

**Why relationships rather than roles?** We believe relationships are far more flexible than the roles you see in most systems, and [AuthZed, who sell a ReBAC service, make that case in detail](https://authzed.com/learn/rbac-vs-rebac-when-to-use-which). The failure they name is *role explosion*: getting fine-grained with roles takes roughly one role per resource per action, and nested groups, resource hierarchies, and delegated access all fit badly — which are precisely the shapes an org tree is made of. Their own conclusion is not that ReBAC replaces RBAC, though. Most B2B SaaS ends up running both: roles for coarse policy, relationships at the resource level. That is already what we do. The `scopeAdmin` bit that dominion reads is the coarse, role-like half, and the DAG is the fine-grained half.

**Registry endpoints.** HTTP routes on the edge Worker in front of the Registry DO. A route is a URL pattern and an ordered list of steps, ending in the handler:

```
/auth/:scope/create-star  [parseScopeGuard, verifyJwtGuard, subRateLimitGuard, passageGuard, dominionOverScopeGuard, handleCreateStar]
/auth/claim-universe      [connectionRateLimitGuard, turnstileGuard, forwardRaw]
```

The layers below describe the first of the examples above — a route whose caller arrives with an access token in the `Authorization: Bearer …` header. The second presents none, which is why it is handled differently; § *The Registry* covers that case. Every layer runs in order, though not every route uses all of them:

- **R1 — The route table.** The table above is the registration: a path with no entry reaches no handler and 404s, and a known path with no entry for the verb answers **405** with `Allow`.
- **R2 — The addressed scope is parsed.** Patterns like `/auth/:scope/create-star` carry a scope as a segment, so it is parsed and refused if malformed before any step that reads it. **It is itself a step** — `parseScopeGuard`, first in the list — not something the table does, so a route carrying no scope simply omits it. The segment is the `targetScope` that R5 and R6 compare against.
- **R3 — Rate limiting.** ONE limiter per route; **its key and place follow from whether verified identity exists at that point.** A token-bearing route takes a single `sub`-keyed limiter *after* R4 (`subRateLimitGuard`): everything costly on such a route — a Registry read, a DO write — sits after the verify, and a signature check is sub-millisecond local CPU, so a limiter ahead of it would pay roughly what it saves. A route with no `sub` yet — the cookie routes, the open routes — takes a single connection-keyed limiter (`connectionRateLimitGuard`) ahead of the first expensive thing: the cookie resolution's singleton read, or `turnstileGuard`'s `siteverify` round trip. Never both on one route.
- **R4 — `verifyJwtGuard`.** Signature and expiry, from the `Authorization: Bearer` header. Produces the verified claims every later step reads.
- **R5 — `passageGuard`.** Calls `hasPassageInto` — the same verdict M3 computes, with R2's scope as the `targetScope`.
- **R6 — The endpoint's own guard functions.** Each asks one complete question. For example: `dominionOverScopeGuard` for the `/create-star` endpoint in the Registry endpoints partial shown above.
- **R7 — Checks in the handler.** Same role as M6: decisions resolving into something other than yes or no. For example: a claim on a taken slug resolves three ways in the handler — a fresh slug proceeds, the same unverified claimer gets their link re-sent, and anyone else gets a conflict (§ *Founding a Star*).

Every step refuses the same way: return a `Response` with an appropriate HTTP code. Explicit throwing is discouraged because that surfaces to the caller as an ambiguous 500. The mesh does the opposite: a refusal there travels back over `lmz.call()`, which preserves a thrown Error whole — custom properties included — so throwing carries what a status code cannot.

One authenticated route carries no scope at all: `my-scopes` returns the scopes the caller can reach, so there is no target to decide about. R2 has nothing to parse and R5 nothing to compare — the answer *is* the set, and it is computed from the caller's own claims.

> **Today's code differs.** `create-galaxy`, `create-star` and `delete-scope(-plan)` — the first example row above included — still take their scope in the request body rather than a URL segment, so R2 and R5 skip them too. The edge verifies the token, injects the verified `access` claim, and the Registry DO checks dominion at the top of the method it runs — so the check lands at R7 where R6 belongs, and the route table cannot show it. Moving them onto `/auth/:scope/…` puts it back in front of the handler — [nebula-registry-scope-in-url.md](../../tasks/nebula-registry-scope-in-url.md) owns the move.

The sections that follow expand on the model above.

## Scopes

Scope is the driver for coarse-grained access control.

It often appears in a segment of a URL, but it can also be a parameter of a mesh call or in the body of a Request.

In `https://nebula.lumenize.com/{bindingName}/{u}.{g}.{s}/`, the `{u}.{g}.{s}` would be the scope. Braces stand in for a value here and throughout; `:scope` in the route table above is literal `URLPattern` syntax, which is why the two differ.

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
| **`authScope`** | *who you are* — the membership this session was established under | `access.authScope` in the token, and the refresh cookie's `Path` |
| **`activeScope`** | *which one you are acting as right now*, chosen within `authScope` | the token's `aud` |
| **`targetScope`** | *what you are acting on* | a URL segment, a mesh node's name, or a call parameter |

**The first two are properties of the caller; the third is a property of the call.** `authScope` and `activeScope` ride the token and change only at login or refresh; `targetScope` differs for every call the same token makes. The two sections below cover the first two — `targetScope` needs no section of its own, because it is simply whatever is being addressed.

⚠️ **The coarse-grained verdicts read exactly two of the three: `authScope` and `targetScope`.** `activeScope` is not an input to passage or dominion (§ *Coarse-grained access control*), and leaving it out subtracts nothing — every refresh already confines it inside `authScope`, so deciding on it would be deciding on a value `authScope` has already bounded.

Anything that looks like a fourth resolves to one of these. `Memberships.universeGalaxyStarId` is `authScope` at rest. The `:scope` segment of a Registry route and the instanceName half of a mesh node address are both `targetScope`, arriving by different transport. `myScopeTree` returns a *set* of scopes a person can reach, which is an answer about many scopes rather than a fourth role for one.

## `authScope` (sessions)

A session has one `authScope`, represented by the refresh cookie set at login. It outlives any particular access token, tab, or client and has a long TTL. Reloading the page reuses it, and logging in at a different scope starts another one without removing the current one so more than one can be active at any given time, each with a different `Path` and expiration.

The refresh cookie is `HttpOnly` so no script can read it, `Secure` so it only travels over HTTPS, and `SameSite=Strict` so it is never sent cross-site. Its `Path` is `/auth/{authScope}`.

Browsers decide which cookies to send by starts-with-style matching the request path against that `Path`, one whole segment at a time. So a cookie at `/auth/{u}` is sent to `/auth/{u}` and to anything deeper, like `/auth/{u}/refresh-token`, but not to `/auth/{u}.{g}/`, because `{u}.{g}` is a different URL segment rather than a deeper path. Sessions at different scopes are therefore fully separate.

## `activeScope`

An access token is a signed JWT. It has one `activeScope` — the scope the client is working in, carried as the `aud` claim. One session mints a token per client, and those clients can sit at different active scopes at once.

The client asks for it on each refresh and the server confines it to what the session already reaches, so it can only ever name somewhere `authScope` allows. It is restrained by `authScope`, but is not an independent factor in an access-control decision.

What it does do is fence the Gateway's **outbound** leg. A call heading out to a client is refused if its `aud` differs from the one that connection presented, so a person's own clients cannot bleed into each other. Since the client picks both sides of that comparison, the fence can only withhold a call — never reach anything new. The Profile is exempt, deliberately: responses out of it carry public fields only, and cross-scope delivery is the point.

The UI has controls for moving between active scopes for the people who most often work in more than one — admins and coaches. Someone working in `u.g1` who wants to do some work in `u.g2` picks it from a list of every scope they are a member of, and the URL changes to name it, because the scope you are working in is view state ([ADR-017](../adr/017-the-url-is-the-view-state.md)). Whether the browser makes that a full navigation or a client-side one does not matter: either way the old client is disposed and a new one connects at the new `activeScope`, since a connection carries for its life the one `aud` it presented. They work there until they change it again.

That list is over memberships rather than over what the current token reaches, so it can span sessions — and a different session is a different cookie, at a different `Path`** (§ *`authScope` (sessions)*). Where the destination is inside the session already open, the move is what this section describes: a new token, a new `aud`, the same cookie. Where it is a different membership, meaning a different session, the url changes first, and it is the cookie at *that* scope's `Path` that mints the new token. Those cookies are long-lived and coexist, so an already-open session just works, and only an expired or absent one puts a login in front of the user's desire to work somewhere else.

Because one person can hold memberships at several addresses, the list is keyed on the **person** — their `profileId` — rather than on any one address (§ *Identity and membership*). It takes an authenticated caller to retrieve the list.

> **Today's code differs.** Switching already disposes the client and rebuilds it at the new `activeScope`, but the URL never changes — the divergence [ADR-017](../adr/017-the-url-is-the-view-state.md) was written against. Neither endpoint behind the picker exists yet either. The only move available is opening a Star within the session already open, and the only person-wide list is `discover`, which is keyed on the email address and unauthenticated — filed as an enumeration oracle in [backlog.md](../../tasks/backlog.md) § *Nebula Auth*, whose fix is the authentication half of what this section describes. The `profileId`-keyed list is not built.

The contrast, at a glance:

| | `authScope` | `activeScope` |
|---|---|---|
| Belongs to | the session | each access token |
| What it is | where you authenticated | the scope one client works in |
| Where it lives | the refresh cookie's path, and the JWT's `access` claim | the JWT `aud` |
| Who sets it | fixed at login | the client asks on each refresh; the server confines it to what the session reaches |

## The access token

A whole token, annotated — a Galaxy admin whose client is working in one of their tenants. Each comment names the section that expands it:

```jsonc
{
  "sub": "8f3c…",              // the membership — see § Identity and membership
  "aud": "acme.crm.bigco",     // activeScope — fences calls out to me, grants nothing
  "access": {
    "authScope": "acme.crm",   // where I am a member — passage and dominion both read it
    "scopeAdmin": true         // see § Coarse-grained access control
  },
  "profileId": "1a9d…",        // my public profile — see § Profiles
  // "act": { "sub": "…" },    // present only when impersonating — see § Impersonation
  // the standard JWT claims
  "iss": "…", "exp": 1754400000, "iat": 1754399100, "jti": "…"
}
```

## How the claims travel

The verified claims do not stop at the boundary they were checked on. The Gateway builds them once, when it accepts the connection and verifies the JWT, and every `lmz.call()` from there inherits them **unchanged** — so a node five hops deep reads the same `sub`, the same `access`, and the same `act` chain the first node saw, without a lookup and without any caller threading them by hand. That is what makes the decision in § *Coarse-grained access control* local, and what lets a Resource write record its author from context alone.

## Coarse-grained access control

> **Today's code differs, in ONE way.** The JWT now carries the member's scope itself and a non-admin no longer reaches downward — but **a call to a node named `nebula-platform` is refused outright**, so the universal passage described here does not yet hold at the root. That is a **name reservation** — nothing is deployed at that name, and refusing it stops an arbitrary class occupying the most reachable name in the system — so it closes when the name goes from **rejected to bound**, never by being opened.

**This layer exists to make lateral movement impossible while allowing certain kinds of vertical movement.**

The `onBeforeCall()` guard sits at the node's outer boundary, and the one question it asks is whether the `lmz.call()` gets **passage** past it — decided from scope information alone. The design of the access token makes it so **this decision is completely local**. No network hop is needed.

**Lateral movement is not allowed**: If you are a member of one Star, there is nothing you can do with another. You cannot see it, read it, write it, or reach it at all — the call is refused at the boundary, before anything at the target runs. That is the first row of the table below.

**Vertical passage is allowed in only two specific forms** described below.

It compares where you are a member (`authScope`) against the scope being acted on (`targetScope`), and there are two ways passage is granted:

- **Passage upward is free.** `targetScope` can be your own `authScope`, or an ancestor of it. No `scopeAdmin` needed.
- **Passage downward takes dominion.** `targetScope` is a descendant of `authScope` *and* `scopeAdmin` is set — the pair, never the bit on its own.

In one line: **`authScope` and `targetScope` must be on the same vertical line, upward is free, and downward needs dominion** (`scopeAdmin`).

*Passage* and *dominion* mean one thing each, everywhere in this repo, and are never borrowed for anything else — which is why two uncommon words were picked ([ADR-015](../adr/015-passage-and-dominion.md) defines them). However, the analogy below should help you remember them.

Think of `scopeAdmin` as a feudal lord's title over some land (scope) — King of a Universe, Duke of a Galaxy, Count of a Star. A Duke does whatever they want in every County of their Duchy. In the Kingdom above, they may use what the Kingdom's rules leave open — the wood, the road — but decide nothing there and change nothing. Dominion is the combination of the title (`scopeAdmin`) *and* the land (scope), never the bare `scopeAdmin` bit, and it runs only downward. Passage is the right of way, and it runs both ways: the Duke rides down into their own Counties because they hold them, and up to the King's wood because the Kingdom's rules say that it stands open to everyone in the Kingdom — while the neighbouring Duchy's border is closed to them. God sits above the Kings — the root of the realm rather than an exception to it — and has dominion over everything, by the same downward rule every lord holds. § *Superuser seed*.

Two predicates express all of it, and no guard re-derives either ([ADR-007](../adr/007-shared-node-security-core.md)). [ADR-015](../adr/015-passage-and-dominion.md) is the definition home; where it and this section disagree, it wins:

```
isAtOrAbove(myScope, targetScope)  — my scope covers the target: the same scope, or an
                                     ancestor of it. The reserved platform scope is the ROOT
                                     of the tree, so it is at or above every scope.
isAtOrBelow(myScope, targetScope)  — my scope sits at or beneath the target: the same scope,
                                     or a descendant of it. Every scope is at or below the
                                     platform root. Exactly isAtOrAbove with the arguments
                                     flipped: isAtOrAbove(A, B) === isAtOrBelow(B, A).

dominion(authScope, scopeAdmin, targetScope) = scopeAdmin ∧ isAtOrAbove(authScope, targetScope)

passage(authScope, scopeAdmin, targetScope)  = isAtOrBelow(authScope, targetScope)
                                               ∨ dominion(authScope, scopeAdmin, targetScope)
```

Passage is only getting past the outer border. What you can then do is decided by the rules of whatever you reached — on the mesh path (M5–M7):

-  `@mesh()` guards on the methods the node exposes;
- the checks at the top of those methods, and;
- for anything touching Resources, by the Data-plane's own grants.

A Registry endpoint is the same shape one layer shorter (R6–R7): its own guard functions, then the checks in its handler. It reaches no Resources, so there is no third.

So the last column below is what a caller of that shape *usually* ends up able to do. It characterizes the common case; it is not a rule.

Seven example calls, all in the same Universe:

| Case | `authScope` | `scopeAdmin` | `targetScope` | Usually can |
|---|---|---|---|---|
| **Lateral** | `u.g.s1` | no | `u.g.s2` | **nothing** — lateral movement, refused; the case this layer exists for |
| Ordinary | `u.g.s` | no | `u.g.s` | most of the app's methods, and the Resources their orgTree grants reach |
| Upward | `u.g` | no | `u` | read the organizational-level agentic coding standing guidance |
| Upward, `scopeAdmin` below the target | `u.g` | **yes** | `u` | the same as the row above — the bit sits beneath `u`, so it buys nothing |
| Upward, `scopeAdmin` at the target | `u` | **yes** | `u` | everything at the Universe, including editing the standing guidance |
| Downward | `u.g` | **yes** | `u.g.s` | everything in that Star, via the bypass |
| Downward, no `scopeAdmin` | `u.g` | no | `u.g.s` | **nothing** — no method ever runs |

**Lateral** needs no rule of its own: `u.g.s2` is neither an ancestor of `u.g.s1` nor a descendant of it, so both comparisons simply fail. A sibling Galaxy or another Universe fails identically.

The four rows between it and **Downward** are one rule against different target scopes, and none of them needs `scopeAdmin` to get in — passage is doing all the work. Dominion is then asked a second time *inside*, against the scope being acted on, which is why passing the boundary settles nothing about what you may do once there (§ *The data plane*).

The last row is the invited collaborator on one app: they reach into no Star at all, not even the `.dev` one, so testing there is a second membership and a second session.

`nebula-platform` is **not** an exception. It is the **root of the scope tree** — at or above every scope, and every scope at or below it — so a superuser's dominion everywhere is the ordinary downward rule applied from the top, and no separate arm is needed. Declaring the root once, inside `isAtOrAbove`, is what keeps it out of every call site. It also means the two verdicts land differently there, and the asymmetry is the whole point: **passage to the platform scope is universal** — the upward arm asks `isAtOrAbove('nebula-platform', anything)`, which the root satisfies for everyone — while **dominion over it is superuser-only**, because that asks the reverse, `isAtOrAbove(myScope, 'nebula-platform')`, which holds only when your own scope *is* the platform scope.

One thing sits outside all of this: the Profile, deliberately — § *Profiles*. 

### Why upward exists

Upward passage exists primarily so a caller can read what the scope above them offers. For example, there is one app definition and many tenant Stars, so anything belonging to the app rather than to a tenant has to be readable from below.

Another example is the **guidance hierarchy**. Standing guidance — `AGENTS.md`, skills, rules — lives at three levels, each owned by different people and serving a different purpose: we own the platform layer, a Universe's admins own what holds across that organization's apps, a Galaxy's admins own what holds for one app. Anyone designing an app needs the whole stack upward.

Reading the whole stack is free; **editing a layer takes dominion over the scope that owns it**. A Galaxy admin evolves that Galaxy's guidance and nothing above it. When a retro turns up something that would help every app in the organization, lifting it to the Universe layer takes dominion over the Universe, so a Universe admin is the one who makes that edit. That is the product improving itself recursively — the same loop we run on this repo.

That is a limit on who *writes*, not on who *proposes*. Nothing here would stop a feature that lets that Galaxy admin suggest a Universe-level change and routes it for attention over email — or one that lets an ordinary Galaxy member suggest a change to their own layer.

> **Today's code differs.** The guidance hierarchy is not built. Upward passage works, but nothing yet stores, reads, or writes standing guidance at any of the three levels, so it has no consumer in the running system.

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

The two admins meet here, and the direction is one-way. A data-plane `admin` is a grant on an orgTree node; `scopeAdmin` is a bit on a membership, carried on the token. `scopeAdmin` reaches into the data plane, never the reverse. Someone whose dominion covers the node hosting a data plane gets a bypass over that entity's whole orgTree — full read, write and admin, with no data-plane-level grant ever written. Dominion over *that host* is the whole test, never the bare bit, so an admin of a child scope whom passage legitimately lets into the parent holds no bypass once there. That is § *Why downward is generous for admins* arriving where user data lives.

A Star's own admin does not depend on that bypass: founding one writes a real `admin` grant on its root node (§ *Founding a Star*), so a founder holds both. A Resources-level admin added later, likely does not hold a Registry-level authAdmin. The overlap for the founder is **visibility, not access** — the bypass is nowhere in the orgTree, so a client climbing it for someone who can grant what it needs (§ *Inside the node*) cannot see a bypass-only admin, and would climb to the root and find nobody to ask. The real grant gives that climb a terminus inside the Star. Independence runs the other way too, though not to zero: a data-plane `admin` on **any** node of the orgTree, holding `scopeAdmin` nowhere, grants and revokes freely inside that orgTree — and has a little authority in the Registry as well. They may invite a peer into their own scope (§ *Grants*), including one who will hold data-plane `admin` themselves. What they cannot do is make anyone a `scopeAdmin`, create a sibling scope, or delete this one.

> **Today's code differs.** The climb is not built — [`tasks/on-hold/nebula-request-access.md`](../../tasks/on-hold/nebula-request-access.md) is still a stub, so nothing today walks the orgTree looking for someone to ask. The root-admin grant that gives it a terminus *is* built and seeded (`apps/nebula/src/star.ts`), which is why the Star writes a grant whose only consumer does not exist yet.

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

## The Registry

The Registry is the one thing in this document that sits entirely outside the mesh, and it is the single source of truth for who exists, what scopes exist, and who is a member where: the records the rest of this document reads have to be written somewhere no token is yet required. How it is reached splits along one line — **HTTP carries the session lifecycle; the mesh carries what a session does** (the mechanism: § *Grants in both planes*).

Its scoped routes are gated by the same two rules as a mesh node (§ *Coarse-grained access control*) — reaching your own scope or an ancestor is free, and a descendant takes dominion — so there is one model, not one per surface.

#### Endpoints that present no access token

This case has two families, and neither reaches R4 or R5 — with no verified claims there is nothing for `passageGuard` to decide about. Both take R1, R2 and R3, then whatever steps that endpoint needs.

**Getting a token.** Claiming a scope, requesting a magic link, consuming one, discovering where you are a member. These cannot verify a token because they are how a person obtains one. Two things stand in: `turnstileGuard` proves a human is present, running after rate limiting because it costs a `siteverify` round trip; and the credential itself arrives out of band, because access is anchored to the mailbox (§ *Identity and membership*).

**Presenting the refresh cookie.** `refresh-token` exchanges the refresh cookie for an access token; `logout` ends the session. The caller is authenticated here by cookie rather than by JWT. The cookie's `Path` is `/auth/{authScope}` and browsers match whole segments, so `/auth/{u}/refresh-token` only ever receives a cookie set at `/auth/{u}` or shallower — but that decides which cookie is *sent*, never what it is worth. The scope is read server-side from the stored refresh record, and the requested `activeScope` is confined inside it; it is never taken from the cookie or from the URL.

That is also why the scope segment on these routes is not what R2 describes — never a scope being acted on.

The seam stays clean, and it is worth being precise about what kind of clean. **No authorization decision ever consults the Registry mid-session** — once a client presents a valid signed JWT at connect, the coarse-grained gate, the `@mesh()` guards, the checks at the top of methods and the data plane's whole DAG all decide locally, off the claims. What does reach the Registry mid-session is **writes**, through the facade (§ *Grants in both planes*). The deciding path is finished by the time the connection is open; the mutating path goes through one door.

The one exception is a Profile write, where the scoped-admin branch reads the Registry to confirm an accepted membership; the owner branch reads nothing (§ *Profiles*). That borderline exception is one reason why we say that it is best not to think of Profile as a full mesh node.

Scope existence is independent of membership. Creating a Galaxy or a Star writes a scope row and nothing else, so a real, working scope can have zero members — the creator's own scope already reaches down to it. Of the operations that *create a scope*, only the claim paths also mint an identity — because until one exists nobody holds a token that reaches the new scope. Invites mint identities too, but into a scope that already exists (§ *Grants*).

Everything else the Registry owns has its own section: sessions and their cookies, memberships and the addresses they hang off, and the scope and admin bit that the coarse-grained gate reads out of every token.

## Profiles

**It is best not to think of a Profile as a full mesh node.** It participates in the mesh and uses its code and conventions, but its coarse-grained access control is intentionally different: it is the one place where lateral passage is the *point*. The same person works in several applications in one Universe; coaches and contract workers are invited into different organizations entirely. Some will want a distinct persona in each, but most do not want to re-type their name and upload their picture again for every one. So a Profile is reachable sideways, by design, and the rules above do not apply to it.

A Profile holds two categories of data, public and private, and nothing in between. There is no orgTree inside a Profile and no acl structure of its own.

Public data includes name, nickname, and picture. It is open to every Nebula client. Reading it takes an authenticated connection and the `profileId`, and nothing else — no scope, no membership, and no relationship between reader and subject is consulted. The read touches no Registry data.

A Profile is not a web resource. There is no HTTPS endpoint for one — no route and no `fetch()` handler — so it cannot be curled, crawled, or linked to from outside. The only way in is a mesh call on an already-authenticated connection.

The `profileId` being random and unguessable stops enumeration, not access. Any authenticated client who obtains an id, by whatever means, can read that profile's public fields. There will never be more gating than that. If a user doesn't want their real name or picture reachable that way, they are free to obfuscate themselves.

Private data can be read and written only by the owner of the profile, a superuser, or a Registry admin over a scope where that person holds an **accepted** membership.

Accepted is load-bearing, not bookkeeping. An invitation creates a membership before the invitee has done anything, so counting unaccepted ones would let anyone claim a Universe, invite an address they guessed, and become an admin over a scope that stranger's profile touches. A membership is only marked accepted by consuming a link delivered to the mailbox, which no attacker can do for someone else's address.

The owner is whoever's `profileId` is on the token, and only when that token carries no impersonation chain. An admin impersonating someone is not that person here. They may still reach the private fields through the admin rule above, as themselves, if they administer a scope where the profile holds an accepted membership.

Access to a Profile is therefore decided by the token, plus Registry data for the admin case. The owner case reads nothing from the Registry, because the token already carries the `profileId`.

## Superuser seed

An environment variable holds an array of superuser email addresses. Logging in with one of these email addresses and selecting the superuser scope means that login holds dominion over every scope there is — the equivalent of having Registry scopeAdmin over every Universe — essentially God. That needs no special arm: `nebula-platform` is the root of the scope tree, so `isAtOrAbove` already places it at or above every scope (§ *Coarse-grained access control*). God's dominion is the ordinary downward rule, held from the top.

## Impersonation

An admin can act as someone they administer. The token names both people: the top-level `sub` is the person being acted as, and `act.sub` is the admin doing it. The token format allows nesting, but impersonation does not chain — to act as someone else you go back to your original session.

`act` in an **access token** means impersonation and nothing else, and that is an invariant rather than a coincidence: profile ownership is decided by `act` being *absent* (§ *Profiles*), so anything else that prepended an actor into one would silently strip a person of their own profile. Chains grow on the **record** instead — § *Attribution*.

It produces a token but not a session. There is no refresh cookie behind it, which is why ending it means tearing down the client and never calling the logout endpoint — that would spend the cookie of the session that minted it, ending the admin's own.

Authorization is decided by the subject and never the actor. Otherwise the admin carries their own power into the user's seat and never experiences the system the way a user does, which defeats the motivating use case for impersonation — debugging.

It is never an escalation. You can only act as someone whose scope your dominion already covers, and the token mirrors that person's access rather than your own.

Here is that mirroring, in the same shape as the token in § *The access token* above. The admin from that example — `8f3c…`, with profile `1a9d…` — is now acting as a member of one of their Stars:

```jsonc
{
  "sub": "7b2e…",              // the SUBJECT — authz reads this, always
  "aud": "acme.crm.bigco",     // where the admin chose to act
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

One test governs when a check may look at `act` at all: only where impersonation would otherwise grant the actor something they could not already do themselves. Everywhere else it buys nothing, since an admin can already do anything to anyone beneath them. The one case today is profile ownership, which sits outside the scope tree. Such a check may look at whether `act` is present, never at who the actor is.

There is no consent step, deliberately. An admin can already read and write anything in their scope under their own name, so impersonation grants them nothing new. It only changes attribution, and it improves it by naming both parties — gating it would push an admin toward the less traceable path. This changes if a customer requires consent during a security review and the deal is worth it.

### When Nebula is the actor

Studio's agent writes Resources on a user-developer's behalf, and it holds **no authority of its own** — no membership, no access token, no login. The write runs inside the triggering person's own call, carrying their `sub` and their permissions, and the platform adds itself as an **actor on the record**, never on the token. So the record reads *this human, via Nebula*, and authorization is unchanged: the agent can do exactly what that person could and nothing more, because it is that person's authority doing it.

The actor id is `agent:nebula` — self-describing and syntactically not a human, so a server-composed actor stays distinguishable from a token-attested one at a glance ([ADR-016](../adr/016-record-the-acting-principal.md)). It is only ever an actor, never a subject; `sub` names the person who prompted the turn. Nebula does hold a Profile, so it renders like any other participant (§ *Profiles*), but it has no membership and the Registry knows nothing about it.

Two inversions are tempting and both are wrong. Giving the agent its own login would **grant** it authority that then has to be confined, where this design has nothing to confine. And the actor is composed server-side: a client able to name its own actor would defeat the record entirely.

> **Today's code differs.** Nothing prepends Nebula yet, so every `act` chain in a record comes from impersonation alone.

### Attribution

An attribution record answers two questions.

- **Identity** — *who acted* — is the acting principal: the subject, the `access` that token asserted, and the **actor chain** (`act` in the JWT) when an admin and/or Nebula acts on the subject's behalf. The chain is not decoration. Authorization keys off the subject alone (§ *Impersonation*), so a record carrying only the subject names the person acted *upon* as the person who acted — worse than no record, because it will be believed.
- **Topology** — *through what path* — is `callChain`, the `[origin, …, caller]` list of mesh nodes a call travelled, extended automatically at each hop so provenance is never something a caller threads by hand. Naming who acted without how they reached the node is half an answer, so both belong in what gets written.

Two kinds of action write an attribution record, and **the same function builds both** — no site assembles its own fields — so the two cannot drift apart ([ADR-016](../adr/016-record-the-acting-principal.md)).

- **A Resource write** adds what changed and when. A Resource is a sequence of snapshots and the record rides every one of them: a write **closes the current snapshot and opens a new one** rather than overwriting, committed history is immutable, and even a delete is itself a snapshot transition ([ADR-004](../adr/004-snodgrass-temporal-resources.md)). No later write can erase it, because none of them destroys anything.
- **An action that changes who can do what, removes state, or establishes a session** writes its record to a durable sink of its own.

APIs and UIs allow the querying and inspection of both. These records are access controlled so they only show each person what their scope and authAdmin status entitles them to see.

> **Today's code differs.** Neither half is readable as history. Resource snapshots are durable, but every read path returns the current one only — prior versions accumulate with no way to retrieve them and no query surface over them. Their attribution is also narrower than the above: the subject and the actor chain, without `profileId` or the asserted `access`. The acting-token records go to the debug log — retained for a window rather than forever, and readable by nobody filtered to their own scope. And topology is written down nowhere at all; `callChain` survives only for the duration of a call. So identity already rides both records and most of the remaining work is the sink, the reader and the viewer — but the path is a genuine addition. We do not yet meet the full vision of [`_ai-security.md`](_ai-security.md) § *Attribution*.

## Grants

**Grants are made with as little friction as possible and growth is why**. Our success is a function of how many people are on our platform, so friction in the path to getting someone *onto* it is not caution — it is failure. It is why a stranger may claim a Universe or an unclaimed Star and become its `scopeAdmin` with nobody's approval, and it is the same reason a member may bring in a peer.

So, anyone may invite a non-admin at their own scope. Dominion additionally permits inviting downward, and is the only thing that permits conferring `scopeAdmin`.

**Registry-initiated grants**. Only `scopeAdmin` grants are made directly using Registry endpoints.

Ordering is important. A data-plane grant names a `sub`, and a `sub` only exists once a membership does. So the Registry step always comes first.

### Grants in both planes

An operation whose outcome spans both planes — an invite that mints a membership *and* lands an orgTree grant is the canonical case — follows one recipe:

1. **It initiates on the data-plane side** — the node hosting the orgTree — because the grants that authorize it live there and the Registry cannot see them. The data-plane guard stands at this door.
2. **It reaches the Registry through the facade** — a mesh-speaking entrypoint the Registry's package owns, where the Registry-side guards live: claims-level verdicts only, the acting principal recorded from the same verified claims (ADR-016), the one raw Workers RPC call from a node that accepts `lmz.call()`s. The Registry never learns what a Star is.
3. **Both planes are written in one operation — which no transaction spans.** There is no cross-plane transactional support, so inconsistency is the implementor's to consider. The Registry writes first and both halves are idempotent, so the one reachable inconsistency — a membership without its grant — heals on a re-attempted invite.

The facade is not reserved for two-plane operations: it is how *any* authenticated session mutation reaches the Registry (§ *The Registry*), pure-Registry invites included. It also rate-limits nothing, deliberately: mesh calls carry no rate limits anywhere — a mesh caller could overwhelm their own Star or Galaxy by cheaper means, so a limiter here would buy nothing, and we treat that as true until evidence says otherwise. The HTTP surface keeps its limiters (R3 in § *The layers a call passes*).

> **Today's code differs.** `/invite` and `/mint-narrower-token` are authenticated HTTP routes and the facade does not exist yet — [nebula-invite.md](../../tasks/nebula-invite.md) builds it, moves invites onto it and deletes the route; today's `/invite` requires dominion over the target scope and is rate-limited (`dominionOverScopeGuard`, `subRateLimitGuard`), so § *Grants*' own-scope path and derived-bit rule are unbuilt. `/mint-narrower-token` follows ([backlog.md](../../tasks/backlog.md) § *Nebula Auth*).


### Founding a Star

Sometimes, a `scopeAdmin` grant is made for a Star and the data-plane grant happens passively a short while later.

**Cloudflare has no create operation for a Durable Object.** A Star is a DO instance and comes into being the first time it is addressed, placed near whoever addressed it — which is the default you want, since a tenant's data should sit close to the people using it. That makes founding a **sequencing** problem rather than a create step: whoever touches the Star first decides where it lives *forever*, and the person mostly likely near its users is the founder.

So the flow keeps everyone else off the Star until the founder arrives. Having the Registry create the Star would be the worst case, since it is a global singleton sitting wherever it was first touched, and a Star created by a call from it would land beside the Registry rather than beside the Star's founder. Three steps make this happen:

1. **The claim writes to the Registry, never to the Star.** A single unauthenticated call, fronted by Turnstile — anyone may claim an unclaimed Star, with no invitation and no approval step, and that openness is the product rather than an oversight. It validates and then writes atomically: the scope row, an *unaccepted* admin membership at the full three-segment id, and a magic link. The parent Galaxy must already exist, but that is an integrity check rather than an admin gate; nobody is authenticated at this point in the flow.
2. **The mailbox proves the person.** Clicking the emailed link is what marks that membership accepted and logs them in. Re-claiming from the same address re-sends the link; a different address gets a conflict, so a pending claim cannot be taken over.
3. **The founder's first touch creates and places it.** Now authenticated at exactly that Star, they address it — and that call is what brings the Durable Object into existence, near them. The Star writes them an `admin` grant on its root node.

The Star writes that grant only for an admin whose scope is exactly that Star. One from further up gains nothing by it — their dominion already covers everything there (§ *The data plane*) — and would cost the Star a great deal, because the seed runs once and never again: whoever wanders in first becomes that Star's permanent terminus for access requests, routing its members' asks away from their own admin.

That much is enforced. Placement is not — nothing refuses a call from anyone whose dominion covers the Star, so whoever touches it first places it. It is **a bet rather than a check**, and what holds the bet is the sequencing above: until the founder clicks their link, nobody has reason to address the Star at all. The one realistic way to lose it is a support visit landing in the window before they do.
